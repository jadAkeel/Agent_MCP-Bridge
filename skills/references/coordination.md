# Shared coordination boundary

This reference owns common invariants for the separate Bridge skills. It is shared
policy, not another coordinator or task ledger.

## Responsibility map

| Entry | Owns | Handoff |
| --- | --- | --- |
| `agent-mcp-bridge` | Public product/route guide | Open only the relevant library skill |
| `bridge-orchestrator` | Coordination, worker identities and user status | Planning or execution as needed; direct lookup for status |
| `bridge-plan` | Assignment DAG, route, ownership and acceptance | Accepted assignments to execution |
| `bridge-execute` | Ready-task dispatch, recovery, review and integration | Accepted combined results; incidents only when warranted |
| `bridge-learn` | Bridge incident evidence and proposed corrections | One reviewed learning record |

Optional personal `multi-agent-balanced` owns general delegation policy when enabled;
Bridge skills apply that policy to Bridge tools. Resolve ownership once and reuse the
same approved plan, assignments and evidence. Do not create two planners or repeat
reviews merely because both sets are installed. Without personal skills, these packaged
rules remain usable. Follow user/project instructions and the active engineering workflow;
never activate a disabled framework or require Superpowers, EGM or personal skill files.

Original `*-delegate` skills own independent CLI launch and relay mechanics only when
that route is selected; managed `bridge-delegate-*` guides describe Bridge workers.
Do not select an external route or enable a helper merely because a guide exists.
`delegation-retrospective`, when active, owns general incident analysis; `bridge-learn`
supplies Bridge diagnostics to that same investigation.

## One authoritative DAG record

Before dispatch, classify the assignment:

- **Project-linked work:** a subtask of a larger project objective, a prerequisite,
  a consumer of another task's output, or work that must join other changes. Record it
  in the project's documented DAG before dispatch, even for one worker. Reuse existing
  task IDs and real dependency edges; do not invent edges between independent tasks.
- **Truly standalone work:** one self-contained deliverable with no predecessor or
  downstream integration dependency in a larger objective. Use one brief and run/result
  record, without creating a DAG. Being located in a repository alone does not make it
  project-linked. Still define scope, acceptance, review and the next status lookup.

Worker count and sequential/parallel mode do not decide whether a DAG is needed.
If the relationship is uncertain, inspect the existing project plan before dispatch.

For project-linked delegation, reuse its approved plan and task store. Record task IDs,
predecessor edges, scope/resources, selected worker/profile, acceptance, actual run/job
ID and next review. When user/project rules require Beads, use the installed `beads`
skill and the approved project store as the sole task/dependency record. Do not embed
personal paths, create a parallel status list or install a tracker automatically.
If a required tracker is unavailable, report the blocked tracking step before dispatch.
The coordinator owns task updates and actual fan-in joins. Individual worker success
is not acceptance: close a join only after inspecting, integrating and verifying the
combined candidate, then release its dependents from those actual files. A DAG record
is orchestration guidance, not a new Bridge scheduler or tool argument.

## Execution ownership before mode selection

This policy guides coordinator decisions; it does not add an automatic risk classifier
or a general DAG scheduler.

The orchestrator executes small/simple tasks directly when delegation and synchronization
would cost more than the work. It retains implementation that needs the whole-project
context or tightly coupled decisions, and sensitive, critical or high-impact work. This
includes the shared foundation, architectural decisions and integration.

Clearly scoped medium tasks are the usual delegation candidates. A difficult task can
also qualify when it is independent, non-critical, has stable inputs and clear boundaries,
and its result can be verified without repeating the implementation. Difficulty alone
neither requires nor forbids delegation. Compare the benefit with briefing, synchronization,
integration and review costs. If the orchestrator cannot provide a self-contained brief
or assess the result without redoing the work, keep it direct or refine its scope first.
Choose an original delegate or a managed Bridge mode only after this assessment. An
explicit task-specific user exception takes precedence; available workers, a queue, or
parallel capacity do not imply an exception. Required independent review can inspect
critical work without transferring its implementation ownership.

For dependent branches, the orchestrator implements and reviews the common foundation
before fan-out, or reuses an already accepted foundation. Give workers bounded eligible
tasks from that baseline. The orchestrator owns DAG stage transitions: review and combine
predecessor changes, resolve merge and interface conflicts, and verify the combined result
before releasing dependent tasks. Passing individual jobs alone does not release a stage.
Workers receive the actual reviewed file state and do not merge other branches or launch
the next stage unless explicitly assigned. Model dependencies in the existing plan; do
not invent a general DAG scheduler or unsupported tool fields. A truly standalone assignment needs no DAG; project-linked subtasks still use the
project DAG. Worktree requirements come from the selected transport, not task size.

## Shared invariants

- User authorization and project instructions bound all routes. Delegation does not
  authorize committing, merging, publishing, paid calls or more workers.
- The bridge owns jobs, locks, scopes, writer worktrees, slots and integration receipts.
  Do not clear leases manually or run raw CLI writers beside managed writers. This is not
  an OS sandbox; ordinary read scope is not complete filesystem read containment.
- Use supported schemas/calls and preserve models, variants and permissions. No automatic
  provider fallback or account switching. Auth/catalog discovery is not inference evidence.
- One coordinator owns integration; one executor owns each check/input state. Review actual
  source and test edits; reuse verifiable matching receipts, never a report's assertion alone.
- Related sequential steps can retain uncommitted predecessor files and integrate once.
  File continuity is not inherited session memory. Commits require separate authorization.
- Preserve pre-existing edits and partial artifacts. Cancellation must stop owned descendants
  before takeover. Quarantines and unresolved recovery remain blocking evidence.
- Keep one acceptance ledger. Final combined gates and required independent review remain
  pending until actually completed; no efficiency claim can replace them.
