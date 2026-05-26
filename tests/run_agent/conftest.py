"""run_agent test conftest — same pattern as tests/agent/conftest.py."""

from unittest.mock import MagicMock, patch
import pytest


def _make_base_anthropic_namespace() -> dict:
    mock_client = MagicMock(name="anthropic_client")
    mock_client.base_url = "https://api.anthropic.com/v1"
    mock_client.api_key = "sk-ant-mock"

    def _resolve_token():
        import os
        return os.environ.get("ANTHROPIC_TOKEN") or os.environ.get("ANTHROPIC_API_KEY")

    def _build_kwargs_passthrough(model=None, messages=None, tools=None,
                                   max_tokens=None, **kwargs):
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
        "_anthropic_sdk": None,
    }


@pytest.fixture(autouse=True)
def _seed_anthropic_registry():
    """Install mock anthropic namespace before each test, restore after."""
    from agent.plugin_registries import registries
    ns = _make_base_anthropic_namespace()
    with patch.dict(registries._provider_services, {"anthropic": ns}):
        yield
