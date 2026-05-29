"""End-to-end integration test for cross-process hook delivery.

Wires together (in the SAME process to avoid subprocess complexity, but
end-to-end through real HTTP + a real FastAPI app):

    Source HookRegistry ──forwarder──HTTP──> /api/hooks/ingest ──> Dashboard HookRegistry
                                                                            │
                                                                            └─> handler fires

This validates the wire-format contract between the forwarder and the
ingest endpoint: anything the forwarder produces must be accepted and
republished correctly by the ingest endpoint.

The test runs uvicorn in a daemon thread so we have a real OS socket
forwarders can POST to.  ``dashboard.json`` is written into a temp
$HERMES_HOME so the forwarder finds the test server instead of any
real running dashboard on the dev box.
"""

from __future__ import annotations

import json
import socket
import threading
import time
from pathlib import Path
from typing import Callable

import pytest
import uvicorn
from fastapi import FastAPI

from gateway import hook_forwarder
from gateway.hooks import (
    HookRegistry,
    _reset_default_registry_for_tests,
    install_as_default,
)
from hermes_cli import hook_ingest


def _free_port() -> int:
    """Find an unused TCP port on loopback by binding port 0."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_until(predicate: Callable[[], bool], *, timeout: float = 5.0) -> bool:
    """Poll a predicate until it returns True or the timeout elapses.

    Cheaper than ``time.sleep`` calls littered through the test body;
    keeps test runtime down when the system is fast and bounded when
    it's slow.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


@pytest.fixture
def hermes_home(tmp_path, monkeypatch):
    """Each test gets a fresh $HERMES_HOME so ``dashboard.json`` writes
    don't bleed across tests (or into the real dev box's home)."""
    monkeypatch.setattr(hook_ingest, "get_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(hook_forwarder, "get_hermes_home", lambda: tmp_path)
    hook_ingest._reset_for_tests()
    hook_forwarder._reset_for_tests()
    yield tmp_path
    hook_ingest._reset_for_tests()
    hook_forwarder._reset_for_tests()


@pytest.fixture
def dashboard_server(hermes_home):
    """Start a real uvicorn server with the hook router mounted, write a
    matching ``dashboard.json``, and tear it all down on test exit."""
    # Build the dashboard's FastAPI app.  Just the hook router — no need
    # to load the full web_server which would pull in the SPA build,
    # auth providers, etc.
    app = FastAPI()
    app.include_router(hook_ingest.build_hook_router(), prefix="/api/hooks")

    # Install a fresh default registry on the (test) dashboard side.
    # This is what the ingest endpoint republishes events onto.
    _reset_default_registry_for_tests()
    dashboard_reg = HookRegistry()
    install_as_default(dashboard_reg)

    port = _free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)

    server_thread = threading.Thread(target=server.run, daemon=True)
    server_thread.start()

    # Wait for the server to start accepting connections.
    if not _wait_until(lambda: server.started, timeout=5.0):
        raise RuntimeError("uvicorn failed to start within 5s")

    # Drop the discovery file pointing at our test server.
    hook_ingest.write_dashboard_discovery_file("127.0.0.1", port)

    yield {"app": app, "port": port, "registry": dashboard_reg}

    # Teardown: gracefully shut down the server.
    server.should_exit = True
    server_thread.join(timeout=5.0)
    _reset_default_registry_for_tests()


# ---------------------------------------------------------------------------
# End-to-end: source → forwarder → HTTP → ingest → dashboard registry
# ---------------------------------------------------------------------------


def test_end_to_end_event_delivery(dashboard_server, hermes_home):
    """A single fired event in the source registry reaches a subscriber
    on the dashboard registry via real HTTP."""
    captured: list = []
    dashboard_server["registry"].register(
        "agent:start", lambda e, c: captured.append((e, c))
    )

    # Source-side registry — simulates the gateway process.
    source_reg = HookRegistry()
    hook_forwarder.start_if_dashboard_available(source_reg, src="gateway")

    try:
        source_reg.emit_sync(
            "agent:start",
            {"platform": "telegram", "user_id": "u-1", "session_id": "s-1"},
        )

        # Wait for the daemon worker thread to flush the queue + POST.
        assert _wait_until(lambda: len(captured) >= 1, timeout=10.0), (
            "Event never reached the dashboard subscriber"
        )

        event, ctx = captured[0]
        assert event == "agent:start"
        # Original context survived the round trip.
        assert ctx["platform"] == "telegram"
        assert ctx["user_id"] == "u-1"
        assert ctx["session_id"] == "s-1"
        # And the ingest endpoint stamped forwarding metadata.
        assert ctx["_forwarded"] is True
        assert ctx["_forwarded_from"] == "gateway"
    finally:
        hook_forwarder.stop()


def test_multiple_namespaces_round_trip(dashboard_server, hermes_home):
    """The forwarder covers every namespace the design promises."""
    captured: dict = {ns: [] for ns in ("tui:*", "agent:*", "session:*", "command:*")}
    for ns in captured:
        # Closure over ns — bind it as a default arg to avoid late binding.
        dashboard_server["registry"].register(
            ns, lambda e, _c, _ns=ns: captured[_ns].append(e)
        )

    source_reg = HookRegistry()
    hook_forwarder.start_if_dashboard_available(source_reg, src="gateway")

    try:
        # One event per namespace.
        source_reg.emit_sync("tui:tool.start", {"session_id": "s", "payload": {}})
        source_reg.emit_sync("agent:start", {"user_id": "u"})
        source_reg.emit_sync("session:reset", {"session_key": "k"})
        source_reg.emit_sync("command:reset", {"command": "reset"})

        assert _wait_until(
            lambda: all(len(v) >= 1 for v in captured.values()),
            timeout=10.0,
        ), f"Some events missing: {captured}"

        assert captured["tui:*"] == ["tui:tool.start"]
        assert captured["agent:*"] == ["agent:start"]
        assert captured["session:*"] == ["session:reset"]
        assert captured["command:*"] == ["command:reset"]
    finally:
        hook_forwarder.stop()


def test_loop_prevention_forwarded_events_not_reshipped(dashboard_server, hermes_home):
    """An event whose context already has ``_forwarded=True`` is NOT
    shipped by the source-side forwarder.

    This is what closes the loop: dashboard republishes an event into
    its own registry with ``_forwarded=True``, and if a forwarder were
    also running in that process (it isn't, by design — but defense in
    depth) it would skip the event instead of round-tripping it back.
    """
    # Counter on the dashboard side — bumps every time the ingest
    # endpoint fires the agent:start handler.
    ingest_hits: list = []
    dashboard_server["registry"].register(
        "agent:start", lambda _e, _c: ingest_hits.append(1)
    )

    source_reg = HookRegistry()
    hook_forwarder.start_if_dashboard_available(source_reg, src="gateway")

    try:
        # Fire an event that's already marked as forwarded — simulates
        # an event that came back to the source process somehow.  The
        # forwarder must skip it (no POST to /ingest).
        source_reg.emit_sync(
            "agent:start",
            {
                "platform": "telegram",
                "_forwarded": True,
                "_forwarded_from": "dashboard-echo",
            },
        )

        # Wait long enough that if a POST were going to happen, it
        # would have.  Then verify NO ingest hits occurred.
        time.sleep(0.3)
        assert ingest_hits == [], (
            f"Forwarder shipped a _forwarded=True event: {ingest_hits}"
        )
    finally:
        hook_forwarder.stop()


def test_forwarder_recovers_from_dashboard_restart(dashboard_server, hermes_home):
    """If the dashboard rotates its token (restart), the forwarder's
    next probe re-reads ``dashboard.json`` and picks up the new token.

    Unit-tested in detail in ``test_hook_forwarder.py::TestDiscoveryRefresh``.
    Here we pin the integration: after a token rotation + probe, events
    still land at the dashboard.
    """
    captured: list = []
    dashboard_server["registry"].register(
        "agent:start", lambda _e, c: captured.append(c)
    )

    source_reg = HookRegistry()
    hook_forwarder.start_if_dashboard_available(source_reg, src="gateway")

    try:
        # First event lands cleanly with the original token.
        source_reg.emit_sync("agent:start", {"seq": 1})
        assert _wait_until(lambda: len(captured) >= 1, timeout=5.0)
        assert captured[0]["seq"] == 1

        # Simulate dashboard restart: token rotates in dashboard.json
        # AND in the ingest endpoint's module state (we're sharing the
        # same hook_ingest module so write_dashboard_discovery_file
        # updates both).
        port = dashboard_server["port"]
        hook_ingest.write_dashboard_discovery_file("127.0.0.1", port)

        # Force a discovery refresh directly — simulates what the
        # forwarder's worker does on its 30s probe cycle.  Using the
        # active forwarder's HTTP client this way avoids a 30s
        # real-time wait.
        import httpx
        with httpx.Client(timeout=2.0) as client:
            fwd = hook_forwarder._active
            assert fwd is not None
            fwd._refresh_discovery(client)

        source_reg.emit_sync("agent:start", {"seq": 2})
        assert _wait_until(lambda: len(captured) >= 2, timeout=10.0)
        assert captured[1]["seq"] == 2
    finally:
        hook_forwarder.stop()


def test_no_dashboard_available_silent_noop(hermes_home):
    """When no dashboard is reachable (no discovery file), the forwarder
    is a complete no-op — no thread spawned, no handlers registered."""
    # Don't start the dashboard fixture — there's nothing to forward to.
    source_reg = HookRegistry()
    result = hook_forwarder.start_if_dashboard_available(source_reg, src="gateway")

    assert result is None
    assert source_reg._handlers == {}
    # And firing an event doesn't cause anything to happen.
    source_reg.emit_sync("agent:start", {})  # must not raise


def test_no_dashboard_then_dashboard_starts_later(hermes_home):
    """``start_if_dashboard_available`` is a one-shot check at call time.

    If no dashboard is running when the source process starts, the
    forwarder doesn't start.  Documented behavior: source-process
    consumers must call ``start_if_dashboard_available`` once at startup;
    if a dashboard appears later, only newly-started processes pick it
    up.  (A long-running process with no forwarder will never get one
    retroactively.)

    This test pins that contract so we notice if we accidentally add
    retry behavior — that would be a behavior change worth discussing,
    not a sneak in.
    """
    source_reg = HookRegistry()
    # First call: no dashboard yet.
    result = hook_forwarder.start_if_dashboard_available(source_reg, src="gateway")
    assert result is None

    # Dashboard appears.
    port = _free_port()
    hook_ingest.write_dashboard_discovery_file("127.0.0.1", port)

    # Calling again does start the forwarder now.  (The contract says
    # the wire-up sites only call once at startup, but the function
    # itself supports retries — useful for tests, and so callers can
    # call it from a post-config hook if they want.)
    result = hook_forwarder.start_if_dashboard_available(source_reg, src="gateway")
    assert result is not None

    hook_forwarder.stop()
