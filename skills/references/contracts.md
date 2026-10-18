# Compact task/check contract

Reuse one existing ledger; no new coordination database is implied.

Task: ID/job ID, owner, state, goal/acceptance, input identity, predecessor decisions,
read/write/forbidden paths, interfaces/resources, runnable priority, stop conditions,
checks and executor, report/evidence locations and remaining integration concerns.

Check: exact command/arguments, one executor, pending/running/passed/failed/blocked/
invalidated, relevant candidate/source/test/dependency/config input identity, environment/
fixtures, start/end record, exit, counts/skips, artifact location, and reason for any rerun.
A relevant hash or timestamped change/run record suffices; do not continually hash the tree.
This policy ledger is NOT a cross-process test-dispatch lock. Serialize through one verifier
when multiple coordinators cannot establish reliable ownership.

Report: actual behavior/files, exact checks and evidence, unresolved requirements and
integration risks. Distinguish worker self-report, inspected receipts, coordinator review,
independent source review and unexercised live behavior.
