# Durable queue lease properties

The account3 lease scope adds `tests/property-queue-leases.js` and
`tests/helpers/queue-lease-fixture.js`. Production code and package/runner wiring
are unchanged. Root owns independent review, wiring, Node 22.13 execution and all
combined/native/mutation gates. These results are bounded local evidence, not a
production-readiness claim.

## Actual boundary and independent expectations

The fixture imports the actual exported `createQueueLeaseRuntime` from
`lib/queue/leases.js`. Its renewal, reacquisition, handover and watchdog methods
execute their actual SQLite statements. Wait probes open their own actual
read-only SQLite connection to a disposable file database. There is no replacement
SQL ownership implementation or fake CAS seam.

Expected results come from explicit identity/status/deadline matrices and a small
state sequence: unchanged sleeping owner recovers repeatedly; a later generation,
instance, revision, cancellation, completion or deletion prevents further recovery.
The six takeover sequences also run deterministically. Generated identities use
separate namespaces from fixed foreign identities.

| Contract | Evidence in the suite |
| --- | --- |
| Renewal requires live job and instance leases | Each expiry independently at -1, 0 and +1 ms; blank/null and missing instance; exact deadline refused |
| Reacquisition recovers unchanged generation and revision | Repeated generated delays without sleeps, expired job/instance, missing instance; local revision advances, loss flag clears |
| Replacement or cancellation cannot resume old ownership | Correct/wrong/blank/null generation, changed instance/revision, missing job; all eight active and five terminal states, unknown status, null/empty/nonempty cancellation |
| A stopped execution stays stopped | Reacquisition cannot un-abort the old controller; an expired instance still prevents a recovered job passing its probe |
| Probe distinguishes stop reasons | 34 deterministic cases: cancellation wins over completion/replacement; terminal completion differs from genuine ownership loss; generation, instance, status and both deadlines are checked |
| Checks do not extend ownership or write | Repeated probe calls compare every job/instance row, writer connection's `total_changes`, database file SHA-256, and local lease/fence state |
| Local release is idempotent | Matching abort reason, cancellation flag, one info-level release/wake; true loss is error-level; repeated release/loss preserves the original abort |
| Fence changes follow caller responsibilities | Renewal replaces the old timer, `resetFence: false` preserves it until a synthetic commit callback resets it; exact fail-closed deadline and failure guard tested with mocked time |
| Real watchdog caller obeys renewal gate | Live renewal succeeds; replaced, cancelled and expired rows stop locally, with no silent reacquisition |
| Unrelated state survives writes | Sentinel job, all instance rows and unrelated JSON fields preserved; failed SQL calls preserve all local and durable state |

Two existing semantics are deliberately explicit: matching **blank** generations
can renew through the low-level renewal function, while reacquisition requires a
nonblank generation. Renewal can advance from a stale local revision while the
same owner remains live; reacquisition requires the exact revision. The tests do
not silently tighten either production contract.

Inspected callers: `heartbeatKnownQueueState` refreshes the instance in its real
transaction, renews copies with fence reset deferred, and only automatically
reacquires pre-execution records before post-commit callbacks.
`createQueueStartRuntime` retries a refused transition through reacquisition and
uses the probe in provider-wait progress; execution receives the real spawn and
watchdog ownership callbacks. Probe cancellation/completion uses local handover;
watchdog renewal failure uses definitive ownership loss. Those distinct paths
retain their existing behavior.

## Fixture limits

Only `opencode_jobs` and `bridge_instances` columns used by these methods exist.
Instance registration is seeded/updated directly. Project path resolution,
event collection, wake/scheduler behavior and commit callbacks are synthetic.
The tests do not start a bridge, scheduler loop, provider, subprocess or server.
They do not cover heartbeat transaction rollback, real cross-process races,
SQLite busy/error injection, malformed SQL renewal timestamps, schema migration,
pruning, maintenance, pipeline propagation, native containment or live providers.
Existing Day5/native controls remain root's responsibility.

Memory databases cover SQL writes; probe cases use flat `ql-*` directories under
canonical external local TEMP. The parent is bounded to 120 characters (this
sandbox's parent is 93), keeping these flat paths below 150. UNC/network and
checkout-contained TEMP are rejected. Cleanup closes probes and fences and then
checks canonical parent/root, no root symlink, fixed prefix and a unique owner
marker before native recursive deletion. No hard links or global TEMP changes.
Fixture seeding is committed once before the method under test observes it.

The suite uses APIs available in Node 22.13 (`node:sqlite`, `import.meta.dirname`,
`node:test` mock Date/timers), but account3 executed **Node v24.11.1 only**.
Minimum-runtime validation remains root's gate.

## Runs and replay

Run directly, without a listening server or Node test-worker subprocess:

```powershell
node tests/property-queue-leases.js
$env:FC_SEED = '8675309'
node tests/property-queue-leases.js
Remove-Item Env:FC_SEED
```

Default seed is `20261016`. Four properties run 80 identity cases, 80 sleeping
sequences, 40 file-backed probe transitions and 80 wait-publication cases:
**280 generated samples per full run**, in addition to deterministic cases.
The write matrices contain 20 identity/missing scenarios, 70 status/cancellation
scenarios and 21 lease/missing-instance scenarios; probe and handover each cover
34 cases. No generated sample is filtered/discarded with `fc.pre`.

Set `FC_PATH` to fast-check's reported shrink path and select that property's
name with Node's `--test-name-pattern` when replaying a counterexample. Selection
is only for diagnosis; both acceptance seed runs execute every test with zero
skips. `FC_LEASE_TRACE=1` records every successful generated input as diagnostics.
Successful full logs below include those inputs.

Evidence directory: `.test-logs/quality-round-2026-10-16/account3/leases/`.

| Final frozen input | Result | Process elapsed | Log and receipt |
| --- | --- | --- | --- |
| Default seed 20261016 | 15/15, 0 fail/cancel/skip | 5663 ms | `default.log`, `default.receipt.json` |
| Extra seed 8675309 | 15/15, 0 fail/cancel/skip | 5960 ms | `8675309.log`, `8675309.receipt.json` |

`run-evidence.ps1 -Mode seeds` records executable/argv, UTC start, elapsed time,
runtime, seed/path and SHA-256 of both test inputs and actual lease source.
It preserves/restores process-local environment variables. Exact machine-readable
final results and hashes are in `final-report.json`.

## Direct mutant sensitivity (not a Stryker score)

`mutation-observer.mjs` registers the isolated `mutation-loader.mjs`; each named
source replacement must match the actual lease module exactly once. Only the
loaded module is transformed. Assertions, fixture policy and shipped source stay
unchanged. `run-evidence.ps1 -Mode mutants` runs the same entire standalone suite
for each control and checks unchanged input hashes afterward.

| Control | Safety assertion that detects it |
| --- | --- |
| Remove reacquisition revision guard, retaining bind count | Revision conflict matrix and generated takeover sequence refuse stale owner |
| Accept job renewal at exact expiry (`>=`) | Deterministic job deadline and watchdog renewal refuse equality |
| Ignore wait-probe cancellation request | Active cancellation aborts as `agent_cancelled` |
| Ignore wait-probe instance lease | Expired/invalid/missing instance loses ownership even with live job lease |
| Remove handover abort | Released local work must actually abort with its matching reason |

All five controls produce assertion failures (exit 1), with zero skips/cancels.
Each has `<control>.log` and `<control>.receipt.json`; minimized generated
counterexamples and shrink paths are preserved in the logs where applicable.
No full Stryker, full-suite, integration, listening-server or hard-link probe was
run by account3 in this scope.

## Failures and review handoff

`initial.log` preserves six initial harness failures: four SQL comparisons
mistook SQLite null-prototype rows for plain objects, and two file tests rejected
the sandbox's canonical 93-character TEMP against an initial 80-character limit.
These were diagnosed before correction. The bounded path limit is now 120;
row comparisons normalize only their object prototype, retaining every column.
`development-2.log` passed 10/10 and `development-3.log` passed 12/12.
An initial evidence-script parent-depth error stopped before executing tests;
its exact command/error and correction are in `development-ledger.md`.

`pre-review/` preserves the earlier 13-test two-seed receipts and five mutant
runs. Self-review then fixed a theoretical generated-name collision with
`replacement`, added six deterministic post-recovery takeover transitions, and
checked that an already aborted execution cannot be revived. Final receipts
apply to the resulting 15-test files. No actual product defect or minimized
product repro was found; expected mutant failures are not product failures.

Those worker receipts measured the15-test input. Root subsequently added a
probe-open preparation failure/cleanup/recovery case and default renewal-failure
deadline/reason case; the current suite has17 tests. Current combined execution
on official portable Node22.13.0 passed73/73 across five files with zero skips
(`root/continuation-property-node22.receipt.json` under the quality evidence root).
Independent account3 review ACCEPTED the current test/config/wiring deltas.

The first actual lease Stryker measured the earlier15-test input:132 mutants,
115 Killed/17 Survived/0 Timeout,87.12%. Its report and current measured input
were preserved under `root/leases-final-inputs/` before the justified final
measurement. Do not attribute that earlier score to17 tests. The final root-owned
measurement on17 tests is now132 mutants,118 Killed/14 Survived/0 Timeout,
89.39%, with3 additional assertion kills and no original kills lost. Exact
source/mutant identities and input hashes match; see root/leases-final-comparison.json
and final-leases-mutation.receipt.json. Node24 full182/182 is accepted; Node22
full/concurrency and overall acceptance remain pending at this update. Worker-only
execution claims above remain historical and are not rewritten as root evidence.
