"""Tests for the desktop remote self-update RPCs in tui_gateway.

``update.start`` spawns ``hermes update`` detached on the gateway's own host
(so a desktop window driving a REMOTE backend can update that box), and
``update.status`` reports progress via the namespaced ``.desktop_update_*``
marker files. See the /update desktop slash command + ``store/remote-update.ts``.
"""

from __future__ import annotations

import importlib
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture()
def hermes_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    yield home


@pytest.fixture()
def server(hermes_home):
    with patch.dict(
        "sys.modules",
        {
            "hermes_cli.env_loader": MagicMock(),
            "hermes_cli.banner": MagicMock(),
        },
    ):
        mod = importlib.import_module("tui_gateway.server")
        yield mod
        mod._methods.clear()
        importlib.reload(mod)


def _call(server, method, **params):
    return server._methods[method](1, params)


def test_status_is_idle_with_no_markers(server):
    result = _call(server, "update.status")["result"]
    assert result == {
        "running": False,
        "finished": False,
        "exit_code": None,
        "output": "",
    }


def test_status_reports_finished_with_exit_code(server):
    server._DESKTOP_UPDATE_OUTPUT.write_text("pulling…\nAlready up to date.")
    server._DESKTOP_UPDATE_EXIT_CODE.write_text("0")

    result = _call(server, "update.status")["result"]
    assert result["finished"] is True
    assert result["exit_code"] == 0
    assert result["running"] is False
    assert "up to date" in result["output"]


def test_status_running_when_pending_without_exit(server):
    server._DESKTOP_UPDATE_PENDING.write_text("{}")

    result = _call(server, "update.status")["result"]
    assert result["running"] is True
    assert result["finished"] is False


def test_start_spawns_detached_and_writes_pending(server):
    with patch.object(server.subprocess, "Popen") as popen:
        result = _call(server, "update.start")["result"]

    assert result["started"] is True
    assert server._DESKTOP_UPDATE_PENDING.exists()
    # Cleared so a stale prior result can't be read as this run's status.
    assert not server._DESKTOP_UPDATE_EXIT_CODE.exists()
    popen.assert_called_once()


def test_start_is_idempotent_while_running(server):
    server._DESKTOP_UPDATE_PENDING.write_text("{}")  # in flight, no exit code yet

    with patch.object(server.subprocess, "Popen") as popen:
        result = _call(server, "update.start")["result"]

    assert result.get("already_running") is True
    popen.assert_not_called()


def test_start_blocked_on_managed_install(server):
    with patch("hermes_cli.config.is_managed", return_value=True):
        resp = _call(server, "update.start")

    assert "error" in resp
    assert "managed" in resp["error"]["message"].lower()
