"""Integration test for the cross-process event bridge.

The dashboard process receives bus relay frames on ``/api/pub`` from two
sources:

  1. The TUI sidecar (legacy JSON-RPC ``{method: "event", params: {...}}``)
  2. The standalone gateway process (new ``{_bus_relay: true, topic, envelope}``)

This test exercises the dashboard-side ingestor (``_republish_pub_frame_to_bus``
in ``hermes_cli/web_server.py``) directly: we feed it synthetic frames in
both shapes and assert the local bus delivers them to subscribers with the
correct topics + envelopes.

We deliberately don't spawn a real subprocess. The wire format and the
ingestor logic are what matter; the WebSocket transport itself is exercised
by the production smoke test (Phase 17 manual smoke) and by upstream
``websockets`` library tests.
"""

from __future__ import annotations

import json
import logging

import pytest

import hermes_events
from hermes_cli.web_server import _republish_pub_frame_to_bus


@pytest.fixture(autouse=True)
def _reset_bus():
    hermes_events._reset_for_tests()
    yield
    hermes_events._reset_for_tests()


# ---------------------------------------------------------------------------
# Shape 2: bus relay (the gateway → dashboard path)
# ---------------------------------------------------------------------------


def test_bus_relay_frame_publishes_with_preserved_envelope():
    """A {_bus_relay: true, topic, envelope} frame is re-published verbatim,
    preserving the originating ts and src so subscribers see the gateway's
    original timestamp rather than a re-stamped one."""
    received: list[dict] = []
    hermes_events.subscribe("**", received.append)

    # Simulate a frame the gateway-side bridge would send: a
    # ``gateway.agent.start`` envelope it built ~5 seconds ago.
    gateway_envelope = {
        "type": "gateway.agent.start",
        "ts": 100.0,
        "src": "gateway",
        "platform": "telegram",
        "session_id": "abc-123",
    }
    frame = json.dumps(
        {
            "_bus_relay": True,
            "topic": "gateway.agent.start",
            "envelope": gateway_envelope,
        }
    )

    _republish_pub_frame_to_bus(frame)

    assert len(received) == 1
    env = received[0]
    assert env["type"] == "gateway.agent.start"
    assert env["ts"] == 100.0, "originating ts must be preserved, not re-stamped"
    assert env["src"] == "gateway", "originating src must be preserved"
    assert env["platform"] == "telegram"
    assert env["session_id"] == "abc-123"


def test_bus_relay_with_arbitrary_topic_passes_through():
    """The dashboard ingestor publishes whatever topic the gateway sent; it
    does not inspect or validate the topic namespace beyond shape."""
    received: list[str] = []
    hermes_events.subscribe("**", lambda env: received.append(env["type"]))

    frame = json.dumps(
        {
            "_bus_relay": True,
            "topic": "agent.iteration",
            "envelope": {"type": "agent.iteration", "ts": 1.0, "src": "agent", "n": 5},
        }
    )
    _republish_pub_frame_to_bus(frame)

    assert received == ["agent.iteration"]


# ---------------------------------------------------------------------------
# Shape 1: TUI sidecar JSON-RPC (the TUI → dashboard path)
# ---------------------------------------------------------------------------


def test_tui_jsonrpc_frame_publishes_as_tui_namespace():
    """A {jsonrpc, method:"event", params:{type, session_id, payload}} frame
    becomes a `tui.<type>` topic publish on the local bus."""
    received: list[dict] = []
    hermes_events.subscribe("tui.**", received.append)

    frame = json.dumps(
        {
            "jsonrpc": "2.0",
            "method": "event",
            "params": {
                "type": "tool.start",
                "session_id": "sess-1",
                "payload": {"name": "web_search", "preview": "foo bar"},
            },
        }
    )
    _republish_pub_frame_to_bus(frame)

    assert len(received) == 1
    env = received[0]
    assert env["type"] == "tui.tool.start"
    assert env["src"] == "tui"
    assert env["session_id"] == "sess-1"
    assert env["name"] == "web_search"
    assert env["preview"] == "foo bar"
    # ts is auto-stamped (TUI JSON-RPC frames don't carry one).
    assert isinstance(env["ts"], float)


def test_tui_jsonrpc_frame_without_payload_still_publishes():
    received: list[dict] = []
    hermes_events.subscribe("tui.**", received.append)

    frame = json.dumps(
        {
            "jsonrpc": "2.0",
            "method": "event",
            "params": {"type": "message.start", "session_id": "s1"},
        }
    )
    _republish_pub_frame_to_bus(frame)

    assert len(received) == 1
    assert received[0]["type"] == "tui.message.start"
    assert received[0]["session_id"] == "s1"


def test_tui_jsonrpc_frame_drops_silently_when_type_missing():
    received: list[dict] = []
    hermes_events.subscribe("**", received.append)

    frame = json.dumps(
        {
            "jsonrpc": "2.0",
            "method": "event",
            "params": {"session_id": "s1"},  # no `type` field
        }
    )
    _republish_pub_frame_to_bus(frame)

    assert received == []


# ---------------------------------------------------------------------------
# Malformed frames are best-effort (must not raise)
# ---------------------------------------------------------------------------


def test_invalid_json_is_silently_ignored():
    """A malformed frame must not raise — the production pub_ws handler
    relies on this so a single bad frame doesn't kill the WS receive loop."""
    received: list[dict] = []
    hermes_events.subscribe("**", received.append)

    _republish_pub_frame_to_bus("not json at all {{{")
    _republish_pub_frame_to_bus("")
    _republish_pub_frame_to_bus("[1, 2, 3]")  # array, not dict

    assert received == []


def test_unknown_frame_shape_is_silently_ignored():
    received: list[dict] = []
    hermes_events.subscribe("**", received.append)

    # Looks like JSON-RPC but method is not "event" — ignore.
    _republish_pub_frame_to_bus(json.dumps({"jsonrpc": "2.0", "method": "ping"}))
    # Looks like bus_relay but topic missing — ignore.
    _republish_pub_frame_to_bus(json.dumps({"_bus_relay": True, "envelope": {}}))
    # Neither shape — ignore.
    _republish_pub_frame_to_bus(json.dumps({"hello": "world"}))

    assert received == []


# ---------------------------------------------------------------------------
# Subscriber sees both sources via a single pattern
# ---------------------------------------------------------------------------


def test_plugin_can_subscribe_to_both_sources_with_one_pattern():
    """The point of the bridge: a plugin subscribing to e.g. `**` should see
    TUI events (auto-stamped) AND gateway events (preserved ts) interleaved
    via a single subscribe() call — no need for per-source plumbing."""
    received: list[tuple[str, float]] = []
    hermes_events.subscribe(
        "**", lambda env: received.append((env["type"], env["ts"]))
    )

    # Gateway-relayed event with preserved ts.
    _republish_pub_frame_to_bus(
        json.dumps(
            {
                "_bus_relay": True,
                "topic": "gateway.agent.start",
                "envelope": {"type": "gateway.agent.start", "ts": 100.0, "src": "gateway"},
            }
        )
    )
    # TUI event auto-stamped.
    _republish_pub_frame_to_bus(
        json.dumps(
            {
                "jsonrpc": "2.0",
                "method": "event",
                "params": {"type": "tool.start", "session_id": "s1"},
            }
        )
    )

    assert len(received) == 2
    topics = [t for t, _ in received]
    assert topics == ["gateway.agent.start", "tui.tool.start"]
    # Gateway ts preserved; TUI ts is auto-stamped (current time, > 100).
    assert received[0][1] == 100.0
    assert received[1][1] > 100.0


# ---------------------------------------------------------------------------
# The pub_ws's outer try/except catches our errors too
# ---------------------------------------------------------------------------


def test_subscriber_exception_does_not_propagate(caplog):
    """The bus already isolates subscriber exceptions; this confirms that
    when called from the ingestor, the exception is still contained."""

    def boom(env):
        raise RuntimeError("subscriber test failure")

    hermes_events.subscribe("**", boom)

    with caplog.at_level(logging.ERROR):
        # Must not raise.
        _republish_pub_frame_to_bus(
            json.dumps(
                {
                    "_bus_relay": True,
                    "topic": "any",
                    "envelope": {"type": "any", "ts": 1.0, "src": "test"},
                }
            )
        )
