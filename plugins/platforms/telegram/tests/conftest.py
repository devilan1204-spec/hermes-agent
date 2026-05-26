"""Shared fixtures for telegram plugin tests.

Provides the ``_ensure_telegram_mock`` helper that guarantees a minimal mock
of the ``telegram`` package is registered in :data:`sys.modules` **before**
any test file triggers ``from hermes_agent_telegram import ...``.
"""

import sys
from unittest.mock import MagicMock

import pytest


def _ensure_telegram_mock():
    if "telegram" in sys.modules and hasattr(sys.modules["telegram"], "__file__"):
        return
    mod = MagicMock()
    mod.ext.ContextTypes.DEFAULT_TYPE = type(None)
    mod.constants.ParseMode.MARKDOWN_V2 = "MarkdownV2"
    mod.constants.ChatType.GROUP = "group"
    mod.constants.ChatType.SUPERGROUP = "supergroup"
    mod.constants.ChatType.CHANNEL = "channel"
    mod.constants.ChatType.PRIVATE = "private"
    for name in ("telegram", "telegram.ext", "telegram.constants", "telegram.request"):
        sys.modules.setdefault(name, mod)


# Auto-apply at collection time so every test file sees the mock.
_ensure_telegram_mock()
