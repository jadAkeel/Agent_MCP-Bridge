# Retry property and mutation evidence

2026-10-14–15, Windows, Node 24.11.1; fast-check 4.10.2 / Stryker 9.6.1.
Status: successful initial **194-mutant** retry baseline and two survivor-driven
verification rounds completed. The earlier runner IPC `EACCES` failure is historical
and superseded. Latest: **120 killed, 72 survived, 2 timed out, 0 errors; 62.89%**.
The second-round gate failed at 174/182. After the Windows fixture correction
below, a new **single complete `npm test` passed: 182/182 commands, exit 0**,
31m20.156s, with four optional skipped cases, two optional partial cases and zero
required skips. Local testing acceptance is now established for the recorded
synthetic environment; historical snapshot uncertainty remains explicit.
No confirmed product defect or product source change. All candidate edits remain
uncommitted in `C:\Users\10User\bridge-testing-tools-2026-10-14`, branch
`codex/testing-tools-2026-10-14`.

**2026-10-16 extension:** seven more retry properties now pass with two seeds.
The complete gate above belongs to the predecessor; root owns the new combined
gate. Account3's one new Stryker attempt failed before execution with IPC
`EACCES`, and its native retry-intent check encountered `fs.link` `EPERM`.
The latest completed mutation score remains the inherited **62.89%**, not a
measurement of the extended suite. See the final section for receipts and limits.

## Initial coverage assessment and choice (three-property baseline)

Bounded inspection: `lib/queue/retry.js` policy/receipt/dispatch/requeue functions,
`lib/queue.js` retry constants, and targeted sections/searches of
`review-day5-retry-intent.js`, `review-flex-fallback.js`, `review-queue-cost.js`,
`review-pause-precheck.js`, existing property examples and mutation documentation.
One initial PowerShell `rg` wildcard was rejected; the subsequent directory search
found the relevant coverage. No whole suite or personal configuration was read.

Ranked gaps:

1. **Dispatch identity and release:** Day5's overlapping-scan case exercises one
   identity. Generated simultaneous distinct cwd/job pairs additionally establish
   that coalescing includes both identifiers, preserves one promise per pair,
   accounts for all outstanding decisions and releases keys after failed lookup.
2. **Wait caps at the execution boundary:** fallback cases cover two slot waits
   and one paused refusal. Generated cap-minus-one/exact-cap slot (12) and pause
   (24) cases cross execution attempts 1–10, available/exhausted execution budget
   and repeated dispatch. The test's independent outcome table checks admission,
   unchanged predecessor budget, exactly one successor history entry, wait counter
   changes and durable final receipt stability.
3. **Persistence stress, supplementary:** Day5 already proves native rollback and
   idempotent recovery. New generated repeated receipt failures vary wait count,
   attempts and repetition, ensuring committed intent stays byte-equivalent as
   parsed state and recovery does not charge the successor twice. This extends
   combinations rather than claiming the rollback invariant was uncovered.

No extra rate-limit, infrastructure, model-selection or worktree suite was added:
existing examples cover those paths and they are outside the chosen coherent gap.

## Initial files and harness boundaries

- `tests/property-queue-retry.js`: initially three async properties, 100 cases each;
  the follow-up adds three more, described below.
- `tests/helpers/queue-retry-fixture.js`: actual production retry runtime and
  isolated `DatabaseSync(':memory:')` predecessor CAS/receipt SQL. A SQLite trigger
  rejects successor marking until removed. No timers/processes/providers are run;
  every fixture closes its DB and the dispatch gate releases in `finally`.
  The follow-up also injects non-throwing mark refusal and inconsistent receipts
  with SQLite triggers, plus detached lookup/logging failures.
- `stryker.retry.config.json`: separate focused command-runner configuration.
- This document; artifacts under `.test-logs/account3-retry/`.

External admission is a stub backed by a real SQLite UNIQUE(root,key) table;
decryption/schema/project checks are synthetic boundaries. The harness does not
implement retry accounting or force dispatch coalescing. It does not prove the
production enqueue fingerprint, encryption, real cross-process admission,
on-disk crash durability, scheduler recovery or provider behavior. Existing Day5
tests remain the authority for those integration guarantees. No shared helper or
existing test was changed in the initial round. The follow-up changes the command
inventory and reruns its 26-test suite as well as the 31-test retry suite.

## Historical initial checks and replay

Final receipts include timestamps, exit codes and SHA-256 hashes of the tests,
fixture and source. Stdout/stderr are merged into the corresponding `.log` files.

| Command | Result | Evidence under `.test-logs/account3-retry/` |
| --- | --- | --- |
| `node --test tests/property-queue-retry.js` (seed 20261014) | exit 0; 3/3, 300 generated cases, zero skips; 498.6549 ms | `final-20261014.log`, `.receipt.json` |
| same command, `FC_SEED=987654321` | exit 0; 3/3, 300 generated cases, zero skips; 495.6733 ms | `final-987654321.log`, `.receipt.json` |
| in-memory negative control (below) | exit 1; selected property failed after one generated case, shrunk once | `negative-control.log`, `.receipt.json` |
| negative control replay, `FC_SEED=20261014 FC_PATH=0:0` | exit 1; identical counterexample, zero further shrinks | `replay-negative.log`, `.receipt.json` |
| `node_modules/.bin/stryker.cmd run stryker.retry.config.json` | historical exit 1 before tests, runner IPC EACCES; superseded by the successful run below | `mutation.log`, `.receipt.json` |

Earlier development logs are retained: `property-default.log` failed because the
generator allowed maxAttempts 11 (attempt 10 plus headroom). This was a fixture
input defect, not a product defect. The generator now restricts headroom to the
supported maximum 10. Earlier successful receipts precede a diagnostic-only
generated-count correction; final receipts above bind the frozen test files.

The negative control uses Node 24 `registerHooks` to change only the loaded source
expression `const nextAttempt = uncounted ? attempt : attempt + 1;` to
`const nextAttempt = attempt + 1;`. No source file changes on disk. This experiment
is evidence that the property detects lost uncounted-budget behavior; it is not a
Stryker result or product bug. Minimal counterexample: slot wait count 11,
attempt/maxAttempts 1, two overlapping dispatches; successor attempt becomes 2
instead of 1. Replay in PowerShell:

```powershell
$env:FC_SEED = '20261014'
$env:FC_PATH = '0:0'
node --import ./.test-logs/account3-retry/budget-negative-control.mjs --test --test-name-pattern='generated slot/pause' tests/property-queue-retry.js
Remove-Item Env:FC_SEED
Remove-Item Env:FC_PATH
```

For ordinary failure replay omit `--import`, use the reported seed/path, and
select the failed property with `--test-name-pattern`. The experimental loader
is an artifact and requires Node 24; the actual suite uses APIs available at the
project's Node 22.13 minimum, but was only executed on Node 24 here.

## Stryker scope and superseded infrastructure failure

Exact ranges in unchanged `lib/queue/retry.js`:
`273:0-322:0` (wait/infra/rate-limit classification, history, execution budget,
successor record fields), `339:0-347:0` (successor receipt validation), and
`366:0-396:0` (dispatch identity, coalescing, error containment and release).
Some classification branches are broader than the selected retry properties;
the survivor analysis below distinguishes those from meaningful gaps.

Command runner: `node --test tests/property-queue-retry.js`, coverageAnalysis off,
concurrency 2, timeoutMS 5000, timeoutFactor 1.5; no score threshold or mutant
exclusions. Complete HTML/JSON outputs are configured for
`reports/mutation/queue-retry.html` and `reports/mutation/queue-retry.json`.

**Historical failure, superseded:** at 19:59:16 +03:00 Stryker instrumented
**194 mutants** in one source file and
created two runner processes. At 19:59:17 it failed with:
`StrykerError: AggregateError: EACCES` in `internalConnectMultiple` /
`child-proxy/child-process-proxy.js:132:39`. No baseline test or mutant execution
was reported. **Killed/timed-out/survived/mutant-errors: unavailable**, not zeros;
one infrastructure run failure. No HTML/JSON reports were produced and no
survivor classification/comparison could be asserted from that failed run. Its
hashes bind the pre-diagnostic-correction tests; source and config are unchanged.

After the locked dependencies were installed with `npm ci --ignore-scripts`, the
same scoped Stryker command **completed with exit 0**: **194 mutants, 60 killed,
132 survived, 2 timed out, 0 errors; 31.96%**. This is the verified starting
evidence for the follow-up, not a failed mutation run. Its duration was not supplied
in the continuation evidence and is not inferred from the JSON report.

Before rerunning, both successful reports were preserved byte-for-byte at
`.test-logs/retry-followup/baseline/queue-retry.{json,html}`, along with the then
current tests, fixture, inventory, config and this document. `hashes.json` binds
those snapshots. Earlier `.test-logs/account3-retry/` evidence remains intact.

## First follow-up: review of all 132 baseline survivors and both timeouts

IDs refer to the saved successful baseline. All 132 survivors are accounted for
once in the following table. “Outside scope” means untested by these focused
properties, **not equivalent or unimportant**. No mutant was excluded. These
assessments describe the first follow-up; the second round below extends two
previously out-of-scope areas.

| Behavior / lines | Baseline survivor IDs (count) | Assessment and follow-up |
| --- | --- | --- |
| Rate-limit output signals and wait admission, 276–279 | 0–9, 11–16, 19, 25–31 (**24**) | Output count, final response, changed files and the pause cap are meaningful contracts. None of the original three properties supplies a rate-limit error, so these changes are unobserved. IDs 25–26 relax ordering guards; accounting can be redundant when another uncounted category already applies, but returned flags/diagnostics can still differ. This entire behavioral group remains outside this round's slot/pause/receipt/dispatch scope. |
| History and uncounted notes, 281–285 | 39–44, 47 (**7**) | **44** drops the history bound; **47** erases the new job/error entry: meaningful gaps now killed. 39–43 change explanatory persisted text, not budget decisions; exact prose is deliberately unasserted. |
| Give-up receipt, returned details and diagnostics, 287–298 | 51–66, 74 (**17**) | **51–52** lose the durable completion marker/history or its value: now killed. **53** removes returned attempt/history details, still unasserted (not equivalent). 54–57 alter whether a give-up event is logged, while returning the same decision; 58–66 and 74 alter event fields/message wording. Logging semantics are separate from the selected durable-state contracts. |
| Infrastructure backoff, model rotation, successor wait metadata/counters, 306–317 | 76–85, 89, 92–95, 101 (**16**) | Meaningful infrastructure delay/counter, fallback model and startAfter/reason contracts. The fixture has no candidate models, no active pause map and no infrastructure error, so these are unobserved or their fields are unasserted. Not global equivalents; left outside scope. |
| Durable successor receipt / success log, 341–346 | 103, 106–110, 112–114, 116, 118–123 (**16**) | **106–110, 114, 118–121** bypass or misreport incomplete receipts: ten meaningful changes now killed. **103** is equivalent: the `onlyIf` predicate returns falsy either way. **113, 116** remove optional chaining after earlier short-circuit checks already establish a summary (plain SQLite/JSON objects), so are equivalent on this path. **112** differs if the terminal row disappears/changes status before receipt lookup: a defensive concurrency edge outside this fixture, not a proven equivalent. 122–123 are success event level/name changes. |
| Detached error handling and diagnostics, 371–373 | 130–142 (**13**) | **130–134** damage error-category preservation or handling of null throws: now killed. 135–142 remove/change failure logging; not equivalent diagnostics, but unobserved by the selected outcome/cleanup contract. Logging-throw containment is exercised without requiring exact prose. |
| Manual requeue argument/default validation, 390–395 | 146, 148–150, 154–156, 158, 162–180, 182–193 (**39**) | Most protect meaningful jobId, timeout (integer/zero/max) or model contracts, plus refusal text. Policy dispatch passes a valid ID, no timeout and an explicit empty model, so manual-input behavior is outside scope. **168** is redundant with `!Number.isInteger(timeoutMs)`. **184–186, 188, 190** are equivalent validation guards: the default replaces undefined with `""`, and the final typeof check already excludes strings; changing/removing the preceding guards cannot admit a nonstring. Other members are not labeled equivalent. |

Totals: **24 + 7 + 17 + 16 + 16 + 13 + 39 = 132**. The exact per-mutant
before/after status ledger is `.test-logs/retry-followup/mutation-comparison.json`.
The remaining 113 survivors are the same listed groups minus the 19 new kills.
The score is not a diagnosis of a product defect.

### Comparison with the 31-test retry regression suite

`tests/review-day5-retry-intent.js` already tests committed intent before dispatch,
fresh-process crash recovery, a two-process race with one successor, overlapping
scans, policy/no-policy and exhausted-budget settlement, cancellation/parent/final
exclusions, live-orphan deferral, decryption and persistence failures, native
successor/terminal/definitive-decision rollback, generation/lease fencing, bounded
recovery cursors, malformed retained JSON and idle DB stability.

Those integration guarantees were **not missing simply because the property-only
mutation command scored 31.96%**. Its SQLite trigger for mark failure (and the
original property trigger) throws before the later receipt guard. The new tests
complement it with non-throwing refusal and individually inconsistent receipt
fields. The 31-test suite also covers one exhausted attempt and a tagged dispatch
failure, but does not generate bounded retained histories or make detached logging
throw. `review-flex-fallback.js` separately contains counted rate-limit output,
model rotation, provider pause and slot-wait examples; it was inspected, not
executed in this follow-up. No claim is made that those examples kill every
out-of-scope mutant.

### Three added properties (100 cases each)

1. **Counted attempts and retained history:** ordinary retryable failures vary
   attempts 1–10 and headroom; check one counted successor or a durable gave-up
   receipt, retained recent entries up to the history bound, a nonempty failed-job
   and error entry, unchanged predecessor attempt, and stable later decisions.
   Retained-history inputs include the configured bound (including legacy stored
   state); this is not a claim that every length is reachable in one fresh chain.
2. **Receipt integrity before reporting success:** SQL triggers refuse a mark
   without throwing, or independently corrupt successor identity, pending intent,
   or decision outcome after an acknowledged mark. Admission must not be reported
   as a completed retry. A refused mark leaves original intent unchanged and
   recovers the same admitted child after repair, without another wait charge.
   The contradictory-receipt cases prove fail-closed reporting, not recovery from
   arbitrary corruption or cross-process/power-loss durability.
3. **Detached failure containment and release:** overlapping callers share one
   decision; ordinary, tagged and null lookup throws resolve with the appropriate
   failure category, even if failure logging throws. The count returns to zero and
   the same identity can subsequently requeue normally.

The fixture still calls the production runtime with in-memory SQLite; admission
is synthetic and uses UNIQUE(root,key). No provider, process executor, encryption
key or user profile is involved. All six properties retain deterministic default
seed **20261014**, fast-check shrinking and `FC_SEED` / `FC_PATH` replay. Select
one failed property with `--test-name-pattern` when replaying a path.

### Timeouts: meaningful finalization changes, still not assertion kills

- **124**, `BlockStatement`, 366–380: erases the entire detached callback, including
  policy execution, cleanup and promise resolution.
- **143**, `BlockStatement`, 375–379: erases `finally`, including count decrement,
  dispatch-key deletion and promise resolution.

Both remain **Timeout** in the final Stryker report. They are neither equivalents
nor exclusions. Separate bounded loaded-source probes on Node 24 apply each exact
report replacement in memory, leaving production bytes unchanged:

```text
node .test-logs/retry-followup/timeout-probe.mjs control
node .test-logs/retry-followup/timeout-probe.mjs 124
node .test-logs/retry-followup/timeout-probe.mjs 143
```

All probes exited 0 (the expected observation was asserted). The control resolves
`requeued` with count 0. After a 100 ms observation window, 124 has an unsettled
promise, count 1, no child and unchanged pending intent; 143 has an unsettled
promise and count 1 **despite one admitted child and a completed receipt**. JSON
evidence is `timeout-control.json`, `timeout-124.json`, `timeout-143.json` beside
the probe. This supports the dispatch/finalization explanation; it does not prove
exactly where the Windows command runner waits or convert the two Stryker timeouts
into assertion kills. No timeout limit was increased, no cleanup mutation was
excluded, and no unmodified-product hang was reproduced.

## Actual follow-up verification (2026-10-15)

Every command below ran through `.test-logs/retry-followup/run.mjs`, which records
merged output, exact child command, exit code, wall duration and file SHA-256s in
`<label>.log` / `<label>.receipt.json`. The wrapper creates empty synthetic HOME,
USERPROFILE, APPDATA, LOCALAPPDATA, XDG, Codex, Claude and bridge-state directories
under the approved temp root, with `copyProfiles: false`, credential-variable
scrubbing and isolated Git configuration. No real user config was read or changed.

| Exact child command | Result | Actual duration | Evidence label |
| --- | --- | --- | --- |
| `npm run test:property` before wiring | exit 0; 24/24, 0 skips; 1,640 generated cases plus deterministic controls | Node 2,368.8865 ms; wall 4,308.0882 ms | `property-before` |
| `node --test tests/property-queue-retry.js` before additions | exit 0; 3/3, 300 cases, 0 skips | Node 845.0935 ms; wall 980.2157 ms | `retry-before` |
| `node --test tests/property-queue-retry.js` after additions | exit 0; 6/6, 600 cases, 0 skips | Node 1,081.8398 ms; wall 1,212.1981 ms | `retry-after` |
| `npm run test:property` after wiring | exit 0; 30/30, 2,240 generated cases plus deterministic controls, 0 skips | Node 2,558.2116 ms; wall 4,363.3919 ms | `property-after` |
| `node tests/review-day5-retry-intent.js` | exit 0; 31/31, 0 skips | wall 37,688.1137 ms | `regression-after` |
| `node tests/review-test-runner.js` | exit 0; 26/26, 0 skips | wall 48,350.0631 ms | `inventory-after` |
| `node_modules\.bin\stryker.cmd run stryker.retry.config.json` | exit 0; 194 mutants: 79 killed, 113 survived, 2 timed out, 0 no-coverage, 0 errors; 41.75%; dry run passed the six-property command with no skips | Stryker 2m08s; wall 130,662.2802 ms | `mutation-after` |

**Runtime cost:** the three added properties took 296.0372 ms combined in the
standalone after-run; total retry Node duration increased by 236.7463 ms, wall by
231.9824 ms. Including all retry properties in the parallel normal property
command increased its Node duration by **189.3251 ms**, wall by **55.3037 ms** in
this single before/after sample; these are observations, not a benchmark guarantee.

The 31-test regression was measured at **37.688 s**, versus **1.212 s** standalone
retry-property wall time (about 31x). Adding it to every mutant run was not applied
or benchmarked as a combined command; that single-run cost already makes it a poor
low-cost default. The scoped Stryker config, ranges, concurrency, timeouts and
command are unchanged; only six properties run per mutant. The normal property
inventory now includes retry, and `npm run test:mutation:retry` exposes the scoped
command. Inventory assertions preserve 182 commands, original argv hashes and the
final skip gate.

### Mutation comparison and retained reports

Exact matching by location, mutator and replacement found all **194** pairs with
identical product source: **19 Survived → Killed, 113 Survived → Survived,
60 Killed → Killed, 2 Timeout → Timeout**. No prior assertion kill regressed.
New kills: history/gave-up 44, 47, 51, 52; receipt 106–110, 114, 118–121; detached
error handling 130–134. Score improvement is **31.96% → 41.75%** on the same scope.

- Current reports: `reports/mutation/queue-retry.json` and
  `reports/mutation/queue-retry.html`.
- Preserved successful baseline: `.test-logs/retry-followup/baseline/queue-retry.json`
  and `.html`.
- Exact comparison: `.test-logs/retry-followup/mutation-comparison.json`.
- Earlier failed IPC run, seed/replay controls and receipts:
  `.test-logs/account3-retry/` (historical, preserved).
- Product `lib/queue/retry.js` SHA-256 stayed
  `b9fa4245727daf2b814baaf9039ccfd603ed13b42d44666aeb7b8c889e14434f`.

Final `git diff --check` and `node .test-logs/retry-followup/final-check.mjs`
both exited 0. The latter verifies the original three properties are preserved,
the only existing inventory-command delta is the appended retry filename, the
retry source/config are unchanged, and both saved baseline reports retain their
original hashes. Final status confirmed the same branch and no running test or
mutation process.

## Historical acceptance status before the second round

At the end of the first follow-up the latest known full `npm test` was
**exit 1, 176 passed / 182 commands,
6 failed, 1,662,603 ms**, with four optional skipped cases, two optional partial
cases and zero required skips. All six affected complete files subsequently
passed in clean-environment focused reruns; that is **not a single full-suite
pass**. See `PROPERTY-MUTATION-TESTING.md`. No full suite was rerun here.

The broader initial mutation baseline remains **101 mutants, 83 killed,
10 timed out, 8 survived; 92.08%**. Later scheduler/provider scoped evidence in
that document is separate from these retry results.

This round changed `tests/property-queue-retry.js`, its private fixture,
`package.json`, `tests/review-test-runner.js`, `README.md`,
`docs/PROPERTY-MUTATION-TESTING.md` and this document. Earlier unrelated
uncommitted files and artifacts were preserved. No product fix, deployment,
live provider run, real user credential/config access, TestSprite run, commit, merge or push
was performed. Node 22 compatibility is not runtime-verified; actual execution
was on Node 24. The separate skill-packaging candidate was not touched.

## Second round: rate-limit and infrastructure contracts (2026-10-15)

### Selection, receipt reuse and fixture realism

Preflight confirmed the expected branch and no command line targeting this
worktree, test runner or mutation run. Existing source/test/fixture/config/package
hashes matched `mutation-after.receipt.json`; the **79/113/2** baseline was reused,
not rerun. Its HTML/JSON reports and six-property input files are preserved under
`.test-logs/retry-followup/round2-before/`. The earlier 60/132/2 reports remain in
`baseline/`; neither historical report was discarded.

Two areas were selected, rather than reclassifying every survivor:

| Area | Existing coverage | Useful added contract / remaining boundary |
| --- | --- | --- |
| Rate-limit execution accounting | `review-queue-cost.js` B-169 checks no output versus 1,200 output tokens; `review-flex-fallback.js` checks counted output and model changes | Independently test a final response alone and a changed file alone, plus silent waits below/at 24 and available/exhausted execution budget, for all three rate/quota error types. Missing assertions, not established defects. |
| Infrastructure retry and model choice | `review-queue-cost.js` B-165 checks `agent_metadata_unavailable` at attempt 1, 45/90/180 seconds and same-model retry | Generate all three infrastructure error types, attempts 1–10 and different stored pins; verify no fourth retry, exact backoff windows, unchanged execution/wait budgets, and retained model despite active provider pauses. Rate-limit cases additionally exercise choosing the sole available alternative or waiting for the earliest paused candidate. |

The old fixture could not observe model preservation/selection: it had no model
list/pin, no pause map and no admitted model fields. The extension now uses the
**production `createAgentPolicyRuntime` parser/allowlist functions**, synthetic
allowlisted models, injected pause-map I/O and the actual retry/requeue runtime.
The admitted record captures the job's selected scope contract. No fixture
function implements retry classification, model choice or backoff. Admission,
decryption and schema/project boundaries remain synthetic; scheduler execution,
encryption, provider behavior and on-disk durability are not established here.

Two properties were appended; all original six remain unchanged. Each runs 100
fast-check samples with default seed 20261014 and existing shrinking/replay support:

- **Rate-limit property:** each sample tests four independent signal cases (silent,
  positive output count, final response only, changed file only). Only the silent
  case receives an uncounted pause wait below the cap. It observes successor count,
  durable intent settlement, attempt/counter fields, selected model and hold time,
  then checks repeated decisions are inert.
- **Infrastructure property:** each sample tests prior retry counts 0, 1, 2 and 3
  against the operational table 45 s, 90 s, 180 s and no automatic successor. The
  startAfter assertion uses before/after wall-clock bounds without sleeping through
  the delay. Execution budget is exhausted deliberately to show that infrastructure
  retries do not spend an execution attempt. Other wait counters remain untouched.

Thus the retry suite has **8 properties / 800 generated samples**; the new
properties execute **800 concrete fixture scenarios** within 200 generated samples.
The combined property command has 32 tests and 2,440 generated samples plus controls.

### Exact mutation comparison and cost

One scoped Stryker run was performed after the tests stabilized. Source ranges,
source bytes, concurrency, timeout settings and exclusions were unchanged.
All **194** mutants matched by location, mutator and replacement:

| Transition | Count |
| --- | ---: |
| Survived → Killed | **41** |
| Killed → Killed | **79** |
| Survived → Survived | **72** |
| Timeout → Timeout | **2** |

Score: **41.75% → 62.89%**. Of the new assertion kills, **22** concern rate-limit
classification/admission (0–9, 11–16, 19, 27–31), **15** infrastructure/model/wait
fields (76–80, 82–85, 89, 92–95, 101), and **4** manual model-validation mutations
(183, 191–193) are collateral benefits of passing real nonempty model overrides.
No previous assertion kill regressed. These are regression-detection improvements,
not product bug counts.

Representative remaining survivors:

- **25–26:** loosen classification precedence when another uncounted category
  already applies; the accounting can be redundant, but flags/diagnostics may
  differ. Not asserted to be globally equivalent.
- **81:** changes slot-wait-driven round-robin order. Meaningful but unresolved by
  this fixture's generated selection inputs: old slot-wait cases have no model
  list; new model cases do not vary slot-wait rotation. Existing fallback examples
  cover model order, but no claim is made that they kill this exact change.
- Manual invalid-input guards, optional-chain defensive edges and diagnostic
  changes remain as classified in the first follow-up. The known equivalent
  falsy predicate/short-circuit guards remain visible, not excluded.
- **124 and 143 remain timeouts**, with the same locations/replacements and the
  previously documented deleted-dispatch/deleted-finalizer explanation. They are
  not new unmodified-product hangs and were not rerun as separate probes.

Exact ledger: `.test-logs/retry-followup/round2-mutation-comparison.json`. Current
reports remain `reports/mutation/queue-retry.{json,html}`.

| Exact child command | Exit / counts / skips | Duration and evidence |
| --- | --- | --- |
| `node --test tests/property-queue-retry.js` | 0; 8/8; 800 samples; 0 skips | Node 1,954.2786 ms; wall 2,146.4698 ms; `round2-retry.log` / `.receipt.json` |
| `node tests/review-queue-cost.js` | 0; 5/5; 0 skips | wall 12,086.6324 ms; `round2-cost.*` |
| `node tests/review-flex-fallback.js` | 0; 13/13; 0 skips | wall 26,908.6961 ms; `round2-fallback.*` |
| `npm run test:property` | 0; 32/32; 0 skips | Node 3,301.7307 ms; wall 9,168.6877 ms; `round2-property.*` |
| `node_modules\.bin\stryker.cmd run stryker.retry.config.json` | 0; 194: 120 killed, 72 survived, 2 timed out, 0 errors/no-coverage | Stryker 4m11s; wall 254,700.4580 ms; `round2-mutation.*` |

All evidence labels above are under `.test-logs/retry-followup/`. The two new
properties consumed **782.5328 ms combined** in the standalone run. Relative to
the valid six-property receipt, standalone Node time rose **872.4388 ms**, wall
time **934.2717 ms**; combined-property Node time rose **743.5191 ms**. Combined
npm wall time varied by 4,805.2958 ms, so it is not attributed entirely to tests.
Mutation wall time increased **124,038.1778 ms** versus the prior valid receipt.
These are single-run observations, not controlled benchmarks. The integration
suites remain outside each mutant run. Provider/scheduler mutation suites were
not rerun because their inputs and scope were unchanged.

## Complete candidate gate and failure investigation

### Previous six failures and selected environment

The actual six old failure logs were inspected, including the structured-429
failure's `external_plugin_integrity_failed` value. They name the inherited
MCP-enabled `opencode.jsonc` in synthetic profiles. Four previously affected
commands (B-096, runtime-control, prod-quota and round5) now passed in the complete
run. The other two (queue-worker and spawn) no longer fail on MCP inheritance;
they reached later worktree behavior instead. The saved clean-environment reruns
were retained; only three have persisted file receipts, and those old receipts
do not bind the entire current candidate. No full pass was inferred from them.

Exact launch:

```text
node .test-logs/retry-followup/round2-run.mjs full full-candidate
  -> npm test
  -> node bin/test-runner.js
```

The wrapper calls `prepareTestEnvironment(..., { copyProfiles: false })`, gives
the real runner synthetic HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG/Codex/Claude
and bridge-state paths, scrubs credential variables, isolates Git config, and
removes `FC_PATH`, `CODEX_TEST_ALLOW_REQUIRED_SKIPS`, `NODE_OPTIONS` and `NODE_PATH`.
The real runner can copy only this empty synthetic parent, never user profiles.
No security check, skip gate, worker count or timeout was disabled or loosened.
The run was launched as a background process and observed without restarting it.

Frozen executable-input identity (238 source/config/test/profile files):
`159a15601ef63575112d2850c32d18e5efa75b549ee9116d6fa4844702465cdd`.
`full-candidate.start.json` records individual SHA-256s, branch, exact cwd, command
and the selected environment paths, not ambient secrets. All 238 hashes matched
again after the complete run and focused controls.

### Actual complete-run result: failed

- **`npm test`: exit 1; 174/182 commands passed, 8 failed.**
- Runner duration **2,203,762 ms (36m43.762s)**; wrapper wall **2,206,005.4629 ms**.
- **4 optional skipped cases, 2 optional partial cases, 0 required skips** across
  50 reporting files; the final skip summary ran and passed.
- Within that run: property command passed (32/32, 0 skips; command 3,155 ms),
  retry-intent passed (31/31, 0 skips; 45,018 ms), and inventory passed
  (26/26, 0 skips; 45,314 ms).
- Authoritative report/logs:
  `.test-logs/2026-10-15T15-49-19-826Z-3208/report.json` and sibling command logs.
  At that checkpoint `.test-logs/report.json` pointed to this run; the accepted
  round-three report below now supersedes that pointer. The earlier 176/182 receipt was
  archived first as `.test-logs/retry-followup/round2-before/report.json`.
- Wrapper output/receipts: `full-candidate.log`, `.start.json`, `.receipt.json`.

| Failed command / log prefix | Actual symptom | Focused control below |
| --- | --- | --- |
| `node tests/server-self-test.js` / 166 | Pipeline worktree setup: `fatal: '$GIT_DIR' too big` | Passed with flatter temp layout |
| `node bin/process-supervisor.js --self-test` / 080 | Descendant snapshot `{snapshotOk:false,found:0,...}` | Passed serially; exact initial probe failure remains unresolved |
| `node tests/review-flex-self-check.js` / 107 | No agent calls; queued case reports `worktree_create_failed` | 8/8 passed |
| `node tests/review-batch-race.js` / 109 | B-154 sweep removes 0 rather than 1 | 16/16 passed; precise original cleanup refusal not captured |
| `node tests/review-shared-attestation.js` / 112 | Real worktree boundaries fail with `'$GIT_DIR' too big` | 28/28 passed |
| `node tests/review-flex-queue-worker.js` / 120 | Retry-worktree fixture never observes retry execution | 24/24 passed; exact original child failure not captured |
| `node tests/review-spawn.js` / 131 | Direct writer abort ends before launch with `'$GIT_DIR' too big` | Still 42/43, same explicit path error |
| `node tests/review-queue-features.js` / 163 | No fix-pass calls; queued case reports `worktree_create_failed` | 32/32 passed |

### Focused investigation, not another complete gate

The full wrapper nested its synthetic outer TEMP above the runner's own unique
fixture root, which further nests each test's repos/worktrees. This produced real
Windows Git path-depth refusals. A focused control removed that redundant outer
temp nesting, kept the isolated profile and unique runner-owned leaf TEMP, and
ran only the eight failed commands plus the unchanged skip-gate prelude/summary
through **`runTestCommands`, jobs 1**:

```text
node .test-logs/retry-followup/round2-focused-controls.mjs
```

Result: **exit 1; 7/8 selected suites passed** (10/11 commands including gates),
**596,139.9170 ms**. No optional skipped cases, one optional symlink partial,
zero required skips. Exact argv/results/environment correction and logs are in
`.test-logs/retry-followup/round2-controls/receipt.json`, `report.json`, and the
numbered command logs. Per-command durations: server 293,327 ms; supervisor
13,868 ms; self-check 22,644 ms; batch-race 72,141 ms; attestation 44,215 ms;
queue-worker 87,825 ms; spawn 23,639 ms; queue-features 38,273 ms.

The shorter layout supports the path-sensitivity diagnosis, but the direct-writer
fixture still exceeds Git's limit even there. The supervisor's 5-second CIM
snapshot budget is unchanged; its control pass does not prove why the earlier
snapshot failed (timeout/nonzero/empty result are not distinguished in that event).
Likewise, the control passes for sweep/retry are not claimed as proof of their
original internal cause. No product defect has been confirmed from these results.

**At the end of round two, acceptance remained failed/incomplete.** Seven focused passes neither replace
the 174/182 complete-run failure nor justify combining runs into a full pass.
No second full run was started. The next justified gate attempt needs a verified
short Windows fixture/TEMP layout (especially the direct-writer case), with
profile isolation retained, and an understood native snapshot failure. Keep
timeouts/assertions/security enforcement intact; a test-harness-only path
correction can be proposed separately before paying for another complete run.

This round changed only `tests/property-queue-retry.js`, its existing private
fixture, and the three existing testing/coverage documents. No production source,
normal command inventory or mutation config changed. All existing edits and
evidence remain uncommitted; no provider workloads, real credentials/config,
deployment, merge or push was used. Actual execution remains Node 24, not Node 22.

## Third round: Windows fixture correction and complete acceptance

### Established Git cause, including independent path controls

The original direct-writer fixture was inspected alongside
`createWorktreeForJob` / `resolveWorktreeRoot` in `lib/worktrees.js` and the real
runner's TEMP layout. The product constructs:

```text
<state>/worktrees/<project-state-key>/<safe-agent>-<safe-job-id>
git worktree add -b <branch> <destination> <base-commit>
```

Git additionally creates common-repository metadata under
`.git/worktrees/<destination-basename>` and a `.git` file in the destination.
Repeated agent/job identifiers and the long test prefix consumed path budget.
The previous wrapper unnecessarily nested the runner's TEMP below another
synthetic profile's TEMP. Reducing that outer nesting had helped seven suites,
but the direct-writer fixture still failed. That was not sufficient correction.

`node .test-logs/retry-followup/round3-path-repro.mjs` ran actual Git in a fresh,
canonical, non-linked, uniquely owned external fixture root. It reproduced the
unchanged failure before the test-file correction, with **Git
2.39.1.windows.1**, no system/global config, and `core.longpaths` unset. Its local
relevant settings were repositoryformatversion=0, bare=false and symlinks=false.
The exact repository/destination/metadata paths, lengths, Git argv, exit codes,
bounded stderr and timings are preserved in `round3-path-repro.json`.

| Native Git layout | Repo chars | Destination chars | Per-worktree metadata chars | Result |
| --- | ---: | ---: | ---: | --- |
| Original `codex-opencode-review-spawn-` prefix | 133 | 222 | 201 | exit 128, `fatal: '$GIT_DIR' too big`; 81.2315 ms |
| Only the prefix shortened to `spawn-` | 111 | 200 | 179 | exit 0, real worktree created; 144.6642 ms |

The successful case also verified the actual absolute Git dir and `.git` file,
then removed its real worktree. These observations do **not** establish a
universal maximum path length or show that the common metadata path is the sole
cause. An independent native probe isolated the two dimensions:

```text
node .test-logs/retry-followup/round3-path-isolation.mjs
```

- Long repo / **short destination**: repo 133 chars, destination 121, metadata 201;
  **exit 0** (437.6943 ms).
- Short repo / **long destination**: repo 75 chars, destination 222, metadata 143;
  **exit 128, the same `'$GIT_DIR' too big`** (364.6821 ms).

Thus destination depth alone is sufficient for this reproduction on this Git
version; a 201-character per-worktree metadata path alone was not. The error is
not adequately explained as simply crossing a generic 260-character file limit.
Details are in `round3-path-isolation.json`; these supplemental disposable Git
repos did not touch the frozen candidate or its running fixtures.

**Correction:** `tests/review-spawn.js` now uses `spawn-` instead of
`codex-opencode-review-spawn-` for its `mkdtemp` prefix, saving **22 characters**.
The random suffix, unique ownership, real Git repo/worktrees, direct SDK
cancellation, child-PID assertions, retained writer output, unchanged source repo,
no-validation assertion and cleanup boundaries are unchanged. The source audit
verified that reversing only the prefix/comment reproduces the original file
byte-for-byte: no behavioral assertion was removed or weakened. Production
worktree construction and the test runner itself were not changed.

### Native snapshot: what is established and what is still unknown

The previous supervisor failure event only exposes `snapshotOk:false`; its
helper internally distinguishes timeout, nonzero exit and parse/empty results,
but those details were not present in the historical event. Neither the old log
nor its serial pass can reconstruct the original category. **The old failure's
root cause remains unknown.** No new production snapshot/containment bug was
confirmed, and no timeout, PID identity check or containment behavior was changed.

The focused diagnostic arrangement used the supported runner with **three suite
workers and the existing two-heavy limit**, running these canonical commands
concurrently (not serially):

```text
node bin/process-supervisor.js --self-test
node tests/review-flex-fallback.js
node tests/review-queue-cost.js
```

Only the supervisor command received a diagnostic-only Node 24 loaded-source
observer, saved as `round3-snapshot-observer.mjs`. It observes the unchanged native
command's return after the same **5,000 ms** budget, without changing the command,
parsing, return values, PID checks or termination behavior. It records duration,
exit/error category, stdout size/parsed-row count and a redacted numeric row shape;
it does not dump unrelated process command lines. Production stderr remains
ignored, which is disclosed rather than invented as diagnostic evidence.

Observed actual snapshot: **exit 0, 2,030.0122 ms, nativeOk=true, category=success,
399 parsed rows**, with row shapes only. Evidence:
`.test-logs/retry-followup/round3-native-snapshots.jsonl`. The parallel supervisor
self-test passed in 13,449 ms alongside fallback (13/13) and queue-cost (5/5).
This supports current behavior under that arrangement; it does not retroactively
prove the old failure was a timeout. The subsequent complete gate ran the normal
uninstrumented supervisor and passed it in **13,634 ms**. The observer was **not**
loaded into the complete gate.

### Focused verification boundary

Exact wrapper commands and receipts under `.test-logs/retry-followup/`:

| Command | Actual checks/result | Duration |
| --- | --- | ---: |
| `node .test-logs/retry-followup/round3-path-repro.mjs` | exit 0 after asserting the native failure/success pair above | Per-Git-operation timings in `round3-path-repro.json` |
| `node .test-logs/retry-followup/round3-run.mjs focused` | exit 0; spawn 43/43, runner checks 26/26; 5/5 runner commands including gates; 0 skipped cases, 1 optional symlink partial, 0 required skips | 57,028.0860 ms wall |
| `node .test-logs/retry-followup/round3-run.mjs representative` | exit 0; parallel supervisor/fallback/queue-cost; 6/6 commands including gates; 0 skips/partials | 27,049.9077 ms wall |

The focused direct-writer case passed all its existing real cancellation
assertions; its reported cleanup was **906 ms**. Numbered evidence:
`round3-focused/131-review-spawn.js.log`, `round3-focused/124-review-test-runner.js.log`
and `round3-representative/080-process-supervisor.js.log`. Full reports and exact
argv/timing/skip receipts are in the corresponding directories and
`round3-{focused,representative}.receipt.json`.

### Complete gate boundary: accepted for this local testing candidate

After focused verification the executable candidate was frozen. Exactly one new
complete run was launched:

```text
node .test-logs/retry-followup/round3-run.mjs full
  -> npm test
  -> node bin/test-runner.js
```

It used the actual unmodified runner: **8 syntax workers, 3 suite workers, at most
2 heavy suites, normal exclusive lanes, original command inventory, 15-minute
per-file timeout and normal skip accounting**. The wrapper calls
`prepareTestEnvironment(..., { copyProfiles: false })` for the synthetic parent,
scrubs credentials, uses empty HOME/XDG/Codex/Claude/AppData/bridge-state profiles,
isolates Git config, removes inherited Node options and required-skip overrides,
and sets outer TEMP/TMP/TMPDIR to the flat approved temp parent. The actual runner
then creates its own unique validated fixture root and shared PPID-bound ledger
TEMP; it can copy only the empty synthetic parent profiles. No real user profile,
Git global setting or security check was changed.

**Actual result: `npm test` exit 0; 182/182 commands passed; zero failures.**

- Runner duration **1,880,156 ms (31m20.156s)**; wrapper wall **1,885,351.2180 ms**.
- **4 optional skipped cases, 2 optional partial cases, 0 required skips** across
  50 reporting files. Optional cases are the existing Windows symlink/quoted-path
  limitations; neither the inventory nor skip requirements were changed.
- All eight previously failing commands passed **within this single run**.
  This is not an aggregate of the earlier focused controls.
- Within the complete run: spawn 43/43 (23,751 ms; one optional partial), runner
  checks 26/26 (36,108 ms), retry-intent 31/31 (44,889 ms), property command
  32/32 (3,700 ms, zero skips), supervisor self-test (13,634 ms).
- Canonical owned fixtures were successfully cleaned (`fixturesRemoved: true`).
- All **238 executable-input hashes** still matched after the run.

Frozen executable-input SHA-256 identity:
`0d15456554842db137a2c7717acb36550520034816de78fd0916405e71807f23`.
The sole executable-source difference from the 174/182 candidate is the
`review-spawn.js` prefix/comment. Production source, package/command inventory,
mutation configs and property suites are unchanged.

Authoritative current report:
`.test-logs/2026-10-15T20-41-41-703Z-2040/report.json`, with sibling numbered logs.
`.test-logs/report.json` now points to that successful run. The older 174/182 report
was archived before launch at `.test-logs/retry-followup/round3-before/report.json`;
its dated logs and `full-candidate.*` receipts remain intact. New launch/output:
`round3-full.start.json`, `round3-full.receipt.json`, `round3-full.log`; exact
environment paths and per-file hashes are in those receipts. Observed progress
timestamps are retained in `round3-progress.jsonl`. Consolidated source/receipt
verification is `round3-final-summary.json`.

### Remaining product limitation and pending work

The Git destination-depth limitation is real and reproducible outside the bridge;
a sufficiently deep production destination generated by the unchanged
`createWorktreeForJob` can encounter the same native refusal. Short fixture naming
addresses this candidate, not arbitrary long production roots. A shorter safe
configured worktree root is an existing operational mitigation; no real user
configuration was changed here.

If broader long-root support is required, a separate production repair should
budget the full generated destination, use a compact stable physical leaf while
keeping full job/branch identity in durable records, preserve collision/ownership
and canonical-root checks, and fail explicitly when even the root cannot fit.
Verify it with native long-destination creation, retry, retained-output and cleanup
identity cases. That production behavior change is **not implemented or implied
by this gate pass**. There is no confirmed product repair blocking the observed
testing-candidate acceptance. The old snapshot failure remains unexplained rather
than declared fixed; its current parallel and complete-run evidence is recorded.

No Stryker or standalone property baseline was rerun in this harness-only round.
The valid retry mutation evidence remains **194: 120 killed, 72 survived,
2 diagnosed timeouts; 62.89%**. Node 22, real-provider workloads and deployment
were not validated. Actual execution was Node 24.11.1. The candidate is accepted
for this recorded local complete-suite gate, not asserted production-ready.
All edits and evidence remain uncommitted in the same worktree/branch. This round
changes `tests/review-spawn.js` and these existing testing documents only; main and
the separate packaging candidate were untouched.

## 2026-10-16: survivor ledger and independent retry invariants

Account3 changed only `tests/property-queue-retry.js`,
`tests/helpers/queue-retry-fixture.js`, and this document. Root's concurrent lock
work and all inherited edits were preserved. Evidence lives in
`.test-logs/quality-round-2026-10-16/account3/`; `STATUS.md` records boundaries.

All **72** actual baseline survivors were inspected against the real source and
existing properties. `survivor-ledger.json` gives every ID, exact location,
replacement, priority, classification and rationale, deduplicated by risk:

| Priority / category | IDs / count | Contract consequence |
| --- | --- | --- |
| P1 manual inputs | 25 IDs at lines 391–395 | Reject invalid IDs, nonnumeric/fractional/out-of-range timeouts and nonstring models before decrypting/admitting; accept valid timeout endpoints. |
| P1 wait rotation | 81 | A prior slot wait must advance the model ring without charging an execution attempt. |
| P1 stored scope | 146 | Omitting an override must preserve the stored pin and scope. |
| P2 durable result | 53, 112 | Expose terminal attempts/history; retain the persistence-failure category when a terminal receipt disappears. |
| P3 unresolved observability | 33 IDs | History/log text, event metadata and overlapping pause/rate result flags; not evidence of product defects. |
| P4 equivalent under current contracts | 103, 113, 116, 184–190 | False/undefined both refuse the read-only receipt probe; receipt short-circuiting guarantees later optional-chain receivers; model defaults and the type guard make sentinel mutations redundant. |

This is **29 meaningful, 33 unresolved, 10 equivalent** survivors, not 72 bugs.
The source review corrected IDs 25/26 from execution-state equivalence to
unresolved full equivalence: combined pause/rate flags can change the returned
`uncountedRateLimit` and diagnostic suffix despite identical persisted budgets.
The initial ledger is retained under `before/`; no log-string assertions were
added to chase those survivors.

All eight inherited properties remain. Seven generated properties now add:

- A ticket-ring model of execution/wait rotation, shuffled model order, available
  alternatives and a unique earliest all-paused deadline. Both slot and pause
  waits run at exhausted execution budgets and persist SQL predecessor receipts.
- Infrastructure backoff/pin precedence when a provider-refusal marker and long
  provider pauses coexist; inspect 45/90/180-second deadlines without sleeping.
- Manual input refusal before decryption/admission, including zero, fractional,
  wrong-type and oversized timeouts; successful 1 ms/24-hour endpoints and omitted
  overrides preserve scope, runtime-evidence requirements, locks and validation.
- Stored-schema/project/model and synthetic admission refusals that preserve
  pending intent; final decisions, cancellation markers and parent/active rows
  that remain byte-for-byte durable barriers across repeated dispatch.
- A real SQL loss of terminal eligibility between admission and predecessor CAS,
  which must report persistence failure rather than acknowledge success.

The fixture uses the actual retry runtime, actual agent-policy parser/allowlist,
actual scope-contract schema and in-memory native SQLite for receipts. Its
request-schema subset, decryption, project matching, pause source and admission
remain **synthetic boundaries**, not production admission/encryption coverage.
Admission observations capture the full request; fault injection changes real SQL
state. No production source, dependencies, mutation ranges, timeouts, assertions,
skip policy or normal scheduling changed.

### Actual checks and mutation limits

Exact launches use `node .test-logs/quality-round-2026-10-16/account3/run.mjs
<mode>`. Each receipt records child argv, cwd/branch, timestamps, relevant hashes,
exit and synthetic environment paths. The wrapper uses the real runner's
`prepareTestEnvironment(copyProfiles:false)`, empty profiles, isolated Git config,
credential-variable scrubbing and flat validated external TEMP; it never copies
real profiles or configuration.

| Mode / child command | Actual result | Wrapper wall |
| --- | --- | ---: |
| `property-default` / `node --test tests/property-queue-retry.js` | exit 0; 15/15, 100 generated cases each; default seed 20261014; zero skips | 2,113.6855 ms |
| `property-seed` / same, `FC_SEED=20261016` | exit 0; 15/15, 100 generated cases each; zero skips | 2,100.6560 ms |
| `intent` / `node tests/review-day5-retry-intent.js` | exit 1; 0/31 passed, zero skips; native key-publication `fs.link` EPERM precedes admission | 2,981.0082 ms |
| `mutation` / `node_modules\.bin\stryker.cmd run stryker.retry.config.json` | exit 1; instrumented 194, executed zero; child-runner IPC AggregateError EACCES before dry run | 8,608.2250 ms |

Syntax checks of both owned JS files also exited 0. Relevant executable hashes
stayed unchanged during both successful property runs. No `npm test`, concurrency
harness, release gate or competing Stryker was launched by account3.

The sole Stryker attempt ran **2026-10-15T21:44:19.447Z–21:44:28.058Z** (local date
October 16). Current JSON/HTML outputs were copied to `before/` before launch.
The JSON still hashes to
`f402b016ecf45a3b36dca74bcee5a78803a0700687259d66e4d9a4707ba1f199`, identical to
baseline. Its **120 Killed / 72 Survived / 2 Timeout, 62.89%** is stale for these
new tests: **no final score, score increase or baseline-to-final transitions can
be claimed**. `mutation.receipt.json` explicitly marks `reportFresh:false`, zero
executed mutants and null final counts/score/transitions. The baseline timeouts
124/143 retain only their previously documented diagnosis; this failed attempt
did not reobserve or clear them. No mutation errors/timeouts were newly measured;
the invocation itself failed at startup. Production and unchanged mutation-config
hashes are in `baseline-hashes.json` and `final-summary.json`.

To obtain bounded sensitivity evidence without a second Stryker invocation,
`node .test-logs/quality-round-2026-10-16/account3/controls.mjs` loaded nine selected
baseline replacements **only in child-process memory**, retaining the real module
URL/imports and unchanged tests. All nine produced replayable fast-check assertion
failures, with verified applied-source hashes:

| IDs | Detected contract change |
| --- | --- |
| 53 | Missing terminal attempts/history result |
| 81 | Reversed slot-wait rotation |
| 112 | Missing-receipt failure category lost |
| 146 | Fabricated default model replaces/refuses stored request |
| 149 | Invalid ID guard fails before safe refusal |
| 167, 173 | Fractional or zero timeout admitted |
| 176 | Valid maximum timeout rejected |
| 182 | Nonstring model accepted |

These **are not Stryker transitions or a mutation score**. Raw per-control logs,
counterexample seeds/paths, exact source slices/replacements and receipts are
`control-<id>.log`, `control-plan.json`, and `controls.receipt.json`; total child
wall was 49,131.9465 ms. The initial control setup used a Windows path where Node
requires a file URL and failed before applying a mutant; its separate log/receipt
is retained. The corrected loader applied all nine controls. The initial wrapper
import-path error likewise preceded tests; a TAP-only parser was corrected from
the already saved Node spec log without repeating a successful run.

### Source review, remaining gaps and handoff

Review checked the complete owned delta against `before/`: no inherited property
was removed/weakened; fixture extensions expose observations or native SQL faults
without reproducing policy decisions. The independent rotation oracle moves
tickets, deadline checks use known ordered release times, and timeout endpoints
exercise acceptance as well as refusal. Manual success compares complete scope
and boundary inputs; rejection checks require no successor and unchanged receipt.
No real product defect was established, so no production fix is proposed.

`link-probe.mjs` reproduces native hard-link EPERM with nonsensitive text in both
disposable external TEMP and owned evidence. This localizes the integration
failure below retry logic without claiming a specific Windows/sandbox cause.
Do not preseed keys, replace publication with a weaker operation, or infer a pass
from this failure. Root independently ran the unchanged retry-intent regression:
**31/31 passed, zero skips**, exit 0, 29,218.431 ms wrapper wall; verified receipt
`../root/retry-intent-root.receipt.json` and its `172-review-day5-retry-intent.js.log`
are relative to account3 evidence. This is root-owned evidence, not a worker pass.
Root's combined gate and fresh mutation completion remain separate requirements.
The predecessor 182/182 receipt remains inherited evidence only.

Meaningful remaining gaps: new ring/deadline cases cover provider pauses, not
model-specific/quota-group pauses or pause-store failure; synthetic admission
does not prove real lock/capacity/worktree validation; decryption/schema observations
do not prove encrypted persistence or cross-process recovery. Concurrent terminal
settlement beyond the injected eligibility change remains in existing integration
tests. IDs 25/26 and diagnostic/history mutations remain explicit open signals.
Windows Node 24.11.1 was used; Node 22 and live providers were not verified.

Actual external Codex CLI events are at `account3/run1/events.jsonl` under the
round evidence root, session `01a14181-0fc9-7190-b661-6ce7f7ef8cdc`. The worker's
`usage-snapshot.json` inspects structured fields: no completed-turn/token-count
usage event existed before this turn ended. Root must collect the terminal
`turn.completed` usage afterward; no counts were inferred from printed text.
No extra agents, remote projects, private configuration, credentials, global
settings, commits or deployment were used.
