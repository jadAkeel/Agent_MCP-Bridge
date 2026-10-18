---
name: agent-mcp-bridge
description: "Choose and coordinate flexible coding delegation with Agent MCP Bridge: sequential Light tasks, protected parallel work, durable queues/pipelines, or explicitly selected independent CLI delegates. Use when a user wants to delegate development and review the result before integration."
license: ISC AND MIT
compatibility: Requires a local Agent MCP Bridge installation for managed execution, Node.js >=22.13.0, Git, OpenCode 1.18.32, an MCP-capable client, and authorized provider access. Independent delegates require their own installed CLIs and prerequisites.
metadata:
  version: "0.1.0-rc.1"
---

# Agent MCP Bridge: Flexible Delegation

Help the user choose how to delegate, carry out bounded work, and review the actual
result. Match the route to the task, available tools, dependencies and user-selected
models. The coordinator remains responsible for the outcome.

## 1. Establish the available route

Inspect project instructions, relevant source, existing edits and actual check commands.
Use [setup](references/setup.md) if the local runtime or selected CLI is missing.
Marketplace Skill delivery supplies instructions and supporting material; local runtime
installation and provider sign-in are separate steps.

For managed work, discover the registered Bridge MCP tools and call
`get_opencode_bridge_status` before first dispatch. A healthy server does not establish
that a provider/model can perform a task. Preserve the user's provider, model, effort
and permissions. Confirm an unverified authorized route with one useful bounded task
before parallel dispatch.

## 2. Choose the smallest useful execution mode

Read the [mode guide](references/modes.md), then use
[Bridge planning](library/bridge-plan/SKILL.md) to define ownership and acceptance.

| Task shape | Route |
| --- | --- |
| Tiny obvious change | Work directly in the current client |
| One bounded task | Sequential managed Light execution |
| Independent tasks with disjoint resources | Validated managed parallel execution |
| Work requiring durable scheduling or stages | Bridge queue/pipeline tools |
| A user-selected independent CLI workflow | The corresponding original delegate |

Use the [delegate catalog](references/catalog.md) to load only the selected guide.
Independent delegates use their own relays and permissions. Managed Bridge routes use
Bridge MCP tools. Keep their workspaces and resource ownership distinct.

## 3. Execute the agreed work

Follow [Bridge execution](library/bridge-execute/SKILL.md) for managed work. Give each
worker a compact brief with the goal, observable acceptance, relevant inputs, owned and
forbidden paths, shared resources, actual checks, stop conditions and report requirements.
Managed writers require an isolated worktree, explicit ownership and a write Scope
Contract. Use the registered tool schemas rather than inventing arguments.

For an independent route, follow its original guide using the separately installed
local Skill/scripts and a user-approved workspace. Reference files delivered by a
marketplace are not evidence that executable files exist on the user's disk. Ask for
missing prerequisites instead of constructing a local path to a remotely loaded file.

## 4. Review and integrate

Inspect the actual diff, untracked files and tests. A worker's report or zero exit is not
acceptance. Reuse matching check receipts; run missing behavioral checks in an authorized
environment. For Bridge worktrees, preview integration, inspect the patch, and apply with
the same contract and exact reviewed preview receipt. Independent routes use their own
review/landing procedure and do not acquire Bridge receipts.

Preserve unrelated edits and partial results. Follow supported cancellation/recovery
before takeover. Commits, pushes, publication, account changes and provider spending
require the user's applicable authorization. Never silently change model or permissions.

## 5. Report the result

State the selected mode and worker, changed behavior/files, actual checks, integration
state and remaining work. Use [Bridge learning](library/bridge-learn/SKILL.md) when a
completed or interrupted run provides useful evidence. Read
[compatibility](references/compatibility.md) before making support or performance claims.
