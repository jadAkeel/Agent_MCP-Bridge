---
name: bridge-plan
description: Choose direct, Light, or protected parallel execution and divide an authorized bridge task into bounded deliverables, dependencies, ownership and acceptance concerns. Use before substantial delegation; do not force a team for tiny work.
metadata:
  version: "1.0.0"
---

# Decide and divide

Input: the user's goal, relevant project state, constraints and actual available routes.
Output: selected path with rationale, bounded deliverables, real dependencies, ownership
and acceptance concerns. The coordinator owns the completed result.

Read relevant instructions, current changes and real check commands once. Use
the installed Superpowers workflow for direct engineering work. Before delegation,
read multi-agent-balanced and the guidance for the selected runner, including
opencode-balanced for OpenCode or agy-delegate for the independent Antigravity relay.
Managed dispatch follows the selected managed transport. Report missing required skills.
Plan status reporting in the same Codex Desktop chat. Record each worker's selected account profile,
scope, workspace, transport, and run or job ID on receipt. Keep each worker's ID for parallel
dispatch and use the original transport for status and result lookup.

Use
the execution-ownership policy in [coordination](../references/coordination.md) before
choosing a route. Small/simple work stays direct when delegation costs more; work needing
the whole-project context, tightly coupled decisions, and sensitive/critical/high-impact
implementation stays with the orchestrator. Medium tasks and independent difficult tasks
may qualify when bounded, non-critical and verifiable without repeating the work, with
benefit exceeding coordination costs. Difficulty and task count alone do not select a
mode. For managed work, use `get_opencode_bridge_status` before
first dispatch; refresh when state/configuration changes. Load transport details only
for the selected route, not every skill and reference on every job.

| Concern | Smallest useful path |
| --- | --- |
| Small/simple task | Orchestrator executes directly with meaningful project checks |
| Work needing the full context, coupled decisions, or sensitive/critical/high-impact implementation | Orchestrator implements directly and owns the foundation and decisions |
| One eligible bounded task, medium or difficult, selected for managed execution | Light: one sequential managed `run_opencode_agent` job |
| Multiple eligible tasks with independent contracts/resources | `validate_delegation_plan`, then `run_opencode_parallel` |
| Eligible jobs needing durable scheduling | Existing queue/pipeline tools where their actual final gates fit |

Light uses `executionMode: "light"` and one supported delegate: managed OpenCode or
explicitly enabled/allowlisted Codex. Load the selected bridge-delegate skill. No raw
upstream relay runs beside bridge writers. A Claude MCP client is not a Claude worker.
An optional Pi worker uses normal bridge write jobs, not Light. It defaults to refusal,
requires explicit unsandboxed-worktree acceptance, and supports builder/debugger file
edits only; the coordinator owns shell/tests. Load bridge-delegate-pi only when selected.

If the user selects an installed original `*-delegate` skill, classify it as independent
delegation and follow that skill's prerequisites/relay workflow. It is not protected
Light/Parallel: do not promise bridge locks, scope, isolation or integration receipts.
An original skill selection takes precedence over the managed mode table above. Keep
its upstream entrypoint, relay and support-tool procedure unchanged; do not redirect it
to Light or prepend Bridge health/worktree/integration steps because Bridge is available.
Assign an exclusive approved workspace/resource set, never overlapping an active bridge
writer. Read only the selected skill; installing it does not authorize its provider,
fleet configuration or background-service bootstrap.

Compare useful work with briefing, startup, repeated discovery, review and integration.
Group shared discovery; split coherent acceptance concerns. Do not create planner,
builder, reviewer and tester jobs for every small edit. Independent review is warranted
by risk or a required gate, not by a desire to fill available slots.

Record genuine predecessor file state. A dependency chain stays sequential. Schedule it
through supported calls; do not invent a `dependsOn` tool field. For related writers,
plan retained `continueWorktree` steps and one reviewed integration; no commit per step
is required. Explain the serial fallback when no subagents are used.

Own files AND databases, ports, caches, fixtures and generated outputs. File-disjoint
jobs can still conflict on resources. Shared manifests/lockfiles/schema/migrations and
bridge-designated serial paths have one serial owner. Start a dependent writer only
from the reviewed predecessor's actual files. Avoid readers racing relevant writers.

Write the compact [task/check contract](../references/contracts.md). Assign one executor
per check/input state before dispatch. Then hand the approved plan and pending work to
bridge-execute without repeating discovery. This skill grants no extra permissions.
