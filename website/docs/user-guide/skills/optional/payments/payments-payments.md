---
title: "Payments — Router for Hermes payment skills — Link, MPP, Projects"
sidebar_label: "Payments"
description: "Router for Hermes payment skills — Link, MPP, Projects"
---

{/* This page is auto-generated from the skill's SKILL.md by website/scripts/generate-skill-docs.py. Edit the source SKILL.md, not this page. */}

# Payments

Router for Hermes payment skills — Link, MPP, Projects.

## Skill metadata

| | |
|---|---|
| Source | Optional — install with `hermes skills install official/payments/payments` |
| Path | `optional-skills/payments/payments` |
| Version | `0.1.0` |
| Author | Teknium (teknium1), Hermes Agent |
| License | MIT |
| Platforms | linux, macos |
| Tags | `Payments`, `Router`, `Stripe`, `MPP`, `Link` |
| Related skills | [`stripe-link-cli`](/docs/user-guide/skills/optional/payments/payments-stripe-link-cli), [`mpp-agent`](/docs/user-guide/skills/optional/payments/payments-mpp-agent), [`stripe-projects`](/docs/user-guide/skills/optional/payments/payments-stripe-projects) |

## Reference: full SKILL.md

:::info
The following is the complete skill definition that Hermes loads when this skill is triggered. This is what the agent sees as instructions when the skill is active.
:::

# Payments Skill (Router)

Routes the agent to the right payment skill based on the user's intent. The actual implementations live in the three sibling skills under `optional-skills/payments/`.

Hermes does not have built-in payment tools. Every purchase is mediated by an external CLI (Link CLI, mppx, Tempo Wallet, stripe projects) and gated by an explicit user approval — either in the Link app, the wallet UI, or a CLI confirmation prompt. The agent cannot self-approve a spend.

Gated `[linux, macos]` — the underlying CLIs (`@stripe/link-cli` especially) are not Windows-supported yet.

## When to Use

Load this skill first when the user says something payment-related but you can't tell which path they want. It hands off to the right sub-skill.

## Routing table

| User intent | Skill to load |
|---|---|
| "Buy something", "checkout", "pay for X", merchant has a card form | `stripe-link-cli` |
| Merchant returns `HTTP 402` with `method="stripe"` in `www-authenticate` | `stripe-link-cli` (use `--credential-type shared_payment_token`) |
| Merchant returns `HTTP 402` with `tempo`/`mpp` only | `mpp-agent` |
| "Pay per API call", "machine payments", "use my Tempo / Privy / AgentCash wallet" | `mpp-agent` |
| "Provision &lt;service>", "create a database", "set up Twilio", "add Neon" | `stripe-projects` |
| "Manage my stack credentials", "rotate this key", "upgrade my &lt;provider> plan" | `stripe-projects` |
| "Add 402 to my own API" | none yet — fetch https://mpp.dev/quickstart/server with `web_extract` |

## Hard rules (apply to every payment skill)

These are invariants. They apply regardless of which sub-skill the user routes to.

1. **No card numbers, tokens, or wallet private keys ever enter the agent's transcript, reasoning context, memory, logs, or session state.** Use the secure file output flags every CLI provides (`link-cli ... --output-file /tmp/...json` with `0600` perms; `mppx` and `stripe projects` keep credentials in their own config dirs). Never `cat`/`read_file` a credential file into the agent.
2. **Approvals are not self-bypassable.** The Link app approval, Tempo wallet approval, and Stripe CLI confirmation prompts exist because the agent should not be able to spend without a human-in-the-loop signal. Do not pass `--yes`/`--force` flags or pipe `echo y |` into approval prompts to "automate" past them.
3. **Confirm the final total with the user before issuing a spend request.** Amounts are in the smallest unit (cents for Link, varies for MPP). Misplacing the decimal point on a $35.00 book turns it into $3500.00.
4. **Clean up credential files.** After a one-time-use card is consumed, `rm` the output file. After an MPP receipt is verified, archive or drop the response.
5. **US-only services stay US-only.** The Link CLI rejects non-US accounts at `auth login`. Tell the user once, don't keep retrying.

## Procedure

1. Read the user's request and pick a row from the routing table.
2. Load the matching skill: `skill_view(name="<skill-name>")`.
3. Follow that skill's procedure end-to-end.
4. If the user changes intent mid-task (e.g. starts on Link, hits an MPP-only merchant), come back here and re-route — don't try to bridge it ad-hoc.

## Verification

This skill is a router — it has no commands of its own. Verify each sub-skill independently with its own `Verification` block.
