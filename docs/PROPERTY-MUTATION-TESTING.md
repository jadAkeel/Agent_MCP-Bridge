# Property and mutation testing

Install development tools with `npm ci` (Node >=22.13.0). Production installs
using `npm ci --omit=dev` do not need these tools.

## Property tests

Run `npm run test:property`. The same grouped command is included in the normal
`npm test` runner before the final skip gate. The command runs
`tests/property-provider-wait.js`, `tests/property-queue-scheduler.js`, and
`tests/property-queue-retry.js`, `tests/property-locks.js`, and
`tests/property-queue-leases.js`.
It uses fast-check to generate queue/action sequences, budgets, operation results
and parallel context identities. The scheduler properties run the actual injected
runtime with controlled clocks and fake external persistence/process operations.
Deterministic
controls check cancellation, deadlines, listener cleanup and diagnostic bounds.
These are local tests: no provider credentials or external jobs are required.

The provider/scheduler/retry default seed is 20261014; the lock and lease suites
default to 20261016. `FC_SEED` overrides each file. To explore another seed in PowerShell:

```powershell
$env:FC_SEED = '12345'
npm run test:property
Remove-Item Env:FC_SEED
```

Failures report a seed and shrinking path. Replay with `FC_SEED` and `FC_PATH`
set to those values, then unset both variables. The path applies to the failed
property; use Node's `--test-name-pattern` to select that test for replay.

## Mutation tests

Run `npm run test:mutation`. `stryker.config.json` currently mutates the entire
`lib/provider-wait.js` and `lib/queue/scheduler.js` modules in disposable sandboxes and runs the property suite
for each mutant (provider-wait and scheduler tests only). Run
`npm run test:mutation:retry` for the separate scoped retry-policy experiment;
see [retry evidence](RETRY-PROPERTY-MUTATION.md) for survivor analysis and limits.
`npm run test:mutation:locks` targets selected lock conflict, expiry, release, and
heartbeat ranges using the actual lock runtime, real SQLite, and an independent
generated state model. Its reports are `reports/mutation/locks.{html,json}`.
Two local workers bound resource consumption. Mutation testing
is separate from `npm test` because it is slower. It does not change product
source files and does not require an agent or LLM.

Open `reports/mutation/bridge-core.html` for source-level results; JSON is at
`reports/mutation/bridge-core.json`. Reports and `.stryker-tmp` are ignored
by Git. Command-runner mode cannot provide per-test coverage; its displayed
single test represents the whole command, not the number of Node test cases.

A surviving mutant identifies a possible missing assertion or equivalent behavior,
not automatically a product bug. Timeouts are counted as detected by Stryker:
inspect their number separately from assertion kills. No score threshold is imposed
until this initial scoped baseline has been reviewed. Do not exclude mutants or
weaken assertions just to improve the score.

Stryker is pinned to 9.6.1 to retain the project's Node 22.13 compatibility
(Stryker 10's Babel dependencies require newer Node versions). A scoped override
uses patched qs 6.16.0 only under Stryker's typed-rest-client dependency.

This scope covers provider wait and queue scheduling behavior. It does not establish
coverage of all database, lock or integration states. The additional scoped lock
experiment also leaves native process races and finalizer integration controls to
the ordinary regression/concurrency suites. Extend generated state models
and mutation targets together when adding coverage; the existing regression suite
remains required.

`npm run test:mutation:leases` is the separate scoped durable queue lease experiment;
reports are `reports/mutation/queue-leases.{html,json}`. Its real-SQL and read-only
probe tests, deterministic deadline controls and five explicit SQL/control mutants
are described in [queue lease properties](QUEUE-LEASE-PROPERTIES.md). The fixture
does not implement production instance registration, schema migration or scheduler
recovery; their existing integration tests remain required.

## Verified initial baseline (2026-10-14, Windows, Node 24.11.1)

- `npm ci --ignore-scripts`: exit 0; reproducible lockfile installation.
- `npm run test:property`: exit 0; 8 tests, 0 skipped. Generated properties
  execute 700 cases total with the default seed, plus deterministic controls.
- `node tests/review-test-runner.js`: exit 0; 26/26, 0 skipped. The inventory
  verifies the new command and preserves historical command hashes.
- The new property command also passed through `runTestCommands` itself:
  1/1 command, exit 0; log at `.test-logs/property-tooling/181-property-provider-wait.js.log`.
- `npm run test:mutation` after the final clean install: exit 0, 1m02s;
  101 mutants, 83 killed, 10 timed out, 8 survived, 0 errors; score 92.08%.
  Surviving changes concern listener options, the infinite-deadline branch,
  error wording and diagnostic separators/empty strings. They remain visible
  in the report, with no exclusions added.
- `git diff --check`: exit 0. Existing production lock entries unchanged;
  every installed development package's declared Node engine admits 22.13.0
  (actual execution here was on Node 24, not a Node 22 runtime).

`npm audit --omit=dev` still reports two pre-existing production advisories
(MCP SDK high and proxy-addr critical); it exits 1. This setup did not update
those dependencies or assess their reachability. The new development dependency
advisories were resolved by the scoped qs override. No live
provider run, commit or push was performed for this tooling change. The initial
setup used focused tests; the subsequent complete local run is recorded below.

## Complete local verification follow-up

`npm test` ran all 182 commands through the real runner on 2026-10-14:
176 passed, 6 failed, exit 1, 1,662,603 ms (27m43s).
The historical receipt is now archived as
`.test-logs/retry-followup/round2-before/report.json`; individual logs are under
`.test-logs/2026-10-14T14-01-24-096Z-26480/`.
There were four optional skipped cases and two optional partial cases, all
Windows symlink/Git quoting limitations; zero required skips.

All six failed commands reached the existing plugin-policy refusal because the
runner copied an ambient OpenCode config enabling MCP servers into its synthetic
profiles. This prevented the intended status/worker/spawn paths from running.
The security refusal was retained. Re-running each whole affected file with
`XDG_CONFIG_HOME` pointing to an empty temporary directory produced:

| Test file | Result | Exit |
| --- | --- | --- |
| review-b096-rate-limit-exit.js | 15/15, no skips | 0 |
| review-flex-runtime-control.js | 10/10, no skips | 0 |
| review-prod-quota.js | 8/8, no skips | 0 |
| review-flex-queue-worker.js | 24/24, no skips | 0 |
| review-spawn.js | 43/43, one optional symlink partial | 0 |
| review-round5.js | 23/23, no skips | 0 |

Persisted clean-environment logs/receipts for queue-worker, spawn and round5 are
under `.test-logs/tooling-clean-environment/`; the first three re-runs were
reported directly by the command output. No product code, assertions or user
configuration was changed. The new property test passed in the complete run.
These results combine the complete run and focused environmental re-runs; they
are not a claim that a single complete run exited zero.

For an ordinary local full test run, avoid inheriting your personal MCP config:

```powershell
$toolingPreviousConfig = $env:XDG_CONFIG_HOME
$toolingScratchConfig = Join-Path ([System.IO.Path]::GetTempPath()) ('bridge-test-config-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $toolingScratchConfig | Out-Null
try {
  $env:XDG_CONFIG_HOME = $toolingScratchConfig
  npm test
} finally {
  $env:XDG_CONFIG_HOME = $toolingPreviousConfig
}
```

The original test runner's ambient-profile behavior remains unchanged. A future
harness change should preserve native diagnostic prerequisites and tests of the
actual policy; it must not disable that policy just to obtain passing tests.

## Expanded scheduler coverage (2026-10-14)

Account3 implemented the generated scheduler tests through external Codex CLI
on `gpt-6.1-sol xhigh`, in one bounded workspace-write session. The coordinator
reviewed the frozen files and owned Stryker, wiring and verification. Worker
receipts are under `.test-logs/account3-fastcheck/run-1/` and `run-2/`; candidate
hashes, terminal states and structured usage are in `verification.json`.
The same session was continued once with a specific mutation-driven delta.

Final `npm run test:property`: **24/24, exit 0, no skips**, about 1.6 seconds here.
The scheduler contributes 15 properties and 940 generated runs; provider wait
contributes 700 generated runs and deterministic controls. Coverage includes
capacity, FIFO admission, memory/drain holds, cancellation, recovery barriers,
ownership refusal, blocker generations/backoff, model pause/resume and shared
quota groups. New wake properties observe actual timers without forcing an
immediate wake: queue off, earliest-deadline/coalescing behavior, requests during
awaited passes, logged failures and recovery, and terminal idle queues.

The scheduler uses real injected production functions with fake external I/O;
it does not exercise real SQLite transactions or providers. Its fixture extracts
the real `nextQueueScheduleDelay` body from `server.js` to avoid initializing
bridge state. Fixed clocks and explicit pass settling keep tests reproducible.

Actual Stryker verification:

| Run | Scope and result | Duration |
| --- | --- | --- |
| Provider wait after no-deadline control | Full module: 101 mutants, 84 killed, 10 timed out, 7 survived; 93.07%, exit 0 | 1m02s |
| First expanded baseline, before wake delta | Two full modules: 522 mutants, 406 killed, 10 timed out, 106 survived; 79.69%, exit 0 | 5m39s |
| Wake-delta verification | Scheduler lines 107–284: 265 mutants, 224 killed, 0 timeout, 41 survived; 84.53%, exit 0 | 4m35s |

Comparison by exact mutation location/type/replacement found all 265 matches:
192 killed/73 survived before, 224 killed/41 survived after. **32 previously
surviving mutants are now killed; zero previously killed mutants regressed.**
This is a like-for-like subset comparison, not a new overall score for both
modules. No unchanged whole-project gate was repeated for this test-only delta.
The wiring/runner check passed 26/26, and `git diff --check` passed.

Reports retained:

- `reports/mutation/provider-wait-latest.html` and `.json`.
- `reports/mutation/bridge-core.html` and `.json`: the first full expanded baseline.
- `reports/mutation/queue-wake.html` and `.json`: final targeted verification.
- `.test-logs/account3-fastcheck/mutation-comparison.json`: exact matched changes.

Remaining survivors are visible in JSON/HTML; no mutations were excluded and no
score threshold was lowered. Some are cosmetic/equivalent changes; others flag
further possible coverage work around redundant wake admission, memory-hold
side effects, repeated recovery writes, progress accounting and final wake
filtering. These are not confirmed product defects. No product source was changed.
Console mutant/test listings are disabled to reduce log traffic; complete details
remain in the HTML/JSON reports. No LLM is used by the installed test commands.

## Retry follow-up (2026-10-15)

`npm run test:property` and its existing normal-runner inventory entry now include
`tests/property-queue-retry.js`: six properties, 600 generated cases. The combined
command passed **30/30, exit 0, zero skips**, 2,240 generated cases plus deterministic
controls. Node duration was 2,558.2116 ms versus 2,368.8865 ms immediately before
wiring (+189.3251 ms in one sample; not a benchmark guarantee). The retry regression
passed 31/31 and inventory tests passed 26/26, both exit 0 with zero skips.

The successful initial retry scope was **194 mutants, 60 killed, 132 survived,
2 timed out, 0 errors; 31.96%** after installing the locked dependencies. Its older
Windows IPC failure is superseded. One survivor-driven verification run of the
unchanged retry scope/config passed with **79 killed, 113 survived, 2 timed out,
0 errors; 41.75%**, 130,662.2802 ms wall time. All 194 exact mutations matched:
19 former survivors were killed and all 60 prior kills remained killed.

Use `npm run test:mutation:retry` for this separate scope. It runs only retry
properties, not the 31-test integration regression. See
[retry evidence](RETRY-PROPERTY-MUTATION.md) for the complete survivor/timeout
classification, fixture limits, before/after timings and report paths. These
focused passes do not replace or change the full-`npm test` exit-1 result above.

## Second retry round and actual candidate acceptance (2026-10-15)

Two properties extend rate-limit output/final-response/changed-file accounting
and infrastructure retry limits/backoff/stored-model preservation. The fixture
uses production model parsing/allowlisting and retry/model-selection functions,
with synthetic pause-map I/O and SQLite. Retry: **8/8, 800 generated samples**;
combined properties: **32/32, 2,440 generated samples plus controls**, both exit 0
with zero skips. Queue-cost 5/5 and fallback 13/13 also passed without skips.

The valid 79/113/2 mutation receipt was hash-checked and reused. One scoped retry
Stryker run completed: **194 mutants, 120 killed, 72 survived, 2 timed out,
0 errors; 62.89%, exit 0**, wall 254,700.4580 ms. Exact comparison adds **41
assertion kills**, retaining all 79 prior kills. The two known finalization
timeouts remain unchanged. The added properties consumed 782.5328 ms combined
standalone; mutation wall time rose 124,038.1778 ms against the valid prior receipt.
No provider/scheduler mutation baseline was rerun.

**At the end of the second round, the candidate had not passed its complete gate.** One real `npm test` run
completed in this worktree: **exit 1, 174/182 commands, 8 failed**, runner duration
**2,203,762 ms (36m43.762s)**. Skip accounting: **4 optional skipped cases,
2 optional partial cases, 0 required skips**. The property command, 31-test
retry regression and 26-test inventory all passed within that same run.

Authoritative full report:
`.test-logs/2026-10-15T15-49-19-826Z-3208/report.json`;
wrapper recipe, candidate hashes and output:
`.test-logs/retry-followup/full-candidate.{start.json,receipt.json,log}`.
Synthetic parent profiles avoided the old MCP inheritance failures, but redundant
outer TEMP nesting exposed Windows Git `'$GIT_DIR' too big` errors. A serial,
flatter-temp focused control passed seven of the eight failing suites; spawn's
direct-writer case still failed with that explicit path error. The native
supervisor snapshot failure did not reproduce serially and remains unexplained.
Those controls are **not** a complete-suite pass. No second full run was started.

See [retry evidence](RETRY-PROPERTY-MUTATION.md) for all eight failures, exact
focused commands/durations, representative survivors, limitations and the next
environment correction needed before another gate attempt. Product source and
mutation settings remain unchanged; all candidate edits remain uncommitted.

## Predecessor Windows fixture correction and complete gate acceptance

That candidate **passed one complete real-runner `npm test`: exit 0,
182/182 commands, zero failures**, runner duration **1,880,156 ms (31m20.156s)**,
wrapper wall **1,885,351.2180 ms**. Normal accounting recorded **4 optional skipped
cases, 2 optional partial cases, 0 required skips**. All eight previously failing
commands passed in this same run. This supersedes the previous failed gate; the
historical 174/182 and 176/182 runs and focused controls remain separate evidence.

The only executable-source correction was shortening `review-spawn.js`'s unique
scratch prefix to `spawn-`, saving 22 characters. No assertion, real worktree,
cancellation/PID check, inventory entry, production timeout or security check was
changed. Native Git 2.39.1.windows.1 reproduced the old layout's failure and the
short prefix's success. Independent controls showed a 222-character destination
still failed with a short repo, while a 201-character per-worktree metadata path
succeeded with a short destination. This is a real destination-depth limitation,
not just an assumption about synthetic metadata paths or a generic 260 limit.

Focused verification passed spawn 43/43 (one optional symlink partial) and runner
checks 26/26. The supervisor passed with fallback and queue-cost running on three
supported parallel workers. A diagnostic-only observer recorded the unchanged
native snapshot command succeeding in **2,030.0122 ms**, exit 0, within its 5,000 ms
budget, with 399 parsed rows and redacted row shapes only. The original snapshot
failure cannot be reconstructed from the old aggregate event and remains
unexplained. The complete gate used **no observer** and also passed the normal
supervisor self-test.

Exact launch: `node .test-logs/retry-followup/round3-run.mjs full`, which executes
`npm test` with empty synthetic profiles, credential scrubbing, isolated Git
config and **flat outer TEMP**. The unmodified real runner retains normal
scheduling, unique/canonical fixture ownership, per-slot profiles and skip ledger.
The 238 executable-input hashes matched before and after; identity:
`0d15456554842db137a2c7717acb36550520034816de78fd0916405e71807f23`.

Authoritative report for that predecessor:
`.test-logs/2026-10-15T20-41-41-703Z-2040/report.json`.
Launch/environment/output: `.test-logs/retry-followup/round3-full.*`.
Native path and snapshot evidence, focused receipts, limitations and proposed
separate long-path hardening are detailed in [retry evidence](RETRY-PROPERTY-MUTATION.md).

That testing candidate was accepted for its recorded local gate, with optional
Windows limitations disclosed. Production long-path behavior and the old native
snapshot uncertainty are not declared repaired. No Stryker/standalone property
baseline was repeated; retry mutation remains **120 killed / 72 survived /
2 known timeouts, 62.89%**. All work remains uncommitted; no production readiness,
Node 22 execution or provider/deployment validation is inferred.

## Quality round continuation (2026-10-16)

The expanded candidate is distinct from the predecessor above. It currently has
**73 properties** across five files: provider wait9, scheduler15, retry15,
locks17 and queue leases17. Current combined execution on Node22.13.0 passed
73/73 with zero skips; the lock stop/drain test now holds an actual fixture DB
open and proves stop stays pending until release for success/failure outcomes.
No timing sleep, production lock edit or assertion weakening was used.

Retry's current measured scope is194 mutants,150 Killed/42 Survived/2 Timeout,
78.35%, with30 additional assertion kills against identical mutant identities.
It was not rerun unchanged. Final lock/lease mutation measurements and frozen
Node24/22 complete gates are in progress; earlier14/15-case lock/lease scores
must not be attributed to the current17/17-case inputs.

Approved product repair Q-20261016-01 rejects expired positive launch authority
in bin/process-supervisor.js immediately before spawn. Native before/after marker
controls verified refusal on22/24 and valid controls still start. Current native
supervisor selftests pass both versions. A historical Node22 found:0 descendant
failure was not reproduced by paired predecessor/repaired probes or an independent
review's capped six-case immediate/readiness/non-Node matrix. Raw owned PID rows
and native-handle birth evidence were retained; strict timestamp/identity and
cleanup assertions were preserved. Its historical cause remains unresolved.

Source/delta review independently ACCEPTED the first244-input candidate
f47c02ee78889fe4022ca430a7dd0461e32f30682589b175f133dbd99095db4e.
This is not yet whole-candidate acceptance. Receipts, exact commands and current
coordination are under `.test-logs/quality-round-2026-10-16/`; see
[quality-round plan](QUALITY-ROUND-2026-10-16.md). Existing dependency audit exit1,
native Windows long Git paths and untested providers/platforms remain disclosed.

That first lock measurement exposed five synthetic timeouts caused by the new
test waiting for DB entry even after a mutant pulse had settled without opening.
Its164 Killed/71 Survived/5 Timeout report and exact inputs are preserved in
`root/locks-held-barrier-measured/`. A test-only entry-versus-settlement race now
fails immediately for that condition while retaining the stop-pending assertion.
Exact synthetic174 fails the intended assertion in3.5s with zero skips/cancels;
current73/73 Node22 properties pass. Current frozen244-input candidate is
`a2551d119b3d4bf37fc1efc3b7bdafffa5cacf2443c342fe8c0b9f9cf7016399`.
The exact a255 delta and completed local evidence have now been independently
accepted; complete Node22/concurrency acceptance remains pending at this update.

### Completed final measurements on a255

| Scope | Total | Killed | Survived | Timeout | Additional assertion kills |
| --- | ---: | ---: | ---: | ---: | ---: |
| Retry (unchanged measurement) | 194 | 150 | 42 | 2 | 30 |
| Locks | 240 | 168 | 71 | 1 | 27 |
| Queue leases | 132 | 118 | 14 | 0 | 3 |

Exact source/mutant identity comparisons found no original kills lost. Timeout
is separate from an assertion kill; survivors identify coverage gaps, not a
count of real bugs. The final lock measurement used supported CLI `--concurrency 1`
after capped same-instrumentation replays showed contention-induced budget misses
in sampled cases. The tests, mutation scope and timeout configuration were not
weakened. Normal `npm test` scheduling remains unchanged. Evidence and preserved
intermediate reports are under `.test-logs/quality-round-2026-10-16/root/`.

The actual final Node24.11.1 full gate passed182/182 commands with4 optional
skips,2 optional partials and0 required skips, unchanged244-input a255 identity.
It includes setup/portable/release self-tests, not approval of the real release
audit policy. Full Node22 and native concurrency results must be recorded
separately; the earlier73/73 Node22 property pass alone does not establish them.
