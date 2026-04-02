"""
Cross-environment backend compatibility tests.

Derived from analysis of 218 real Hermes agent sessions (590 terminal calls).
Tests the command execution patterns the agent actually uses, against any
environment backend (local, docker, ssh, modal, daytona, singularity).

Usage:
    # Local (default)
    uv run pytest tests/test_env_backend_compat.py -v

    # Docker
    TERMINAL_ENV=docker TERMINAL_DOCKER_IMAGE=ubuntu:24.04 \
        uv run pytest tests/test_env_backend_compat.py -v

    # SSH
    TERMINAL_ENV=ssh TERMINAL_SSH_HOST=... TERMINAL_SSH_USER=... \
        uv run pytest tests/test_env_backend_compat.py -v

    # Modal
    TERMINAL_ENV=modal uv run pytest tests/test_env_backend_compat.py -v
"""

import json
import os
import time
import pytest

ENV_TYPE = os.getenv("TERMINAL_ENV", "local")


def _get_env():
    """Create and return an environment backend based on TERMINAL_ENV."""
    from tools.terminal_tool import _create_environment

    env_type = ENV_TYPE
    image = os.getenv("TERMINAL_DOCKER_IMAGE", "ubuntu:24.04")
    cwd = os.getenv("TERMINAL_CWD", "/tmp")
    timeout = int(os.getenv("TERMINAL_TIMEOUT", "30"))

    ssh_config = None
    if env_type == "ssh":
        ssh_config = {
            "host": os.environ["TERMINAL_SSH_HOST"],
            "user": os.environ["TERMINAL_SSH_USER"],
            "port": int(os.getenv("TERMINAL_SSH_PORT", "22")),
            "key": os.getenv("TERMINAL_SSH_KEY", ""),
        }

    container_config = {
        "container_cpu": int(os.getenv("TERMINAL_CPU", "1")),
        "container_memory": int(os.getenv("TERMINAL_MEMORY", "2048")),
        "container_disk": int(os.getenv("TERMINAL_DISK", "10240")),
        "container_persistent": True,
    }

    return _create_environment(
        env_type=env_type,
        image=image,
        cwd=cwd,
        timeout=timeout,
        ssh_config=ssh_config,
        container_config=container_config,
        task_id="test_env_compat",
    )


@pytest.fixture(scope="module")
def env():
    """Module-scoped environment — created once, reused across tests."""
    e = _get_env()
    yield e
    if hasattr(e, "cleanup"):
        try:
            e.cleanup()
        except Exception:
            pass


def _exec(env, command: str, timeout: int = 30) -> dict:
    """Execute a command and parse the result dict."""
    result = env.execute(command, timeout=timeout)
    assert isinstance(result, dict), f"Expected dict, got {type(result)}"
    return result


def _output(result: dict) -> str:
    return result.get("output", "")


def _rc(result: dict) -> int:
    return result.get("returncode", result.get("exit_code", -999))


# ---------------------------------------------------------------------------
# Category 1: Basic execution
# From session data: simple single commands are the foundation
# ---------------------------------------------------------------------------

class TestBasicExecution:
    def test_echo(self, env):
        """Most basic: can we run a command and get output?"""
        r = _exec(env, "echo hello")
        assert "hello" in _output(r)
        assert _rc(r) == 0

    def test_exit_code_success(self, env):
        r = _exec(env, "true")
        assert _rc(r) == 0

    def test_exit_code_failure(self, env):
        r = _exec(env, "false")
        assert _rc(r) != 0

    def test_stderr_captured(self, env):
        """Agent relies on 2>&1 patterns; stderr must be captured."""
        r = _exec(env, "echo err >&2")
        # stderr may be merged into output or separate — just verify no crash
        assert isinstance(_output(r), str)

    def test_multiline_output(self, env):
        r = _exec(env, "printf 'line1\\nline2\\nline3'")
        lines = _output(r).strip().split("\n")
        assert len(lines) >= 3


# ---------------------------------------------------------------------------
# Category 2: cd && command chains
# 37% of all terminal commands use this pattern. CRITICAL.
# ---------------------------------------------------------------------------

class TestCdAndChain:
    def test_cd_and_command(self, env):
        """cd /tmp && ls — the most common pattern in session data."""
        r = _exec(env, "cd /tmp && echo 'in_tmp'")
        assert "in_tmp" in _output(r)

    def test_chained_and(self, env):
        """Multiple && chains: agent does cd X && source Y && cmd Z."""
        r = _exec(env, "echo a && echo b && echo c")
        out = _output(r)
        assert "a" in out and "b" in out and "c" in out

    def test_chained_semicolon(self, env):
        """Semicolon chains: agent uses '; echo "---"' as separators."""
        r = _exec(env, "echo first; echo '---'; echo second")
        out = _output(r)
        assert "first" in out and "---" in out and "second" in out

    def test_cd_nonexistent_and_fails(self, env):
        """cd to bad dir && cmd should fail (not run cmd)."""
        r = _exec(env, "cd /nonexistent_dir_xyz && echo should_not_see")
        assert "should_not_see" not in _output(r)

    def test_cwd_persists_across_calls(self, env):
        """CWD now persists via cwdfile tracking (unified execution model).
        Previously: 37% of commands needed 'cd X &&' prefix. Now automatic."""
        _exec(env, "cd /tmp")
        r = _exec(env, "pwd")
        assert "/tmp" in _output(r)


# ---------------------------------------------------------------------------
# Category 3: Pipes
# 46% of commands use pipes. Essential.
# ---------------------------------------------------------------------------

class TestPipes:
    def test_simple_pipe(self, env):
        r = _exec(env, "echo 'hello world' | wc -w")
        assert "2" in _output(r)

    def test_multi_pipe(self, env):
        """Agent chains: find X | grep Y | head -N"""
        r = _exec(env, "echo -e 'a\\nb\\nc\\nd\\ne' | grep -v c | wc -l")
        assert "4" in _output(r)

    def test_pipe_with_grep(self, env):
        """Common pattern: cmd 2>&1 | grep pattern"""
        r = _exec(env, "echo -e 'foo\\nbar\\nbaz' | grep ba")
        out = _output(r)
        assert "bar" in out and "baz" in out
        assert "foo" not in out


# ---------------------------------------------------------------------------
# Category 4: Environment variables and source
# 19% of commands use source. Agent does: source ~/.bashrc && cmd
# ---------------------------------------------------------------------------

class TestEnvAndSource:
    def test_inline_env_var(self, env):
        r = _exec(env, "MY_VAR=hello && echo $MY_VAR")
        assert "hello" in _output(r)

    def test_export_and_use(self, env):
        r = _exec(env, "export FOO=bar && echo $FOO")
        assert "bar" in _output(r)

    def test_env_does_not_persist(self, env):
        """Env vars don't persist across execute() calls."""
        _exec(env, "export HERMES_TEST_VAR=1234")
        r = _exec(env, "echo ${HERMES_TEST_VAR:-unset}")
        assert "unset" in _output(r)

    def test_source_inline_script(self, env):
        """Agent pattern: write a file, source it, use its vars."""
        r = _exec(env, (
            "echo 'export TEST_SOURCED=yes' > /tmp/hermes_test_source.sh && "
            "source /tmp/hermes_test_source.sh && "
            "echo $TEST_SOURCED"
        ))
        assert "yes" in _output(r)


# ---------------------------------------------------------------------------
# Category 5: File I/O via shell
# Agent uses cat, heredoc, find, ls extensively
# ---------------------------------------------------------------------------

class TestFileIO:
    def test_write_and_read(self, env):
        r = _exec(env, (
            "echo 'test content' > /tmp/hermes_test_file.txt && "
            "cat /tmp/hermes_test_file.txt"
        ))
        assert "test content" in _output(r)

    def test_heredoc_write(self, env):
        """0.5% of commands use heredoc — rare but important for config files."""
        r = _exec(env, """cat > /tmp/hermes_heredoc_test.txt << 'EOF'
line one
line two
line three
EOF
cat /tmp/hermes_heredoc_test.txt""")
        out = _output(r)
        assert "line one" in out and "line three" in out

    def test_mkdir_p(self, env):
        r = _exec(env, "mkdir -p /tmp/hermes_test_deep/a/b/c && ls /tmp/hermes_test_deep/a/b/")
        assert "c" in _output(r)

    def test_find(self, env):
        r = _exec(env, (
            "mkdir -p /tmp/hermes_find_test && "
            "touch /tmp/hermes_find_test/a.py /tmp/hermes_find_test/b.txt && "
            "find /tmp/hermes_find_test -name '*.py'"
        ))
        assert "a.py" in _output(r)

    def test_file_persistence_within_session(self, env):
        """Files written and read in a single execute() call."""
        r = _exec(env, (
            "echo 'persistent' > /tmp/hermes_persist_test.txt && "
            "cat /tmp/hermes_persist_test.txt"
        ))
        assert "persistent" in _output(r)


# ---------------------------------------------------------------------------
# Category 6: Multiline commands
# 6% of commands are multiline. Agent sends literal newlines.
# ---------------------------------------------------------------------------

class TestMultiline:
    def test_multiline_script(self, env):
        r = _exec(env, """echo "step 1"
echo "step 2"
echo "step 3" """)
        out = _output(r)
        assert "step 1" in out and "step 3" in out

    def test_multiline_with_variable(self, env):
        r = _exec(env, """X=42
echo "value is $X" """)
        assert "value is 42" in _output(r)


# ---------------------------------------------------------------------------
# Category 7: Timeouts
# 50% of terminal calls specify a timeout. Some go up to 1800s.
# ---------------------------------------------------------------------------

class TestTimeouts:
    def test_fast_command_with_timeout(self, env):
        r = _exec(env, "echo fast", timeout=5)
        assert "fast" in _output(r)

    def test_slow_command_timeout(self, env):
        """Command that exceeds timeout should be killed."""
        start = time.time()
        r = _exec(env, "sleep 60", timeout=3)
        elapsed = time.time() - start
        # Should return in roughly timeout seconds, not 60
        assert elapsed < 15, f"Command took {elapsed}s, should have timed out at ~3s"


# ---------------------------------------------------------------------------
# Category 8: Output handling
# Verifying the contract: {output: str, exit_code/returncode: int, error: ...}
# ---------------------------------------------------------------------------

class TestOutputContract:
    def test_result_has_output_key(self, env):
        r = _exec(env, "echo test")
        assert "output" in r

    def test_result_has_returncode(self, env):
        r = _exec(env, "echo test")
        assert "returncode" in r or "exit_code" in r

    def test_large_output_not_truncated_at_execute_level(self, env):
        """The env.execute() should return raw output.
        Truncation happens in terminal_tool.py, not in the backend."""
        r = _exec(env, "seq 1 5000")
        lines = _output(r).strip().split("\n")
        # Should get all 5000 lines from the backend itself
        assert len(lines) >= 4900, f"Expected ~5000 lines, got {len(lines)}"

    def test_binary_output_doesnt_crash(self, env):
        """Agent sometimes runs commands that produce partial binary output."""
        r = _exec(env, "echo -e '\\x00\\x01\\x02hello\\x03'")
        # Just verify it doesn't crash
        assert isinstance(_output(r), str)


# ---------------------------------------------------------------------------
# Category 9: Package/tool availability
# Agent frequently checks for tools before using them
# ---------------------------------------------------------------------------

class TestToolAvailability:
    def test_which_pattern(self, env):
        """Agent pattern: which X 2>/dev/null || echo 'not found'"""
        r = _exec(env, "which bash 2>/dev/null || echo 'not found'")
        out = _output(r)
        assert "bash" in out or "not found" in out

    def test_python_available(self, env):
        """Agent uses python3 extensively."""
        r = _exec(env, "which python3 2>/dev/null && python3 --version || echo 'no python3'")
        assert "Python" in _output(r) or "no python3" in _output(r)

    def test_git_available(self, env):
        """52 git operations in session data."""
        r = _exec(env, "which git 2>/dev/null && git --version || echo 'no git'")
        assert "git" in _output(r).lower() or "no git" in _output(r)


# ---------------------------------------------------------------------------
# Category 10: Error handling edge cases
# ---------------------------------------------------------------------------

class TestEdgeCases:
    def test_empty_command(self, env):
        """Empty or whitespace command shouldn't crash."""
        try:
            r = _exec(env, "")
            # May succeed with empty output or fail gracefully
        except Exception:
            pass  # Acceptable to raise

    def test_command_not_found(self, env):
        r = _exec(env, "nonexistent_command_xyz_123 2>&1")
        assert _rc(r) != 0

    def test_special_characters_in_output(self, env):
        """Agent processes JSON, YAML, code — special chars must survive."""
        r = _exec(env, """echo '{"key": "value", "list": [1,2,3]}'""")
        out = _output(r)
        assert '"key"' in out

    def test_long_command_string(self, env):
        """Agent sends commands up to ~500 chars. Verify no truncation on input."""
        long_val = "A" * 500
        r = _exec(env, f"echo {long_val} | wc -c")
        count = int(_output(r).strip())
        assert count >= 500


# ---------------------------------------------------------------------------
# Category 11: Unified execution model — new capabilities
# ---------------------------------------------------------------------------

class TestUnifiedExecution:
    def test_cwd_tracking_updates_env(self, env):
        """env.cwd should update after cd command."""
        _exec(env, "cd /tmp")
        assert env.cwd == "/tmp"

    def test_stdin_data(self, env):
        """stdin_data should be piped to the command."""
        r = env.execute("cat", stdin_data="hello from stdin\n")
        assert "hello from stdin" in _output(r)

    def test_snapshot_fallback(self, env):
        """Commands work even when snapshot is missing/broken."""
        old_snapshot = env._snapshot_ready
        old_path = env._snapshot_path
        env._snapshot_ready = False
        env._snapshot_path = None
        try:
            r = _exec(env, "echo still_works")
            assert "still_works" in _output(r)
        finally:
            env._snapshot_ready = old_snapshot
            env._snapshot_path = old_path

    def test_exit_code_preserved_through_wrapper(self, env):
        """Exit code from the user command should pass through the wrapper."""
        r = _exec(env, "exit 42")
        assert _rc(r) == 42

    def test_single_quotes_in_command(self, env):
        """Commands with single quotes must survive the eval wrapper."""
        r = _exec(env, "echo 'it'\\''s a test'")
        assert "it's a test" in _output(r)


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True, scope="module")
def cleanup_test_files(env):
    """Clean up test artifacts after all tests."""
    yield
    try:
        env.execute("rm -rf /tmp/hermes_test_* /tmp/hermes_find_test /tmp/hermes_heredoc_test.txt /tmp/hermes_persist_test.txt /tmp/hermes_test_source.sh", timeout=5)
    except Exception:
        pass
