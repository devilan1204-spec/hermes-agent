"""Base class for all Hermes execution environment backends."""

from abc import ABC, abstractmethod
import logging
import os
import shlex
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Protocol, runtime_checkable

from hermes_constants import get_hermes_home
from tools.interrupt import is_interrupted

logger = logging.getLogger(__name__)


def get_sandbox_dir() -> Path:
    """Return the host-side root for all sandbox storage (Docker workspaces,
    Singularity overlays/SIF cache, etc.).

    Configurable via TERMINAL_SANDBOX_DIR. Defaults to {HERMES_HOME}/sandboxes/.
    """
    custom = os.getenv("TERMINAL_SANDBOX_DIR")
    if custom:
        p = Path(custom)
    else:
        p = get_hermes_home() / "sandboxes"
    p.mkdir(parents=True, exist_ok=True)
    return p


@runtime_checkable
class ProcessHandle(Protocol):
    """Duck type for anything _run_bash returns.

    subprocess.Popen satisfies this natively.  SDK backends (Modal, Daytona)
    return small adapters that wrap async/blocking calls in a thread + OS pipe.
    """

    def poll(self) -> int | None: ...
    def kill(self) -> None: ...
    def wait(self, timeout: float | None = None) -> int: ...

    @property
    def stdout(self): ...  # readable, iterable-of-str (for drain thread)

    @property
    def returncode(self) -> int | None: ...


class BaseEnvironment(ABC):
    """Common interface for all Hermes execution backends.

    **Unified execution model (spawn-per-call):**

    Backends implement ``_run_bash()`` — the ONLY thing that differs per
    backend.  Everything else (command wrapping, CWD tracking, snapshot
    management, timeout/interrupt handling, output collection) lives here.

    Backends that cannot return a ProcessHandle (e.g. HTTP-based
    ManagedModal) may override ``execute()`` directly and use
    ``_wrap_command()`` for command shaping only.
    """

    def __init__(self, cwd: str, timeout: int, env: dict = None):
        self.cwd = cwd
        self.timeout = timeout
        self.env = env or {}
        self._snapshot_path: str | None = None
        self._cwdfile_path: str | None = None
        self._snapshot_ready: bool = False
        self._session_id: str = ""

    # ------------------------------------------------------------------
    # Abstract — the ONLY thing backends implement
    # ------------------------------------------------------------------

    def _run_bash(self, cmd_string: str, *,
                  stdin_data: str | None = None) -> ProcessHandle:
        """Spawn ``bash -c <cmd_string>`` in the backend.

        Returns a ProcessHandle (subprocess.Popen or equivalent adapter).
        The caller owns polling, timeout, output collection, and cleanup.

        If *stdin_data* is provided, write it to the process's stdin and
        close.  Backends that cannot pipe stdin (Modal, Daytona) must embed
        it via heredoc in *cmd_string* before calling their SDK.

        Subclasses MUST override this.  The base implementation raises
        NotImplementedError (not declared abstract so legacy backends that
        still override execute() directly can be instantiated during migration).
        """
        raise NotImplementedError(
            f"{type(self).__name__} must implement _run_bash()"
        )

    def cleanup(self):
        """Release backend resources (container, instance, connection).

        Subclasses should override.  Base implementation cleans up snapshot
        and cwdfile if they exist.
        """
        pass

    # ------------------------------------------------------------------
    # Snapshot — login-shell env capture (called once at session init)
    # ------------------------------------------------------------------

    def _run_bash_login(self, cmd_string: str) -> ProcessHandle:
        """Spawn ``bash -l -c <cmd_string>`` for snapshot creation.

        Defaults to ``_run_bash`` — backends override this when the login
        flag needs different handling (e.g. local adds ``-l`` to Popen args).
        """
        return self._run_bash(cmd_string)

    def init_session(self):
        """Capture the login-shell environment into a snapshot file.

        Called once after ``__init__`` completes.  If it fails, commands
        still work — they just don't get env restoration.
        """
        self._session_id = uuid.uuid4().hex[:12]
        self._snapshot_path = f"/tmp/hermes-snap-{self._session_id}.sh"
        self._cwdfile_path = f"/tmp/hermes-cwd-{self._session_id}"

        bootstrap = (
            f"set +e\n"
            f"export -p > {self._snapshot_path}\n"
            f"if type declare >/dev/null 2>&1; then "
            f"declare -f >> {self._snapshot_path} 2>/dev/null; fi\n"
            f"alias -p >> {self._snapshot_path} 2>/dev/null || true\n"
            f"echo 'set +e' >> {self._snapshot_path}\n"
            f"echo 'set +u' >> {self._snapshot_path}\n"
            f"pwd -P >| {self._cwdfile_path}\n"
        )

        try:
            proc = self._run_bash_login(bootstrap)
            result = self._wait_for_process(proc, timeout=15)
            if result["returncode"] == 0:
                self._snapshot_ready = True
                logger.info(
                    "Snapshot created (session=%s)", self._session_id,
                )
            else:
                logger.warning(
                    "Snapshot creation failed (rc=%d), commands will "
                    "run without env restoration", result["returncode"],
                )
        except Exception as e:
            logger.warning("Snapshot creation failed: %s", e)

        # Pick up the reported cwd if available
        reported_cwd = self._read_file_in_env(self._cwdfile_path).strip()
        if reported_cwd:
            self.cwd = reported_cwd

    # ------------------------------------------------------------------
    # Command wrapping
    # ------------------------------------------------------------------

    def _wrap_command(self, command: str, cwd: str) -> str:
        """Wrap a user command with snapshot sourcing and CWD tracking.

        Returns a bash script string.
        """
        parts: list[str] = []

        # 1. Source snapshot (if available)
        if self._snapshot_ready and self._snapshot_path:
            parts.append(
                f"source {self._snapshot_path} 2>/dev/null || true"
            )

        # 2. cd to working directory
        work_dir = cwd or self.cwd
        if work_dir:
            parts.append(f"cd {shlex.quote(work_dir)} || exit 1")

        # 3. The actual command (eval to handle complex shell syntax)
        escaped = command.replace("'", "'\\''")
        parts.append(f"eval '{escaped}'")

        # 4. Capture exit code, then record CWD
        parts.append("__hermes_ec=$?")
        if self._cwdfile_path:
            parts.append(f"pwd -P >| {self._cwdfile_path}")
        parts.append("exit $__hermes_ec")

        return "\n".join(parts)

    # ------------------------------------------------------------------
    # Unified execute()
    # ------------------------------------------------------------------

    def execute(self, command: str, cwd: str = "", *,
                timeout: int | None = None,
                stdin_data: str | None = None) -> dict:
        """Execute a command, return ``{"output": str, "returncode": int}``."""
        self._before_execute()

        exec_command, sudo_stdin = self._prepare_command(command)

        # Merge sudo stdin with caller stdin
        effective_stdin: str | None = None
        if sudo_stdin is not None and stdin_data is not None:
            effective_stdin = sudo_stdin + stdin_data
        elif sudo_stdin is not None:
            effective_stdin = sudo_stdin
        else:
            effective_stdin = stdin_data

        wrapped = self._wrap_command(exec_command, cwd)
        effective_timeout = timeout or self.timeout

        proc = self._run_bash(wrapped, stdin_data=effective_stdin)
        result = self._wait_for_process(proc, timeout=effective_timeout)

        # Update CWD from the cwdfile written by the wrapping template
        self._update_cwd_from_file()

        return result

    # ------------------------------------------------------------------
    # Process lifecycle (shared — not overridden except _kill_process)
    # ------------------------------------------------------------------

    def _wait_for_process(self, proc: ProcessHandle,
                          timeout: int) -> dict:
        """Poll process with interrupt checking, drain stdout, enforce timeout."""
        output_chunks: list[str] = []

        def _drain():
            try:
                for line in proc.stdout:
                    output_chunks.append(line)
            except (ValueError, OSError):
                pass

        reader = threading.Thread(target=_drain, daemon=True)
        reader.start()
        deadline = time.monotonic() + timeout

        while proc.poll() is None:
            if is_interrupted():
                self._kill_process(proc)
                reader.join(timeout=2)
                partial = "".join(output_chunks)
                return {
                    "output": partial + "\n[Command interrupted]",
                    "returncode": 130,
                }
            if time.monotonic() > deadline:
                self._kill_process(proc)
                reader.join(timeout=2)
                partial = "".join(output_chunks)
                msg = f"\n[Command timed out after {timeout}s]"
                return {
                    "output": (partial + msg) if partial else msg.lstrip(),
                    "returncode": 124,
                }
            time.sleep(0.2)

        reader.join(timeout=5)
        return {"output": "".join(output_chunks), "returncode": proc.returncode}

    def _kill_process(self, proc: ProcessHandle):
        """Kill a process.  Backends may override for process-group kill."""
        try:
            if hasattr(proc, "terminate"):
                proc.terminate()
                try:
                    proc.wait(timeout=1.0)
                    return
                except Exception:
                    pass
            proc.kill()
        except (ProcessLookupError, PermissionError, OSError):
            pass

    # ------------------------------------------------------------------
    # CWD tracking
    # ------------------------------------------------------------------

    def _update_cwd_from_file(self):
        """Read the cwdfile after process exit, update self.cwd."""
        if not self._cwdfile_path:
            return
        try:
            new_cwd = self._read_file_in_env(self._cwdfile_path).strip()
            if new_cwd:
                self.cwd = new_cwd
        except Exception:
            pass  # CWD tracking is best-effort

    def _read_file_in_env(self, path: str) -> str:
        """Read a file inside the backend's execution context.

        Default: run ``cat <path>`` via _run_bash.  Backends with faster
        methods (local: ``open()``) should override.
        """
        proc = self._run_bash(f"cat {shlex.quote(path)} 2>/dev/null")
        result = self._wait_for_process(proc, timeout=5)
        return result.get("output", "")

    # ------------------------------------------------------------------
    # Hooks for subclasses
    # ------------------------------------------------------------------

    def _before_execute(self):
        """Hook for pre-execution sync (SSH rsync, Modal file push, etc.)."""
        pass

    # ------------------------------------------------------------------
    # Compat
    # ------------------------------------------------------------------

    def stop(self):
        """Alias for cleanup (compat with older callers)."""
        self.cleanup()

    def __del__(self):
        try:
            self.cleanup()
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Shared helpers (kept for backward compat during migration)
    # ------------------------------------------------------------------

    def _prepare_command(self, command: str) -> tuple[str, str | None]:
        """Transform sudo commands if SUDO_PASSWORD is available."""
        from tools.terminal_tool import _transform_sudo_command
        return _transform_sudo_command(command)

    def _build_run_kwargs(self, timeout: int | None,
                          stdin_data: str | None = None) -> dict:
        """Build common subprocess.run kwargs for non-interactive execution."""
        kw = {
            "text": True,
            "timeout": timeout or self.timeout,
            "encoding": "utf-8",
            "errors": "replace",
            "stdout": subprocess.PIPE,
            "stderr": subprocess.STDOUT,
        }
        if stdin_data is not None:
            kw["input"] = stdin_data
        else:
            kw["stdin"] = subprocess.DEVNULL
        return kw

    def execute_oneshot(self, command: str, cwd: str = "", *,
                        timeout: int | None = None,
                        stdin_data: str | None = None) -> dict:
        """Execute a command bypassing any persistent shell.

        Safe for concurrent use alongside a long-running execute() call.
        Backends that maintain a persistent shell (SSH, Local) override this
        to route through their oneshot path, avoiding the shell lock.
        Non-persistent backends delegate to execute().
        """
        return self.execute(command, cwd=cwd, timeout=timeout,
                            stdin_data=stdin_data)

    def _timeout_result(self, timeout: int | None) -> dict:
        """Standard return dict when a command times out."""
        return {
            "output": f"Command timed out after {timeout or self.timeout}s",
            "returncode": 124,
        }
