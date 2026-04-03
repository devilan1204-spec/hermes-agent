#!/usr/bin/env python3
"""
Quick compatibility check: connect to a local OpenAI-compatible endpoint
and run a single agent turn via HermesAgentLoop with all standard tools.

Usage:
    python environments/check_gym_compat.py                    # auto-detect model
    python environments/check_gym_compat.py --model my-model   # explicit model
    python environments/check_gym_compat.py --base-url http://... --model ...
"""

import asyncio
import argparse
import json
import logging
import sys
from pathlib import Path

# Ensure repo root is on sys.path when run as a standalone script
_repo_root = str(Path(__file__).resolve().parent.parent)
if _repo_root not in sys.path:
    sys.path.insert(0, _repo_root)

import requests
from openai import AsyncOpenAI

from environments.agent_loop import HermesAgentLoop, AgentResult
from model_tools import get_tool_definitions

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Thin server wrapper — gives HermesAgentLoop the chat_completion() it wants
# ---------------------------------------------------------------------------

class OpenAIServer:
    """Minimal async server wrapping an OpenAI-compatible endpoint."""

    def __init__(self, base_url: str, model: str, api_key: str = "dummy"):
        self.model = model
        self.client = AsyncOpenAI(base_url=base_url, api_key=api_key)

    async def chat_completion(self, **kwargs):
        kwargs.setdefault("model", self.model)
        return await self.client.chat.completions.create(**kwargs)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def detect_model(base_url: str) -> str:
    try:
        resp = requests.get(f"{base_url}/models", timeout=10)
        resp.raise_for_status()
        models = resp.json().get("data", [])
        if not models:
            print("WARNING: /v1/models returned no models")
            return "default"
        model_id = models[0]["id"]
        print(f"Auto-detected model: {model_id}")
        return model_id
    except Exception as e:
        print(f"Could not auto-detect model ({e}), falling back to 'default'")
        return "default"


async def run_check(base_url: str, model: str, message: str) -> AgentResult:
    server = OpenAIServer(base_url=base_url, model=model)

    # Get all default hermes tools
    tool_schemas = get_tool_definitions(quiet_mode=False)
    valid_names = {t["function"]["name"] for t in tool_schemas}

    agent = HermesAgentLoop(
        server=server,
        tool_schemas=tool_schemas,
        valid_tool_names=valid_names,
        max_turns=5,
    )

    messages = [
        {"role": "system", "content": "You are a helpful assistant with access to tools."},
        {"role": "user", "content": message},
    ]

    return await agent.run(messages)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Check gym endpoint compatibility")
    parser.add_argument("--base-url", default="http://127.0.0.1:11746/v1")
    parser.add_argument("--model", default=None)
    parser.add_argument("--message", default="Hello! What's the current directory you're in?")
    args = parser.parse_args()

    model = args.model or detect_model(args.base_url)

    print(f"\n{'='*60}")
    print(f"Endpoint:  {args.base_url}")
    print(f"Model:     {model}")
    print(f"Message:   {args.message}")
    print(f"{'='*60}\n")

    try:
        result = asyncio.run(run_check(args.base_url, model, args.message))

        print(f"\n{'='*60}")
        print(f"Turns used:         {result.turns_used}")
        print(f"Finished naturally: {result.finished_naturally}")
        print(f"Tool errors:        {len(result.tool_errors)}")
        print(f"{'='*60}")

        # Print the final assistant response
        for msg in reversed(result.messages):
            # if msg.get("role") == "assistant" and msg.get("content"):
            #     print("\nRESPONSE:")
            #     print(msg["content"])
            #     break
            print(msg)

        if result.tool_errors:
            print("\nTOOL ERRORS:")
            for err in result.tool_errors:
                print(f"  turn {err.turn}: {err.tool_name} — {err.error}")

        status = "✅ passed" if result.finished_naturally else "⚠️  hit max turns"
        print(f"\nGym compatibility check {status}")

    except Exception as e:
        print(f"\n❌ Gym compatibility check failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
