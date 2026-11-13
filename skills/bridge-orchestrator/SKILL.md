---
name: bridge-orchestrator
description: "Coordinate software tasks from Codex Desktop. Choose whether to work directly or delegate, plan bounded sub-agent tasks, select the requested worker and execution mode, and track every worker through its final result."
---

# Bridge Orchestrator

Use this skill when coordinating a coding task, assigning work to an agent or CLI, splitting work, or checking the status of delegated work. Keep coordination and worker status in the same Codex Desktop chat. Codex Desktop remains the coordinator in the current user conversation.

## Decide and prepare

1. Read the repository instructions, inspect the relevant project state, and identify the available transports.
2. Use `multi-agent-balanced` to decide whether direct work, a single worker or parallel workers best fits the task. Keep tightly coupled, sensitive or shared-foundation work with the coordinator.
3. Use the matching runner guidance when available, such as `opencode-balanced`, `codex-balanced`, `gemini-balanced`, `opencode-delegate` or `agy-delegate`. Use `bridge-plan` and `bridge-execute` for managed Bridge work. Follow the chosen transport's real permissions, profile support, workspace ownership and cleanup rules.
4. For the coordinator's own software changes, use the available Superpowers workflow. For a new or ambiguous feature, use brainstorming before implementation. For an approved design, write a plan. Implement behavior changes test-first and verify the final result.
5. Build a concise brief for each worker with the goal, acceptance check, input revision, selected account profile, owned and forbidden paths, shared resources, required tools, commands and report format. A profile provides that CLI's own account and compatible user customizations. Do not silently change profiles, models, permissions or transports.
6. Start dependent work only from inspected and accepted predecessor results. Parallel jobs need independent file scopes and shared resources.

## Track every worker

As soon as a transport returns a dispatch receipt, save the worker name, mode, selected profile, workspace and run or job ID in the current Codex Desktop conversation. Keep one identifier per worker plus a group identifier if available. For a queue, record the durable job ID. For a standalone relay, record its run ID and continue using its supported result tool.

When the user asks what happened, look up the saved identifier through the same transport and report the latest observed state and the worker's actual result. A dispatch receipt is not a completion report. If the transport says interrupted, missing or recovery required, report that state and use its recovery procedure. Never redispatch just because a result was not immediately available.

## Review and finish

Inspect worker output, actual changed files, tests and permissions. The coordinator owns final review, dependency joins and integration. Preserve partial results and respect cancellation and cleanup. Report which profile and worker ran, their result, checks and any remaining verification. Do not claim completion from a worker's own success message.
