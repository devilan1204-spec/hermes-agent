"""
Hermes Agent — process-local pub/sub event bus.

Plugins and core components can publish events on a shared in-process bus and
subscribe to topic patterns. Sources publish; subscribers listen; neither knows
about the other.

EXPERIMENTAL — topic names and payload shapes are explicitly prone to change
until we publish a v1.0 schema. See ``docs/events.md`` for the current taxonomy
and the breakage notice. Third-party plugins are welcome to subscribe today,
but should expect to update their topic globs over the next few releases.

Basic usage
-----------

::

    from hermes_events import publish, subscribe, unsubscribe

    # Sources publish — always sync, even from inside async contexts.
    publish("tui.tool.start", {"name": "web_search", "session_id": "abc"})

    # Subscribers register glob patterns. ``*`` matches one topic segment;
    # ``**`` matches any number of segments.
    handle = subscribe("tui.tool.*", on_tool_event)   # tui.tool.start/.complete/...
    handle = subscribe("tui.**",     on_any_tui)      # any tui.* topic
    handle = subscribe("**",         everything)
    unsubscribe(handle)

Envelope
--------

Every published payload is wrapped in a minimal envelope before being delivered
to subscribers:

::

    {
        "type": "<topic>",           # always the topic the publisher used
        "ts":   <unix-seconds-float>, # auto-stamped if missing
        "src":  "<first-topic-segment>",  # auto-stamped if missing
        ...source-specific fields, freely evolving in the experimental phase
    }

Publishers that are *relaying* events from another process should pre-populate
``ts`` and ``src`` so the original values are preserved (the bus only fills in
missing keys; it never overwrites them).

Async semantics
---------------

``publish()`` is synchronous. Sync subscribers fire immediately in the
publisher's stack. Async subscribers are scheduled via
``asyncio.create_task()`` when a running event loop is detected. When no loop
is running (unit tests outside of an async test, startup-before-loop), async
subscribers are dropped for that emit with a single warning log line — sync
subscribers still fire normally.

This means async publishers (e.g. ``gateway.hooks.HookRegistry.emit()``) just
call sync ``publish()`` from inside their coroutine — no ``await`` needed.

Exceptions in subscribers are logged but never raised back to the publisher.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import threading
import time
from collections.abc import Awaitable, Callable
from typing import Any

logger = logging.getLogger(__name__)


# A subscriber callback. Receives the envelope dict and may return either
# ``None`` (sync) or an awaitable (async).
SubscriberCallback = Callable[[dict], "Awaitable[None] | None"]


class _Subscription:
    """Internal record of one subscription. Returned (opaque) to callers as
    the handle for ``unsubscribe()``.
    """

    __slots__ = ("pattern", "segments", "callback", "is_async")

    def __init__(self, pattern: str, callback: SubscriberCallback) -> None:
        self.pattern = pattern
        self.segments = pattern.split(".")
        self.callback = callback
        # ``iscoroutinefunction`` doesn't catch partials, bound methods of
        # async functions in all cases, or callable objects with an async
        # ``__call__``. ``inspect.iscoroutinefunction`` handles the common
        # cases; we also probe by calling and inspecting if a callable
        # object's __call__ is async-tagged. Keep this conservative — a
        # false-negative just runs an async subscriber synchronously and
        # discards the coroutine (with a warning), which is recoverable;
        # a false-positive schedules a sync function as a task, which
        # would explode in create_task().
        self.is_async = inspect.iscoroutinefunction(callback) or inspect.iscoroutinefunction(
            getattr(callback, "__call__", None)
        )


# Module-level state. The bus is a process-local singleton — we deliberately
# don't expose a class or constructor to avoid the "which bus is this?"
# confusion. Inside one Python process, there is exactly one bus.
_subscriptions: list[_Subscription] = []
_lock = threading.RLock()


def _matches(topic_segments: list[str], pattern_segments: list[str]) -> bool:
    """Glob-match a topic against a pattern.

    ``*`` matches exactly one segment. ``**`` matches zero or more segments.
    Anywhere a literal segment appears in the pattern, the topic must match
    exactly at that position.

    Recursive implementation; patterns are short (typically 1-3 segments).
    """
    # ``ti`` indexes into topic; ``pi`` indexes into pattern.
    def _rec(ti: int, pi: int) -> bool:
        # Both exhausted simultaneously → match.
        if pi == len(pattern_segments):
            return ti == len(topic_segments)

        seg = pattern_segments[pi]

        if seg == "**":
            # Greedy: try consuming 0..N topic segments.
            # First, try matching with ``**`` consuming zero topic segments.
            if _rec(ti, pi + 1):
                return True
            # Then try consuming one more topic segment and recurse on the
            # same ``**`` position.
            if ti < len(topic_segments) and _rec(ti + 1, pi):
                return True
            return False

        if ti == len(topic_segments):
            # Pattern still has segments to consume but topic is exhausted.
            return False

        if seg == "*" or seg == topic_segments[ti]:
            return _rec(ti + 1, pi + 1)

        return False

    return _rec(0, 0)


def subscribe(pattern: str, callback: SubscriberCallback) -> _Subscription:
    """Subscribe a callback to a topic glob pattern.

    Returns a subscription handle. Pass it to :func:`unsubscribe` to remove.

    The same callback may subscribe to the same pattern more than once; each
    call returns a distinct handle. The bus does not deduplicate.
    """
    if not pattern:
        raise ValueError("subscribe pattern must be a non-empty string")

    sub = _Subscription(pattern, callback)
    with _lock:
        _subscriptions.append(sub)
    return sub


def unsubscribe(handle: _Subscription) -> bool:
    """Remove a subscription. Returns True if the handle was found, False
    otherwise (idempotent — unsubscribing a removed handle is not an error).
    """
    with _lock:
        try:
            _subscriptions.remove(handle)
            return True
        except ValueError:
            return False


def publish(topic: str, payload: dict | None = None) -> None:
    """Publish an event on a topic.

    ``topic`` is a ``.``-segmented string (e.g. ``"tui.tool.start"``).
    ``payload`` is a dict of source-specific fields; the bus wraps it with the
    minimal envelope (``type``, ``ts``, ``src``) before delivery.

    Publishers that are relaying events from another process may pre-populate
    ``ts`` and/or ``src`` in the payload to preserve the originating values;
    the bus only fills in missing keys.

    This call always returns synchronously. Sync subscribers fire immediately;
    async subscribers are scheduled via ``asyncio.create_task()`` when a
    running loop is available. If no loop is running, async subscribers are
    dropped with a single warning log line per emit.
    """
    if not topic:
        raise ValueError("publish topic must be a non-empty string")

    # Build the delivered envelope. We do this once and share the dict across
    # all subscribers — subscribers that mutate it are misusing the API, but
    # we can't realistically guard against that without copying for every
    # delivery (which would balloon cost for the ``**`` firehose case).
    envelope = dict(payload) if payload else {}
    envelope.setdefault("type", topic)
    envelope.setdefault("ts", time.time())
    envelope.setdefault("src", topic.split(".", 1)[0])

    topic_segments = topic.split(".")

    # Snapshot subscribers under the lock, then release before invoking
    # callbacks — a subscriber that calls publish() or subscribe() from
    # inside its callback must not deadlock on a sync callback.
    with _lock:
        matches = [
            sub
            for sub in _subscriptions
            if _matches(topic_segments, sub.segments)
        ]

    if not matches:
        return

    # Probe for a running event loop ONCE per publish call, not per
    # subscriber. ``get_running_loop()`` only succeeds if we're being called
    # from inside a coroutine or task; otherwise it raises ``RuntimeError``.
    try:
        loop: asyncio.AbstractEventLoop | None = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    dropped_async = 0

    for sub in matches:
        try:
            if sub.is_async:
                if loop is None:
                    dropped_async += 1
                    continue
                # Invoke the coroutine factory to get a coroutine, then schedule
                # it on the running loop. The task object is intentionally not
                # awaited — the bus is fire-and-forget.
                coro = sub.callback(envelope)
                if inspect.iscoroutine(coro):
                    loop.create_task(coro)
            else:
                result = sub.callback(envelope)
                # A sync subscriber that accidentally returns a coroutine
                # (e.g. someone changed sync→async without updating the
                # registration) would leak the coroutine. Warn and discard.
                if inspect.iscoroutine(result):
                    logger.warning(
                        "hermes_events: subscriber for %r returned a coroutine "
                        "but was not registered as async; coroutine dropped",
                        sub.pattern,
                    )
                    result.close()
        except Exception:
            # Subscriber exceptions are logged but never propagated. One
            # bad subscriber must not break the publisher's main path or
            # starve the rest of the subscribers on this emit.
            logger.exception(
                "hermes_events: subscriber for pattern %r raised on topic %r",
                sub.pattern,
                topic,
            )

    if dropped_async:
        logger.warning(
            "hermes_events: dropped %d async subscriber(s) on topic %r "
            "(no running asyncio loop)",
            dropped_async,
            topic,
        )


# -----------------------------------------------------------------------------
# Testing aids — not part of the documented public API.
# -----------------------------------------------------------------------------


def _reset_for_tests() -> None:
    """Clear all subscriptions. For unit tests only — must NOT be called from
    production code or third-party plugins."""
    with _lock:
        _subscriptions.clear()


def _subscriber_count() -> int:
    """Return the current subscriber count. For unit tests only."""
    with _lock:
        return len(_subscriptions)


__all__ = ["publish", "subscribe", "unsubscribe"]
