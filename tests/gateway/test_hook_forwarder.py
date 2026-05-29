"""Unit tests for ``gateway/hook_forwarder.py``.

Covers:

* No-op behavior when discovery file absent / env var disables
* Idempotent ``start_if_dashboard_available`` (repeat calls re-use same forwarder)
* Handler registration on every forwarded namespace
* Loop prevention via ``_forwarded`` context flag
* Queue overflow drops oldest, enqueues newest
* ``stop()`` and ``_reset_for_tests`` are clean and idempotent
* Error-log rate limiting

The HTTP-POST path is exercised in the integration test
(``test_hook_forwarder_integration.py``) where a real FastAPI app
stands in for the dashboard.  Unit tests here focus on the
registry-side behaviors that don't need an HTTP server.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from gateway import hook_forwarder
from gateway.hooks import HookRegistry


@pytest.fixture(autouse=True)
def _clean_forwarder():
    """Reset forwarder state + env between tests so they're independent."""
    hook_forwarder._reset_for_tests()
    # Make sure HERMES_HOOK_FORWARDER isn't sticky from a previous test.
    saved = os.environ.pop("HERMES_HOOK_FORWARDER", None)
    yield
    hook_forwarder._reset_for_tests()
    if saved is not None:
        os.environ["HERMES_HOOK_FORWARDER"] = saved


def _write_discovery(tmp_path: Path, *, url: str = "http://127.0.0.1:9119") -> Path:
    """Write a valid dashboard.json into tmp_path and return its path."""
    discovery = tmp_path / "dashboard.json"
    discovery.write_text(
        json.dumps(
            {
                "url": url,
                "hooks_ingest_token": "test-token-abc",
                "pid": 99999,
                "started_at": "2026-05-29T12:00:00Z",
            }
        )
    )
    return discovery


# ---------------------------------------------------------------------------
# No-op paths
# ---------------------------------------------------------------------------


class TestStartIfDashboardAvailable:
    def test_no_dashboard_json_returns_none(self, tmp_path, monkeypatch):
        """Missing discovery file ⇒ forwarder doesn't start."""
        monkeypatch.setattr(hook_forwarder, "get_hermes_home", lambda: tmp_path)
        reg = HookRegistry()

        result = hook_forwarder.start_if_dashboard_available(reg, src="gateway")

        assert result is None
        assert not hook_forwarder.is_active()
        # No handlers registered on the registry.
        assert reg._handlers == {}

    def test_env_disabled_returns_none_even_with_dashboard(
        self, tmp_path, monkeypatch
    ):
        """``HERMES_HOOK_FORWARDER=0`` short-circuits even when discovery
        is otherwise valid."""
        monkeypatch.setattr(hook_forwarder, "get_hermes_home", lambda: tmp_path)
        _write_discovery(tmp_path)
        monkeypatch.setenv("HERMES_HOOK_FORWARDER", "0")
        reg = HookRegistry()

        result = hook_forwarder.start_if_dashboard_available(reg, src="gateway")

        assert result is None
        assert reg._handlers == {}

    @pytest.mark.parametrize("value", ["0", "false", "FALSE", "No", "off"])
    def test_env_disabled_accepts_common_falsy_values(
        self, tmp_path, monkeypatch, value
    ):
        monkeypatch.setattr(hook_forwarder, "get_hermes_home", lambda: tmp_path)
        _write_discovery(tmp_path)
        monkeypatch.setenv("HERMES_HOOK_FORWARDER", value)
        reg = HookRegistry()

        assert hook_forwarder.start_if_dashboard_available(reg, src="gateway") is None

    def test_malformed_discovery_json_returns_none(self, tmp_path, monkeypatch):
        """Garbage in ``dashboard.json`` ⇒ forwarder doesn't start."""
        monkeypatch.setattr(hook_forwarder, "get_hermes_home", lambda: tmp_path)
        (tmp_path / "dashboard.json").write_text("{not json")
        reg = HookRegistry()

        assert hook_forwarder.start_if_dashboard_available(reg, src="gateway") is None

    def test_discovery_missing_required_keys_returns_none(
        self, tmp_path, monkeypatch
    ):
        """``dashboard.json`` without ``url`` or ``hooks_ingest_token`` ⇒
        no forwarder."""
        monkeypatch.setattr(hook_forwarder, "get_hermes_home", lambda: tmp_path)
        (tmp_path / "dashboard.json").write_text(
            json.dumps({"pid": 123})  # missing url + token
        )
        reg = HookRegistry()

        assert hook_forwarder.start_if_dashboard_available(reg, src="gateway") is None

    def test_repeated_calls_are_idempotent(self, tmp_path, monkeypatch):
        """Two ``start_if_dashboard_available`` in the same process re-use
        the same forwarder instance and don't double-register handlers."""
        monkeypatch.setattr(hook_forwarder, "get_hermes_home", lambda: tmp_path)
        _write_discovery(tmp_path)
        reg = HookRegistry()

        first = hook_forwarder.start_if_dashboard_available(reg, src="gateway")
        try:
            second = hook_forwarder.start_if_dashboard_available(reg, src="tui")

            assert first is not None
            assert second is first  # same instance
            # And handlers registered exactly once per namespace.
            for pattern in hook_forwarder._FORWARDED_NAMESPACES:
                assert len(reg._handlers[pattern]) == 1
        finally:
            hook_forwarder.stop()


# ---------------------------------------------------------------------------
# Registration coverage
# ---------------------------------------------------------------------------


class TestRegistration:
    def test_registers_every_forwarded_namespace(self, tmp_path, monkeypatch):
        """Forwarder subscribes to all five canonical namespaces."""
        monkeypatch.setattr(hook_forwarder, "get_hermes_home", lambda: tmp_path)
        _write_discovery(tmp_path)
        reg = HookRegistry()

        try:
            hook_forwarder.start_if_dashboard_available(reg, src="gateway")
            for pattern in (
                "tui:*",
                "agent:*",
                "session:*",
                "command:*",
                "gateway:*",
            ):
                assert pattern in reg._handlers
                assert len(reg._handlers[pattern]) == 1
        finally:
            hook_forwarder.stop()

    def test_stop_unregisters_all_handlers(self, tmp_path, monkeypatch):
        """``stop()`` removes every handler the forwarder installed."""
        monkeypatch.setattr(hook_forwarder, "get_hermes_home", lambda: tmp_path)
        _write_discovery(tmp_path)
        reg = HookRegistry()

        hook_forwarder.start_if_dashboard_available(reg, src="gateway")
        for pattern in hook_forwarder._FORWARDED_NAMESPACES:
            assert pattern in reg._handlers

        hook_forwarder.stop()
        for pattern in hook_forwarder._FORWARDED_NAMESPACES:
            assert reg._handlers.get(pattern, []) == []

    def test_stop_is_idempotent(self, tmp_path, monkeypatch):
        """Calling ``stop()`` twice doesn't raise."""
        monkeypatch.setattr(hook_forwarder, "get_hermes_home", lambda: tmp_path)
        _write_discovery(tmp_path)
        reg = HookRegistry()

        hook_forwarder.start_if_dashboard_available(reg, src="gateway")
        hook_forwarder.stop()
        hook_forwarder.stop()  # second call is no-op


# ---------------------------------------------------------------------------
# Handler behavior — loop prevention + queue management
# ---------------------------------------------------------------------------


class TestHandlerBehavior:
    """Tests the handler in isolation — skipping the worker thread by
    constructing the ``_HookForwarder`` directly so we can inspect the
    queue without racing on a daemon thread."""

    def test_handler_enqueues_event(self):
        fwd = hook_forwarder._HookForwarder(src="gateway")
        fwd._handler("agent:start", {"platform": "telegram", "user_id": "u-1"})

        assert fwd._queue.qsize() == 1
        frame = fwd._queue.get_nowait()
        assert frame == {
            "event_type": "agent:start",
            "context": {"platform": "telegram", "user_id": "u-1"},
            "src": "gateway",
        }

    def test_handler_skips_forwarded_events(self):
        """The ``_forwarded=True`` flag closes the source ↔ dashboard loop."""
        fwd = hook_forwarder._HookForwarder(src="gateway")

        # This came from the ingest endpoint; must not be shipped back.
        fwd._handler(
            "agent:start",
            {"platform": "telegram", "_forwarded": True, "_forwarded_from": "gateway"},
        )

        assert fwd._queue.qsize() == 0

    def test_handler_does_not_skip_explicit_false_forwarded(self):
        """Only the literal ``True`` triggers loop prevention; a ``False``
        or absent flag is fine."""
        fwd = hook_forwarder._HookForwarder(src="gateway")

        fwd._handler("agent:start", {"_forwarded": False})
        fwd._handler("agent:start", {"_forwarded": None})

        assert fwd._queue.qsize() == 2

    def test_handler_drops_oldest_on_queue_full(self):
        """At ``_QUEUE_MAX`` capacity, oldest frame is evicted to make
        room for newest."""
        fwd = hook_forwarder._HookForwarder(src="gateway")
        # Replace the queue with a tiny one so we can exercise overflow
        # without filling 1024 slots.
        from queue import Queue as _Queue

        fwd._queue = _Queue(maxsize=3)

        for i in range(5):
            fwd._handler("agent:step", {"iteration": i})

        # Only the last 3 should survive (iterations 2, 3, 4).
        iterations = []
        while not fwd._queue.empty():
            iterations.append(fwd._queue.get_nowait()["context"]["iteration"])
        assert iterations == [2, 3, 4]

    def test_handler_never_raises_on_pathological_queue(self):
        """Even if the queue is wedged (both put_nowait calls fail), the
        handler returns cleanly — never propagates to the publisher."""
        fwd = hook_forwarder._HookForwarder(src="gateway")
        from queue import Queue as _Queue, Full as _Full

        # Build a queue stub whose put_nowait always raises Full.
        class _StubbedFull(_Queue):
            def __init__(self):
                super().__init__(maxsize=1)

            def put_nowait(self, item):
                raise _Full()

            def get_nowait(self):
                from queue import Empty
                raise Empty()

        fwd._queue = _StubbedFull()  # type: ignore[assignment]

        # Should not raise.
        fwd._handler("agent:step", {"iteration": 1})


# ---------------------------------------------------------------------------
# Discovery refresh / probe behavior — exercised without starting the worker
# ---------------------------------------------------------------------------


class TestDiscoveryRefresh:
    def test_refresh_picks_up_new_token(self, tmp_path, monkeypatch):
        """A dashboard restart writes a new token; the next probe must
        pick it up."""
        monkeypatch.setattr(hook_forwarder, "get_hermes_home", lambda: tmp_path)
        discovery_path = tmp_path / "dashboard.json"
        discovery_path.write_text(
            json.dumps({"url": "http://127.0.0.1:9119", "hooks_ingest_token": "first"})
        )

        fwd = hook_forwarder._HookForwarder(src="gateway")

        # Stub the http client's get() to always return 200 — the
        # discovery file is what we want to test here, not the probe.
        class _Stub200:
            status_code = 200

        class _StubClient:
            def get(self, *a, **kw):
                return _Stub200()

        fwd._refresh_discovery(_StubClient())
        assert fwd._discovery is not None
        assert fwd._discovery["hooks_ingest_token"] == "first"

        # Now the dashboard "restarts" with a new token.
        discovery_path.write_text(
            json.dumps({"url": "http://127.0.0.1:9119", "hooks_ingest_token": "second"})
        )
        fwd._refresh_discovery(_StubClient())
        assert fwd._discovery["hooks_ingest_token"] == "second"

    def test_refresh_invalidates_on_probe_failure(self, tmp_path, monkeypatch):
        """If the health probe fails, discovery is cleared even though
        the file still exists."""
        monkeypatch.setattr(hook_forwarder, "get_hermes_home", lambda: tmp_path)
        _write_discovery(tmp_path)

        fwd = hook_forwarder._HookForwarder(src="gateway")
        # First probe succeeds.
        class _Stub200:
            status_code = 200

        class _OkClient:
            def get(self, *a, **kw):
                return _Stub200()

        fwd._refresh_discovery(_OkClient())
        assert fwd._discovery is not None

        # Now make the probe fail — connection refused, dashboard gone.
        class _FailingClient:
            def get(self, *a, **kw):
                raise ConnectionError("refused")

        fwd._refresh_discovery(_FailingClient())
        assert fwd._discovery is None

    def test_refresh_invalidates_on_non_200_response(self, tmp_path, monkeypatch):
        monkeypatch.setattr(hook_forwarder, "get_hermes_home", lambda: tmp_path)
        _write_discovery(tmp_path)

        fwd = hook_forwarder._HookForwarder(src="gateway")

        class _Stub503:
            status_code = 503

        class _BadClient:
            def get(self, *a, **kw):
                return _Stub503()

        fwd._refresh_discovery(_BadClient())
        assert fwd._discovery is None


# ---------------------------------------------------------------------------
# Error-log rate limiting
# ---------------------------------------------------------------------------


class TestErrorRateLimit:
    def test_first_error_logs_immediately(self, caplog):
        fwd = hook_forwarder._HookForwarder(src="gateway")
        caplog.set_level("WARNING", logger="gateway.hook_forwarder")
        fwd._log_error("first error")

        assert any("first error" in r.message for r in caplog.records)

    def test_subsequent_errors_suppressed_until_window_elapses(self, caplog):
        fwd = hook_forwarder._HookForwarder(src="gateway")
        caplog.set_level("WARNING", logger="gateway.hook_forwarder")

        fwd._log_error("first error")
        before = len(caplog.records)

        # Many follow-up errors within the same minute — all suppressed.
        for _ in range(10):
            fwd._log_error("nth error")

        assert len(caplog.records) == before

    def test_suppression_count_surfaces_on_next_log(self, caplog, monkeypatch):
        fwd = hook_forwarder._HookForwarder(src="gateway")
        caplog.set_level("WARNING", logger="gateway.hook_forwarder")

        fwd._log_error("first error")
        for _ in range(5):
            fwd._log_error("suppressed")

        # Simulate the rate-limit window elapsing.
        fwd._last_error_log_at = time.monotonic() - hook_forwarder._ERROR_LOG_INTERVAL_S - 1
        fwd._log_error("after window")

        # Last record should include the "5 similar errors suppressed" suffix.
        last = caplog.records[-1].message
        assert "after window" in last
        assert "5 similar errors suppressed" in last
