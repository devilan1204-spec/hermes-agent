"""Hook registry cross-process delivery — dashboard-side endpoints.

The companion to ``gateway/hook_forwarder.py``.  Provides:

* ``write_dashboard_discovery_file()`` / ``remove_dashboard_discovery_file()`` —
  drops/cleans ``$HERMES_HOME/dashboard.json`` with the bound dashboard URL and
  a freshly-generated bearer token.  Long-lived source processes (gateway,
  TUI, subagents) read this file on startup to find the dashboard and
  authenticate ingest POSTs.

* :func:`build_hook_router` — returns a FastAPI router with two endpoints:

  - ``GET /api/hooks/health`` — unauthenticated reachability probe.  The
    forwarder GETs this before each round of POSTs so a downed dashboard
    fails fast without spamming the ingest endpoint with retries.

  - ``POST /api/hooks/ingest`` — accepts ``{event_type, context, src}``
    frames from forwarders and republishes them via
    ``get_default_registry().emit_sync(event_type, context)``.  Bearer
    token from ``dashboard.json:hooks_ingest_token`` is the security
    boundary, independent of the dashboard's session token / OAuth
    gate.  Loop-prevention: the republished context is stamped with
    ``_forwarded=True`` and ``_forwarded_from=<src>`` so source-side
    forwarders skip these events if they ever round-trip back.

See ``DESIGN-cross-process-hooks.md`` for the full design rationale.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import secrets
import stat
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request

from hermes_cli.config import get_hermes_home


_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Discovery file
# ---------------------------------------------------------------------------
#
# The dashboard writes this file on startup and removes it on shutdown.
# Forwarders running in non-dashboard processes read it to discover the
# dashboard URL + bearer token.  Lives under HERMES_HOME so it's
# profile-aware; no /tmp fallback.

_DISCOVERY_FILENAME = "dashboard.json"

# Token used by forwarders to authenticate POST /api/hooks/ingest.
# Generated fresh on each dashboard startup; lives only in memory + the
# 0600-mode discovery file.  Stored at module level so the ingest
# endpoint can compare against it without re-reading the file on every
# request.
_HOOKS_INGEST_TOKEN: str = ""


def _discovery_path() -> Path:
    """Return the absolute path of ``$HERMES_HOME/dashboard.json``."""
    return get_hermes_home() / _DISCOVERY_FILENAME


def write_dashboard_discovery_file(host: str, port: int) -> str:
    """Generate a fresh hooks-ingest token and write the discovery file.

    The discovery file is written atomically (write to ``.tmp``, rename
    to final path) so a forwarder that reads concurrently never sees a
    partially-written file.  The file mode is ``0600`` — owner-only —
    so a same-host non-root user can't read the token without already
    having compromised the dashboard user's account.

    Idempotent in the trivial sense: calling twice in the same process
    rotates the token and overwrites the file.  Not thread-safe; should
    only be called from the dashboard's startup path.

    Args:
        host: The host the dashboard bound to (``127.0.0.1``, ``0.0.0.0``,
            a specific interface, …).  Written verbatim into the discovery
            file so forwarders dial the right address.
        port: The port the dashboard bound to.

    Returns:
        The freshly-generated bearer token (also stored module-locally
        so :func:`_hook_ingest_auth_ok` can validate POSTs).
    """
    global _HOOKS_INGEST_TOKEN
    token = secrets.token_urlsafe(32)
    _HOOKS_INGEST_TOKEN = token

    payload = {
        "url": f"http://{host}:{port}",
        "hooks_ingest_token": token,
        "pid": os.getpid(),
        "started_at": datetime.now(timezone.utc).isoformat(),
    }

    path = _discovery_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".json.tmp")
    try:
        tmp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        # 0600 — owner read+write, nothing for group or other.  Same
        # posture as ~/.hermes/auth.json.
        os.chmod(tmp_path, stat.S_IRUSR | stat.S_IWUSR)
        tmp_path.replace(path)
    except OSError as exc:
        _log.warning(
            "[hooks-ingest] failed to write dashboard discovery file at %s: %s",
            path,
            exc,
        )
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise

    _log.debug("[hooks-ingest] wrote %s", path)
    return token


def remove_dashboard_discovery_file() -> None:
    """Delete the discovery file.  Idempotent; safe to call from atexit."""
    global _HOOKS_INGEST_TOKEN
    try:
        _discovery_path().unlink(missing_ok=True)
    except OSError:
        pass
    _HOOKS_INGEST_TOKEN = ""
    _log.debug("[hooks-ingest] removed discovery file")


# ---------------------------------------------------------------------------
# Auth helper
# ---------------------------------------------------------------------------


def _hook_ingest_auth_ok(request: Request) -> bool:
    """True if the request carries a valid hooks-ingest bearer token.

    The token is independent of the dashboard session token / OAuth
    cookie; only forwarders that have read ``dashboard.json`` know it.

    Constant-time comparison via :func:`hmac.compare_digest`.
    """
    if not _HOOKS_INGEST_TOKEN:
        # No token yet — discovery file not written; refuse everything.
        return False
    auth = request.headers.get("authorization", "")
    expected = f"Bearer {_HOOKS_INGEST_TOKEN}"
    return hmac.compare_digest(auth.encode(), expected.encode())


# ---------------------------------------------------------------------------
# FastAPI router
# ---------------------------------------------------------------------------


def build_hook_router() -> APIRouter:
    """Return a FastAPI router with ``/health`` and ``/ingest`` endpoints.

    Caller mounts at ``/api/hooks`` to get the documented endpoints
    (``GET /api/hooks/health`` and ``POST /api/hooks/ingest``).
    """
    router = APIRouter()

    @router.get("/health")
    async def hook_health() -> dict:
        """Unauthenticated reachability probe for the forwarder."""
        return {"ok": True}

    @router.post("/ingest")
    async def hook_ingest(request: Request) -> dict:
        """Republish a forwarded event on the dashboard's local registry.

        Wire shape (POST body)::

            {
              "event_type": "agent:start",
              "context":    {"platform": "telegram", "user_id": "u-1", ...},
              "src":        "gateway"
            }

        The context is republished with ``_forwarded=True`` and
        ``_forwarded_from=<src>`` stamped on it so source-side
        forwarders skip the event if it ever round-trips back (closing
        the loop).

        Returns ``{"ok": True}`` on success, raises 401 on missing/bad
        token, 400 on malformed body.

        ``emit_sync`` is the right entry point: handlers run
        synchronously on the request thread (fast, push-to-queue style
        for typical plugin handlers); async handlers are scheduled on
        the running event loop via the existing ``asyncio.ensure_future``
        path inside ``emit_sync``.
        """
        if not _hook_ingest_auth_ok(request):
            raise HTTPException(status_code=401, detail="Unauthorized")

        try:
            body = await request.json()
        except Exception as exc:
            raise HTTPException(
                status_code=400, detail=f"invalid JSON body: {exc}"
            ) from exc

        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="body must be a JSON object")

        event_type = body.get("event_type")
        if not isinstance(event_type, str) or not event_type:
            raise HTTPException(
                status_code=400, detail="missing or empty 'event_type'"
            )

        context = body.get("context") or {}
        if not isinstance(context, dict):
            raise HTTPException(
                status_code=400, detail="'context' must be a JSON object"
            )

        src = body.get("src", "?")
        if not isinstance(src, str):
            src = "?"

        # Stamp the context with forwarding metadata so:
        # 1. Source-side forwarders skip this event if it ever round-trips
        #    back to them (loop prevention).
        # 2. Subscribers can filter forwarded-vs-original on
        #    ``context["_forwarded"]`` (useful for hooks that fire in
        #    every process and don't want 2x firing).
        context = {**context, "_forwarded": True, "_forwarded_from": src}

        # Lazy import to avoid a hard dependency on gateway.hooks at
        # module-load time (web_server can be imported in contexts
        # where gateway.hooks isn't ready).
        from gateway.hooks import get_default_registry

        try:
            get_default_registry().emit_sync(event_type, context)
        except Exception as exc:
            # emit_sync swallows handler exceptions internally — if we
            # see one here it's a registry-level bug.  Log it but still
            # return 200 so the forwarder doesn't retry-storm.
            _log.warning(
                "[hooks-ingest] emit_sync raised for %s: %s", event_type, exc
            )

        return {"ok": True}

    return router


# ---------------------------------------------------------------------------
# Test helper
# ---------------------------------------------------------------------------


def _reset_for_tests() -> None:
    """Clear the cached token + remove any leftover discovery file."""
    global _HOOKS_INGEST_TOKEN
    _HOOKS_INGEST_TOKEN = ""
    remove_dashboard_discovery_file()


def get_current_token_for_tests() -> str:
    """Read the currently-active hooks-ingest token.

    Test-only accessor; do not call from production code.
    """
    return _HOOKS_INGEST_TOKEN
