# Shared coordination boundary

Maintained source adapted from the agent-mcp-bridge orchestration draft and the balanced
Day4/Day5 and Public Menu lessons. The three entrypoints split decisions, execution and
learning; this reference owns their common invariants.

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
not invent a general DAG scheduler or unsupported tool fields. A small single task needs
neither a new DAG nor a compulsory worktree.

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
