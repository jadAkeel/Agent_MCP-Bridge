---
name: bridge-execute
description: Execute an approved bridge plan with bounded worker ownership, concise context, check reuse, progress, recovery, source review and controlled integration. Use for pending authorized work; do not redo planning automatically.
metadata:
  version: "1.0.0"
---

# Carry out and balance

Input: approved plan and current pending work. Output: actual ownership/evidence,
reviewed combined candidate and honest acceptance state. Use
[coordination](../references/coordination.md) and the existing
[task/check ledger](../references/contracts.md); load
[verification](../references/verification.md) when assigning checks or deciding reruns.

1. Start only runnable priorities. Give each worker goal/acceptance, reviewed input and
   predecessor decisions, exact read/write ownership, forbidden paths, interfaces and
   shared resources, actual commands and check owners, stop conditions and report contract.
   Point to relevant source rather than transferring the whole chat/manual. Workers must
   preserve others' edits and must not commit, publish or recursively delegate.
2. Direct execution follows project rules. Light is one sequential `run_opencode_agent`
   with `executionMode: "light"`; managed writers require worktree isolation, explicit
   locks, allowed edits and a write Scope Contract. Parallel execution uses the existing
   validated parallel tool, strict locks and disjoint resources. Retained sequential
   `continueWorktree` preserves FILES, not session memory; carry decisions explicitly.
   An explicitly selected independent `*-delegate` instead follows its original relay
   and review procedure in an exclusive approved workspace. Bridge tools do not supervise
   that relay; do not invent bridge job IDs, isolation or integration receipts for it.
3. Preserve chosen model/effort/permissions and actual provider/local capacity. An unverified
   route gets one useful bounded task before fan-out. Model mismatch/evidence refusal
   blocks the unchanged route; no silent fallback, account rotation or broader sandbox.
4. Assign one executor per relevant check/input state. Inspect running/passing receipts
   before dispatching another check. Managed worktrees lack installed dependencies and
   builder shell access is restricted: `git diff --check` is only a whitespace check.
   Assign genuine behavior checks to an authorized environment with actual dependencies.
5. Keep meaningful progress updates during long work (roughly within a minute). State
   actual transitions, running command, verified results and blockers. Updates can use the
   last observation; they do not require another poll. Use completion waits, compact job
   views and changed event cursors; avoid unchanged full-log reads and repeated inventories.
6. Diagnose a suspected stall once: provider/quota wait, configuration refusal, crash,
   permissions, slow checks or watchdog expiry. Inspect terminal state and partial artifacts.
   Recover the unfinished acceptance concern with a delta, normally one diagnosed recovery
   before reassessment. Retry only with a changed premise or supported transient cause.
   Before takeover stop the owned writer through supported cancellation and CONFIRM owned
   descendants stopped; preserve partial/untracked edits, locks and quarantine evidence.
7. Inspect actual source/diff including untracked files and test edits. Reject scope creep,
   weakened tests, missing concerns and invented success. Reports and successful exits are
   not acceptance; green tests do not replace incomplete review. Required independent
   review means separate source inspection, not automatically repeating every command.
8. Preview `integrate_opencode_worktree` with `dryRun:true`, inspect/show the patch as
   required, then apply with the same contract, `reviewed:true` and exact `previewReceipt`.
   Use stat preview only after inspecting the actual diff. Never integrate an `in_use`
   worktree. The receipt binds patch/arguments; it is not proof of correctness. No automatic
   autoIntegrate/contractor mode or commit as an efficiency shortcut.
9. Verify interfaces and required combined checks on the final integrated candidate.
   Reuse valid evidence, invalidate affected checks after input changes, and run required
   independent/full gates at a stable boundary. Diagnose unchanged failures instead of
   blind reruns. Record unavailable checks as pending, not passing.

Finish with behavior/files, exact candidate path, actual exits/counts/skips/evidence,
review status and remaining required work. Measure outcome, elapsed time, attempts and
available structured usage honestly: cached/reasoning counters can overlap; parallel
windows overlap; missing usage is unknown. Claim savings only for comparable acceptance.
Use bridge-learn at a meaningful completion/interruption boundary when incidents warrant it.
