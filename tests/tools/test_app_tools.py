"""Unit tests for tools/app_tools.py — the Nous tool gateway integration."""

from __future__ import annotations

import json
import types
from unittest.mock import MagicMock, patch

import httpx
import pytest

from tools.managed_tool_gateway import ManagedToolGatewayConfig


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_FAKE_GATEWAY = ManagedToolGatewayConfig(
    vendor="tools",
    gateway_origin="https://tools-gateway.example.com",
    nous_user_token="test-token-abc123",
    managed_mode=True,
)


def _mock_httpx_response(status_code: int = 200, json_body: dict | None = None):
    """Build a mock httpx.Response."""
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    resp.json.return_value = json_body or {"data": {}, "error": None}
    resp.text = json.dumps(json_body or {"data": {}, "error": None})
    return resp


# ---------------------------------------------------------------------------
# 1. check_fn gating
# ---------------------------------------------------------------------------

class TestAppToolsAvailability:
    def test_returns_false_when_gateway_not_ready(self, monkeypatch):
        monkeypatch.setattr(
            "tools.app_tools.is_managed_tool_gateway_ready", lambda vendor: False
        )
        monkeypatch.setattr(
            "tools.app_tools._read_portal_app_tools_enabled", lambda: True
        )
        from tools.app_tools import _app_tools_available
        assert _app_tools_available() is False

    def test_returns_true_when_gateway_ready_and_config_on(self, monkeypatch):
        monkeypatch.setattr(
            "tools.app_tools.is_managed_tool_gateway_ready", lambda vendor: True
        )
        monkeypatch.setattr(
            "tools.app_tools._read_portal_app_tools_enabled", lambda: True
        )
        from tools.app_tools import _app_tools_available
        assert _app_tools_available() is True

    def test_returns_false_when_config_off(self, monkeypatch):
        monkeypatch.setattr(
            "tools.app_tools.is_managed_tool_gateway_ready", lambda vendor: True
        )
        monkeypatch.setattr(
            "tools.app_tools._read_portal_app_tools_enabled", lambda: False
        )
        from tools.app_tools import _app_tools_available
        assert _app_tools_available() is False


# ---------------------------------------------------------------------------
# 2. URL + auth header
# ---------------------------------------------------------------------------

class TestSearchPostsCorrectUrlAndAuth:
    def test_posts_to_v1_search_with_bearer_token(self, monkeypatch):
        monkeypatch.setattr(
            "tools.app_tools.resolve_managed_tool_gateway", lambda v: _FAKE_GATEWAY
        )
        monkeypatch.setattr(
            "tools.app_tools._get_current_model_name", lambda: "test-model"
        )

        captured = {}
        fake_resp = _mock_httpx_response(200, {"data": {"results": []}, "error": None})

        def fake_post(self, url, *, json=None, headers=None):
            captured["url"] = url
            captured["headers"] = headers
            captured["json"] = json
            return fake_resp

        monkeypatch.setattr(httpx.Client, "post", fake_post)

        from tools.app_tools import handle_app_search_tools
        result = handle_app_search_tools({"queries": [{"use_case": "send email"}]})

        assert captured["url"] == "https://tools-gateway.example.com/v1/search"
        assert captured["headers"]["Authorization"] == "Bearer test-token-abc123"
        assert captured["headers"]["Content-Type"] == "application/json"
        assert captured["json"]["queries"] == [{"use_case": "send email"}]
        assert captured["json"]["model"] == "test-model"


# ---------------------------------------------------------------------------
# 3. Model auto-injection
# ---------------------------------------------------------------------------

class TestModelAutoInjection:
    def test_injects_model_from_config(self, monkeypatch):
        monkeypatch.setattr(
            "tools.app_tools.resolve_managed_tool_gateway", lambda v: _FAKE_GATEWAY
        )
        monkeypatch.setattr(
            "tools.app_tools._get_current_model_name", lambda: "claude-sonnet-4"
        )
        captured = {}
        fake_resp = _mock_httpx_response(200, {"data": {}, "error": None})

        def fake_post(self, url, *, json=None, headers=None):
            captured["json"] = json
            return fake_resp

        monkeypatch.setattr(httpx.Client, "post", fake_post)

        from tools.app_tools import handle_app_search_tools
        handle_app_search_tools({"queries": [{"use_case": "test"}]})
        assert captured["json"]["model"] == "claude-sonnet-4"

    def test_omits_model_when_unresolvable(self, monkeypatch):
        monkeypatch.setattr(
            "tools.app_tools.resolve_managed_tool_gateway", lambda v: _FAKE_GATEWAY
        )
        monkeypatch.setattr(
            "tools.app_tools._get_current_model_name", lambda: None
        )
        captured = {}
        fake_resp = _mock_httpx_response(200, {"data": {}, "error": None})

        def fake_post(self, url, *, json=None, headers=None):
            captured["json"] = json
            return fake_resp

        monkeypatch.setattr(httpx.Client, "post", fake_post)

        from tools.app_tools import handle_app_search_tools
        handle_app_search_tools({"queries": [{"use_case": "test"}]})
        assert "model" not in captured["json"]


# ---------------------------------------------------------------------------
# 4. Composio-specific param stripping
# ---------------------------------------------------------------------------

class TestExecuteStripsComposioParams:
    def test_strips_sync_response_thought_step_metric(self, monkeypatch):
        monkeypatch.setattr(
            "tools.app_tools.resolve_managed_tool_gateway", lambda v: _FAKE_GATEWAY
        )
        captured = {}
        fake_resp = _mock_httpx_response(200, {"data": {"results": []}, "error": None})

        def fake_post(self, url, *, json=None, headers=None):
            captured["json"] = json
            return fake_resp

        monkeypatch.setattr(httpx.Client, "post", fake_post)

        from tools.app_tools import handle_app_execute_tools
        handle_app_execute_tools({
            "tools": [{"tool_slug": "TEST", "arguments": {}}],
            "sync_response_to_workbench": True,
            "thought": "testing",
            "current_step": "TESTING",
            "current_step_metric": "1/1 tests",
        })

        body = captured["json"]
        assert "sync_response_to_workbench" not in body
        assert "thought" not in body
        assert "current_step" not in body
        assert "current_step_metric" not in body
        assert body["tools"] == [{"tool_slug": "TEST", "arguments": {}}]


# ---------------------------------------------------------------------------
# 5. HTTP error → tool result (not exception)
# ---------------------------------------------------------------------------

class TestHttpErrorReturnedAsToolResult:
    @pytest.mark.parametrize("status_code", [402, 403, 422, 500])
    def test_returns_error_json_not_exception(self, monkeypatch, status_code):
        monkeypatch.setattr(
            "tools.app_tools.resolve_managed_tool_gateway", lambda v: _FAKE_GATEWAY
        )
        error_body = {"error": {"code": "TEST_ERROR", "message": "fail"}}
        fake_resp = _mock_httpx_response(status_code, error_body)

        def fake_post(self, url, *, json=None, headers=None):
            return fake_resp

        monkeypatch.setattr(httpx.Client, "post", fake_post)

        from tools.app_tools import handle_app_search_tools
        result_str = handle_app_search_tools({"queries": [{"use_case": "test"}]})
        result = json.loads(result_str)
        assert result["error"]["code"] == "TEST_ERROR"


# ---------------------------------------------------------------------------
# 6. Network failure → tool result
# ---------------------------------------------------------------------------

class TestNetworkFailureReturnedAsToolResult:
    def test_connect_error_returns_gateway_unreachable(self, monkeypatch):
        monkeypatch.setattr(
            "tools.app_tools.resolve_managed_tool_gateway", lambda v: _FAKE_GATEWAY
        )

        def fake_post(self, url, *, json=None, headers=None):
            raise httpx.ConnectError("Connection refused")

        monkeypatch.setattr(httpx.Client, "post", fake_post)

        from tools.app_tools import handle_app_search_tools
        result_str = handle_app_search_tools({"queries": [{"use_case": "test"}]})
        result = json.loads(result_str)
        assert result["error"]["code"] == "GATEWAY_UNREACHABLE"

    def test_timeout_returns_gateway_timeout(self, monkeypatch):
        monkeypatch.setattr(
            "tools.app_tools.resolve_managed_tool_gateway", lambda v: _FAKE_GATEWAY
        )

        def fake_post(self, url, *, json=None, headers=None):
            raise httpx.ReadTimeout("timed out")

        monkeypatch.setattr(httpx.Client, "post", fake_post)

        from tools.app_tools import handle_app_search_tools
        result_str = handle_app_search_tools({"queries": [{"use_case": "test"}]})
        result = json.loads(result_str)
        assert result["error"]["code"] == "GATEWAY_TIMEOUT"


# ---------------------------------------------------------------------------
# 7. manage_connections forwards toolkits
# ---------------------------------------------------------------------------

class TestManageConnectionsForwardsToolkits:
    def test_forwards_toolkits_and_reinitiate(self, monkeypatch):
        monkeypatch.setattr(
            "tools.app_tools.resolve_managed_tool_gateway", lambda v: _FAKE_GATEWAY
        )
        captured = {}
        fake_resp = _mock_httpx_response(200, {"data": {}, "error": None})

        def fake_post(self, url, *, json=None, headers=None):
            captured["url"] = url
            captured["json"] = json
            return fake_resp

        monkeypatch.setattr(httpx.Client, "post", fake_post)

        from tools.app_tools import handle_app_manage_connections
        handle_app_manage_connections({
            "toolkits": ["gmail", "slack"],
            "reinitiate_all": True,
        })

        assert captured["url"].endswith("/v1/connections")
        assert captured["json"]["toolkits"] == ["gmail", "slack"]
        assert captured["json"]["reinitiate_all"] is True


# ---------------------------------------------------------------------------
# 8. tool_schemas forwards slugs
# ---------------------------------------------------------------------------

class TestToolSchemasForwardsSlugs:
    def test_forwards_slugs_and_include(self, monkeypatch):
        monkeypatch.setattr(
            "tools.app_tools.resolve_managed_tool_gateway", lambda v: _FAKE_GATEWAY
        )
        captured = {}
        fake_resp = _mock_httpx_response(200, {"data": {}, "error": None})

        def fake_post(self, url, *, json=None, headers=None):
            captured["url"] = url
            captured["json"] = json
            return fake_resp

        monkeypatch.setattr(httpx.Client, "post", fake_post)

        from tools.app_tools import handle_app_tool_schemas
        handle_app_tool_schemas({
            "tool_slugs": ["GMAIL_SEND_EMAIL"],
            "include": ["input_schema", "output_schema"],
        })

        assert captured["url"].endswith("/v1/schemas")
        assert captured["json"]["tool_slugs"] == ["GMAIL_SEND_EMAIL"]
        assert captured["json"]["include"] == ["input_schema", "output_schema"]


# ---------------------------------------------------------------------------
# 9. Registry entries exist
# ---------------------------------------------------------------------------

class TestRegistryEntries:
    def test_all_four_tools_registered_under_app_tools(self):
        from tools.registry import registry
        # Force import so registrations run
        import tools.app_tools  # noqa: F401

        expected = {
            "app_search_tools", "app_tool_schemas",
            "app_execute_tools", "app_manage_connections",
        }
        for name in expected:
            entry = registry._tools.get(name)
            assert entry is not None, f"{name} not registered"
            assert entry.toolset == "app_tools"


# ---------------------------------------------------------------------------
# 10. session (object) vs session_id (string) asymmetry
# ---------------------------------------------------------------------------

class TestSessionVsSessionIdAsymmetry:
    def _capture_post(self, monkeypatch):
        monkeypatch.setattr(
            "tools.app_tools.resolve_managed_tool_gateway", lambda v: _FAKE_GATEWAY
        )
        monkeypatch.setattr(
            "tools.app_tools._get_current_model_name", lambda: None
        )
        captured = {}
        fake_resp = _mock_httpx_response(200, {"data": {}, "error": None})

        def fake_post(self, url, *, json=None, headers=None):
            captured["json"] = json
            return fake_resp

        monkeypatch.setattr(httpx.Client, "post", fake_post)
        return captured

    def test_search_uses_session_object(self, monkeypatch):
        captured = self._capture_post(monkeypatch)
        from tools.app_tools import handle_app_search_tools
        handle_app_search_tools({
            "queries": [{"use_case": "test"}],
            "session": {"generate_id": True},
        })
        assert "session" in captured["json"]
        assert isinstance(captured["json"]["session"], dict)
        assert "session_id" not in captured["json"]

    def test_schemas_uses_session_id_string(self, monkeypatch):
        captured = self._capture_post(monkeypatch)
        from tools.app_tools import handle_app_tool_schemas
        handle_app_tool_schemas({
            "tool_slugs": ["TEST"],
            "session_id": "sess-123",
        })
        assert captured["json"]["session_id"] == "sess-123"
        assert "session" not in captured["json"]

    def test_execute_uses_session_id_string(self, monkeypatch):
        captured = self._capture_post(monkeypatch)
        from tools.app_tools import handle_app_execute_tools
        handle_app_execute_tools({
            "tools": [{"tool_slug": "TEST", "arguments": {}}],
            "session_id": "sess-456",
        })
        assert captured["json"]["session_id"] == "sess-456"
        assert "session" not in captured["json"]

    def test_connections_uses_session_id_string(self, monkeypatch):
        captured = self._capture_post(monkeypatch)
        from tools.app_tools import handle_app_manage_connections
        handle_app_manage_connections({
            "toolkits": ["gmail"],
            "session_id": "sess-789",
        })
        assert captured["json"]["session_id"] == "sess-789"
        assert "session" not in captured["json"]


# ---------------------------------------------------------------------------
# 11. Config toggle disables check_fn
# ---------------------------------------------------------------------------

class TestConfigToggleDisablesCheckFn:
    def test_portal_app_tools_false_disables_availability(self, monkeypatch):
        monkeypatch.setattr(
            "tools.app_tools.is_managed_tool_gateway_ready", lambda vendor: True
        )
        monkeypatch.setattr(
            "tools.app_tools._read_portal_app_tools_enabled", lambda: False
        )
        from tools.app_tools import _app_tools_available
        assert _app_tools_available() is False
