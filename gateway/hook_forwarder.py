"""Cross-process hook forwarder.

Subscribes to a fixed set of namespaces on a process-local
:class:`gateway.hooks.HookRegistry` and POSTs each fired event to the
dashboard's ``/api/hooks/ingest`` endpoint. The dashboard republishes
the event on its own default registry so plugins running in the
dashboard process see events that originated in the gateway, TUI,
subagent, or batch-runner processes.

Design constraints (see ``DESIGN-cross-process-hooks.md``):

* Never blocks the publisher.  Handler enqueues onto a bounded queue
  and returns immediately; a daemon worker thread does the HTTP POSTs.
* Bounded queue drops *oldest* on overflow.  Observability events are
  best-effort; recency beats history when the dashboard is slow.
* Loop prevention.  Events whose context carries ``_forwarded=True``
  are skipped — those came from the ingest endpoint and must not be
  shipped back.
* No-op when no dashboard is available.  Discovery file absent ⇒ no
  registration, no thread.  Probe re-checks every 30s so a dashboard
  that starts later auto-attaches.
* ``HERMES_HOOK_FORWARDER=0`` short-circuits everything for paranoid
  security postures, or for tests that don't want the daemon thread.

The forwarder is wired in by long-lived non-dashboard processes
(gateway, TUI, subagents, batch runners) via
:func:`start_if_dashboard_available`.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from queue import Empty, Full, Queue
from typing import Any, Callable, Optional

from hermes_cli.config import get_hermes_home


_log = logging.getLogger(__name__)


# Namespaces the forwarder ships to the dashboard.  Picked to cover every
# event type the registry emits today.  Adding a new namespace is a
# one-line append here.  Wildcards use the existing registry semantics
# (``<namespace>:*`` matches every ``<namespace>:<anything>`` event).
_FORWARDED_NAMESPACES = (
    "tui:*",
    "agent:*",
    "session:*",
    "command:*",
    "gateway:*",
)

# Bounded queue size per source process.  At peak (~70 events/sec, see the
# design doc's "Performance" section) this is ~14 seconds of backlog
# before drop-oldest kicks in.  Generous for a purely-observability feed.
_QUEUE_MAX = 1024

# Probe cadence.  When the dashboard isn't running we re-check the
# discovery file every 30s so a delayed ``hermes dashboard`` startup
# eventually attaches.  Cheap (one stat + one health GET) so this can
# run forever without overhead.
_PROBE_INTERVAL_S = 30.0

# HTTP timeouts.  Connection is loopback in the common case so anything
# beyond 2s probably means the dashboard is wedged; better to drop the
# frame than queue up retries that won't help.
_HTTP_TIMEOUT_S = 2.0

# Error-logging cadence.  POST failures get logged once per minute, not
# per failure, so a downed dashboard doesn't spam ``agent.log``.
_ERROR_LOG_INTERVAL_S = 60.0


def _dashboard_discovery_path() -> Path:
    """Return the path the dashboard writes its discovery JSON to.

    Always under ``$HERMES_HOME``; no ``/tmp`` fallback.  Config
    consistency across processes is a precondition, not something the
    forwarder patches over.
    """
    return get_hermes_home() / "dashboard.json"


def _read_discovery_file() -> Optional[dict]:
    """Read and parse ``dashboard.json``.

    Returns ``None`` when the file is absent, unreadable, malformed, or
    missing required keys.  Never raises — callers treat a ``None``
    result as "no dashboard available" and re-probe on the next cycle.
    """
    path = _dashboard_discovery_path()
    try:
        if not path.exists():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    if "url" not in data or "hooks_ingest_token" not in data:
        return None
    return data


def _disabled_by_env() -> bool:
    """``HERMES_HOOK_FORWARDER=0`` (or ``false``/``no``) short-circuits."""
    val = os.environ.get("HERMES_HOOK_FORWARDER", "").strip().lower()
    return val in ("0", "false", "no", "off")


# ---------------------------------------------------------------------------
# HookForwarder — per-process singleton-ish
# ---------------------------------------------------------------------------


class _HookForwarder:
    """The actual forwarder.

    Tracks the registry it's attached to, the unregister callables (so
    :meth:`stop` can clean up), and the worker thread state.

    Multiple instances are technically supported but in practice each
    process holds at most one — see :func:`start_if_dashboard_available`
    and the module-level ``_active`` reference.
    """

    def __init__(self, src: str) -> None:
        self.src = src
        self._queue: Queue[dict] = Queue(maxsize=_QUEUE_MAX)
        self._unregisters: list[Callable[[], None]] = []
        self._stop = threading.Event()
        self._worker: Optional[threading.Thread] = None
        # Discovery state — refreshed by the worker thread before each
        # POST so a dashboard restart (with a new token) auto-recovers.
        self._discovery: Optional[dict] = None
        self._discovery_lock = threading.Lock()
        # Error-log rate limit state.
        self._last_error_log_at: float = 0.0
        self._error_count_since_log: int = 0

    # -- registry side ---------------------------------------------------

    def _handler(self, event_type: str, context: dict) -> None:
        """Sync hook handler — enqueues the event for the worker thread."""
        # Loop prevention: events forwarded *into* this process must not
        # be shipped back.  The dashboard's ingest endpoint stamps every
        # republished context with ``_forwarded=True``.
        if context.get("_forwarded") is True:
            return
        try:
            self._queue.put_nowait(
                {"event_type": event_type, "context": context, "src": self.src}
            )
        except Full:
            # Drop oldest, enqueue newest.  Observability is best-effort.
            try:
                self._queue.get_nowait()
            except Empty:
                pass
            try:
                self._queue.put_nowait(
                    {"event_type": event_type, "context": context, "src": self.src}
                )
            except Full:
                # Pathological — worker isn't draining at all.  Give up
                # silently; next event will overwrite this slot.
                pass

    def register(self, registry: "object") -> None:
        """Register the handler for every forwarded namespace."""
        for pattern in _FORWARDED_NAMESPACES:
            unreg = registry.register(  # type: ignore[union-attr]
                pattern,
                self._handler,
                name=f"hook_forwarder({pattern}→dashboard)",
            )
            self._unregisters.append(unreg)

    def unregister(self) -> None:
        """Remove every handler the forwarder installed.  Idempotent."""
        while self._unregisters:
            try:
                self._unregisters.pop()()
            except Exception:  # pragma: no cover — defensive
                pass

    # -- worker thread ---------------------------------------------------

    def start_worker(self) -> None:
        """Spawn the daemon worker thread that drains the queue."""
        if self._worker is not None and self._worker.is_alive():
            return
        self._stop.clear()
        self._worker = threading.Thread(
            target=self._worker_loop,
            name=f"hook-forwarder-{self.src}",
            daemon=True,
        )
        self._worker.start()

    def stop_worker(self, *, join_timeout: float = 1.0) -> None:
        """Signal the worker to exit and wait briefly for it to do so.

        Idempotent.  Safe to call from any thread.  Daemon threads die
        with the process anyway; the join is only there so tests don't
        race on lingering threads between cases.
        """
        self._stop.set()
        if self._worker is not None:
            try:
                self._worker.join(timeout=join_timeout)
            except RuntimeError:
                pass

    def _worker_loop(self) -> None:
        """Drain the queue, POSTing each frame, until ``_stop`` is set."""
        # httpx is imported lazily so processes that never produce events
        # don't pay the import cost.  In practice the gateway and TUI
        # both have httpx loaded by the time we get here, but defer
        # anyway to be polite.
        import httpx

        next_probe_at: float = 0.0

        with httpx.Client(timeout=_HTTP_TIMEOUT_S) as client:
            while not self._stop.is_set():
                # Probe the discovery file periodically so a dashboard
                # that comes up later (or restarts with a new token)
                # auto-attaches.
                now = time.monotonic()
                if now >= next_probe_at:
                    next_probe_at = now + _PROBE_INTERVAL_S
                    self._refresh_discovery(client)

                # Block on the queue.  Short timeout so we re-check the
                # stop flag and probe interval often enough.
                try:
                    frame = self._queue.get(timeout=1.0)
                except Empty:
                    continue

                with self._discovery_lock:
                    discovery = self._discovery

                if discovery is None:
                    # No dashboard available right now.  Drop the frame;
                    # the next probe will re-acquire discovery, and any
                    # events fired between now and then are lost (the
                    # design accepts best-effort delivery).
                    continue

                self._post_frame(client, discovery, frame)

    def _refresh_discovery(self, client: "Any") -> None:  # client: httpx.Client
        """Reload the discovery file and probe the dashboard's health.

        Updates ``self._discovery`` to the new value (or ``None`` if the
        dashboard is unreachable).  Called from the worker thread.
        """
        data = _read_discovery_file()
        if data is None:
            with self._discovery_lock:
                self._discovery = None
            return

        url = data["url"].rstrip("/")
        try:
            resp = client.get(f"{url}/api/hooks/health", timeout=_HTTP_TIMEOUT_S)
            if resp.status_code != 200:
                with self._discovery_lock:
                    self._discovery = None
                return
        except Exception:
            with self._discovery_lock:
                self._discovery = None
            return

        with self._discovery_lock:
            self._discovery = data

    def _post_frame(
        self,
        client: "Any",  # httpx.Client
        discovery: dict,
        frame: dict,
    ) -> None:
        """POST one frame to ``/api/hooks/ingest``.

        Errors are logged at most once per minute, regardless of how
        many failures accumulate.  A 401 invalidates the cached
        discovery so the next probe re-reads the token (which may have
        rotated on a dashboard restart).
        """
        url = discovery["url"].rstrip("/") + "/api/hooks/ingest"
        token = discovery["hooks_ingest_token"]
        # Filter the context: ``_forwarded`` etc. are added by the
        # dashboard on republish.  Source-side contexts are passed as-is,
        # but they should never carry ``_forwarded=True`` (that's how
        # loop prevention works above).
        try:
            resp = client.post(
                url,
                json={
                    "event_type": frame["event_type"],
                    "context": frame["context"],
                    "src": frame["src"],
                },
                headers={"Authorization": f"Bearer {token}"},
                timeout=_HTTP_TIMEOUT_S,
            )
        except Exception as exc:
            self._log_error(f"POST {url} failed: {exc}")
            return

        if resp.status_code == 401:
            # Token rotated (dashboard restarted with a new one).
            # Invalidate the cached discovery; the next probe will
            # re-read the file and pick up the new token.
            self._log_error(
                "POST /api/hooks/ingest returned 401 — token rotated; "
                "invalidating discovery cache"
            )
            with self._discovery_lock:
                self._discovery = None
            return
        if resp.status_code >= 400:
            self._log_error(
                f"POST /api/hooks/ingest returned {resp.status_code}: "
                f"{resp.text[:200]!r}"
            )

    def _log_error(self, message: str) -> None:
        """Rate-limited error logging — once per minute per process."""
        self._error_count_since_log += 1
        now = time.monotonic()
        if now - self._last_error_log_at < _ERROR_LOG_INTERVAL_S:
            return
        suppressed = self._error_count_since_log - 1
        suffix = f" ({suppressed} similar errors suppressed)" if suppressed else ""
        _log.warning("[hook_forwarder] %s%s", message, suffix)
        self._last_error_log_at = now
        self._error_count_since_log = 0


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

# Per-process forwarder.  Multiple ``start_if_dashboard_available`` calls
# in the same process are idempotent (they re-use this instance).
_active: Optional[_HookForwarder] = None
_active_lock = threading.Lock()


def start_if_dashboard_available(
    registry: "object",
    *,
    src: str = "unknown",
) -> Optional[_HookForwarder]:
    """Wire the forwarder into ``registry`` if a dashboard is reachable.

    Idempotent: repeated calls in the same process are no-ops.  Returns
    the active forwarder if one is running (the same instance on every
    subsequent call within the process), or ``None`` if the forwarder
    was suppressed (no dashboard, or ``HERMES_HOOK_FORWARDER=0``).

    The ``src`` argument is a short tag identifying the source process
    (``"gateway"``, ``"tui"``, ``"subagent"``, ``"batch"``).  It's
    included in the wire frame for the dashboard's diagnostic logging
    and the republished context's ``_forwarded_from`` field, so a
    subscriber can tell which process originated each event.

    Args:
        registry: The :class:`gateway.hooks.HookRegistry` whose events
            should be forwarded.  Normally
            :func:`gateway.hooks.get_default_registry`.
        src: Source-process tag.  See above.

    Returns:
        The active forwarder, or ``None`` if forwarding is suppressed.
    """
    global _active

    if _disabled_by_env():
        _log.debug(
            "[hook_forwarder] HERMES_HOOK_FORWARDER=0 — skipping start"
        )
        return None

    discovery = _read_discovery_file()
    if discovery is None:
        _log.debug(
            "[hook_forwarder] no dashboard.json — forwarder not started"
        )
        return None

    with _active_lock:
        if _active is not None:
            # Already started in this process; nothing to do.
            return _active

        fwd = _HookForwarder(src=src)
        try:
            fwd.register(registry)
        except Exception as e:
            _log.warning(
                "[hook_forwarder] failed to register handlers: %s", e
            )
            return None

        fwd.start_worker()
        _active = fwd
        _log.info(
            "[hook_forwarder] started for src=%s, forwarding %d namespaces",
            src,
            len(_FORWARDED_NAMESPACES),
        )
        return fwd


def stop() -> None:
    """Tear down the active forwarder.  Idempotent.

    Primarily for tests; production processes just rely on the daemon
    thread dying with the process.
    """
    global _active
    with _active_lock:
        if _active is None:
            return
        _active.unregister()
        _active.stop_worker()
        _active = None


def _reset_for_tests() -> None:
    """Test helper — clears active state without preserving its
    side-effects (registered handlers etc.)."""
    stop()


def is_active() -> bool:
    """Return whether a forwarder is currently registered in this process."""
    return _active is not None
