"""Regression tests for _next_run_sleep_seconds busy-spin floor (salvaged #39244).

The cron ticker shortens its sleep based on the .next_run hint. A past-due
hint (e.g. a paused-but-enabled job whose next_run_at is in the past) must
NOT yield a 0-second sleep — that tight-loops the ticker at 100% CPU. The
floor is 1 second.
"""

from datetime import datetime, timedelta, timezone

import pytest

import gateway.run as gw


@pytest.fixture
def hint(tmp_path, monkeypatch):
    home = tmp_path
    (home / "cron").mkdir()
    monkeypatch.setattr(gw, "get_hermes_home", lambda: home)

    def write(dt):
        (home / "cron" / ".next_run").write_text(dt.isoformat(), encoding="utf-8")

    return write


def test_past_due_hint_floors_to_one_second(hint):
    """A hint in the past must return 1, never 0 (no busy-spin)."""
    hint(datetime.now(timezone.utc) - timedelta(minutes=5))
    assert gw._next_run_sleep_seconds(60) == 1


def test_imminent_hint_floors_to_one_second(hint):
    """A sub-second-away hint still returns at least 1."""
    hint(datetime.now(timezone.utc) + timedelta(milliseconds=200))
    assert gw._next_run_sleep_seconds(60) >= 1


def test_soon_hint_shortens_sleep(hint):
    """A hint ~10s out yields a short sleep, capped below interval."""
    hint(datetime.now(timezone.utc) + timedelta(seconds=10))
    s = gw._next_run_sleep_seconds(60)
    assert 1 <= s <= 12


def test_far_hint_caps_at_interval(hint):
    """A hint far out is capped at the normal interval."""
    hint(datetime.now(timezone.utc) + timedelta(hours=2))
    assert gw._next_run_sleep_seconds(60) == 60


def test_missing_hint_returns_interval(tmp_path, monkeypatch):
    monkeypatch.setattr(gw, "get_hermes_home", lambda: tmp_path)
    (tmp_path / "cron").mkdir()
    assert gw._next_run_sleep_seconds(60) == 60
