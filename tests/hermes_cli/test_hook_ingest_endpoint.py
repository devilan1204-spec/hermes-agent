"""Unit tests for ``hermes_cli/hook_ingest.py``.

Covers:

* Discovery file write/read/remove lifecycle
* File permissions (0600) and atomic replace semantics
* Auth gating on the ingest endpoint (401 without token, 200 with)
* Body validation (400 on bad shape, missing keys, non-dict context)
* Forwarded events are stamped with ``_forwarded=True`` and
  ``_forwarded_from=<src>`` and republished via ``emit_sync``
* Health endpoint returns 200 unconditionally and is unauthenticated
* `--insecure` mode does not disable the ingest endpoint (the bearer
  token is the security boundary regardless of bind address)
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from gateway.hooks import (
    HookRegistry,
    _reset_default_registry_for_tests,
    get_default_registry,
    install_as_default,
)
from hermes_cli import hook_ingest


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    """Each test gets a fresh hermes home + fresh registry singleton +
    fresh ingest-token state.  Without this the module-level
    ``_HOOKS_INGEST_TOKEN`` from one test would leak into the next."""
    monkeypatch.setattr(hook_ingest, "get_hermes_home", lambda: tmp_path)
    hook_ingest._reset_for_tests()
    _reset_default_registry_for_tests()
    yield
    hook_ingest._reset_for_tests()
    _reset_default_registry_for_tests()


@pytest.fixture
def fresh_registry():
    """Install a clean ``HookRegistry`` as the process default and return it."""
    reg = HookRegistry()
    install_as_default(reg)
    return reg


@pytest.fixture
def hook_app(fresh_registry):
    """A FastAPI app with the hook router mounted at /api/hooks."""
    app = FastAPI()
    app.include_router(hook_ingest.build_hook_router(), prefix="/api/hooks")
    return app


@pytest.fixture
def client(hook_app):
    return TestClient(hook_app)


# ---------------------------------------------------------------------------
# Discovery file lifecycle
# ---------------------------------------------------------------------------


class TestDiscoveryFile:
    def test_write_creates_file_with_expected_shape(self, tmp_path):
        token = hook_ingest.write_dashboard_discovery_file("127.0.0.1", 9119)

        path = tmp_path / "dashboard.json"
        assert path.exists()

        data = json.loads(path.read_text())
        assert data["url"] == "http://127.0.0.1:9119"
        assert data["hooks_ingest_token"] == token
        assert isinstance(data["pid"], int)
        assert "started_at" in data
        # ISO-8601 timestamp.
        assert "T" in data["started_at"]

    def test_write_returns_fresh_token_each_call(self, tmp_path):
        first = hook_ingest.write_dashboard_discovery_file("127.0.0.1", 9119)
        second = hook_ingest.write_dashboard_discovery_file("127.0.0.1", 9119)

        assert first != second  # 32-byte urlsafe tokens collide ~never

    def test_write_records_non_loopback_bind(self, tmp_path):
        """``--insecure`` mode binds non-loopback; the discovery file
        must reflect that so forwarders dial the right address."""
        hook_ingest.write_dashboard_discovery_file("0.0.0.0", 9119)
        data = json.loads((tmp_path / "dashboard.json").read_text())
        assert data["url"] == "http://0.0.0.0:9119"

    def test_write_creates_parent_dir_if_missing(self, monkeypatch, tmp_path):
        """``$HERMES_HOME`` might not exist yet on first startup."""
        nested = tmp_path / "new" / "hermes"
        monkeypatch.setattr(hook_ingest, "get_hermes_home", lambda: nested)

        hook_ingest.write_dashboard_discovery_file("127.0.0.1", 9119)

        assert (nested / "dashboard.json").exists()

    def test_file_mode_is_0600(self, tmp_path):
        """Discovery file holds a bearer token in cleartext; must be
        owner-only readable."""
        hook_ingest.write_dashboard_discovery_file("127.0.0.1", 9119)
        path = tmp_path / "dashboard.json"
        mode = stat.S_IMODE(path.stat().st_mode)
        # 0o600 = read+write for owner, nothing for group/other.
        assert mode == 0o600, f"expected 0600, got {oct(mode)}"

    def test_remove_deletes_file(self, tmp_path):
        hook_ingest.write_dashboard_discovery_file("127.0.0.1", 9119)
        assert (tmp_path / "dashboard.json").exists()

        hook_ingest.remove_dashboard_discovery_file()
        assert not (tmp_path / "dashboard.json").exists()

    def test_remove_is_idempotent(self):
        # Never written.
        hook_ingest.remove_dashboard_discovery_file()
        # And again — must not raise.
        hook_ingest.remove_dashboard_discovery_file()

    def test_remove_clears_in_memory_token(self):
        """Once removed, no one can authenticate to ingest anymore."""
        hook_ingest.write_dashboard_discovery_file("127.0.0.1", 9119)
        assert hook_ingest.get_current_token_for_tests() != ""

        hook_ingest.remove_dashboard_discovery_file()
        assert hook_ingest.get_current_token_for_tests() == ""


# ---------------------------------------------------------------------------
# /health endpoint
# ---------------------------------------------------------------------------


class TestHealthEndpoint:
    def test_health_returns_200_unauthenticated(self, client):
        r = client.get("/api/hooks/health")
        assert r.status_code == 200
        assert r.json() == {"ok": True}

    def test_health_returns_200_with_no_token_set(self, client):
        """Health probe must succeed even before any token has been
        written (forwarder probes before discovery is established)."""
        # No write_dashboard_discovery_file call — token stays "".
        r = client.get("/api/hooks/health")
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# /ingest endpoint — auth
# ---------------------------------------------------------------------------


class TestIngestAuth:
    def test_ingest_401_without_token(self, client):
        token = hook_ingest.write_dashboard_discovery_file("127.0.0.1", 9119)
        del token  # noqa: F841 — we intentionally don't send it.

        r = client.post(
            "/api/hooks/ingest",
            json={"event_type": "agent:start", "context": {}, "src": "gateway"},
        )
        assert r.status_code == 401

    def test_ingest_401_with_wrong_token(self, client):
        hook_ingest.write_dashboard_discovery_file("127.0.0.1", 9119)

        r = client.post(
            "/api/hooks/ingest",
            json={"event_type": "agent:start", "context": {}, "src": "gateway"},
            headers={"Authorization": "Bearer wrong"},
        )
        assert r.status_code == 401

    def test_ingest_401_when_no_token_set(self, client):
        """Discovery file never written ⇒ ingest refuses everything."""
        r = client.post(
            "/api/hooks/ingest",
            json={"event_type": "agent:start", "context": {}, "src": "gateway"},
            headers={"Authorization": "Bearer something"},
        )
        assert r.status_code == 401

    def test_ingest_200_with_valid_token(self, client):
        token = hook_ingest.write_dashboard_discovery_file("127.0.0.1", 9119)

        r = client.post(
            "/api/hooks/ingest",
            json={"event_type": "agent:start", "context": {}, "src": "gateway"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200
        assert r.json() == {"ok": True}

    def test_ingest_works_for_non_loopback_bind(self, client):
        """``--insecure`` doesn't disable ingest.  The bearer token IS
        the security boundary regardless of bind address (see
        DESIGN-cross-process-hooks.md "Bind-address independence")."""
        token = hook_ingest.write_dashboard_discovery_file("0.0.0.0", 9119)

        r = client.post(
            "/api/hooks/ingest",
            json={"event_type": "agent:start", "context": {}, "src": "gateway"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# /ingest endpoint — body validation
# ---------------------------------------------------------------------------


class TestIngestBodyValidation:
    @pytest.fixture
    def auth_headers(self):
        token = hook_ingest.write_dashboard_discovery_file("127.0.0.1", 9119)
        return {"Authorization": f"Bearer {token}"}

    def test_400_on_non_json_body(self, client, auth_headers):
        # FastAPI itself produces 422 for parse failures, but we explicitly
        # request JSON parsing so the response should be 400 with our
        # message — actually, request.json() on bad JSON raises and we
        # convert it to 400.
        r = client.post(
            "/api/hooks/ingest",
            content=b"not json",
            headers={**auth_headers, "Content-Type": "application/json"},
        )
        assert r.status_code == 400

    def test_400_on_non_dict_body(self, client, auth_headers):
        r = client.post(
            "/api/hooks/ingest",
            json=["this", "is", "an", "array"],
            headers=auth_headers,
        )
        assert r.status_code == 400
        assert "object" in r.json()["detail"]

    def test_400_on_missing_event_type(self, client, auth_headers):
        r = client.post(
            "/api/hooks/ingest",
            json={"context": {}, "src": "gateway"},
            headers=auth_headers,
        )
        assert r.status_code == 400
        assert "event_type" in r.json()["detail"]

    def test_400_on_empty_event_type(self, client, auth_headers):
        r = client.post(
            "/api/hooks/ingest",
            json={"event_type": "", "context": {}, "src": "gateway"},
            headers=auth_headers,
        )
        assert r.status_code == 400

    def test_400_on_non_dict_context(self, client, auth_headers):
        r = client.post(
            "/api/hooks/ingest",
            json={"event_type": "agent:start", "context": "string", "src": "gateway"},
            headers=auth_headers,
        )
        assert r.status_code == 400

    def test_200_with_missing_optional_fields(self, client, auth_headers):
        """src and context are optional; default to "?" and {}."""
        r = client.post(
            "/api/hooks/ingest",
            json={"event_type": "agent:start"},
            headers=auth_headers,
        )
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# /ingest endpoint — republish behavior
# ---------------------------------------------------------------------------


class TestIngestRepublish:
    def test_republishes_via_emit_sync(self, client, fresh_registry):
        captured: list = []
        fresh_registry.register("agent:start", lambda e, c: captured.append((e, c)))

        token = hook_ingest.write_dashboard_discovery_file("127.0.0.1", 9119)

        r = client.post(
            "/api/hooks/ingest",
            json={
                "event_type": "agent:start",
                "context": {"platform": "telegram", "user_id": "u-1"},
                "src": "gateway",
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200
        assert len(captured) == 1

        event, ctx = captured[0]
        assert event == "agent:start"
        # Original context keys preserved.
        assert ctx["platform"] == "telegram"
        assert ctx["user_id"] == "u-1"
        # Forwarding metadata stamped.
        assert ctx["_forwarded"] is True
        assert ctx["_forwarded_from"] == "gateway"

    def test_forwarded_stamp_overrides_caller_provided_value(
        self, client, fresh_registry
    ):
        """If a malicious/buggy caller tries to set _forwarded=False to
        smuggle the event past loop prevention, the endpoint overrides
        it.  This isn't a security boundary (the auth gate is) but a
        defensive sanity check."""
        captured: list = []
        fresh_registry.register("agent:start", lambda e, c: captured.append(c))

        token = hook_ingest.write_dashboard_discovery_file("127.0.0.1", 9119)
        client.post(
            "/api/hooks/ingest",
            json={
                "event_type": "agent:start",
                "context": {"_forwarded": False},
                "src": "gateway",
            },
            headers={"Authorization": f"Bearer {token}"},
        )

        assert captured[0]["_forwarded"] is True

    def test_wildcard_handlers_see_forwarded_events(self, client, fresh_registry):
        """A subscriber to ``tui:*`` sees forwarded ``tui:tool.start`` events."""
        captured: list = []
        fresh_registry.register("tui:*", lambda e, c: captured.append(e))

        token = hook_ingest.write_dashboard_discovery_file("127.0.0.1", 9119)

        client.post(
            "/api/hooks/ingest",
            json={
                "event_type": "tui:tool.start",
                "context": {"session_id": "s-1", "payload": {"name": "search_files"}},
                "src": "tui",
            },
            headers={"Authorization": f"Bearer {token}"},
        )

        assert captured == ["tui:tool.start"]

    def test_src_defaults_to_question_mark(self, client, fresh_registry):
        captured: list = []
        fresh_registry.register("agent:start", lambda e, c: captured.append(c))

        token = hook_ingest.write_dashboard_discovery_file("127.0.0.1", 9119)

        client.post(
            "/api/hooks/ingest",
            json={"event_type": "agent:start", "context": {}},
            headers={"Authorization": f"Bearer {token}"},
        )

        assert captured[0]["_forwarded_from"] == "?"

    def test_non_string_src_is_normalized(self, client, fresh_registry):
        """If something weird sends src=123, we don't propagate the bad type."""
        captured: list = []
        fresh_registry.register("agent:start", lambda e, c: captured.append(c))

        token = hook_ingest.write_dashboard_discovery_file("127.0.0.1", 9119)

        r = client.post(
            "/api/hooks/ingest",
            json={"event_type": "agent:start", "context": {}, "src": 123},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200
        assert captured[0]["_forwarded_from"] == "?"

    def test_handler_exception_does_not_break_ingest(self, client, fresh_registry):
        """A buggy subscriber raising in emit_sync must not 500 the
        ingest endpoint — emit_sync swallows handler exceptions, but
        the route also has a top-level try/except defensive layer."""
        fresh_registry.register("agent:end", lambda _e, _c: 1 / 0)

        token = hook_ingest.write_dashboard_discovery_file("127.0.0.1", 9119)

        r = client.post(
            "/api/hooks/ingest",
            json={"event_type": "agent:end", "context": {}, "src": "gateway"},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert r.status_code == 200
