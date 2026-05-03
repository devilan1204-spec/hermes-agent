"""TinyFish cloud browser provider."""

import logging
import os
import uuid
from typing import Any, Dict, Optional

import requests

from tools.browser_providers.base import CloudBrowserProvider
from tools.managed_tool_gateway import resolve_managed_tool_gateway

logger = logging.getLogger(__name__)

_DEFAULT_BASE_URL = "https://api.browser.tinyfish.ai"
_DEFAULT_TIMEOUT_SECONDS = 300


class TinyFishBrowserProvider(CloudBrowserProvider):
    """TinyFish (https://tinyfish.ai) cloud browser backend."""

    def provider_name(self) -> str:
        return "TinyFish"

    # ------------------------------------------------------------------
    # Config resolution (direct API key OR managed Nous gateway)
    # ------------------------------------------------------------------

    def _get_config_or_none(self) -> Optional[Dict[str, Any]]:
        api_key = os.environ.get("TINYFISH_API_KEY")
        if api_key:
            return {
                "api_key": api_key,
                "base_url": os.environ.get("TINYFISH_API_URL", _DEFAULT_BASE_URL).rstrip("/"),
                "managed_mode": False,
            }

        managed = resolve_managed_tool_gateway("tinyfish")
        if managed is None:
            return None

        return {
            "api_key": managed.nous_user_token,
            "base_url": managed.gateway_origin.rstrip("/"),
            "managed_mode": True,
        }

    def _get_config(self) -> Dict[str, Any]:
        config = self._get_config_or_none()
        if config is None:
            raise ValueError(
                "TinyFish requires a TINYFISH_API_KEY environment variable. "
                "Get your API key at https://agent.tinyfish.ai/api-keys"
            )
        return config

    def is_configured(self) -> bool:
        return self._get_config_or_none() is not None

    # ------------------------------------------------------------------
    # Session lifecycle
    # ------------------------------------------------------------------

    def _headers(self, config: Dict[str, Any]) -> Dict[str, str]:
        return {
            "X-API-Key": config["api_key"],
            "Content-Type": "application/json",
        }

    def create_session(self, task_id: str) -> Dict[str, object]:
        config = self._get_config()

        timeout_seconds = _DEFAULT_TIMEOUT_SECONDS
        try:
            timeout_seconds = int(os.environ.get("TINYFISH_BROWSER_TIMEOUT", str(_DEFAULT_TIMEOUT_SECONDS)))
        except (ValueError, TypeError):
            pass

        response = requests.post(
            config["base_url"],
            headers=self._headers(config),
            json={"timeout_seconds": timeout_seconds},
            timeout=30,
        )

        if response.status_code in (401, 403):
            raise ValueError(
                f"TinyFish authentication failed (HTTP {response.status_code}). "
                "Check your TINYFISH_API_KEY at https://agent.tinyfish.ai/api-keys"
            )
        if response.status_code == 402:
            raise ValueError(
                "TinyFish browser session failed: insufficient credits or no active subscription. "
                "Check your account at https://agent.tinyfish.ai"
            )
        if response.status_code == 404:
            raise ValueError(
                "TinyFish browser API is not enabled on your plan. "
                "Contact support or upgrade at https://agent.tinyfish.ai"
            )
        if not response.ok:
            raise RuntimeError(
                f"Failed to create TinyFish browser session: "
                f"{response.status_code} {response.text[:200]}"
            )

        data = response.json()
        session_name = f"hermes_{task_id}_{uuid.uuid4().hex[:8]}"

        logger.info("Created TinyFish browser session %s", session_name)

        return {
            "session_name": session_name,
            "bb_session_id": data["session_id"],
            "cdp_url": data["cdp_url"],
            "features": {"tinyfish": True},
        }

    def close_session(self, session_id: str) -> bool:
        # TinyFish has no explicit delete endpoint — sessions auto-expire on inactivity timeout.
        logger.debug(
            "TinyFish sessions expire automatically on inactivity — no close call needed for %s",
            session_id,
        )
        return True

    def emergency_cleanup(self, session_id: str) -> None:
        # No-op: TinyFish sessions are cleaned up server-side on inactivity.
        logger.debug("TinyFish emergency_cleanup skipped for %s — auto-expiry handles cleanup", session_id)
