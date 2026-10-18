# Shared coordination boundary

Maintained source adapted from the agent-mcp-bridge orchestration draft and the balanced
Day4/Day5 and Public Menu lessons. The three entrypoints split decisions, execution and
learning; this reference owns their common invariants.

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
