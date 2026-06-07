"""Regression tests for _resolve_venv_dir (salvaged PR #39749).

`hermes update` previously hardcoded `PROJECT_ROOT / "venv"`, which orphaned
deps into a stray `venv/` on uv-style installs whose real env is `.venv/`.
`_resolve_venv_dir()` now prefers the active interpreter's venv, then
`VIRTUAL_ENV`, then a `.venv`-before-`venv` directory fallback.
"""

import os
import sys
from pathlib import Path

import pytest

from hermes_cli import main as hermes_main


def test_resolves_active_interpreter_venv(monkeypatch, tmp_path):
    """When running inside a venv, sys.prefix wins."""
    venv = tmp_path / "active-venv"
    venv.mkdir()
    monkeypatch.setattr(sys, "prefix", str(venv))
    monkeypatch.setattr(sys, "base_prefix", str(tmp_path / "system"))
    assert hermes_main._resolve_venv_dir() == venv


def test_falls_back_to_virtual_env_var(monkeypatch, tmp_path):
    """uv sets VIRTUAL_ENV without changing sys.prefix; honor it."""
    venv = tmp_path / "uv-venv"
    venv.mkdir()
    # Not inside a venv per sys.prefix.
    monkeypatch.setattr(sys, "prefix", str(tmp_path / "system"))
    monkeypatch.setattr(sys, "base_prefix", str(tmp_path / "system"))
    monkeypatch.setenv("VIRTUAL_ENV", str(venv))
    assert hermes_main._resolve_venv_dir() == venv


def test_prefers_dot_venv_over_venv_in_fallback(monkeypatch, tmp_path):
    """With no active venv and no VIRTUAL_ENV, .venv beats venv."""
    (tmp_path / ".venv").mkdir()
    (tmp_path / "venv").mkdir()
    monkeypatch.setattr(sys, "prefix", str(tmp_path / "system"))
    monkeypatch.setattr(sys, "base_prefix", str(tmp_path / "system"))
    monkeypatch.delenv("VIRTUAL_ENV", raising=False)
    monkeypatch.setattr(hermes_main, "PROJECT_ROOT", tmp_path)
    assert hermes_main._resolve_venv_dir() == tmp_path / ".venv"


def test_returns_none_when_no_venv(monkeypatch, tmp_path):
    """No active venv, no VIRTUAL_ENV, no fallback dirs -> None."""
    monkeypatch.setattr(sys, "prefix", str(tmp_path / "system"))
    monkeypatch.setattr(sys, "base_prefix", str(tmp_path / "system"))
    monkeypatch.delenv("VIRTUAL_ENV", raising=False)
    monkeypatch.setattr(hermes_main, "PROJECT_ROOT", tmp_path / "empty")
    assert hermes_main._resolve_venv_dir() is None
