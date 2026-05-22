---
name: hermes-agent
description: "Configure, extend, or contribute to Hermes Agent."
version: 3.0.0
author: Hermes Agent + Teknium
license: MIT
metadata:
  hermes:
    tags: [hermes, setup, configuration, multi-agent, spawning, cli, gateway, development]
    homepage: https://github.com/NousResearch/hermes-agent
    related_skills: [claude-code, codex, opencode]
---

# Hermes Agent

Hermes Agent is an open-source AI agent framework by Nous Research that runs in your terminal, messaging platforms, and IDEs. It belongs to the same category as Claude Code (Anthropic), Codex (OpenAI), and OpenClaw — autonomous coding and task-execution agents that use tool calling to interact with your system. Hermes works with any LLM provider (OpenRouter, Anthropic, OpenAI, DeepSeek, local models, and 15+ others) and runs on Linux, macOS, and WSL.

What makes Hermes different:

- **Self-improving through skills** — Hermes learns from experience by saving reusable procedures as skills. When it solves a complex problem, discovers a workflow, or gets corrected, it can persist that knowledge as a skill document that loads into future sessions. Skills accumulate over time, making the agent better at your specific tasks and environment.
- **Persistent memory across sessions** — remembers who you are, your preferences, environment details, and lessons learned. Pluggable memory backends (built-in, Honcho, Mem0, and more) let you choose how memory works.
- **Multi-platform gateway** — the same agent runs on Telegram, Discord, Slack, WhatsApp, Signal, Matrix, Email, and 10+ other platforms with full tool access, not just chat.
- **Provider-agnostic** — swap models and providers mid-workflow without changing anything else. Credential pools rotate across multiple API keys automatically.
- **Profiles** — run multiple independent Hermes instances with isolated configs, sessions, skills, and memory.
- **Extensible** — plugins, MCP servers, custom tools, webhook triggers, cron scheduling, and the full Python ecosystem.

**This skill is a navigation index.** The complete documentation lives in `website/docs/` inside the repo. When the user asks about Hermes configuration, extension, or troubleshooting, fetch only the relevant doc — never load everything.

## Doc Tree & Quick Mapping

Docs live at `~/.hermes/hermes-agent/website/docs/`. Read them locally with `read_file`. Paths are relative to that directory:

| User asks about... | Read |
|---|---|
| Install, setup, update | `getting-started/quickstart.md`, `getting-started/installation.md`, `getting-started/updating.md` |
| Model/provider config | `user-guide/configuring-models.md`, `integrations/providers.md` |
| Config (yaml, env, tools) | `user-guide/configuration.md` |
| CLI commands, flags, spawning | `reference/cli-commands.md`, `user-guide/cli.md` |
| Gateway, messaging platforms | `user-guide/messaging/index.md` |
| Telegram setup, topics, DM | `user-guide/messaging/telegram.md` |
| Other platforms (Discord, Slack, etc.) | `user-guide/messaging/<platform>.md` |
| Creating/adding tools | `developer-guide/adding-tools.md` |
| Skills system | `user-guide/features/skills.md`, `developer-guide/creating-skills.md` |
| Memory system | `user-guide/features/memory.md`, `user-guide/features/memory-providers.md` |
| Cron jobs | `user-guide/features/cron.md`, `guides/cron-troubleshooting.md` |
| MCP servers | `user-guide/features/mcp.md`, `reference/mcp-config-reference.md` |
| Profiles | `user-guide/profiles.md`, `reference/profile-commands.md` |
| Voice, TTS, STT | `user-guide/features/voice-mode.md`, `user-guide/features/tts.md` |
| Browser automation | `user-guide/features/browser.md` |
| Delegation, subagents | `user-guide/features/delegation.md` |
| Security, secrets, redaction | `user-guide/security.md`, `user-guide/secrets/` |
| Slash commands (in-session) | `reference/slash-commands.md` |
| All tools reference | `reference/tools-reference.md`, `reference/toolsets-reference.md` |
| Troubleshooting | `reference/faq.md` |
| Environment variables | `reference/environment-variables.md` |
| Available models | `reference/model-catalog.md` |
| Developing, contributing | `developer-guide/contributing.md`, `developer-guide/architecture.md` |
| Agent loop internals | `developer-guide/agent-loop.md` |
| Context compression, caching | `developer-guide/context-compression-and-caching.md` |
| Provider plugins | `developer-guide/model-provider-plugin.md` |

**How to read:** Use `read_file` with these paths relative to `~/.hermes/hermes-agent/website/docs/`. Only read the specific doc(s) relevant to the question. If the doc doesn't answer it, check `reference/faq.md` next. Fallback: fetch from `https://raw.githubusercontent.com/NousResearch/hermes-agent/main/website/docs/` if the local repo isn't available.

**Docs site:** https://hermes-agent.nousresearch.com/docs/

**How to fetch efficiently:**
- Scan section headers before reading a full doc to narrow down what you actually need
- Trim large docs — some exceed 200KB; use offset/limit to read only relevant sections
- Browse the directory tree on GitHub when the mapping above doesn't cover a topic

## Key Paths

```
~/.hermes/config.yaml       Main configuration
~/.hermes/.env              API keys and secrets
~/.hermes/SOUL.md           Agent persona
~/.hermes/skills/           Installed skills
~/.hermes/sessions/         Session transcripts
~/.hermes/logs/             Gateway and error logs
~/.hermes/hermes-agent/     Source code (if git-installed)
```

## Key Rules

- **Never break prompt caching** — don't change context, tools, or system prompt mid-conversation
- **Message role alternation** — never two assistant or two user messages in a row
- **Use `get_hermes_home()`** from `hermes_constants` for all paths (profile-safe), never hardcode `~/.hermes`
- **Config values go in `config.yaml`**, secrets and API keys go in `.env`
- **New tools need a `check_fn`** so they only appear when requirements are met
- **Don't fabricate user information** — never assume or invent facts about the user that aren't in memory. If unsure, verify. When asked about the current model or config, read `config.yaml` directly — it's the runtime truth, memory can be stale.
