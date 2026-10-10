# Test-suite fragility review (read-only), 2026-10-10

Repo `C:\Users\10User\codex-opencode-mcp`, branch `bridge/housekeeping` at b74fbc7 (= main). No tracked file changed, nothing
committed. All scratch artefacts are in this directory. Host: Windows 11, 12 logical CPUs, Node 24.11.1, git 2.39.1.windows.1.
Host load varied a lot during the review (CPU 79 % while other review agents ran, 2-17 % at the end); every timing below
names its condition.

## 1. `tests/review-integration-reuse.js`: the 2026-10-09 "hang" at case 16

### What I ran

| run | condition | result | elapsed | case 16 ("automatic removal ...") |
|---|---|---|---|---|
| 1 | `timeout 420`, CPU ~79 % (other agents) | 18/18 PASS | 295.1 s | started 243.9 s, took 14.1 s |
| 2 | `timeout 420`, same + my measurement lane | 18/18 PASS | 382.8 s | started 331.2 s, took 16.7 s |
| 3 | `timeout 420`, same | 18/18 PASS | 346.7 s | PASS |

Logs: `reuse-run1.log`..`reuse-run3.log` (each line prefixed with ms since start), `reuse-summary.txt`.
Per-case durations are 5-41 s; the slowest cases are the ones with two fixtures or two applies (cases 10, 11, 13, 15: 27-41 s).
**The whole file needs 5-6.5 minutes on a busy host.** Run 2 crossed the 5-minute mark during case 15, which is exactly
where the 2026-10-09 run was reported stuck. A caller budget of 5 minutes (a Bash tool timeout, a harness `timeout 300`) is
therefore not enough for this file by itself, independent of any bug.

Scratch probe of case 16 alone (`case16-probe.mjs`, run 3 times, `case16-probe.log`): apply returns at ~12.5-13.3 s,
the deferred cleanup row disappears 2.9-3.4 s later (12-14 polls of ~154 ms each, every poll spawns `git rev-parse` through
`openLockDb`). My earlier hypothesis that the 50 ms cleanup timer (scheduled inside the integration lease,
`lib/integration-cleanup.js:94`, released later in `lib/integration-serial.js:237-254`) loses the lease and waits the 5 s
retry was **not** confirmed: in all three probes the first drain got the lease.

### Forensics of the 2026-10-09 run (it is still on disk)

The killed run left `C:\Users\10User\AppData\Local\Temp\bridge-integration-reuse-1XqbKh` (never cleaned: the test's
`rm(root)` is in a `finally` that a kill skips). I copied the project databases to `oct9-case16\` and read them read-only.
(Note: one `git status` I ran in its `repo-19` refreshed that leftover repo's index; nothing else was written there.)

* The run started 09:46:32 (repo-1), case 16's fixture `repo-19` was created at 09:51:06; pid 9924 matches the
  `(node:9924)` warning in `scratchpad\review-integration-reuse.out`, whose last write is 09:58:23.
* `repo-19`'s project DB (`c0a68d1b94c775bf2f45a420.sqlite`):
  * preview lease `...1791528668046` acquired 09:51:08.0, released 09:51:12.8 (dry run finished);
  * apply lease `codex-merge_manager-1791528673069-trq79j` acquired 09:51:13.07, **still `running`**, and its
    `expires_at` is exactly `created_at + 1 800 000` (the 30-min `DEFAULT_LOCK_TTL_MS`): **the 30-s heartbeat
    (`lib/locks.js:566`, interval min(30 s, ttl/3)) never renewed it once**;
  * `consumed_integration_previews` holds 1 row: the reviewed apply consumed its receipt
    (`lib/integration-apply.js:428`), the DB file's last write is 09:51:14.97;
  * `integration_operations` is empty (case 15's DB, by contrast, holds its two committed operations), the target's
    `a.txt` is still `original`, the source worktree still exists, no `integration_worktree_cleanup` row.
* So the process stopped making progress between the receipt consumption (`integration-apply.js:428`) and the journal
  begin (after `inspectRepositoryOperationState`, `:557`), i.e. inside `captureRollbackBaseline` /
  `gitChangedFileSnapshot` / `captureIntegrationTargetState` (`integration-apply.js:491-557`), for at least 5 and
  probably 7 minutes.

### Root cause: what the evidence supports, and what it does not

1. Every await on that path has a deadline: git runs through `runCommand` -> `execFile` with 15 s-5 min timeouts
   (`lib/run-command.js:35`, `CONFIG.gitHeavyTimeoutMs` = 5 min), `openLockDb` retries 8 times with `busy_timeout`
   5000 (`lib/state/database.js:117-246`). I verified that an `execFile` timeout kills both `C:\Program Files\Git\cmd\git.exe`
   (the launcher that PATH resolves from PowerShell) and `mingw64\bin\git.exe` at 2.0 s with no surviving git process
   (`launcher-timeout.cjs`), so the "grandchild keeps the pipe open" theory does not hold for git.
2. A slow git command would not explain the lease: the heartbeat timer is independent of the stuck await and would have
   renewed `expires_at` 10-14 times in 5-7 minutes. **No renewal at all means no JavaScript ran in that process for
   minutes**: the event loop was blocked or the process was frozen. Candidates I could not distinguish from the
   leftovers: a synchronous `CreateProcessW` in `uv_spawn` stalled by the host (antivirus/process-creation stall under the
   heavy concurrent verification of that morning), a process suspended by its parent/terminal, or a synchronous SQLite
   busy wait repeated without bound (I found no such loop; each wait is <= 5 s).
3. It did not reproduce in 3 full runs + 3 probes today.

**Verdict:** two separate problems. (a) Reproducible: the file legitimately needs 5-6.5 min under load, so any 5-min
caller budget reports it as hung at case 15/16. (b) Not reproduced: on 2026-10-09 the process stopped executing
JavaScript (heartbeat evidence) right after consuming the receipt; there is no unbounded `await` in the code, so the
cause is outside the bridge's async logic (event-loop block or process freeze). Nothing in the evidence points at the
deferred-cleanup drain, the fenced cleanup lease or Windows directory-removal retries: case 16 never reached them.

### Other hang risks in this file (code reading)

* Case 18 (`tests/review-integration-reuse.js:317-320`): `await new Promise(r => child.once("close", r))` after
  `child.kill()` and the dry `bridge-gc.js --json` `execute` have no timeout (the `--apply` call has 30 s).
* `:338` `rm(root, { recursive: true, force: true })` has no `maxRetries`; my probe hit `EBUSY ... rmdir repo-1` once in 3
  runs with the same pattern. In the test this throws from the `finally` after all PASS lines and fails the file.
* No per-case or per-file watchdog anywhere in the suite, and `npm test` / `bin/release-gate.js:205` wait on `close`
  forever: a real hang blocks the gate indefinitely with no diagnosis.

### Recommendations

1. Give this file a per-case hang guard that prints the case name and `process.getActiveResourcesInfo()`, and a
   **worker-thread watchdog** that notices a stalled main thread (a SharedArrayBuffer heartbeat) and then lists the
   process's child processes with command lines (`Get-CimInstance Win32_Process -Filter "ParentProcessId=<pid>"`). That
   separates "awaiting a stuck git" from "event loop blocked" next time.
2. Split it in two files (cases 1-9 and 10-18): each ~2.5-3 min under load, so a 5-min caller budget stops being a trap
   and a parallel runner can overlap them.
3. Case 18: bound the close wait (10 s, then `taskkill /T /F`) and give the dry `bridge-gc` call `timeout: 30_000`;
   `rm(root, { ..., maxRetries: 5, retryDelay: 200 })`.
4. Product nit (not a cause today): `enqueueIntegrationCleanup` schedules its 50 ms timer while the integration lease is
   still held; scheduling from the `finally` after `releaseHardLock` removes the race whose loser waits 5 s.
5. Housekeeping: delete `bridge-integration-reuse-1XqbKh`; 131 `bridge-test-xdg-config-*` dirs leak in `%TEMP%`
   (`tests/test-env.js` creates one per process and never removes it); 7 orphan `codex-opencode-test-skips-*.jsonl` ledgers
   from aborted gates.

## 2. Wall-clock-dependent assertions (tests/*.js, bin/*.test.js, plus bin/e2e-concurrency.js)

Full table (178 rows, file:line, class, budget, fragility): `timing-inventory.md` (built by a helper agent from code
reading; I spot-checked review-spawn.js:309, review-round5.js:497-502 and lib/provider-leases.js:32-48 against the code).

| class | rows | meaning |
|---|---|---|
| UPPER | 116 | fails if something takes longer than N ms (fragile under load) |
| SLEEP-RACE | 16 | fixed sleep, then asserts background work did/did not happen |
| HARNESS | 33 | hang guard >= 60 s or a sleep followed by a load-independent check |
| LOWER | 13 | asserts at least N ms (safe) |

23 UPPER/SLEEP-RACE rows have fragility 4-5. Three mechanisms explain most of them:

* `acquireProviderLease` spends the caller's `timeoutMs`/`maxWaitMs` on opening the provider DB too
  (`lib/provider-leases.js:32-35`, "initialization exceeded the caller deadline"): every test that expects a *slot* timeout
  with a budget <= 600 ms can get the DB-init error instead. That is B-035, and it affects ~10 assertions, not only
  review-spawn #6.
* A short `CODEX_OPENCODE_QUEUE_LEASE_MS` shrinks the supervisor watchdog of every supervised spawn in that process
  (`lib/run-command.js:145-149`: watchdog = 0.75 x lease, heartbeat = watchdog/3).
* The idle watchdog is armed when the supervisor is ready, so the payload's own node startup counts against
  `idleTimeoutMs` (`lib/run-command.js:272-316`).

Worst five:

| # | where | budget | why fragile | fix pattern |
|---|---|---|---|---|
| 1 | slot-timeout family: `review-provider-wait.js:209,217,240,249,261` (100-180 ms), `review-spawn.js:309` (300), `review-provider-fallback.js:179` (250), `review-queue-features.js:159,180` (400) | 100-400 ms | budget also pays SQLite open (WAL, synchronous=FULL, schema) | warm/open the DB before the timed call, or hold all slots and use >= 2 s; assert the errorType, not a duration |
| 2 | `review-round5.js:497-502` | 900 ms idle | node startup must be < ~750 ms | emit one byte at once, or arm the idle check at first output; or a `CODEX_TEST_TIME_SCALE` multiplier |
| 3 | `review-spawn.js:322-328` | 2000 ms wait, 3200 ms run | 500 ms slack after a 1500 ms release timer, ~1.2 s for supervisor + fake OpenCode | release on the waiter's onWait progress, fake waits on a file, run timeout ~10 s |
| 4 | `review-friend-runtime.js` (1000 ms queue lease, :59-66, :156/183, :197-207) | 750 ms watchdog / 250 ms heartbeat | every supervised spawn in the file runs with a sub-second watchdog | 4000 ms lease / 200 ms heartbeat as B-034 did; isolate the cases that need a short lease |
| 5 | `review-flex-runners.js:130` | 1500 ms idle, whole file | fake codex must print within 1.5 s; "commit" mode runs git silently first | idle watchdog only in the agy idle case; fake prints before git |

Also fragility 4: `review-provider-wait.js:195` (5 s expiry must return within 1.5 s), `:229-230` (<600 ms, <30 ms),
`review-batch-race.js:219` (200 ms window to see a transient "blocked"), `review-round5.js:480-490` (1 s idle),
`review-flex-rate-limit.js:172-185`, `review-validation-tree.js:55-57` (detached grandchild in 4 s),
`server-self-test.js:3501-3510` (~1 s scheduler window). The reuse file's 20 s cleanup bound and 30 s owner reply are
fragility 3 (case 16 took 14-17 s end to end today, cleanup itself ~3 s).

General rule for the SLEEP-RACE rows: poll until the condition holds with a >= 15 s hang guard; for transient states assert
on a durable counter (`queueWorkspaceWaits >= 1`) instead of sampling. A single `CODEX_TEST_TIME_SCALE` env (default 1,
gate sets 2-3 on a loaded host) applied to every UPPER budget would make the whole class tunable without touching
product defaults.

## 3. B-201: make the gate independent of the operator's OpenCode config

How each script builds the env of the bridge it starts:

| script | spawns the real stdio server? | XDG_CONFIG_HOME |
|---|---|---|
| `bin/mcp-robustness.js` (in `npm test`) | yes, `StdioClientTransport` (:39-44) and a raw `spawn` (:130-132) | **inherited**: `serverEnvironment()` (:27-35) is `{ ...process.env, QUEUE_MODE, STATE_DIR, ALLOW_EXTERNAL_PLUGINS:false }` |
| `tests/server-self-test.js` | no (imports server.js with `--self-test`; the startup policy check at `server.js:5978` does not run) | `tests/test-env.js` sets a scratch dir **only if unset** |
| other `tests/*.js` that start a server (`review-ops-log-coverage`, `review-queue`, `pipeline-abandon`, `review-split-lib-pin`, `review-production-startup`, `review-setup-cli`) | yes | explicit scratch/fixture dirs |
| `bin/release-gate.js` | runs `npm test` etc. via `spawn(step.command, { shell })` (:205) with no `env`: inherits the operator shell | inherited |
| `bin/e2e.js`, `bin/e2e-contractor.js` | yes | explicit isolated `configHome` (e2e.js:149-171) |
| `bin/e2e-concurrency.js` | yes | `fakeConfigHome` (:631) |

Confirmed: `~/.config/opencode/opencode.jsonc` declares `"mcp"` (the runtime dir's copy does not); without
`XDG_CONFIG_HOME`, `assertNoInheritedMcpServers` (`lib/plugin-policy.js:183-205`) rejects and the robustness child exits
after connect (`McpError -32000: Connection closed`, `scratchpad\npm-test-housekeeping.log`). `mcp-robustness.js` is the
only `npm test` entry that starts a real server with the inherited value.

**Smallest change (one file, test-only):** in `bin/mcp-robustness.js` `serverEnvironment(stateDir, extraEnv)` always set
`XDG_CONFIG_HOME: path.join(path.dirname(stateDir), "xdg-config")` (i.e. inside the run's own `fixtureRoot`, removed by the
existing cleanup at :253). An empty directory is enough because the script runs with
`CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS=false` (pure mode, no agent starts). Verified without changing the repo: the
unchanged script run with `XDG_CONFIG_HOME=<empty scratch dir>` passed in 29 s (`robustness-emptyxdg.log`). Note the
server (OpenCode's eager mkdir) wrote `opencode/opencode.jsonc` and `opencode/.gitignore` into that dir, so the current
rule "run the gate with XDG_CONFIG_HOME = the live runtime dir" lets a gate run write into the deployed runtime profile; the
scratch dir avoids that as well. Copying the reviewed `opencode/opencode.jsonc` there (as e2e.js copies agents/skills) is
only needed if a later robustness case starts an agent.

Follow-ups of the same kind (not needed for B-201 itself): make `tests/test-env.js` always use its scratch dir unless an
explicit opt-in (`CODEX_TEST_KEEP_XDG_CONFIG_HOME=1`) is set, so an operator's `XDG_CONFIG_HOME` never reaches tests; and
remove the dir on exit. Production clients are untouched: `bin/setup.js:182,196` keeps passing the runtime dir.
Remaining exposure outside XDG: `assertNoInheritedMcpServers` also reads the managed system dirs and `$HOME/.opencode`
(today: no config files there).

## 4. A parallel runner that keeps coverage and the skip-gate ledger

Today `npm test` is one `&&` chain of 157 commands (`package.json:11`): 84 `node --check`, 70 suites/self-tests,
`skip-gate --self-test/--reset/--summary`. It stops at the first failure, prints no per-file duration and has no timeout.
`tests/review-prod-core.js` (11 cases, B-110..B-118) is in neither `npm test` nor the release gate.

### Measurements

| file | under load (CPU ~79 %, sequential) | quiet (CPU 2-17 %, sequential) | quiet, 3 in parallel |
|---|---|---|---|
| tests/server-self-test.js | 447.7 s | ~240 s (2026-10-09 log: 08:03:38-08:07:38) | - |
| tests/review-integration-reuse.js | 295-383 s | - | - |
| tests/review-integration-recovery.js | 144.2 s | 67.6 s | 94.2 s |
| tests/review-spawn.js | 33.6 s | 12.6 s | 18.5 s |
| bin/mcp-robustness.js | 28.5 s | 8.5 s | 16.9 s |
| tests/review-queue.js | 24.0 s | 11.5 s | 22.0 s |
| tests/review-flex-defaults.js | 18.4 s | 5.6 s | 13.4 s |
| 84 x `node --check` | - | 15.2 s sequential | 3.6 s at 8 parallel |

Prototype: `mini-runner.mjs` (scratch, ~40 lines): the same five files took 106.1 s at `--jobs 1` and 94.4 s wall at
`--jobs 3` (sum of per-file times 165 s, i.e. ~1.56x contention); the long recovery file is the critical path. All passed
in parallel, including the timing-sensitive review-spawn.js, and the **existing skip ledger worked unchanged**
("Total skipped: 1 across 3 reporting test files"), because children spawned with `shell: false` all have the runner as
`process.ppid` (`tests/skip-gate.js:33`).

### Design

`tests/run-gate.js`, `npm test` -> `node tests/run-gate.js` (keep the old chain as `test:serial` for one release):

1. **Manifest** `tests/gate-manifest.js`: ordered list of `{ argv, lane, timeoutMs }` generated from today's chain, so
   coverage is identical; the runner fails if a `tests/review*.js` / `bin/*.test.js` file is neither listed nor in an
   explicit `excluded` list with a reason (this would have caught `review-prod-core.js`).
2. **Phases:** `skip-gate --self-test` and `--reset` serial first; all `node --check` at concurrency 8 (15 s -> 4 s);
   then the suites at `--jobs N` (default 3, `CODEX_TEST_JOBS` / `--jobs`); `skip-gate --summary` last.
3. **Lanes:** `parallel` (default); `exclusive` for files whose UPPER budgets are below ~1 s (review-spawn,
   review-provider-wait, review-provider-fallback, review-queue-features, review-round5, review-friend-runtime,
   review-flex-runners, review-flex-rate-limit, review-batch-race): they run alone, so adding parallelism does not
   add flakes until the budgets are fixed (section 2); `serial-first` for the longest files (server-self-test, reuse,
   recovery) so they start immediately and the critical path is not left to the end.
4. **Process model:** `spawn(process.execPath, argv, { shell: false })` so the ledger keeps working; better, also set
   `CODEX_TEST_SKIP_LEDGER=<file>` and make `ledgerPath()` prefer it (one-line change), or one ledger file per test to
   avoid concurrent appends.
5. **Per file:** stdout/stderr to `.test-logs/<file>.log`, a one-line `PASS|FAIL|TIMEOUT  12.3 s  tests/x.js`, and a
   timeout (default 15 min, per-file override) that first records the child process tree (command lines, ages), then
   `taskkill /PID <pid> /T /F`.
6. **No stop at first failure** (`--bail` for the old behaviour); the end prints a table sorted by duration, the failed
   files with the last 30 lines of their logs, the skip summary, and writes `.test-logs/report.json` that
   `bin/release-gate.js` can copy into its receipt (per-file durations become trend data).
7. `--only <substring>`, `--rerun-failed` (reads report.json) for the fix loop.

### Estimated saving

Sequential gate on 2026-10-09: ~55 min under load. With `--jobs 3` and the measured ~1.5x per-file contention, balanced
work gives ~3/1.56 ~ 1.9x: about **27-30 min** (save ~25-28 min). `--jobs 4` on a quiet host: ~23-25 min. The floor is the
longest file (server-self-test 4-7.5 min, reuse 5-6.5 min under load), so splitting those two into stage-sized files
(server-self-test already has 5 named stages) is what lets the wall time approach ~15 min. The exclusive lane costs a few
minutes (those files are 10-35 s each). These are estimates from 5 measured files plus the node --check timing, not a
full parallel gate run.

## Could not verify

* Why the 2026-10-09 process stopped running JavaScript (blocked event loop vs frozen process); it did not reproduce.
* A full parallel gate (I measured 5 files in parallel, not all 70).
* Whether the review-batch-race job really completes on its first re-poll (helper agent's open point).
