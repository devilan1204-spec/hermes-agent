# Hermes Events Bus

> ⚠️ **EXPERIMENTAL.** Topic names and payload shapes in this document are
> explicitly prone to change. The bus is shipped now so plugin authors can
> start consuming it, but you should expect to update your topic globs and
> payload-field accesses over the next few releases. We will declare a
> stable v1.0 schema once the orb (and at least one more consumer) have
> shaken out the design — at that point we'll add a proper deprecation
> policy. Until then, breakage is on the menu.

`hermes_events` is the in-process pub/sub bus that lets core components
(the embedded TUI, the gateway, the agent loop, the cron scheduler, ...)
broadcast lifecycle events that plugins (and other core components) can
subscribe to. It is the substrate that drives the orb's `SceneState`
machine and is intended to be the substrate that drives any future
"what is Hermes doing right now" widget, observability shipper, or
debug-tap plugin.

## API surface

```python
from hermes_events import publish, subscribe, unsubscribe

# Sources publish — always sync, even from inside async contexts.
publish("tui.tool.start", {"name": "web_search", "session_id": "abc"})
publish("gateway.agent.start", {"platform": "telegram", "session_id": "xyz"})

# Plugins subscribe with glob patterns.
handle = subscribe("tui.tool.*", on_tool_event)         # one segment after tool.
handle = subscribe("gateway.agent.*", on_agent_event)
handle = subscribe("tui.**", any_tui_topic)              # any number of segments
handle = subscribe("**", on_anything)                    # firehose
unsubscribe(handle)
```

- Topics are `.`-segmented.
- Pattern globs: `*` matches one segment; `**` matches zero or more segments.
- `publish()` is **synchronous**. Async publishers (`async def emit(): ...`)
  just call sync `publish()` from inside their coroutine — no `await` needed.
- Subscribers may be sync or async. Sync subscribers fire immediately in the
  publisher's stack. Async subscribers are scheduled via
  `asyncio.create_task()` if a running event loop is detected. **If no loop
  is running** (unit tests outside `pytest-asyncio`, startup-before-loop),
  async subscribers are dropped for that emit with a warning log line; sync
  subscribers still fire.
- Subscriber exceptions are logged but never raised back to the publisher.

## Envelope

Every published payload is wrapped before delivery:

```python
{
    "type": "tui.tool.start",   # always the topic the publisher used
    "ts":   1716938400.123,      # unix seconds (float)
    "src":  "tui",               # first dot-segment of `type`
    # ...source-specific fields, freely evolving during the experimental phase
}
```

`type`, `ts`, and `src` are always present. The bus auto-stamps `ts` (current
`time.time()`) and `src` (first segment of the topic) only if the publisher
omits them. **Relayed events** (e.g. the dashboard receiving a frame from a
remote gateway process) should pre-populate `ts` and `src` so the originating
values are preserved — the bus does not overwrite existing keys.

## Current topic taxonomy

All topic names below are **experimental**. Plugins should subscribe to
the most general pattern that meets their needs and tolerate the addition
of new sibling topics over time.

### `tui.*` — emitted by the dashboard's TUI sidecar

| Topic | When it fires |
|---|---|
| `tui.message.start` | The model begins emitting a new assistant message. |
| `tui.message.delta` | A streaming-token chunk of the current assistant message. |
| `tui.message.complete` | The assistant message has finished streaming. |
| `tui.tool.start` | A tool call has begun execution. |
| `tui.tool.progress` | A long-running tool reports incremental output. |
| `tui.tool.complete` | A tool call finished (success or failure). |
| `tui.tool.generating` | The model is mid-stream of constructing a tool call's arguments. |
| `tui.reasoning.delta` | A streaming-token chunk of the model's reasoning content. |
| `tui.reasoning.available` | A full reasoning block became available (non-streaming case). |
| `tui.error` | An error frame propagated through the TUI. |

Common payload fields (best-effort, not guaranteed):
- `session_id` (str) — TUI session this event belongs to.
- `name` (str) — for tool events, the tool's name.
- `preview` (str) — for tool events, a short preview of args or output.

### `gateway.*` — emitted by the messaging gateway

| Topic | When it fires |
|---|---|
| `gateway.startup` | The gateway process has finished initializing. |
| `gateway.agent.start` | The agent has begun processing a user message. |
| `gateway.agent.step` | Each iteration of the agent's tool-calling loop. |
| `gateway.agent.end` | The agent has finished processing a user message. |
| `gateway.session.start` | A new session was created (first message of a new session). |
| `gateway.session.end` | A session ended (user ran `/new` or `/reset`). |
| `gateway.session.reset` | A session reset completed; a new session entry was created. |
| `gateway.command.<name>` | Any slash command was executed. Wildcard-friendly via `gateway.command.*`. |

Common payload fields:
- `platform` (str) — `"telegram"`, `"discord"`, `"slack"`, etc.
- `session_id` (str) — the gateway session this event belongs to.

### Future namespaces

Topics under namespaces we haven't shipped yet are reserved. If you see
events fire under a namespace not listed here, that's a leak from in-flight
work — please don't subscribe to it; the topic may be renamed or removed
before the next release.

## Cross-process delivery

Each process has its own bus instance. Bridges ship events between
processes:

- **TUI sidecar → dashboard:** the sidecar runs as a PTY-spawned subprocess
  of the dashboard. A default `subscribe("**", ship_via_pub_ws)` on the TUI
  side forwards every event to the dashboard via the `/api/pub` WebSocket,
  which re-publishes them onto the dashboard's local bus.
- **Gateway → dashboard:** the gateway process opens a WebSocket to the
  dashboard at startup and ships its events the same way. If the dashboard
  is offline, the bridge silently no-ops; gateway runs are never blocked.
- **Same-process publishers** (e.g. an embedded gateway in the dashboard
  process) hit the local bus directly — no bridge involved.

This means a plugin's `plugin_api.py` running in the dashboard process
sees events from all three sources via a single `subscribe(...)` call.
Subscription patterns do not change based on where events originated.

## For plugin authors

A typical plugin backend wires up subscriptions in its `register()` (or
at import time, since `plugin_api.py` is imported once at dashboard
startup):

```python
from fastapi import APIRouter
from hermes_events import subscribe

router = APIRouter()

def _on_tool_event(envelope: dict) -> None:
    # Process the envelope, push to your WebSocket subscribers, etc.
    ...

subscribe("tui.tool.*", _on_tool_event)
subscribe("gateway.agent.*", _on_tool_event)
```

If you need to subscribe asynchronously (e.g. to drive a per-subscriber
`asyncio.Queue` in a long-lived FastAPI WebSocket handler), register an
`async def` callback — the bus will `asyncio.create_task()` it inside the
dashboard's running event loop.

For a fully-worked example, see `plugins/orb/dashboard/plugin_api.py`.

## Stability declaration

Until further notice (read: until a `docs/events-v1.md` lands and this
file is renamed to `docs/events-experimental.md`), assume any topic name
or payload field may be renamed, removed, or split into multiple events
in any release.

The **shape of the bus itself** (the `publish` / `subscribe` /
`unsubscribe` Python API, the envelope auto-stamping rule, the glob
pattern syntax) is more stable — we intend to preserve it through v1.0.
But the **content** flowing through it is the experimental part.
