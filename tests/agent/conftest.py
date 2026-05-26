"""Agent test conftest — pre-populates the registry with safe mock stubs.

Unit tests in tests/agent/ import core modules directly without going through
the normal startup sequence (PluginManager.discover_and_load()).  Any code path
that calls registries.get_provider_service("anthropic", ...) would return None
and either crash or silently degrade.

This conftest installs a minimal mock anthropic namespace in the registry before
each test, so that:
  - _try_anthropic(), _maybe_wrap_anthropic(), etc. don't crash
  - Tests that want to verify specific behaviour can override individual keys
    with their own patch.dict / mock_anthropic_provider context manager
  - The anthropic SDK never actually needs to be installed in the test env

NOTE: The autouse fixture uses `autouse=True` with session scope so it only
runs once per session and doesn't slow down individual tests.
"""

from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest

__all__ = ["mock_anthropic_provider"]


def _make_base_anthropic_namespace() -> dict:
    """Build a minimal anthropic service namespace with safe mock stubs."""
    mock_client = MagicMock(name="anthropic_client")
    mock_client.base_url = "https://api.anthropic.com/v1"
    mock_client.api_key = "sk-ant-mock"

    def _resolve_token():
        """Return token from env vars if set — mimics the real resolve_anthropic_token."""
        import os
        return (os.environ.get("ANTHROPIC_TOKEN")
                or os.environ.get("ANTHROPIC_API_KEY"))

    def _build_kwargs_passthrough(model=None, messages=None, tools=None,
                                   max_tokens=None, **kwargs):
        """Mock build_anthropic_kwargs that passes through the key fields."""
        result = {}
        if model is not None:
            result["model"] = model
        if messages is not None:
            result["messages"] = messages
        if tools:
            result["tools"] = tools
        if max_tokens is not None:
            result["max_tokens"] = max_tokens
        return result

    def _convert_tools(tools):
        """Passthrough mock for convert_tools_to_anthropic."""
        result = []
        for t in (tools or []):
            fn = t.get("function", {})
            result.append({
                "name": fn.get("name", ""),
                "description": fn.get("description", ""),
                "input_schema": fn.get("parameters", {}),
            })
        return result

    def _convert_messages(messages, **kwargs):
        """Passthrough mock for convert_messages_to_anthropic."""
        system = None
        msgs = []
        for m in (messages or []):
            if m.get("role") == "system":
                system = m.get("content")
            else:
                msgs.append(m)
        return system, msgs

    return {
        "build_anthropic_client": MagicMock(return_value=mock_client),
        "build_anthropic_kwargs": _build_kwargs_passthrough,
        "convert_tools_to_anthropic": _convert_tools,
        "convert_messages_to_anthropic": _convert_messages,
        "resolve_anthropic_token": _resolve_token,
        "_is_oauth_token": lambda k: bool(k) and not (k or "").startswith("sk-ant-api"),
        "is_claude_code_token_valid": MagicMock(return_value=False),
        "read_claude_code_credentials": MagicMock(return_value=None),
        "write_claude_code_credentials": MagicMock(),
        "refresh_oauth_token": MagicMock(return_value=None),
        "run_hermes_oauth_login_pure": MagicMock(return_value=("mock-token", None)),
        "_HERMES_OAUTH_FILE": MagicMock(),
        "_to_plain_data": MagicMock(return_value=None),
        "_anthropic_sdk": None,  # SDK not installed in test env
    }


@contextmanager
def mock_anthropic_provider(**overrides):
    """Patch the anthropic registry namespace. Use in core tests instead of
    patching hermes_agent_anthropic.adapter.* directly.

    Usage:
        with mock_anthropic_provider(build_anthropic_client=my_mock):
            result = _try_anthropic()
    """
    from agent.plugin_registries import registries
    base = _make_base_anthropic_namespace()
    base.update(overrides)
    with patch.dict(registries._provider_services, {"anthropic": base}):
        yield base


@pytest.fixture(autouse=True)
def _seed_anthropic_registry():
    """Install mock anthropic namespace before each test, restore after.

    Uses patch.dict so it's guaranteed to restore even when plugin tests
    in other directories (which use the real plugin) run before us in the
    same process. Function-scoped (not session) so it re-seeds after each
    plugin test that overwrites the registry.
    """
    from unittest.mock import patch
    from agent.plugin_registries import registries
    ns = _make_base_anthropic_namespace()
    with patch.dict(registries._provider_services, {"anthropic": ns}):
        yield
