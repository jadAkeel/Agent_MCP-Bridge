# Quality verification round — 2026-10-16

## Goal and authorization

Improve evidence for existing behavior, without adding features. The human
authorized root and exactly one external Codex CLI worker, account3 on
gpt-6.1-sol high. Aim for approximately three hours of useful work per participant;
this is a planning budget, not a reason to repeat unchanged checks or manufacture
findings. Continue unattended, resolve routine choices, and record genuine limits.
No commit, merge, push, deployment, live provider jobs, credential/config reads,
real user configuration edits, dependency additions, or speculative cleanup.

Candidate: C:\Users\10User\bridge-testing-tools-2026-10-14
Branch: codex/testing-tools-2026-10-14
Preserve main and the separate skill-packaging checkout unchanged.

## Verified predecessor and open risks

The preceding round reports one real complete npm test pass: 182/182 commands,
four optional skips, two optional partial cases, zero required skips. Its receipt
is .test-logs/retry-followup/round3-full.receipt.json and dated report is
.test-logs/2026-10-15T20-41-41-703Z-2040/report.json. Root must validate the receipt's
238 hashes before reuse. Retry mutation: 194 mutants, 120 killed, 72 survived,
two diagnosed timeouts, 62.89%. Survivors are coverage signals, not bug counts.

The earlier Git destination-depth failure has a native reproduction and a
minimal shorter test prefix; arbitrary long production roots remain a disclosed
limitation. The earlier process snapshot failure has unknown historical cause;
current representative parallel and full-suite checks passed. Do not claim that
the old cause was repaired. Node 24 was tested; Node 22 and live providers were not.

## Ownership and sequence

| Stage / approximate budget | Root | account3 |
| --- | --- | --- |
| Establish baseline, 0–20 min | Verify current processes, inherited receipts, candidate identity; save baseline and preservation evidence; inspect critical coverage | Read compact brief; inspect real retry source and survivor report |
| Strengthen distinct boundaries, 20–100 min | Real lock runtime: generated ownership, overlap, integration exclusion, lease/release/quarantine state transitions; inspect cancellation/recovery/integration existing coverage | Retry: rank all 72 survivors by consequence, strengthen generated retry/model/wait/manual-admission cases where meaningful; preserve existing cases |
| Mutation and cross-review, 100–135 min | Review retry diff/results; run bounded lock mutation controls where useful; validate no product-source drift | Run targeted retry mutation once after stable tests; report exact transitions and limitations; independently inspect root's lock tests/fixture at a frozen boundary |
| Final combined gate, 135–180+ min | Sole complete-suite executor: wire combined tests, freeze candidate, npm test through real runner with normal scheduling and skip accounting; relevant concurrency/local release gates; final source review and report | Finish independent review and respond to concrete correction requests without overlapping test execution |

Actual scheduling follows dependencies and measured progress rather than artificial
deadlines. The last full gate took 31 minutes; give legitimate checks enough time.
The root may start required final gates earlier after both executable scopes are
frozen. No concurrent full suites or competing Stryker jobs.

Compatibility extension: the advertised minimum is Node 22.13.0 and it has never
been verified in these receipts. Root may use the official Windows portable
binary in ignored artifacts, checked against the official SHA-256 manifest,
without a global install or dependency change. Run properties/prerequisites first;
then a separate complete gate on the same frozen candidate if prerequisites pass.
This checks a different supported runtime, rather than repeating an unchanged
environment. Record each runtime and its actual result separately.

### Exact file ownership

- account3: tests/property-queue-retry.js, tests/helpers/queue-retry-fixture.js,
  docs/RETRY-PROPERTY-MUTATION.md; its own evidence under
  .test-logs/quality-round-2026-10-16/account3/. Existing mutation configuration
  and baseline reports stay unchanged; preserve prior mutation outputs before run.
- root: new tests/property-locks.js, tests/helpers/lock-fixture.js, scoped
  lock/lease mutation configs, package.json wiring, tests/review-test-runner.js
  inventory assertion only if actually required, this plan and final quality
  documentation; root evidence under .test-logs/quality-round-2026-10-16/root/.
- Production lib/bin/server files are read-only during testing work. A confirmed
  existing product defect requires a minimal written repro/plan before a separate
  specifically owned correction. No new feature or broad production refactor.

Next coherent worker card, after its independent lock review: strengthen the
durable queue lease/generation boundary, which the scheduler fixture currently
stubs. account3 may own new tests/property-queue-leases.js and
tests/helpers/queue-lease-fixture.js plus docs/QUEUE-LEASE-PROPERTIES.md, using the
actual exported lease runtime and isolated SQLite, not a fake CAS implementation.
Focus on owner instance+generation, active/terminal and cancellation transitions,
expired lease reacquisition, and wait-ownership probes. Preserve existing native
two-process/child containment coverage rather than reproducing it. Root owns
combined wiring and mutation execution (the worker's actual sandbox IPC/link
refusals are already established). No overlapping worker job may be started.

Workers are not alone. Preserve all inherited edits and one another's files.
Review does not transfer write ownership. Root integrates only after worker ends.

## Test design and acceptance

Use real exported runtimes, actual isolated SQLite/native filesystem boundaries
where relevant, and independent invariants, rather than a replica of the source.
Generated states/actions need deterministic seeds and replayable counterexamples.
Reject implementation-mirroring assertions and score-only tests. Do not delete,
weaken, skip, or fake assertions or relax safety, identity, timeouts, containment,
normal suite scheduling, or required skip policy to get green results.

Reuse existing cancellation, durable retry, integration recovery, quarantine and
concurrency coverage after source inspection instead of duplicating it. Select
focused checks for changed contracts; one full npm test at final stable boundary,
plus justified isolated concurrency/release checks. Do not count partial runs as
the full gate. Record exact commands, exits, counts, skips/reasons, runtime,
candidate identity, logs, and relevant mutant transitions. Preserve old receipts.

Keep tests in disposable empty profiles with flat external validated TEMP, isolated
Git configuration and fake executables. No ambient MCP/private configuration or
real workloads. TestSprite is not a substitute for this local MCP CLI suite; no
project link exists in this checkout, and no external project/config is to be read
or created for this round.

## Coordination and reporting

### Confirmed repair card Q-20261016-01 (root approved)

Independent account3 source review found stale receiver launch authority. Root's
actual native control reproduced it: root/authority-before.json, command
`node .../root/check.mjs authority-before node .../root/launch-authority-repro.mjs`.
A positive supplied deadline already one second in the past produced a `launched`
event AND wrote the local marker before watchdog termination. Future-deadline
control also launched, excluding a broken fixture. This is a real existing
correctness defect, not a hypothetical race or a mutation survivor count.

Root authorizes account3 exclusive write ownership of bin/process-supervisor.js
for the smallest receiver-side fail-closed check immediately before spawn plus
embedded self-test regression, preserving optional-deadline legacy behavior,
protocol/version, PID identity, containment and all existing tests/timeouts.
No other product file or test assertion may change without a concrete necessary
correction plan. This supersedes production-read-only ONLY for this exact card.
Root independently reruns before/after native marker controls on Node24 and22,
inspects the diff, and executes complete gates after repair acceptance. Main and
the separate packaging checkout remain unchanged. No commit/merge/push/deploy.

Record: source findings account3/final-review-run/final.txt; implementation brief
account3/authority-repair.md; exact resumed session and result recorded in STATUS.
The full suite must not be accepted on the preceding uncorrected production bytes.

Use the existing codex-dispatch transport with account3, gpt-6.1-sol, high,
workspace-write, clean-env. Preserve actual session/events/result paths and token
usage when available. No extra worker or schedule. One concise brief and delta
reviews; compact changed output; no repeated unchanged suite or session reloads.
Root sends progress before long operations and about every minute while active.

Maintain current status and receipts in .test-logs/quality-round-2026-10-16/.
Final report distinguishes inherited checks, this round's actual checks, unresolved
defects/environment limits, unverified production behavior and readiness. Passing
tests establish only the covered local candidate, not universal production safety.

## Continuation evidence at first source freeze

Expected branch/HEAD and all existing work were verified before edits. All303
current source/doc files were copied to ignored `root/continuation-before/`;
`root/continuation-baseline.json` verifies protected main284 and packaging447 file
hashes plus exact original HEAD/status. No competing executor was active.

The historical Node22 supervisor failure was snapshotOk:true/found:0, not a
snapshot command failure. Paired disposable predecessor/repaired probes and an
independent review's capped six-case matrix (immediate-exit, readiness-handshake,
non-Node parents) all passed. Raw owned PID rows and non-Node native-handle birth
times were retained. Forty separate clock controls found no upper-bound crossing.
Current uninstrumented supervisor selftests pass on22/24. No regression or further
safe correction was demonstrated; historical target evidence cannot be recovered,
so the cause remains unresolved. No timestamp/identity/containment relaxation or
fixture handshake was shipped. See `root/descendant-assessment.json`.

The lock stop/drain gap was closed with a held DB open, explicit entry/release
barrier and event-loop-turn pending assertion for success/failure outcomes.
Current combined properties passed73/73 on Node22, zero skips. Root preserved old
lock/lease reports and final measured sources separately before sequential reruns.
Retry's measured150 Killed/42 Survived/2 Timeout (78.35%) remains unchanged and
was not rerun. Final mutation and complete gate results are pending here.

Account3 independently ACCEPTED current executable candidate
`f47c02ee78889fe4022ca430a7dd0461e32f30682589b175f133dbd99095db4e`, rehashing244
inputs without mismatches. Root separately reviewed its earlier approved product
repair and callers. Only continuation executable edits are the lock test/helper;
the inherited approved supervisor hash remains34da823d…e9830. Source/delta review
does not substitute for final Node24/22 complete and concurrency gates.

### Test-liveness correction and superseding freeze

The first final lock run measured164 Killed/71 Survived/5 Timeout in16m15.484s.
Inspection showed a concrete test-liveness flaw: when a mutant pulse finished
without entering the DB open, the new drain test waited indefinitely for entry.
The five exact IDs68/70/164/166/174 and measured inputs/report were preserved in
`root/locks-held-barrier-measured/`; `root/drain-liveness-plan.md` preceded editing.
Only the lock test changed: assert acquisition, then race entry against pulse
settlement and require entry to win. The stop-pending proof and finally cleanup
remain intact. Exact synthetic174 now exits1 with intended assertion in3.5s,
zero skips/cancels; current combined Node22 properties pass73/73.

Superseding244-input freeze:
`a2551d119b3d4bf37fc1efc3b7bdafffa5cacf2443c342fe8c0b9f9cf7016399`.
All inputs are copied under `root/final-frozen-inputs/`, manifest final-freeze.json.
Narrow independent review and final-locks-mutation-v2 are active. Final lease
measurement and complete24/22/concurrency acceptance are still pending.
