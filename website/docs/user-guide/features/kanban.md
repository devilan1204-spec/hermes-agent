---
sidebar_position: 12
title: "Kanban (Multi-Agent Board)"
description: "Durable SQLite-backed task board for coordinating multiple Hermes profiles"
---

# Kanban — Multi-Agent Profile Collaboration

Hermes Kanban is a durable task board, shared across all your Hermes profiles, that lets multiple named agents collaborate on work without fragile in-process subagent swarms. Every task is a row in `~/.hermes/kanban.db`; every handoff is a row anyone can read and write; every worker is a full OS process with its own identity.

This is the shape that covers the workloads `delegate_task` can't:

- **Research triage** — parallel researchers + analyst + writer, human-in-the-loop.
- **Scheduled ops** — recurring daily briefs that build a journal over weeks.
- **Digital twins** — persistent named assistants (`inbox-triage`, `ops-review`) that accumulate memory over time.
- **Engineering pipelines** — decompose → implement in parallel worktrees → review → iterate → PR.
- **Fleet work** — one specialist managing N subjects (50 social accounts, 12 monitored services).

For the full design rationale, comparative analysis against Cline Kanban / Paperclip / NanoClaw / Google Gemini Enterprise, and the eight canonical collaboration patterns, see `docs/hermes-kanban-v1-spec.pdf` in the repository.

## Kanban vs. `delegate_task`

They look similar; they are not the same primitive.

| | `delegate_task` | Kanban |
|---|---|---|
| Shape | RPC call (fork → join) | Durable message queue + state machine |
| Parent | Blocks until child returns | Fire-and-forget after `create` |
| Child identity | Anonymous subagent | Named profile with persistent memory |
| Resumability | None — failed = failed | Block → unblock → re-run; crash → reclaim |
| Human in the loop | Not supported | Comment / unblock at any point |
| Agents per task | One call = one subagent | N agents over task's life (retry, review, follow-up) |
| Audit trail | Lost on context compression | Durable rows in SQLite forever |
| Coordination | Hierarchical (caller → callee) | Peer — any profile reads/writes any task |

**One-sentence distinction:** `delegate_task` is a function call; Kanban is a work queue where every handoff is a row any profile (or human) can see and edit.

**Use `delegate_task` when** the parent agent needs a short reasoning answer before continuing, no humans involved, result goes back into the parent's context.

**Use Kanban when** work crosses agent boundaries, needs to survive restarts, might need human input, might be picked up by a different role, or needs to be discoverable after the fact.

They coexist: a kanban worker may call `delegate_task` internally during its run.

## Core concepts

- **Task** — a row with title, optional body, one assignee (a profile name), status (`todo | ready | running | blocked | done | archived`), optional tenant namespace.
- **Link** — `task_links` row recording a parent → child dependency. The dispatcher promotes `todo → ready` when all parents are `done`.
- **Comment** — the inter-agent protocol. Agents and humans append comments; when a worker is (re-)spawned it reads the full comment thread as part of its context.
- **Workspace** — the directory a worker operates in. Three kinds:
  - `scratch` (default) — fresh tmp dir under `~/.hermes/kanban/workspaces/<id>/`.
  - `dir:<path>` — an existing shared directory (Obsidian vault, mail ops dir, per-account folder).
  - `worktree` — a git worktree under `.worktrees/<id>/` for coding tasks.
- **Dispatcher** — `hermes kanban dispatch` runs a one-shot pass: reclaim stale claims, promote ready tasks, atomically claim, spawn assigned profiles. Runs via cron every 60 seconds.
- **Tenant** — optional string namespace. One specialist fleet can serve multiple businesses (`--tenant business-a`) with data isolation by workspace path and memory key prefix.

## Quick start

```bash
# 1. Create the board
hermes kanban init

# 2. Create a task
hermes kanban create "research AI funding landscape" --assignee researcher

# 3. List what's on the board
hermes kanban list

# 4. Run a dispatcher pass (dry-run to preview, real to spawn workers)
hermes kanban dispatch --dry-run
hermes kanban dispatch
```

To have the board run continuously, schedule the dispatcher:

```bash
hermes cron add --schedule "*/1 * * * *" \
    --name kanban-dispatch \
    hermes kanban dispatch
```

## The worker skill

Any profile that should be able to work kanban tasks must load the `kanban-worker` skill. It teaches the worker the full lifecycle:

1. On spawn, read `$HERMES_KANBAN_TASK` env var.
2. Run `hermes kanban context $HERMES_KANBAN_TASK` to read title + body + parent results + full comment thread.
3. `cd $HERMES_KANBAN_WORKSPACE` and do the work there.
4. Complete with `hermes kanban complete <id> --result "<summary>"`, or block with `hermes kanban block <id> "<reason>"` if stuck.

Load it with:

```bash
hermes skills install devops/kanban-worker
```

## The orchestrator skill

A **well-behaved orchestrator does not do the work itself.** It decomposes the user's goal into tasks, links them, assigns each to a specialist, and steps back. The `kanban-orchestrator` skill encodes this: anti-temptation rules, a standard specialist roster (`researcher`, `writer`, `analyst`, `backend-eng`, `reviewer`, `ops`), and a decomposition playbook.

Load it into your orchestrator profile:

```bash
hermes skills install devops/kanban-orchestrator
```

For best results, pair it with a profile whose toolsets are restricted to board operations (`kanban`, `gateway`, `memory`) so the orchestrator literally cannot execute implementation tasks even if it tries.

## Dashboard (GUI)

The `/kanban` CLI and slash command are enough to run the board headlessly, but a visual board is often the right interface for humans-in-the-loop: triage, cross-profile supervision, reading comment threads, and dropping cards between columns. Hermes ships this as a **dashboard plugin** — not a core feature, not a separate service — following the model laid out in [Extending the Dashboard](./extending-the-dashboard).

### What the plugin adds

- A **Kanban** tab in `hermes dashboard` showing one column per status (`triage`, `todo`, `ready`, `claimed`, `running`, `review`, `blocked`, `done`).
- Cards show task id, title, priority, assigned profile, dependency chips, progress (`N/M` subtasks done), and files-touched count.
- Live updates via a WebSocket that tails the `task_events` append-only table. No polling, no full-refetch flicker.
- Click a card → side panel with full description, comment thread, linked tasks, event timeline, and the exact context a worker would see (`hermes kanban context <id>`).
- Drag a card to a new column → sends a status change through the same code path `/kanban` uses.
- Inline **New task** row at the top of every column (title + optional assignee dropdown + priority).
- Per-profile lanes inside the `running` column so you can see at a glance which specialist is busy on what.

Visually the target is the familiar Linear / Fusion layout: dark theme, column headers with item counts, coloured status dots, pill chips for dependencies and badges.

### Architecture

The GUI is strictly a **read-through-the-DB + write-through-the-CLI** layer. It has no domain logic of its own:

```
┌────────────────────────┐      WebSocket (task_events tail)
│   React SPA (plugin)   │ ◀──────────────────────────────────┐
│   @dnd-kit drag/drop   │                                    │
└──────────┬─────────────┘                                    │
           │ REST (thin)                                      │
           ▼                                                  │
┌────────────────────────┐     writes go through the same     │
│  FastAPI router        │     run_slash("<verb> …") that     │
│  plugins/kanban/       │     CLI + gateway already use      │
│  dashboard/routes.py   │                                    │
└──────────┬─────────────┘                                    │
           │                                                  │
           ▼                                                  │
┌────────────────────────┐                                    │
│  ~/.hermes/kanban.db   │ ───── append task_events ──────────┘
│  (WAL, shared)         │
└────────────────────────┘
```

Because writes go through `run_slash`, the GUI cannot drift from the CLI or the gateway. A drag-drop is just a `/kanban assign` or a status change under the hood; every action lands in `task_events` the same way a typed `/kanban` command would.

### REST surface

All routes are mounted under `/api/plugins/kanban/` and protected by the dashboard's ephemeral `_SESSION_TOKEN`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/board?tenant=<name>` | Full board, grouped by status column |
| `GET` | `/tasks/:id` | Task + links + comments + events |
| `POST` | `/tasks` | Create (delegates to `run_slash("create …")`) |
| `PATCH` | `/tasks/:id` | Status / assignee / title / priority |
| `POST` | `/tasks/:id/comments` | Append a comment |
| `POST` | `/tasks/:id/links` | Add a dependency |
| `DELETE` | `/tasks/:id/links/:other` | Remove a dependency |
| `POST` | `/tasks/:id/dispatch` | Nudge the dispatcher (no 60 s wait) |
| `WS` | `/events?since=<event_id>` | Live stream of `task_events` rows |

Every handler is a ~5-line wrapper around an existing `kanban_db` function or a `run_slash` invocation — the plugin adds no new business logic.

### Live updates

`task_events` is an append-only SQLite table with a monotonic `id`. The WebSocket endpoint keeps the last-seen event id per client and pushes new rows as they land. The frontend patches its local state in place, so a card moves between columns the instant any profile — CLI, gateway, or another GUI tab — acts on it. WAL mode means the read loop never blocks the dispatcher's `BEGIN IMMEDIATE` claim.

### Installing it

The plugin is shipped in the repo at `plugins/kanban/` and enabled by default when `hermes dashboard` finds a `kanban.db`:

```bash
hermes dashboard
# browser opens → "Kanban" tab appears in the nav
```

To disable: remove or rename `plugins/kanban/` (or set `dashboard.plugins.kanban.enabled: false` in `config.yaml`). To extend it — extra columns, custom card chrome, tenant filters — follow the plugin shape documented in [Extending the Dashboard](./extending-the-dashboard) (`tab`, shell slots, page-scoped slots, and custom CSS all apply).

### Scope boundary

The GUI is deliberately thin. Everything the plugin does is reachable from the CLI; the plugin just makes it comfortable for humans. Auto-assignment, budgets, governance gates, and org-chart views remain user-space — a router profile, a plugin, or a reuse of `tools/approval.py` — exactly as listed in the out-of-scope section of the design spec.

## CLI command reference

```
hermes kanban init                                     # create kanban.db
hermes kanban create "<title>" [--body ...] [--assignee <profile>]
                                [--parent <id>]... [--tenant <name>]
                                [--workspace scratch|worktree|dir:<path>]
                                [--priority N] [--json]
hermes kanban list [--mine] [--assignee P] [--status S] [--tenant T] [--archived] [--json]
hermes kanban show <id> [--json]
hermes kanban assign <id> <profile>                    # or 'none' to unassign
hermes kanban link <parent_id> <child_id>
hermes kanban unlink <parent_id> <child_id>
hermes kanban claim <id> [--ttl SECONDS]
hermes kanban comment <id> "<text>" [--author NAME]
hermes kanban complete <id> [--result "..."]
hermes kanban block <id> "<reason>"
hermes kanban unblock <id>
hermes kanban archive <id>
hermes kanban tail <id>                                # follow event stream
hermes kanban dispatch [--dry-run] [--max N] [--json]
hermes kanban context <id>                             # what a worker sees
hermes kanban gc                                       # remove scratch dirs of archived tasks
```

All commands are also available as a slash command in the gateway (`/kanban list`, `/kanban comment t_abc "need docs"`, etc.). The slash command bypasses the running-agent guard, so you can `/kanban unblock` a stuck worker while the main agent is still chatting.

## Collaboration patterns

The board supports these eight patterns without any new primitives:

| Pattern | Shape | Example |
|---|---|---|
| **P1 Fan-out** | N siblings, same role | "research 5 angles in parallel" |
| **P2 Pipeline** | role chain: scout → editor → writer | daily brief assembly |
| **P3 Voting / quorum** | N siblings + 1 aggregator | 3 researchers → 1 reviewer picks |
| **P4 Long-running journal** | same profile + shared dir + cron | Obsidian vault |
| **P5 Human-in-the-loop** | worker blocks → user comments → unblock | ambiguous decisions |
| **P6 `@mention`** | inline routing from prose | `@reviewer look at this` |
| **P7 Thread-scoped workspace** | `/kanban here` in a thread | per-project gateway threads |
| **P8 Fleet farming** | one profile, N subjects | 50 social accounts |

For worked examples of each, see `docs/hermes-kanban-v1-spec.pdf`.

## Multi-tenant usage

When one specialist fleet serves multiple businesses, tag each task with a tenant:

```bash
hermes kanban create "monthly report" \
    --assignee researcher \
    --tenant business-a \
    --workspace dir:~/tenants/business-a/data/
```

Workers receive `$HERMES_TENANT` and namespace their memory writes by prefix. The board, the dispatcher, and the profile definitions are all shared; only the data is scoped.

## Design spec

The complete design — architecture, concurrency correctness, comparison with other systems, implementation plan, risks, open questions — lives in `docs/hermes-kanban-v1-spec.pdf`. Read that before filing any behavior-change PR.
