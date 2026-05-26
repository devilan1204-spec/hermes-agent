"""Shared fixtures for anthropic plugin tests.

Registers the anthropic plugin in the singleton registry before each test
and provides the ``agent`` fixture used by integration tests.
"""

from unittest.mock import MagicMock, patch

import pytest


class _MinimalCtx:
    """Minimal plugin context that only wires up provider_services."""

    def register_provider_services(self, name, services):
        from agent.plugin_registries import registries
        registries.register_provider_services(name, services)

    # No-ops for all other register_* methods so plugins don't crash.
    def register_platform(self, *a, **kw): pass
    def register_tool_provider_entry(self, *a, **kw): pass
    def register_auth_provider(self, *a, **kw): pass
    def register_transport_builder(self, *a, **kw): pass
    def register_model_metadata_provider(self, *a, **kw): pass
    def register_credential_pool(self, *a, **kw): pass
    def register_browser_provider(self, *a, **kw): pass
    def register_image_gen_provider(self, *a, **kw): pass
    def register_video_gen_provider(self, *a, **kw): pass


@pytest.fixture(autouse=True)
def _register_anthropic_plugin():
    """Register the real anthropic plugin for the duration of each test,
    then restore the registry to its prior state afterwards.

    Uses patch.dict so the registry is guaranteed to be restored even if
    tests run across conftest scopes in the same process.
    """
    from unittest.mock import patch
    from agent.plugin_registries import registries

    # Build a fresh real-plugin namespace by calling register() against a
    # collector context, then inject it via patch.dict for isolation.
    collected: dict = {}

    class _CollectCtx:
        def register_provider_services(self, name, services):
            if name == "anthropic":
                # Go through the real register_provider_services so _LazyRef
                # wrappers are created. This makes patch("hermes_agent_anthropic.adapter.X")
                # work in plugin tests (the _LazyRef re-reads from the module at call time).
                registries.register_provider_services(name, services)
                collected.update(registries._provider_services.get(name, {}))
        def register_platform(self, *a, **kw): pass
        def register_tool_provider_entry(self, *a, **kw): pass
        def register_auth_provider(self, *a, **kw): pass
        def register_transport_builder(self, *a, **kw): pass
        def register_model_metadata_provider(self, *a, **kw): pass
        def register_credential_pool(self, *a, **kw): pass
        def register_browser_provider(self, *a, **kw): pass
        def register_image_gen_provider(self, *a, **kw): pass
        def register_video_gen_provider(self, *a, **kw): pass

    try:
        from hermes_agent_anthropic import register as _reg  # type: ignore[import]
        _reg(_CollectCtx())
    except ImportError:
        pass

    with patch.dict(registries._provider_services, {"anthropic": collected}):
        yield


def _make_tool_defs(*names: str) -> list:
    """Build minimal tool definition list accepted by AIAgent.__init__."""
    return [
        {
            "type": "function",
            "function": {
                "name": n,
                "description": f"{n} tool",
                "parameters": {"type": "object", "properties": {}},
            },
        }
        for n in names
    ]


@pytest.fixture()
def agent():
    """Minimal AIAgent with mocked OpenAI client and tool loading."""
    from run_agent import AIAgent
    with (
        patch(
            "run_agent.get_tool_definitions", return_value=_make_tool_defs("web_search")
        ),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI"),
    ):
        a = AIAgent(
            api_key="test-key-1234567890",
            base_url="https://openrouter.ai/api/v1",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
        )
        a.client = MagicMock()
        return a
