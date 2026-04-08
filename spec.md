# Execution Layer Refactor — PR Split Spec

Based on PR #4561, split into 3 self-contained PRs plus design decisions from the interview.

## References

- **PR 4561 worktree:** `/tmp/hermes-pr-4561` (checked out at `pr-4561` branch) — the full final state of all changes
- **free-code (Claude Code):** `/Users/sid/main-quests/github/free-code` — reference implementation for spawn-per-call, shell snapshots, CWD tracking. Key files: `src/utils/shell/bashProvider.ts`, `src/utils/Shell.ts`, `src/utils/ShellCommand.ts`, `src/utils/bash/ShellSnapshot.ts`, `src/utils/cwd.ts`
- **PR 4511:** Modal ubuntu/debian image fix (`add_python` param) — absorbed into PR 2
- **PR 6040:** PR 1 (Tool Result Persistence) — open, targeting main

---

## PR 1: Tool Result Persistence (PR #6040, in review)

Already implemented and open as PR #6040 on branch `sid/tool-result-fixes`. See PR description for full details. No changes needed — this section is for reference only.

**Summary:** 3-layer persistence system (pre-truncation, per-result persistence into sandbox, per-turn aggregate budget). Fixes broken `read_file` retrieval on remote backends by writing results into the sandbox via `env.execute()`.

---

## PR 2: Unified Execution Layer (all backends except ManagedModal)

**Goal:** Replace the dual execution model (PersistentShellMixin + per-backend oneshot) with spawn-per-call + session snapshot. All backends except ManagedModal in one PR. Backward compat not required — flag day.

**Scope:** Local, Docker, SSH, Singularity, Modal, Daytona. ManagedModal stays on its current HTTP-based execution model (gateway-side init is a separate follow-up issue).

### Design Decisions (from interview)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Snapshot scope | Full capture at `init_session()` (export -p, declare -f with `grep -vE '^_[^_]'` filter, alias -p, shopt -p). Only `export -p` re-dumped per-command. | Matches free-code's split: functions/aliases/shopts are static after init. Env vars change frequently. Filter removes bloated completion functions (_git, _ssh, etc). |
| Concurrency | Last-writer-wins on snapshot file. No lock. | Parallel tool calls each source the same snapshot and write back independently. Matches how real terminals work. |
| Command quoting | Single-quote escape (`'\''` trick) inside `eval` | Battle-tested, used by `shlex.quote()`. Correct for all inputs. |
| CWD tracking | **Hybrid:** file-based for local, in-band marker for remote | Local: `open("/tmp/hermes-cwd-{session}.txt").read().strip()` after `proc.wait()`. Remote: `__HERMES_CWD_{session_id}__` marker in stdout, parsed by `_extract_cwd_from_output()`. Zero extra round-trips on remote. |
| cancel_fn | Wire now: Modal `sandbox.terminate.aio()`, Daytona `sandbox.stop()` | Restores interrupt behavior from main. PR 4561 left it as no-op due to a bug — fix it. |
| Init failure | Soft-fatal + `bash -l` fallback | When `_snapshot_ready=False`, use `bash -l -c` instead of `bash -c` for all subsequent commands. User's profile still loads. |
| SSH transport | `shlex.quote()` argument to `bash -c` | Double-quoting is correct and doesn't consume stdin. |
| Env tracking | File-only, no Python state | Snapshot file is sole source of truth for env vars. No `_extract_env_from_output()`. No `self.env_vars` dict. |
| cd failure exit code | Exit 126 | Distinguishable from command errors. Semi-standard shell convention for "cannot execute". |
| Tilde expansion | Let bash expand natively | Don't resolve `~` in Python. Pass literally to wrapper. `cd ~` in bash expands correctly on any backend. |
| Login method | Single `_run_bash(cmd, *, login=False)` | Halves override points (7 methods vs 14). Backends add `-l` flag conditionally. |
| Docker env vars | Snapshot-only | `-e` flags on `init_session()` docker exec only. Snapshot carries host vars forward. Subsequent docker exec calls don't need `-e`. |
| Heredoc delimiter | UUID-based: `HERMES_STDIN_{uuid4()}` | Zero collision risk. Slightly longer command string. |
| Binary output | Catch `UnicodeDecodeError`, replace with `[binary output, N bytes]` | Clean signal to model. No lossy garbling. |
| Poll interval | Accept 200ms floor | Negligible vs LLM round-trip. Simpler code. |
| `persistent` param | Hard remove (flag day) | No deprecation warning. TypeError if anyone passes it. |
| ManagedModal | Stays on current code | Gateway-side `init_session()` is a separate follow-up issue. No changes to managed_modal.py. |
| modal_common.py | Rename to `modal_utils.py` | ModalEnvironment inherits `BaseEnvironment` directly. Shared utilities (AsyncWorker, image resolution, credential sync) stay in modal_utils.py. |
| Local/Singularity CWD | Default CWD inheritance | Don't force `cwd='/'` in Popen. Let processes inherit natural CWD. Wrapper's `cd` handles it. |
| SDK streaming | Follow-up issue | Modal/Daytona output is batched (SDK call blocks). Document limitation, address later. |
| First sync | `_last_sync_time=0` | Monotonic time is always >5s past epoch 0. First `_before_execute()` always triggers sync. |
| Test markers | Custom pytest marks | `@pytest.mark.docker`, `@pytest.mark.ssh`, etc. CI config decides which to run. |
| PR 4511 | Absorb into this PR | Cherry-pick `add_python` for ubuntu/debian Modal images. |
| Shell safety (set +e/+u) | Snapshot-only | `bash -c` starts with errexit/nounset off. Snapshot only re-dumps `export -p` (not shell options). Nothing turns them on. |
| `execute_oneshot()` | Delete entirely | No persistent shell means no reason for a separate method. |

### Files

| File | Change |
|------|--------|
| `tools/environments/base.py` | `ProcessHandle` protocol, `_ThreadedProcessHandle` (with `cancel_fn`), `_run_bash(cmd, *, login, timeout, stdin_data)`, `init_session()`, `_wrap_command()`, `_wait_for_process()`, `_kill_process()`, `_extract_cwd_from_output()` (remote only), `_read_cwd_file()` (local only), `_before_execute()` hook, `_embed_stdin_heredoc()`, unified `execute()`. Delete `execute_oneshot()`. |
| `tools/environments/local.py` | Remove `PersistentShellMixin` inheritance. Implement `_run_bash(*, login)` with Popen + `os.setsid`. Override `_kill_process()` for process-group kill. Override CWD to use file-based read. Remove fence markers, shell noise cleanup. |
| `tools/environments/ssh.py` | Remove `PersistentShellMixin` inheritance. Remove all IPC methods. Implement `_run_bash(*, login)` with `shlex.quote()` SSH transport. Move file sync to `_before_execute()`. Remove `persistent` parameter. |
| `tools/environments/docker.py` | Remove `execute()` override. Implement `_run_bash(*, login)` with `docker exec` (conditional `-i` for stdin_data). Remove `-e` env forwarding from per-command calls (only on init_session). Call `init_session()` after container creation. |
| `tools/environments/singularity.py` | Remove `execute()` override. Implement `_run_bash(*, login)` with `apptainer exec`. Default CWD inheritance (no forced `--pwd`). Call `init_session()` after instance start. |
| `tools/environments/modal.py` | Inherit `BaseEnvironment` directly (not `BaseModalExecutionEnvironment`). `_ThreadedProcessHandle` adapter with `cancel_fn=sandbox.terminate.aio()`. `_run_bash(*, login)` via `_modal_exec()`. Move file sync to `_before_execute()`. Absorb PR 4511's `add_python` in `_resolve_modal_image()`. |
| `tools/environments/daytona.py` | `_ThreadedProcessHandle` adapter with `cancel_fn=sandbox.stop()`. `_run_bash(*, login)` via `_daytona_exec()`. Preserve shell timeout wrapper. Move file sync to `_before_execute()`. |
| `tools/environments/modal_common.py` | **Rename** to `modal_utils.py`. Remove `BaseModalExecutionEnvironment` class. Keep shared utilities: `_AsyncWorker`, `_resolve_modal_image()` (with 4511's `add_python`), credential sync helpers. |
| `tools/environments/managed_modal.py` | **No changes** to execution model. Update imports from `modal_common` to `modal_utils`. |
| `tools/environments/persistent_shell.py` | **DELETE** (291 lines) |
| `tools/terminal_tool.py` | Remove `persistent` params from `_create_environment()` factory. Hard removal (TypeError if passed). |

### Execution Model

```
Session start (init_session, once per environment):
  bash -l -c "
    export -p > /tmp/hermes-snap-{session}.sh
    declare -f | grep -vE '^_[^_]' >> /tmp/hermes-snap-{session}.sh
    alias -p >> /tmp/hermes-snap-{session}.sh
    echo 'shopt -s expand_aliases' >> /tmp/hermes-snap-{session}.sh
    echo 'set +e' >> /tmp/hermes-snap-{session}.sh
    echo 'set +u' >> /tmp/hermes-snap-{session}.sh
    pwd -P > /tmp/hermes-cwd-{session}.txt
    printf '\n__HERMES_CWD_{session}__%s__HERMES_CWD_{session}__\n' \"$(pwd -P)\"
  "
  -> captures full env snapshot once (functions filtered, aliases, shell options)
  -> CWD extracted to seed self.cwd (file for local, marker for remote)
  -> _snapshot_ready = True on success
  -> On failure: _snapshot_ready = False, log warning, subsequent commands use bash -l -c

Every command (_wrap_command output):
  bash -c "                    # or bash -l -c if _snapshot_ready=False
    source /tmp/hermes-snap-{session}.sh 2>/dev/null || true
    cd ~ || true               # only if cwd is ~ (let bash expand natively)
    cd {cwd} || exit 126
    eval '{single-quote-escaped command}'
    __hermes_ec=$?
    export -p > /tmp/hermes-snap-{session}.sh 2>/dev/null || true
    pwd -P > /tmp/hermes-cwd-{session}.txt 2>/dev/null || true
    printf '\n__HERMES_CWD_{session}__%s__HERMES_CWD_{session}__\n' \"$(pwd -P)\"
    exit $__hermes_ec
  "
  -> Process exit = completion
  -> CWD: local reads /tmp/hermes-cwd-{session}.txt directly
          remote parses __HERMES_CWD_{session}__ from stdout, strips marker
  -> Env vars: export -p re-dumped to snapshot each command (last-writer-wins)
```

**Note:** The wrapper writes CWD to BOTH a file and stdout marker. Local uses the file (direct `open().read()`). Remote backends use the stdout marker (zero extra round-trip). The file write is a no-op cost on remote (written inside sandbox, never read by Python).

### _ThreadedProcessHandle with cancel_fn

```python
class _ThreadedProcessHandle:
    """Adapter for SDK backends (Modal, Daytona) that have no subprocess."""

    def __init__(self, exec_fn, cancel_fn=None):
        self._cancel_fn = cancel_fn
        self._done = threading.Event()
        self._returncode = None
        # os.pipe() for stdout; daemon thread calls exec_fn, writes output, sets _done

    def poll(self):
        return self._returncode if self._done.is_set() else None

    def kill(self):
        if self._cancel_fn:
            try:
                self._cancel_fn()
            except Exception:
                pass  # Swallow — best-effort cancellation

    def wait(self, timeout=None):
        self._done.wait(timeout=timeout)
        return self._returncode
```

Backend usage:
```python
# Modal
def _run_bash(self, cmd_string, *, login=False, timeout=120, stdin_data=None):
    sandbox, worker = self._sandbox, self._worker
    def cancel():
        worker.run_coroutine(sandbox.terminate.aio(), timeout=15)
    exec_fn = lambda: self._modal_exec_sync(cmd_string, login=login)
    return _ThreadedProcessHandle(exec_fn, cancel_fn=cancel)

# Daytona
def _run_bash(self, cmd_string, *, login=False, timeout=120, stdin_data=None):
    sandbox = self._sandbox
    def cancel():
        sandbox.stop()
    exec_fn = lambda: self._daytona_exec_sync(cmd_string, login=login, timeout=timeout)
    return _ThreadedProcessHandle(exec_fn, cancel_fn=cancel)
```

### Unified execute() (base class)

```python
def execute(self, command, cwd=None, *, timeout=120, stdin_data=None):
    self._before_execute()  # file sync hook (rate-limited)

    exec_command, sudo_stdin = self._prepare_command(command)
    effective_stdin = sudo_stdin or stdin_data
    effective_cwd = cwd or self.cwd

    # Embed stdin as heredoc for backends that need it
    if effective_stdin and self._stdin_mode == "heredoc":
        exec_command = self._embed_stdin_heredoc(exec_command, effective_stdin)
        effective_stdin = None

    wrapped = self._wrap_command(exec_command, effective_cwd)

    login = not self._snapshot_ready  # fallback to bash -l if snapshot failed
    proc = self._run_bash(wrapped, login=login, timeout=timeout, stdin_data=effective_stdin)
    result = self._wait_for_process(proc, timeout=timeout)

    # CWD extraction: file-based for local, marker-based for remote
    self._update_cwd(result)

    return result
```

### _embed_stdin_heredoc (UUID-based delimiter)

```python
def _embed_stdin_heredoc(self, command, stdin_data):
    delimiter = f"HERMES_STDIN_{uuid.uuid4().hex[:12]}"
    return f"{command} << '{delimiter}'\n{stdin_data}\n{delimiter}"
```

### Binary output handling

```python
# In _wait_for_process drain thread:
def _drain_stdout(proc_stdout, output_chunks):
    try:
        for line in proc_stdout:
            output_chunks.append(line)
    except UnicodeDecodeError:
        output_chunks.clear()
        output_chunks.append("[binary output detected — raw bytes not displayable]")
```

### Docker init_session env flow

```
1. init_session():
   docker exec -e API_KEY=xxx -e OPENAI_KEY=yyy ... {container} \
     bash -l -c 'export -p > /tmp/hermes-snap-{sid}.sh; declare -f | grep ... >> ...; ...'
   -> -e flags inject host vars into the login shell
   -> export -p captures them into the snapshot file

2. Subsequent commands:
   docker exec {container} bash -c 'source /tmp/hermes-snap-{sid}.sh; cd ...; eval ...'
   -> No -e flags needed. Snapshot has everything.
   -> Agent-set vars (export MY_VAR=foo) also captured by post-command export -p
```

### Backend Migration Summary

| Backend | `_run_bash()` returns | stdin mode | cancel | CWD method |
|---------|----------------------|------------|--------|------------|
| Local | `subprocess.Popen` (direct) | pipe (thread write) | `os.killpg(SIGTERM/SIGKILL)` | File read |
| Docker | `subprocess.Popen` (docker exec) | conditional `-i` flag | `proc.terminate()` (default) | Stdout marker |
| SSH | `subprocess.Popen` (ssh + shlex.quote) | pipe (thread write) | `proc.terminate()` (kills ssh client) | Stdout marker |
| Singularity | `subprocess.Popen` (apptainer exec) | pipe (thread write) | `proc.terminate()` (default) | Stdout marker |
| Modal | `_ThreadedProcessHandle` | heredoc embed | `cancel_fn` -> `sandbox.terminate.aio()` | Stdout marker |
| Daytona | `_ThreadedProcessHandle` | heredoc embed | `cancel_fn` -> `sandbox.stop()` | Stdout marker |
| ManagedModal | **Unchanged** (HTTP override) | heredoc (in execute) | HTTP cancel endpoint | **Unchanged** |

### What Gets Deleted

- `persistent_shell.py` — 291 lines (entire file)
- `_OUTPUT_FENCE` constant and `_extract_fenced_output()` from local.py
- `_SHELL_NOISE_SUBSTRINGS` and `_clean_shell_noise()` from local.py
- All IPC methods from SSH (`_read_temp_files`, `_kill_shell_children`, `_cleanup_temp_files`, `_spawn_shell_process`, `_execute_oneshot`)
- `execute()` overrides from Docker, Singularity (use base class unified execute)
- `_start_modal_exec`, `_poll_modal_exec`, `_cancel_modal_exec` from modal.py
- `BaseModalExecutionEnvironment` class from modal_common.py
- `_cwdfile_path`, `_update_cwd_from_file()`, `_read_file_in_env()` and all per-backend overrides
- `execute_oneshot()` from base.py
- `persistent` parameter from Local, SSH constructors and `_create_environment()` factory
- `-e` env forwarding from Docker per-command `docker exec` calls (only kept for init_session)

### Tests

**Test markers (pyproject.toml):**
```ini
[tool.pytest.ini_options]
markers = [
    "docker: requires Docker daemon",
    "ssh: requires SSH host (TERMINAL_SSH_HOST, TERMINAL_SSH_USER)",
    "modal: requires Modal credentials",
    "daytona: requires Daytona credentials",
]
```

**Unit tests (mocked, always run in CI):**

| Test file | What it covers |
|-----------|---------------|
| `tests/tools/test_threaded_process_handle.py` | Successful execution, nonzero exit, exception handling, poll-while-running, **cancel_fn called on kill**, cancel_fn exception swallowed, cancel_fn=None safe |
| `tests/tools/test_base_environment.py` | `_wrap_command()` output shape, `_extract_cwd_from_output()` parsing (happy path, missing markers, nested markers), `_embed_stdin_heredoc()` with UUID delimiter, `init_session()` success/failure paths, `_snapshot_ready=False` triggers `login=True` |
| `tests/tools/test_docker_environment.py` | Container creation args, init_session `-e` flag injection, subsequent exec has no `-e`, volume mounts, security flags |
| `tests/tools/test_daytona_environment.py` | Sandbox creation/resume/cleanup, execute via unified model, file sync, `cancel_fn` wired to `sandbox.stop()`, `_before_execute` hook |

**Backend compat tests (real backends, marker-gated):**

```python
# tests/test_env_backend_compat.py

@pytest.fixture(params=["local", pytest.param("docker", marks=pytest.mark.docker),
                         pytest.param("ssh", marks=pytest.mark.ssh)])
def env(request):
    backend = _create_backend(request.param)
    yield backend
    backend.cleanup()

class TestExecute:
    def test_simple_command(self, env): ...
    def test_exit_code_preserved(self, env): ...
    def test_cwd_persists_across_calls(self, env): ...
    def test_env_var_persists_across_calls(self, env): ...
    def test_stdin_data(self, env): ...
    def test_single_quotes_in_command(self, env): ...
    def test_timeout(self, env): ...
    def test_cd_nonexistent_returns_126(self, env): ...
    def test_binary_output_caught(self, env): ...
```

**Testing commands:**
```bash
# Unit tests (always)
uv run pytest tests/tools/test_threaded_process_handle.py tests/tools/test_base_environment.py -v -o "addopts="

# Local backend compat
uv run pytest tests/test_env_backend_compat.py -v -o "addopts=" -k "local"

# Docker backend compat
uv run pytest tests/test_env_backend_compat.py -v -o "addopts=" -m "docker"

# SSH backend compat
TERMINAL_SSH_HOST=<host> TERMINAL_SSH_USER=<user> \
  uv run pytest tests/test_env_backend_compat.py -v -o "addopts=" -m "ssh"

# Daytona (mocked)
uv run pytest tests/tools/test_daytona_environment.py -v -o "addopts="
```

### Integration Smoke Tests (manual, pre-merge)

```bash
# CWD tracking
TERMINAL_ENV=local uv run hermes chat -q \
  "Run 'cd /tmp' in terminal, then run 'pwd' in a separate terminal call." --yolo

# Env var persistence
TERMINAL_ENV=local uv run hermes chat -q \
  "Run 'export MY_TEST_VAR=hello123' then in a separate call run 'echo \$MY_TEST_VAR'" --yolo

# SSH
TERMINAL_ENV=ssh TERMINAL_SSH_HOST=<host> TERMINAL_SSH_USER=<user> \
  uv run hermes chat -q \
  "Run 'cd /tmp' then 'pwd' in separate terminal calls." --yolo
```

**Verification checklist:**
- [ ] No `__HERMES_CWD_{session}__` markers visible in command output
- [ ] CWD persists across calls (model reports correct directory)
- [ ] Exit codes are correct
- [ ] Interrupted commands return rc=130
- [ ] No Python tracebacks in logs

### Comprehensive Backend x Tool Matrix Test Plan

**Tools affected by the unified execution layer refactor:**

| Tool | env.execute() usage | Key capabilities exercised |
|------|---------------------|---------------------------|
| `terminal` (fg) | Direct `execute(command)` | CWD tracking, env var persistence, timeout |
| `terminal` (bg) | via `spawn_via_env` | Concurrent poller thread, nohup/PID tracking |
| `read_file` | `ShellFileOperations._exec()` | CWD override, output parsing |
| `write_file` | `_exec(stdin_data=content)` | `stdin_data` piping, heredoc embedding |
| `patch` | Read + fuzzy match + `_exec(stdin_data=...)` | `stdin_data`, file round-trip |
| `search_files` | `_exec()` | `rg`/`find` invocation, output parsing |
| `execute_code` | 10+ `execute()` calls, concurrent RPC thread | Concurrent execute, base64 file I/O, cwd="/", env var prefix |

**Backends to test:** local, docker, ssh, modal, daytona
*ManagedModal unchanged (uses its own execute via gateway).*

**Test prompts per backend:**

All backends get the same prompt (substitute env var values per backend).
Each prompt exercises: CWD tracking, env var persistence, write_file, read_file,
search_files, patch, and background tasks (local/docker/ssh only).

```
# LOCAL
TERMINAL_ENV=local uv run hermes chat -q "<prompt>" --yolo

# DOCKER
TERMINAL_ENV=docker uv run hermes chat -q "<prompt>" --yolo

# SSH
TERMINAL_ENV=ssh TERMINAL_SSH_HOST=zephyr TERMINAL_SSH_USER=sidbin \
  uv run hermes chat -q "<prompt>" --yolo

# MODAL
TERMINAL_ENV=modal TERMINAL_MODAL_MODE=direct \
  uv run hermes chat -q "<prompt>" --yolo

# DAYTONA
TERMINAL_ENV=daytona uv run hermes chat -q "<prompt>" --yolo
```

**Prompt template (each step in a separate tool call):**

```
Do these steps, each in separate terminal/file tool calls:
1. terminal: cd /tmp && mkdir -p hermes-test-pr2
2. terminal: pwd (verify /tmp/hermes-test-pr2)
3. terminal: export HERMES_TEST_VAR=hello123
4. terminal: echo $HERMES_TEST_VAR (verify hello123)
5. write_file: /tmp/hermes-test-pr2/test.txt with "hello world"
6. read_file: /tmp/hermes-test-pr2/test.txt
7. search_files: find "hello" in /tmp/hermes-test-pr2
8. patch: replace "hello" with "goodbye" in test.txt
9. read_file: verify patch applied
10. terminal (background): sleep 5 && echo done > /tmp/hermes-test-pr2/bg.txt
11. terminal: sleep 6 && cat /tmp/hermes-test-pr2/bg.txt
12. terminal: rm -rf /tmp/hermes-test-pr2
Report each result.
```

**Per-backend verification checklist:**

- [ ] CWD tracking: cd persists to next pwd call
- [ ] Env var persistence: export persists to next echo call
- [ ] write_file + read_file round-trip: content matches
- [ ] search_files: finds the expected match
- [ ] patch: replacement applied correctly
- [ ] Background tasks (local/docker/ssh only): output file created
- [ ] No CWD markers in any tool output
- [ ] No Python tracebacks in hermes logs
- [ ] Exit codes correct: successful commands return 0

**Backend-specific checks:**

| Backend | Extra check |
|---------|-------------|
| Local | CWD file /tmp/hermes-cwd-*.txt exists during session |
| Docker | No -e env flags on post-init docker commands (check logs) |
| SSH | ControlMaster socket reused (check /tmp/hermes-ssh/) |
| Modal | cancel_fn wired (interrupt sleep 60, verify rc=130) |
| Daytona | _before_execute calls _ensure_sandbox_ready then super (check logs) |

---

## PR 3: SSH File Sync Mtime Caching (separate perf fix)

**Goal:** Reduce SSH per-command overhead from ~3s to ~0.6s by adding mtime+size caching to rsync.

### Files

| File | Change |
|------|--------|
| `tools/environments/ssh.py` | Add mtime+size caching for credential files, directory fingerprint for skills, `--delete` flag, track created remote dirs, cache invalidation on failure, `force=True` escape hatch |

### Changes

- **Per-file `(mtime, size)` check** for credential files — skip rsync when unchanged
- **Directory fingerprint** `set[tuple[relpath, mtime, size]]` for skills directory — skip rsync when fingerprint matches
- **`--delete` flag** on skills rsync to prune uninstalled skills from remote
- **Track `_created_remote_dirs`** to avoid redundant `mkdir -p` SSH round-trips
- **Cache invalidation** on rsync failure (remote may have been wiped/recreated)
- **`force=True` parameter** as escape hatch for debugging
- **TTL-based sync skip** (`_SYNC_INTERVAL_SECONDS = 5.0`) — all remote backends skip re-walking within this window

### Performance

| Metric | Before | After |
|--------|--------|-------|
| Per SSH command | ~3.0s (2.3s rsync + 0.6s exec) | ~0.6s (mtime check + exec) |
| SSH test suite | 134s | 50s |

This PR can land independently at any time. If it lands before PR 2, PR 2 carries it forward.

---

## PR Ordering (Stacked PRs)

```
main
 └── PR 1 (Tool Result Persistence)         branch: sid/tool-result-fixes       PR #6040
      └── PR 2 (Unified Execution Layer)     branch: sid/unified-execution
           └── PR 3 (SSH Mtime Caching)      branch: sid/ssh-mtime-cache
```

**Merge order:** PR 1 -> PR 2 -> PR 3 (strictly sequential).

---

## Open Items / Follow-ups

1. **ManagedModal gateway init**: Separate issue — have the gateway run `init_session()` equivalent on sandbox creation so ManagedModal gets snapshot/env persistence.
2. **SDK streaming for Modal/Daytona**: `_ThreadedProcessHandle` batches all output at once. Follow-up to add incremental streaming via Modal's async stdout iteration.
3. **SSH remote orphan on interrupt**: `proc.terminate()` kills local ssh client but remote command may continue. Exists on main today. Follow-up for remote kill over ControlMaster.
4. **Daytona SDK timeout unreliability**: The `timeout N sh -c cmd` wrapper is preserved. Verify it composes correctly with snapshot sourcing in `_wrap_command()`.
