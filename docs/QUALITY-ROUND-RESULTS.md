# Testing quality round — evidence and acceptance

## Current decision

**All requested local acceptance checks are complete and passing**, including
fresh full Node22/Node24 gates, actual isolated concurrency, root source/receipt
review and final preservation. **Independent review of the new Node22 ownership
compatibility correction remains pending.** Earlier account3 acceptance covers
the preceding source and completed evidence, not this new delta.

A bounded Windows private-alpha evaluation is conditionally defensible on the
covered local behavior, with that review and the limits below disclosed. These
tests do not establish real-provider reliability, pass the release audit, or
approve production release/deployment.

Candidate: `C:\Users\10User\bridge-testing-tools-2026-10-14`, branch
`codex/testing-tools-2026-10-14`, HEAD
`2f66a10593513f6930dea1a901f361bad5172f7f`, with uncommitted changes.
Current frozen244-executable-input identity:
`af55a8ea68475852a0303b46a2a510f3a254564754f6b79ec69ee5b682edb913`.
Earlier a255...16399 full-gate evidence is historical after this correction.
Evidence root (E): `.test-logs/quality-round-2026-10-16/`.

## Delivered improvements

- Strengthened actual queue retry properties and policy/schema fixtures:15 cases.
- Added actual-SQL lock ownership/release/expiry/heartbeat/finalizer properties:
  17 cases, including held-open stop/drain behavior and liveness-sensitive checks.
- Added actual durable queue lease renewal/reacquisition/ownership/probe
  properties:17 cases. Existing provider-wait9 and scheduler15 cases remain.
- Combined73-property command is wired once into the existing182-command full
  runner. No inherited assertion was deleted, weakened or bypassed.
- Scoped Stryker configurations and preserved exact input/report comparisons
  establish increased test sensitivity. No mutation score threshold or exclusions
  were introduced to obtain acceptance.
- One confirmed product correction, Q-20261016-01, in
  `bin/process-supervisor.js`: an expired positive supplied launch deadline is
  rejected immediately before payload spawn. Actual pre-fix control launched and
  wrote a marker; repaired22/24 controls report no launch/PID/marker, while valid
  future/legacy controls retain behavior. Strict identity/containment checks remain.
- A second scoped compatibility correction in `lib/queue/worker-files.js` qualifies
  complete pathname identities through a checked read-only handle when Windows
  `lstat` omits the volume ID. All ownership-level device/inode comparisons remain
  exact. Four regression controls extend the existing worker-release suite to72
  cases. This new correction has root review; independent review remains pending.

Dependencies and other testing-tool setup were inherited from the prior tooling
round. This round did not upgrade dependencies or add product features. See
`E/baseline.json`, `root/continuation-baseline.json` and archived before inputs
for attribution; the entire Git diff is not solely this continuation's work.

## Actual verification

| Check | Result | Evidence relative to E |
| --- | --- | --- |
| Retry native regression |31/31,0 skips,exit0 |root/retry-intent-root.receipt.json |
| Combined properties |73/73,0 skips,exit0 on22;also passed in both fresh full gates |root/final-property-node22.receipt.json; fresh runner command181 logs |
| Launch-authority before/after |Defect reproduced; repaired refusal and valid controls pass22/24 |root/authority-before.json, authority-after.json, authority-after-node22.json |
| Supervisor descendant diagnosis |Capped predecessor/repaired immediate/readiness/non-Node matrix passes; original cause unresolved |root/descendant-assessment.json |
| Stop/drain negative controls |Premature stop fails intended assertion on22/24,0 skips/cancels |root/final-stop-control-node22.receipt.json and node24 counterpart |
| Historical a255 Node24 full |182/182 commands,exit0;superseded for whole-candidate acceptance after correction |root/final-node24.receipt.json |
| Historical a255 Node22 full attempt |Interrupted;one observed worker-release failure3/68,0 skips;no full receipt |root/final-node22-full-interruption.json |
| Original isolated worker-release22/24 |22:3/68,exit1;24:68/68,exit0;zero skips;same a255 inputs |root/ownership-before-node22.receipt.json and node24 counterpart |
| Corrected isolated worker-release22/24 |72/72 each,exit0,zero skips;Node22 lifecycle also24/24 |root/ownership-focused22.receipt.json, ownership-focused24.receipt.json |
| Corrected Node22.13.0 full |182/182,exit0,4optional skips,2optional partial,0required;fixtures removed;stable af55 inputs;34m02.092s |root/ownership-full22.receipt.json |
| Corrected Node24.11.1 full |182/182,exit0,4optional skips,2optional partial,0required;fixtures removed;stable af55 inputs;32m49.714s |root/ownership-full24.receipt.json |
| Actual isolated `npm run test:concurrency` on22 |32 checks,0 skips,exit0;stable af55 inputs;44.776s |root/ownership-concurrency22.receipt.json and .log |
| Final preservation |main284/packaging447 files;exact baseline HEAD/status/inventory/hashes;244 current/archive inputs match |root/ownership-preservation-final.json |
| Final root receipt reconciliation |All364 command-log RESULTS checked across two full runs;skip reasons,runtimes and portable binary SHA verified |root/ownership-reconciled-ownership-full22-ownership-full24-ownership-concurrency22.json |

The full runner keeps normal3-suite/2-heavy scheduling,8 syntax workers and
required-skip policy, with required-skip override false. Both use real
setup/portable/build/release self-tests, not the config-reading release/deployment
path. Each full run's actual optional exceptions
are3 unsupported Git filename-character cases,1 symlink case and2 partial
symlink cases because this Windows host lacks the requisite privilege. None
is silently counted as covered behavior.

The official disposable Node22.13.0 executable was verified against SHA256
`364dbc8442f8d5c04fd4226bcfcf8e60d3268627eb1d7be214a91bb7d74cdbb9`;
the launcher prepends its directory to PATH for npm and child processes.
Empty disposable profiles, isolated Git configuration, flat external owned TEMP
and fake local agents keep these checks separate from live user/provider state.

The actual concurrency gate covers two cold-start bridges, shared readers and
exclusive writers,20 overlapping writer races,10 disjoint writer pairs,path
aliases,serial-integration exclusion,pipeline ownership,queue cancellation,
lease expiry/crash takeover,parallel timeout isolation,retained worktrees,
pre-spawn metadata refusal,capacity across4 processes,mixed limits,quarantine
release and both database integrity checks. Its agents are compiled offline fakes.

### Exact final commands and changed files

Executed from the candidate checkout using the existing isolated `check.mjs`
wrapper. The portable-runtime launcher prepended its directory to PATH for npm
and all child processes. Actual argv/environment/input hashes are in each
`.start.json` and `.receipt.json`; `.launch.json` identifies each persistent run.

```powershell
node .test-logs/quality-round-2026-10-16/root/launch.mjs ownership-focused22 22 .test-logs/quality-round-2026-10-16/root/check.mjs ownership-focused22 focused tests/review-day5-worker-release.js tests/review-flex-queue-worker.js
node .test-logs/quality-round-2026-10-16/root/check.mjs ownership-focused24 focused tests/review-day5-worker-release.js
node .test-logs/quality-round-2026-10-16/root/launch.mjs ownership-full22 22 .test-logs/quality-round-2026-10-16/root/check.mjs ownership-full22 node "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" test
node .test-logs/quality-round-2026-10-16/root/launch.mjs ownership-full24 24 .test-logs/quality-round-2026-10-16/root/check.mjs ownership-full24 npm test
node .test-logs/quality-round-2026-10-16/root/launch.mjs ownership-concurrency22 22 .test-logs/quality-round-2026-10-16/root/check.mjs ownership-concurrency22 node "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" run test:concurrency
```

This continuation changed only these nonignored files:
- `lib/queue/worker-files.js`: qualified missing Windows pathname volume metadata.
- `tests/review-day5-worker-release.js`: four regression controls;all68 old cases retained.
- `docs/QUALITY-ROUND-RESULTS.md`: diagnosis,actual results and readiness record.

Updated ignored records: `E/STATUS.md`, `E/HANDOFF.md`, `E/root/source-review.md`.
New diagnostic plans/probes,freeze/archive,launches/logs/receipts,reconciliation
and preservation evidence are under `E/root/ownership-*`. All inherited Git
changes remain present; the existing supervisor repair's hash is unchanged.

Failed/interrupted diagnostic attempts remain preserved: the original22 failure,
an initial new synthetic-inode drift assertion whose small offset rounded to the
same Number,an invalid canonical selector,and a foreground focused-run timeout.
The fixture now verifies a distinct injected inode; later focused/full gates
passed without loosening product assertions. No partial attempt counts as a pass.

## Mutation results

| Scope | Total | Killed | Survived | Timeout | Additional assertion kills vs preserved baseline |
| --- | ---: | ---: | ---: | ---: | ---: |
| Retry |194 |150 |42 |2 |30 |
| Locks |240 |168 |71 |1 |27 |
| Queue leases |132 |118 |14 |0 |3 |

All original kills were preserved against identical source/mutant identities.
These counts measure sensitivity to synthetic edits, not a count of real product
bugs. Timeout is not an assertion kill. Meaningful survivors remain documented,
including diagnostic shape, release failure cleanup, defaults and optional
callbacks; neither all survivors nor all defaults are declared harmless.

An intermediate lock measurement exposed a test waiting for DB entry after a
mutant pulse had settled. A test-only entry/settlement race now fails promptly.
Subsequent two-worker timing misses were investigated with capped exact-
instrumentation replays; sampled runs were slower under contention. The accepted
final measurement used supported CLI concurrency1, unchanged timeout configuration,
scope and assertions. This does not explain every timeout; mutant22 remains a
timeout. Normal full-runner scheduling was not changed. Original reports and
invalid diagnostic attempts are retained, not rewritten as passing evidence.

Evidence: `root/{locks,leases}-final-comparison.json`,
`root/final-survivor-classification.json`, `root/lock-mutation-pacing-plan.md`,
`root/final-locks-mutation-single.receipt.json`,
`root/final-leases-mutation.receipt.json`, `root/retry-comparison.json`.
Unchanged retry mutation was reused rather than rerun. All three measured scopes
are unchanged by the later worker-files correction. Their original measurements
remain valid scoped evidence,not a mutation measurement of the new correction.

## Independent source and evidence review

Existing account3 (`gpt-6.1-sol`,high) independently accepted the earlier a255 held-open
test delta and rehashed244 inputs. Its read-only completed-evidence review
also rehashed current/archive inputs and reconciled mutation identities and actual
Node24 manifest/report/log/skip evidence. No new blocker was found within that
review's coverage. Root inspected the product correction and relevant callers;
source coverage and limits are mapped in `E/root/source-review.md`.

Receipts: `account3/drain-liveness-delta-review-run/` and
`account3/remaining-acceptance-review-run/`. Root reviewed the new helper's fresh
handle acquisition/cleanup,strict caller device/inode comparisons,all affected
claim/refresh/error-cleanup call sites and refusal controls. Root also reconciled
the final af55 gates and preservation evidence. **Independent review of this new
compatibility fix and the final af55 evidence remains pending.** No additional
worker or schedule was created. Passing tests alone are not release acceptance.

## Known limits and release blockers

- The original worker-release failure is diagnosed: on this Windows host,
  Node22.13.0/libuv1.49.2 `lstat.dev` returns0 while `fstat.dev` returns the real
  volume ID1828387645 for the same file. Node24.11.1/libuv1.51.0 agrees across
  both APIs. Plain-file/SQLite, bigint and path-format probes reproduce the
  discrepancy; no fixture or scheduling race is needed. Relevant original source
  and test matched HEAD. The correction reacquires full pathname metadata rather
  than ignoring a mismatch. Precise upstream/OS cause is not asserted. Evidence:
  `root/ownership-stat-22.13.0.json`, `ownership-stat-24.11.1.json`, written
  `ownership-correction-plan.md`, `ownership-freeze.json`.

- One historical Node22 supervisor run reported a usable snapshot with no owned
  descendant found. Paired controls, independent diagnostic matrix and current
  uninstrumented prerequisites did not reproduce it. The original raw target
  identity/timing evidence is unavailable; no root cause or speculative repair is
  claimed. This remains an intermittent native reliability uncertainty.
- Windows deep Git destination paths can still fail. Keep worktree/scratch roots
  short for a bounded evaluation; no user configuration was changed here.
- Production `npm audit --omit=dev --json` remains exit1 for inherited SDK/high
  and proxy-addr/critical advisories. Inspected stdio paths do not expose their
  documented affected HTTP features, but this scoped assessment does not pass
  release audit policy or prove arbitrary future transports safe. Dependencies
  require a separate minimal compatibility-reviewed update before that gate passes.
- No real provider jobs, real-user configuration/install changes, Linux/macOS,
  sustained live load, power loss or full-disk behavior were validated.
- The parent preserves failed/no-payload-started outcome for stale launch authority
  but does not expose the receiver's specific errorType unchanged.

No universal absence of bugs, unconditional daily-work dependability or public
production readiness is claimed. The required local gates and preservation checks
now pass. A bounded Windows private-alpha evaluation is conditionally defensible,
using short roots and disclosing these limits and the pending independent review.

## Preservation and efficiency

Final comparison matches main's clean status and284 file hashes,packaging's exact
pre-existing status and447 hashes,both original HEADs and both complete file
inventories (`root/ownership-preservation-final.json`). All244 current/archive
executable inputs match the final freeze. Branch/HEAD remain as stated above.
No checkout commit,merge,push,deployment,new worker/schedule,dependency addition,
account/model/security setting change or real-user/provider operation was made.

Historical a255 Node24 full took33m14;fresh af55 Node22 took34m02,Node24 took32m50,
concurrency took44.776s;lock final mutation23m57;lease final mutation2m38.
These measured intervals overlap other work and are not summed as whole-round
wall time. Available worker usage will be recorded from structured completed-turn
events; missing coordinator usage is unknown. No invented three-hour-per-agent
claim, exact waste total or cost is inferred.

`E/root/usage-coverage.json` retains raw terminal records for10 completed worker
runs across4 sessions at this update. Resumed-session values are monotonic and
appear cumulative; a naive per-run sum was invalidated in that artifact rather
than reported as an accounting total. Cached input and reasoning are subsets.
Until the accumulation semantics are independently verified, no whole-round
token total or per-card saving is claimed. Coordinator usage remains unknown.

Workflow review reused exact existing receipts and avoided rediscovery and unchanged
mutation reruns. Node24 was rerun only after executable inputs changed. The isolated launcher quoting
mistake and sampled machine-contention effects are recorded without claiming an
exact waste total. Existing skills already require state inspection, safe quoting,
scoped ownership and valid-receipt reuse; no additional overlapping workflow
skill or unsupported personal-skill change was introduced.

One continuation launch split the npm-cli Program Files path and exited before
tests in102ms. Its `root/final-node22.*` invalid-launch evidence is preserved;
the correctly quoted interrupted attempt is `root/final-node22-full.*`. The final
completed22 gate is `root/ownership-full22.*`. The quoting error was a launcher
error,not a product/test failure or a reason to alter permissions.
