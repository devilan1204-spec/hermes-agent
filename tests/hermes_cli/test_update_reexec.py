"""Tests for the post-pull re-exec hand-off in ``hermes update``.

``hermes update`` runs from the *old* install. Before this hand-off, the
post-pull steps (dep install, config migration, gateway restart) executed
stale in-memory code even though the new source was already on disk, so a bug
fixed in the pulled version still crashed the first run — users had to run
``hermes update`` a second time. After a successful pull we now re-exec into
the refreshed code (POSIX ``execve``) so the remainder runs new.

These tests cover the gate (when we re-exec vs. finish in-process), the exec
mechanics, and the finalize pass that the re-exec'd process takes.
"""

import sys
from types import SimpleNamespace

import pytest

from hermes_cli import config as hermes_config
from hermes_cli import main as hermes_main


# ---------------------------------------------------------------------------
# Managed-uv compatibility: make managed_uv helpers follow shutil.which mocking
# (mirrors the autouse fixture in test_update_autostash.py).
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _patch_managed_uv():
    import shutil
    from unittest.mock import patch

    with patch("hermes_cli.managed_uv.resolve_uv", side_effect=lambda: shutil.which("uv")), \
         patch("hermes_cli.managed_uv.ensure_uv", side_effect=lambda: shutil.which("uv")), \
         patch("hermes_cli.managed_uv.update_managed_uv", side_effect=lambda: None):
        yield


def _clear_reexec_env(monkeypatch):
    monkeypatch.delenv("HERMES_UPDATE_FINALIZE", raising=False)
    monkeypatch.delenv("HERMES_UPDATE_NO_REEXEC", raising=False)


# ---------------------------------------------------------------------------
# _should_reexec_after_pull — the gate
# ---------------------------------------------------------------------------
def test_should_reexec_false_in_finalize_mode(monkeypatch):
    _clear_reexec_env(monkeypatch)
    assert hermes_main._should_reexec_after_pull(finalize_only=True) is False


def test_should_reexec_false_when_finalize_env_set(monkeypatch):
    _clear_reexec_env(monkeypatch)
    monkeypatch.setenv("HERMES_UPDATE_FINALIZE", "1")
    assert hermes_main._should_reexec_after_pull(finalize_only=False) is False


def test_should_reexec_false_with_opt_out_env(monkeypatch):
    _clear_reexec_env(monkeypatch)
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.delitem(sys.modules, "pytest", raising=False)
    monkeypatch.setenv("HERMES_UPDATE_NO_REEXEC", "1")
    assert hermes_main._should_reexec_after_pull(finalize_only=False) is False


def test_should_reexec_false_on_windows(monkeypatch):
    _clear_reexec_env(monkeypatch)
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.delitem(sys.modules, "pytest", raising=False)
    assert hermes_main._should_reexec_after_pull(finalize_only=False) is False


def test_should_reexec_false_under_pytest(monkeypatch):
    # Safety invariant: never replace the interpreter while the test suite is
    # running. ``pytest`` is in sys.modules during the suite, so the gate must
    # stay closed even on a non-Windows host with a clean env.
    _clear_reexec_env(monkeypatch)
    monkeypatch.setattr(sys, "platform", "linux")
    assert "pytest" in sys.modules
    assert hermes_main._should_reexec_after_pull(finalize_only=False) is False


def test_should_reexec_true_when_allowed(monkeypatch):
    # The positive path: non-Windows, not finalize, no opt-out, and (simulated)
    # no pytest in the module table.
    _clear_reexec_env(monkeypatch)
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.delitem(sys.modules, "pytest", raising=False)
    assert hermes_main._should_reexec_after_pull(finalize_only=False) is True


# ---------------------------------------------------------------------------
# _reexec_into_updated_code — the exec mechanics
# ---------------------------------------------------------------------------
def test_reexec_invokes_execve_with_finalize_env(monkeypatch):
    captured = {}

    def fake_execve(path, argv, env):
        captured["path"] = path
        captured["argv"] = list(argv)
        captured["env"] = dict(env)
        # A real execve never returns; returning here lets the test continue.

    monkeypatch.setattr(hermes_main.os, "execve", fake_execve)
    monkeypatch.setattr(hermes_main.sys, "argv", ["hermes", "update", "--yes", "--gateway"])

    hermes_main._reexec_into_updated_code()

    assert captured["path"] == sys.executable
    assert captured["argv"][0] == sys.executable
    assert captured["argv"][1:3] == ["-m", "hermes_cli.main"]
    # The original CLI args (minus argv[0]) are carried through verbatim.
    assert captured["argv"][3:] == ["update", "--yes", "--gateway"]
    # The loop-breaker guard the re-exec'd run reads.
    assert captured["env"]["HERMES_UPDATE_FINALIZE"] == "1"


def test_reexec_falls_back_when_execve_raises(monkeypatch):
    def boom(*_a, **_kw):
        raise OSError("exec format error")

    monkeypatch.setattr(hermes_main.os, "execve", boom)
    monkeypatch.setattr(hermes_main.sys, "argv", ["hermes", "update"])

    # Must swallow the error so the caller can finish the update in-process.
    hermes_main._reexec_into_updated_code()


# ---------------------------------------------------------------------------
# Finalize pass — the re-exec'd process
# ---------------------------------------------------------------------------
def _setup_update_mocks(monkeypatch, tmp_path):
    (tmp_path / ".git").mkdir()
    monkeypatch.setattr(hermes_main, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(hermes_main, "_stash_local_changes_if_needed", lambda *a, **kw: None)
    monkeypatch.setattr(hermes_main, "_restore_stashed_changes", lambda *a, **kw: True)
    monkeypatch.setattr(hermes_config, "get_missing_env_vars", lambda required_only=True: [])
    monkeypatch.setattr(hermes_config, "get_missing_config_fields", lambda: [])
    monkeypatch.setattr(hermes_config, "check_config_version", lambda: (5, 5))
    monkeypatch.setattr(hermes_config, "migrate_config", lambda **kw: {"env_added": [], "config_added": []})
    monkeypatch.setattr(hermes_main, "_refresh_active_lazy_features", lambda: None)


def _fake_git_run(commit_count):
    recorded = []

    def side_effect(cmd, **kwargs):
        recorded.append(cmd)
        joined = " ".join(str(c) for c in cmd)
        if "fetch" in joined and "origin" in joined:
            return SimpleNamespace(stdout="", stderr="", returncode=0)
        if "rev-parse" in joined and "--abbrev-ref" in joined:
            return SimpleNamespace(stdout="main\n", stderr="", returncode=0)
        if "rev-list" in joined:
            return SimpleNamespace(stdout=f"{commit_count}\n", stderr="", returncode=0)
        if "--ff-only" in joined:
            return SimpleNamespace(stdout="Already up to date.\n", stderr="", returncode=0)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    return side_effect, recorded


def test_finalize_pass_does_not_reexec(monkeypatch, tmp_path):
    # In finalize mode the gate is closed, so execve must never be touched even
    # though we reach the (would-be) re-exec point. Make execve explode so the
    # test fails loudly if it's ever called.
    _clear_reexec_env(monkeypatch)
    monkeypatch.setenv("HERMES_UPDATE_FINALIZE", "1")
    _setup_update_mocks(monkeypatch, tmp_path)
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/uv" if name == "uv" else None)
    monkeypatch.setattr(hermes_main, "_is_termux_env", lambda env=None: False)

    def no_execve(*_a, **_kw):  # pragma: no cover - asserts it's not called
        raise AssertionError("finalize pass must not re-exec")

    monkeypatch.setattr(hermes_main.os, "execve", no_execve)

    side_effect, recorded = _fake_git_run(commit_count="0")
    monkeypatch.setattr(hermes_main.subprocess, "run", side_effect)

    hermes_main.cmd_update(SimpleNamespace())

    # The whole point of the finalize pass: even with zero new commits (the
    # pull already happened in the original pass) it does NOT take the "Already
    # up to date" early return — it runs the post-pull dependency install.
    install_cmds = [c for c in recorded if "pip" in c and "install" in c]
    assert install_cmds, "finalize pass should run the dependency install, not early-return"


def test_finalize_pass_skips_pre_update_backup(monkeypatch, tmp_path):
    _clear_reexec_env(monkeypatch)
    monkeypatch.setenv("HERMES_UPDATE_FINALIZE", "1")
    _setup_update_mocks(monkeypatch, tmp_path)
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/uv" if name == "uv" else None)
    monkeypatch.setattr(hermes_main, "_is_termux_env", lambda env=None: False)
    monkeypatch.setattr(hermes_main.os, "execve", lambda *a, **kw: None)

    backup_calls = []
    monkeypatch.setattr(hermes_main, "_run_pre_update_backup", lambda args: backup_calls.append(args))

    side_effect, _recorded = _fake_git_run(commit_count="0")
    monkeypatch.setattr(hermes_main.subprocess, "run", side_effect)

    hermes_main.cmd_update(SimpleNamespace())

    assert backup_calls == [], "finalize pass must not retake the pre-update backup"


def test_original_pass_still_runs_pre_update_backup(monkeypatch, tmp_path):
    # Sanity counter-check: a normal (non-finalize) run still takes the backup.
    _clear_reexec_env(monkeypatch)
    _setup_update_mocks(monkeypatch, tmp_path)
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/uv" if name == "uv" else None)
    monkeypatch.setattr(hermes_main, "_is_termux_env", lambda env=None: False)

    backup_calls = []
    monkeypatch.setattr(hermes_main, "_run_pre_update_backup", lambda args: backup_calls.append(args))

    side_effect, _recorded = _fake_git_run(commit_count="3")
    monkeypatch.setattr(hermes_main.subprocess, "run", side_effect)

    # Under pytest the gate is closed, so the normal run finishes in-process
    # (no execve) exactly as it always did.
    hermes_main.cmd_update(SimpleNamespace())

    assert len(backup_calls) == 1
