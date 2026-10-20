# Beta stability investigation — October 20, 2026

## Baseline and evidence

The clean handoff checkout was `fix/ci-c783259` at
`a9070182fefaaaa20ac890189c94c96148755057`. PR #5 was open. Run
39353048668 eventually passed all nine matrix cells on a retry, but its first
Windows/Node24 attempt (job 118401539692, Node 24.21.0) failed two tests.
The green retry does not explain either original failure.

- B-152 retained-worktree-cap cancellation: the durable row remained `blocked`,
  `cancellationRequested=false`, revision 19, workspace wait count 6. Thus the
  cancellation was lost, rather than merely slow to become observable.
- Provider release: `waitedMs=461`, caller elapsed `491`; the strict `<30` ms
  comparison rejected return/measurement overhead as if it were slot wait error.

## Proven cancellation defect and minimal repair

The scheduler claims a job, the worker refuses the workspace, then returns it to
`blocked` with an advanced revision. `cancel_opencode_job` may read the active row
before that write. Its active branch awaited `persistQueueRecord` but ignored
`persisted:false`: persistence reloaded the blocked durable row (including its
false cancellation flag), and aborting the old controller could not cancel a
worker that had already returned. The tool nevertheless claimed cancellation.

The deterministic new D4 test advances `running` to `blocked` between cancellation
read and persistence. Before the repair it failed (33/34 tests passed); after the
repair it passed (34/34). The active branch now uses the same existing durable
cancellation fallback as a pre-execution cancellation when persistence loses.
Successful active persistence still requests exact-tree termination; blocked
cancellation becomes terminal atomically. Existing generation/revision fences,
terminal outcomes and pipeline reconciliation remain in place.

This is a source-proven explanation consistent with B-152. The original CI log
does not retain the cancellation response or full interleaving, so it cannot
prove that particular execution took exactly this branch.

## Wait measurement

The real SQLite release test observes terminal lease progress, then intentionally
delays its progress consumer by 60 ms. It separately records grant observation
and caller elapsed time and asserts the reported wait ends before that delay.
The original acquisition budget and wait bounds are retained. No timeout was
expanded and no test was removed or skipped.

## Focused verification

Windows 11 x64, Node v24.11.1, disposable homes/config/state with ambient auth
removed; no provider calls:

| Invocation after `node bin/verify-isolated.js --node` | Result | Local receipt directory under `.test-logs/` |
| --- | --- | --- |
| `tests/review-queue.js` (before repair) | 33/34; new race test failed | `packaging-1792492141638-14004` |
| `tests/review-queue.js` | 34/34 | `packaging-1792492350713-10864` |
| `tests/review-provider-wait.js` | 22/22, zero skips; wait 203 ms, grant observed 204 ms, return 270 ms | `packaging-1792492350752-27412` |
| `tests/review-batch-race.js` | 16/16, zero skips | `packaging-1792492350772-27956` |

Receipts identify their exact inputs. Subsequent packaging/version or formatting
edits require the final broad gate and matrix; these focused results are not
relabelled as final-release evidence.

## Acceptance boundary

Jad explicitly deferred inference in this session. Real-client/provider
read/write/review/preview/exact-receipt apply and independent-user acceptance
remain blocked pending client, route/model/account and budget selection.
Fixtures, CI and health are not substitutes for that acceptance.
