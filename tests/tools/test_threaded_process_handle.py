"""Unit tests for the _ThreadedProcessHandle adapter in base.py."""

import threading

import pytest


def test_successful_execution():
    """exec_fn returns (output, 0) -> returncode==0 and stdout reads output."""
    from tools.environments.base import _ThreadedProcessHandle

    handle = _ThreadedProcessHandle(lambda: ("hello output", 0))
    handle.wait()
    assert handle.returncode == 0
    text = handle.stdout.read()
    assert text == "hello output"
    handle.stdout.close()


def test_nonzero_exit_code():
    """exec_fn returns (output, 42) -> returncode==42."""
    from tools.environments.base import _ThreadedProcessHandle

    handle = _ThreadedProcessHandle(lambda: ("error output", 42))
    handle.wait()
    assert handle.returncode == 42
    text = handle.stdout.read()
    assert text == "error output"
    handle.stdout.close()


def test_exception_returns_rc1():
    """exec_fn raises RuntimeError -> returncode==1 and error message in stdout."""
    from tools.environments.base import _ThreadedProcessHandle

    def failing_fn():
        raise RuntimeError("boom")

    handle = _ThreadedProcessHandle(failing_fn)
    handle.wait()
    assert handle.returncode == 1
    text = handle.stdout.read()
    assert "boom" in text
    handle.stdout.close()


def test_poll_returns_none_while_running():
    """poll() returns None before exec_fn completes."""
    from tools.environments.base import _ThreadedProcessHandle

    barrier = threading.Event()

    def blocking_fn():
        barrier.wait(timeout=5)
        return ("done", 0)

    handle = _ThreadedProcessHandle(blocking_fn)
    assert handle.poll() is None
    barrier.set()
    handle.wait()
    assert handle.poll() == 0
    handle.stdout.read()
    handle.stdout.close()
