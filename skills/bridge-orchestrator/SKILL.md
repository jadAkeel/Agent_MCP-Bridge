---
name: bridge-orchestrator
description: "Coordinate software tasks from Codex Desktop. Choose whether to work directly or delegate, plan bounded sub-agent tasks, select the requested worker and execution mode, and track every worker through its final result."
---

# Bridge Orchestrator

Use this skill when coordinating a coding task, assigning work to an agent or CLI, splitting work, or checking the status of delegated work. Keep coordination and worker status in the same Codex Desktop chat. Codex Desktop remains the coordinator in the current user conversation.

## Responsibility and handoffs

Use this skill only to assess, plan, supervise or review delegation through the selected
Bridge workflow. An ordinary direct code edit does not require this coordination stack.
Skills do not themselves authorize external dispatch.

Own coordination and worker identity throughout the current conversation. Use
`bridge-plan` to prepare or update assignments, `bridge-execute` to run an approved
plan, and `bridge-learn` only when incidents warrant investigation. These are stages
of one task, not separate coordinators. A status question needs the saved job lookup,
not a fresh planning cycle. See [coordination](../references/coordination.md) for
shared rules, optional personal skills and the DAG record.

## Decide and prepare

1. Read the repository instructions, inspect the relevant project state, and identify the available transports.
2. Use `multi-agent-balanced` when installed and enabled by the user to decide whether direct work, a single worker or parallel workers best fits the task; otherwise use the execution-ownership guidance packaged with `bridge-plan`. Keep tightly coupled, sensitive or shared-foundation work with the coordinator.
3. Load only the selected transport guidance: managed `bridge-delegate-*` guides for Bridge jobs, or the installed original `opencode-delegate`, `codex-delegate` or `agy-delegate` for an explicitly selected independent CLI route. Follow its real permissions, profile support, workspace ownership and cleanup rules.
4. Follow the user's active engineering workflow for software changes. Reuse approved decisions and meaningful verification. Do not activate a disabled framework or require an optional personal skill merely because it is installed.
5. Build a concise brief for each worker with the goal, acceptance check, input revision, selected account profile, owned and forbidden paths, shared resources, required tools, commands and report format. A profile provides that CLI's own account and compatible user customizations. Do not silently change profiles, models, permissions or transports.
6. Before dispatch, put project-linked subtasks in the existing project DAG, even for one worker; truly standalone tasks need no DAG. Start dependent work only from inspected and accepted predecessor results. Parallel jobs need independent file scopes and shared resources.

## Track every worker

As soon as a transport returns a dispatch receipt, save the worker name, mode, selected profile, workspace and run or job ID in the current Codex Desktop conversation. Keep one identifier per worker plus a group identifier if available. For a queue, record the durable job ID. For a standalone relay, record its run ID and continue using its supported result tool.

When the user asks what happened, look up the saved identifier through the same transport and report the latest observed state and the worker's actual result. A dispatch receipt is not a completion report. If the transport says interrupted, missing or recovery required, report that state and use its recovery procedure. Never redispatch just because a result was not immediately available.

## Review and finish

Inspect worker output, actual changed files, tests and permissions. The coordinator owns final review, dependency joins and integration. Preserve partial results and respect cancellation and cleanup. Report which profile and worker ran, their result, checks and any remaining verification. Do not claim completion from a worker's own success message.
