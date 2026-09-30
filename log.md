# Bridge problem log

Every problem found while using the bridge for real work, with its cause, its fix, and the
rule that keeps it from coming back. Newest first within each day. IDs `L-0xx` refer to the
detailed entries in `C:\Users\10User\Desktop\charGPT-python\log.md` (the charGPT migration,
which is the bridge's live acceptance test); `B-xxx` entries are recorded only here.

Status: **fixed** (committed and verified), **fixed, not deployed** (committed on
`bridge/migration-fixes`, not yet in the live tree), **open**, **wont-fix**, **rule** (no code
change; a working rule instead).

How a fix lands: edit and test in the `C:\Users\10User\bridge-fixes` worktree (branch
`bridge/migration-fixes`), run `npm test`, `npm run test:events`, `npm run test:builder-fallback`,
then, with the user's explicit approval, `git merge --ff-only bridge/migration-fixes` in the live
tree and `node bin/release-activate.js --sync-clients`, then restart the clients.

## 2026-09-29

### Second review (review2): R-134..R-174 (Codex review, finished by Claude, 2026-09-29)

A Codex session reviewed the whole bridge again in nine areas (41 findings, verified by a second pass), created one worktree per area and started implementers for areas C, E and G; the user stopped it at 18:23 with nothing committed. Claude finished it the same evening: every area was redone on top of the current code (`6dd33de` + `9be1b87`) in its own worktree, each confirmed finding got a regression test that fails without the fix (`tests/review2-a.js` .. `tests/review2-i.js`, now in `npm test`), each diff was reviewed, and the branches were merged into `bridge/final-fixes`. The uncommitted C/E/G work was kept as patches (`~/.codex/review2-patches-backup-20260929`) and reviewed, not taken as is.

| ID | Problem | Fix | Commit | Status |
|---|---|---|---|---|
| R-134 | A rejected startup recovery was turned into `{ok:true}`, so early tool calls ran on unrecovered state. | Tool calls answer `startup_recovery_failed` until the bridge restarts; the failure is still logged. | `dc31f6d` | fixed |
| R-135 | Two sequential 15 s `git config` reads at import could use the whole 30 s MCP startup deadline. | Read together under one 10 s bound. | `dc31f6d` | fixed |
| R-136 | `node bin/state-audit --self-test` (no `.js`) skipped main and exited 0. | Main-module detection resolves the extensionless path like Node. | `dc31f6d` | fixed |
| R-137 | Invalid numeric env values fell back to the default silently; a `_MS` value above 2^31-1 overflowed timers. | An invalid value (not a number, 0 for a positive setting, or a `_MS` value above 2147483647) stops the bridge at startup with the variable named. | `dc31f6d` | fixed |
| R-138 | Pipeline lists and diagnose returned every pipeline. | `list_multi_agent_pipelines` `limit` (default 20); diagnose keeps every open pipeline plus the 25 newest finished. | `dc31f6d` | fixed |
| R-139 | Plugin trees are not in the attestation-cache fingerprint (30 min stale window). | - | - | rejected: documented TTL within the same-user boundary |
| R-140 | `git` allowlist and command resolve through the same PATH. | - | - | rejected: needs same-user file mutation |
| R-141 | A PEM block with escaped `\n` and no END line kept its body after redaction; bodies past 128 characters leaked. | Unterminated escaped-newline bodies are redacted at any width. | `43a487a` | fixed |
| R-142 | The patch secret gate needed a 40-character next line, so a key wrapped at 32 columns got a receipt. | Key-body characters after the marker are counted across lines (and inside one JSON line). | `43a487a` | fixed |
| R-143 | The git control-surface fingerprint omitted `.git/info/attributes` and `objects/info/alternates`. | Both are fingerprinted, and a repository with an effective entry in either is refused like `core.attributesfile`. | `43a487a` | fixed |
| R-144 | A late provider-lease heartbeat overwrote the quarantine. | `stop()` awaits the in-flight pulse; renewal skips quarantined rows; every stop call is awaited. | `cee3230` | fixed |
| R-145 | An expired write lock could not be quarantined. | Quarantine marks, and re-inserts pruned, rows of the run regardless of expiry. | `cee3230` | fixed |
| R-146 | POSIX termination reported `treeTerminationConfirmed` while a detached child held the pipe. | Confirmed only when the group is empty and the pipes closed. | `cee3230` | fixed |
| R-147 | No durable quarantine if the bridge dies and the supervisor kill fails. | - | - | open (plausible; not a small fix) |
| R-148 | The capacity snapshot threw on a quarantined lease's expiry. | Shown as `quarantined (no expiry)`. | `cee3230` | fixed |
| R-149 | `**/secrets/**` was normalized to `**/secrets`, so `pkg/secrets/credentials.txt` was allowed (same for `**/.git/**`). | A `/**` suffix after a glob prefix is kept and matches any depth. | `d833988` | fixed |
| R-150 | A failure after COMMIT in `acquireHardLock` left the lock for its TTL. | The catch removes the rows this call inserted once COMMIT was attempted. | `d833988` | fixed |
| R-151 | A concurrent edit after the final target check was overwritten by `checkout-index -f`. | Exact bytes of every patched path are re-read right before the first write; a mismatch closes the operation `recovered_noop` and fails `integration_preview_stale`. | `97a2bd6` | fixed |
| R-152 | `bridge-gc` did not re-check activity and dirt before `worktree remove --force`. | Re-checked right before each removal. | `97a2bd6` | fixed |
| R-153 | `bridge-gc` ignored ignored files, so a worktree holding only ignored output was removed. | Ignored entries count as dirt (kept unless `--force-dirty`). | `97a2bd6` | fixed |
| R-154 | A quoted `diff --git "a/…" "b/…"` header bypassed the binary-hunk gate. | Quoted headers are unquoted; an unparseable header is reported. | `97a2bd6` | fixed |
| R-155 | The preview receipt did not bind `cleanupAfterSuccess`. | Bound in the contract hash. | `97a2bd6` | fixed |
| R-156 | A completed writer with `noChanges` became `failed` and failed its pipeline. | `noChanges` counts as evidence. | `64fcd4b` | fixed |
| R-157 | A child whose terminal writes all failed stayed `running` forever behind the pipeline's instance lease. | A fresh instance lease shields only another instance's jobs; this instance's untracked lapsed jobs are reconciled. | `64fcd4b` | fixed |
| R-158 | `state-audit --strict` did not check `finalizing` pipelines. | Included. | `64fcd4b` | fixed |
| R-159 | A crash between `mcp remove` and `mcp add-json` deleted the Claude entry. | The entry is saved to a recovery file first and restored by the next run. | `fa4daab` | fixed |
| R-160 | Config writes and rollbacks did not check for a concurrent edit. | Compare-before-rename for both. | `fa4daab` | fixed |
| R-161 | A missing source subtree counted as empty, so `--apply --remove-stale` deleted every profile. | A missing source directory is an error. | `fa4daab` | fixed |
| R-162 | Runtime sync followed a junction at the target root or an ancestor. | Every existing component of the target path is `lstat`-checked. | `fa4daab` | fixed |
| R-163 | The release clean check ran before the build and ignored the published `node_modules`. | `node_modules` is installed fresh from the lockfile (no shell, `--ignore-scripts`); the clean check runs again after staging. | `fa4daab` | fixed |
| R-164 | The TUI printed ANSI/OSC control bytes from job text. | Control characters are printed as `?`. | `fa4daab` | fixed |
| R-165 | A generated `sh` wrapper double-quoted the checkout path. | Single-quoted. | `fa4daab` | fixed |
| R-166 | The profile smoke tested only the orchestrator. | Orchestrator, reviewer and tester. | `fa4daab` | fixed |
| R-167 | The docs said a scope contract's `read` list restricts reads. | Documented as guidance; sanitized workspace for isolation. | `871f99b` | fixed |
| R-168 | Recommended client timeouts (1500/3000 s) were below the real bound. | The bound is documented (3000 s default, 5100 s with the live builder/validation timeouts). | `871f99b` | fixed |
| R-169 | The docs said an override without `@variant` keeps the profile's variant. | Corrected: no variant. | `871f99b` | fixed |
| R-170 | "Recommended" vs default source-dirt policy. | - | - | rejected |
| R-171 | "Cleanup is opt-in" was wrong. | Documented the default and `cleanupAfterSuccess: false`. | `871f99b` | fixed |
| R-172 | Undocumented env vars; example config showed 12000 / 2 slots. | Every variable listed with its default; example values updated. `CODEX_OPENCODE_WORKTREE_CLEANUP` is documented as a no-op. | `871f99b` | fixed |
| R-173 | Importing `server.js` wrote a gitconfig into the real state directory. | Written lazily on first use, in the effective (overridable) state directory. | `4769386` | fixed |
| R-174 | `npm test` skipped `tests/pipeline-*.js`. | Added, with every `tests/review2-*.js`. | `5ca700b` | fixed |
| B-031 | After the provider limit was raised 2 -> 4, status showed an idle key as "0 of 2". | A stored limit that differs binds only while leases taken under it are held. Recovered from uncommitted work of another session in the `bridge-fixes` worktree. | `9be1b87` | fixed |

Also: tests that skipped silently now report `skip` (`5b55ba9`).

Behaviour changes: an invalid numeric env value stops the bridge at startup; a failed startup recovery refuses every tool call until a restart; `list_multi_agent_pipelines` shows the newest 20 by default; a repository with an effective `.git/info/attributes` or any `objects/info/alternates` is refused (none of the operator's repositories has either); the secret gate flags more key-like text (`acceptFlaggedSecretLines` still applies); nested `secrets/` and `.git/` paths are forbidden; `bridge-gc` keeps worktrees with ignored output unless `--force-dirty`; a release build needs the npm cache or registry; the profile smoke needs `MCP_SMOKE_REVIEWER_MODEL` / `MCP_SMOKE_TESTER_MODEL` where those models differ.

Limits left on purpose: R-147; a millisecond gap between the R-151 byte check and `checkout-index`; the gap between `mcp remove` and `mcp add-json` is recoverable, not closed; an empty (not missing) source directory still empties the targets under `--remove-stale`; `state-audit --strict` still does not check `planned` / `awaiting_finalization`; after R-157 reconciles a child, this bridge's in-memory pipeline entry stays `running` until restart (reads use the database).

### Measurement follow-up: fixes for B-018 and B-020..B-026 (Claude, 2026-09-29)

Branch `bridge/measurement-fixes` (worktree `C:\Users\10User\bridge-measure`), commit c14aa7d. Tests: `tests/review-measurement.js` (12 cases, one per finding) and a migration case in `bin/direct-run-audit.test.js`; on the final code `npm test`, `test:events`, `test:builder-fallback` and `tests/pipeline-*.js` pass. A second reviewer read the diff: no weakened tamper/drift/TOCTOU check; its findings (parallel audit status for unsafe files and spawned-then-thrown jobs, in-flight worktrees offered for removal, `afterAgentMs` with retries, source check order at cleanup) are fixed in the same commit. Not deployed: deploying needs the user's approval (merge into the live tree, `node bin/release-activate.js --sync-clients`, restart both clients).

Real run with this code on a detached checkout of the PyTorch clone (22,708 files), same runtime environment as the Claude client, private state directory; the test suite ran on the same disk at the same time, so the numbers are slightly high:

| Step | Before (Codex run) | After |
|---|---:|---:|
| builder, before the agent starts | 47.8 s (queue startup) | 63.7 s (cold attestation cache) |
| builder, after the agent exits | about 20.7 s (inferred) | 22.6 s, of which patch collection 16.4 s |
| integration dry run | 29.1 s | 28.0 s |
| integration apply | 124.0 s | 115.9 s |

The user chose all three options below on 2026-09-29; they are implemented (tests: `tests/review-speedup.js`). Each trades detection strength for time:

1. **Seed the temporary index from the real index.** The explorer measured 0.9 s instead of 12.5-19 s per capture. Cost: the captures trust stat data, so a rewrite that keeps size and mtime goes unseen. *Implemented for the target checkout only* (every target capture, so dry-run and apply hashes still match); an index with assume-unchanged or skip-worktree entries falls back to the fresh index. The agent's source worktree keeps the fresh index: the agent controls that index, and stat data it wrote could make the applied patch differ from the files a reviewer read in the worktree.
2. **Reuse the final pre-apply capture as the immediate pre-apply capture** when no test hook runs between them (saves one capture per apply; the detection window before the apply grows by one capture). *Implemented.* An apply now does 4 target captures (from the target index) and 2 source captures (fresh).
3. **Cache the in-worktree role attestation** (saves about 13 s per writer, less the plugin-policy check the final attestation then runs uncached). *Implemented* with the key agent + repository + base tree: a freshly created worktree is proven clean and holds exactly its base tree, OpenCode's project directory there is the worktree root, and the global inputs are in the cache fingerprint. The final uncached pre-spawn attestation still runs in every worktree.

| ID | Problem | Cause | Fix | Commit | Status |
|---|---|---|---|---|---|
| B-027 | A file the agent force-adds on an ignored path (`git add -f`) in its worktree is left out of the reviewed patch, is not flagged as unrepresentable, and is deleted with the worktree at cleanup (reproduced in a scratch repository by the integration explorer). | Confirmed with a failing test: the patch is built from a fresh index with `git add -A`, which skips ignored paths, and the ignored-source check lists only untracked files, while the force-added file is tracked in the real index. | Files the source index tracks on ignored paths but the fresh index lacks fail the integration with `integration_source_unrepresentable` naming them; the source is retained. Ignored-path files the base commit already had stay in the patch as before. | (this commit) | fixed, not deployed (`bridge/long-run-hardening`) |
| B-028 | A failed `git worktree add` (here `fatal: '$GIT_DIR' too big` from a long state path) left its new `agent/...` branch behind in the user's repository on every attempt. | git creates the branch before the worktree; the bridge released only its reservation. | The branch, which the bridge checks did not exist before the call, is deleted while it still points at the base commit (`git branch -D` refuses a checked-out branch); the result reports `branchCleanup`. | c14aa7d | fixed, not deployed (`bridge/measurement-fixes`) |
| B-029 | Audit start records whose bridge died before the finish stay `started` forever; at 1000 unfinished rows every new audit start fails open silently. Parallel calls now write one row per job, so the bound is reached sooner after crashes. | Pruning removed only finished rows, and nothing closed a start record whose bridge died. | Start records carry the owning bridge instance and process id. Pruning closes a record of another bridge as `abandoned` (`direct_run_owner_gone`) when its process is gone, and an owner-less record written before this fix after 24 h; a live process (or a reused PID) keeps the record open, and a bridge never closes its own. Abandoned records count as failed in diagnose and are no longer shown as in flight. | (this commit) | fixed, not deployed (`bridge/long-run-hardening`) |

### Maturity measurement run (Codex, 2026-09-29)

Start: 2026-09-29 13:27:33 UTC. Preflight get_opencode_bridge_status on charGPT-python reported server.js SHA-256 prefix 3a623472 and provider concurrency limit 4. Initial diagnose_opencode_bridge found no quarantine, held lease/lock, or unresolved integration. It omitted the three preserved P4-B/C/D parallel worktrees; git worktree list found them, plus one pre-existing stale/prunable Claude scratch worktree. The bridge tree was clean at 47c6f98. No bridge code or configuration was changed in this run.

Jobs below separate bridge completion from the real pytest gate. A dash means the field was unavailable, not zero. The four P4 builders started before this measurement; their original job timing was unavailable. P4-B/C/D received fresh integration receipts during this run. All eight new migration writer jobs completed at the bridge level, had errorType none, needed zero manual retries, and received an integration receipt on the first dry run. Parallel runs do not expose startupMs. Queued jobs expose waitBeforeAgentMs, reported here as startup. The two reviewers and two large-repo jobs are excluded from the writer success denominator.

| Id | Kind | Repo | Outcome | errorType | Duration ms | Agent run ms | providerWaitMs | startupMs | Receipt first try | Retries |
|---|---|---|---|---|---:|---:|---:|---:|---|---:|
| P4-A (original Run id unavailable) | builder | charGPT | previously integrated; test result unavailable | - | - | - | - | - | - | - |
| P4-D builder-1790673045912-99863e1d | builder | charGPT | integrated; 3 parity tests failed, later fixed | none | - | - | - | - | yes | 0 |
| P4-B (original Run id unavailable) | builder | charGPT | integrated; suite had inherited P4-D failures | none | - | - | - | - | yes | 0 |
| P4-C (original Run id unavailable) | builder | charGPT | integrated; suite had inherited P4-D failures | none | - | - | - | - | yes | 0 |
| debugger-1790688867550-8e9d65df (D1) | debugger | charGPT | completed; full pytest passed | none | 89149 | 82919 | 13 | - | yes | 0 |
| reviewer-1790689172440-16e2fb4d | reviewer | charGPT | completed; found TF graph/parity gaps | none | 270625 | 256505 | 21 | - | n/a | 0 |
| reviewer-1790689172440-94096049 | reviewer | charGPT | completed; found TF train validation gaps | none | 249575 | 235479 | 12 | - | n/a | 0 |
| debugger-1790689604167-5c19f059 (D2) | debugger | charGPT | completed; 2 new pytest failures (L-023) | none | 377949 | 370567 | 23 | - | yes | 0 |
| debugger-1790689604167-120ed45b (D3) | debugger | charGPT | completed; own tests passed, full suite retained D2 failures | none | 209504 | 202258 | 10 | - | yes | 0 |
| debugger-1790690320064-96ce8870 (D4) | debugger | charGPT | completed; full pytest passed | none | 91434 | 69546 | 14 | 21946 | yes | 0 |
| builder-1790690614859-305ab6aa (P5-A) | builder | charGPT | completed; full pytest passed | none | 301384 | 285956 | 12 | - | yes | 0 |
| builder-1790690614859-387eef03 (P5-B) | builder | charGPT | completed; 6 new pytest failures (L-024) | none | 340794 | 326069 | 29 | - | yes | 0 |
| debugger-1790691360510-9fda621d (P5-B fix) | debugger | charGPT | completed; full pytest passed | none | 150393 | 117504 | 18 | 33009 | yes | 0 |
| builder-1790691375221-f4dbb958 (P5-C) | builder | charGPT | completed; full pytest passed | none | 119067 | 77295 | 13 | 41873 | yes | 0 |
| reviewer-1790689518205-aed2b4ea | reviewer | PyTorch | completed; no snapshot-size refusal | none | 48523 | 42637 | 18 | - | n/a | 0 |
| builder-1790689664283-459d868b | builder | PyTorch | completed; one comment typo fixed | none | 116495 | 68758 | 22 | 47787 | yes | 0 |

**Metric 1, real writer success:** 12 real P4/P5 builder/debugger jobs in the migration: four P4 jobs already launched before the measurement and eight launched during it. For the timed cohort, bridge completion was **8/8 (100%)** with no terminal errorType, zero manual tool retries and 8/8 first-try preview receipts. The stricter immediate full-pytest gate was **5/8 (62.5%)**: D2 and P5-B introduced test failures; D3's full suite inherited D2's failures. All three failing gates were resolved in later debugger integrations; the final full pytest passed. The four prior jobs cannot be included in a timed or first-test-pass rate because their original records are not available. Reviewer findings were checked and turned into D2/D3 jobs; integration and pytest followed each applied patch.

**Metric 2, large-repo latency:** shallow/partial clone of PyTorch at 71d9ed2, C:\Users\10User\Desktop\bench-large: **22,708 tracked files, 5,253,949 text lines**, 280 binary files and 36 unreadable symlink/submodule entries in the local count. The scoped reviewer took **48,523 ms** total and 42,637 ms agent run; startupMs was not emitted. It was not rejected by snapshot safety, infrastructure, or worktree capacity limits. The one-line comment builder took **116,495 ms** total, 68,758 ms agent run and 47,787 ms pre-agent startup. The measured integration dry run took **29,099 ms** and apply **123,953 ms**, separately; the apply passed git diff --check. No build was run. The edit remains uncommitted in the benchmark checkout under that repository's CLAUDE.md instruction.

**Metric 3, cost per 1,000 ported lines:** **unavailable**. Neither parallel result text nor get_opencode_job with detail:true for queued jobs exposes input/output tokens, turn count, or per-job price; parallel Run ids cannot be queried as queue jobs. No monetary estimate was made. The eight timed writer jobs accumulated 1,532,114 agent-run ms and 1,121 added patch lines (from integration stats / git numstat, excluding migration-log lines); a *time-only proxy* is **22.78 agent minutes per 1,000 added patch lines**. That denominator includes tests and README, so it is not a ported-source-line cost.

Findings (exact error text is retained; causes marked operator guess were not checked in bridge code):

| ID | Problem | Cause | Fix | Commit | Status |
|---|---|---|---|---|---|
| B-020 | diagnose_opencode_bridge({cwd:"C:\\Users\\10User\\Desktop\\charGPT-python"}) omitted the preserved P4-B/C/D worktrees; diagnosticCoverage excludes parallel_runs. Manual git worktree list was needed to discover three patches that the requested diagnose path could not find. | Confirmed: diagnose read only queue records and the audit; parallel writers' worktrees were registered in `worktree_artifacts` (job_id = Run id) but that table was never read. | `diagnose` reports `retainedWorktrees` from the worktree registry with `owner` (queue, direct, parallel, unrecorded), `inFlight` (its job still runs: no integrate/remove advice) and a recovery action; summary counts `retainedWorktrees` and `inFlightWorktrees`. | c14aa7d | fixed, not deployed (`bridge/measurement-fixes`) |
| B-021 | get_opencode_job({cwd:"C:\\Users\\10User\\Desktop\\charGPT-python",jobId:"debugger-1790688867550-8e9d65df",detail:true}) returned "OpenCode queue job not found: debugger-1790688867550-8e9d65df". run_opencode_parallel also omitted startupMs for its reviewer/writer jobs, so the requested per-job detail could not be recovered. | Confirmed: the Run id existed only as a worktree name; no tool looked it up. Parallel results printed no startup figure because the job clock started after shared setup. | `get_opencode_job` falls back to the audit and the worktree registry and returns a `parallel_run`/`direct_run` view (status, timing, usage, retained worktree). `run_opencode_agent` uses one id for its audit record and its worktree. Parallel results print a `Timing ms` block with `sharedSetup`. | c14aa7d | fixed, not deployed (`bridge/measurement-fixes`) |
| B-022 | get_opencode_job({cwd:"C:\\Users\\10User\\Desktop\\charGPT-python",jobId:"debugger-1790691360510-9fda621d",detail:true}) and the analogous P5-C detail contained no token/usage/turn fields; parallel result text also gave no input/output tokens. The requested cost per 1,000 ported lines is unmeasurable. | Confirmed: OpenCode emits `step_finish` events with `tokens` and `cost`; the stream parser ignored them. Real run (PyTorch builder): steps=7 input=32148 output=1069 reasoning=982 cache_read=89367 cost=0 (the provider reports no price). | Usage is summed from `step_finish` (subagent sessions and retries/fallback attempts included) and reported in the result text (`Token usage`), queue records (`usage`), the compact line (`tokens=`) and the audit. Money stays unavailable while the provider reports cost 0; tokens per 1,000 lines are now measurable. | c14aa7d | fixed, not deployed (`bridge/measurement-fixes`) |
| B-023 | run_opencode_parallel P5-A/P5-B and other writer results contained stderr error.error="AI_APICallError: Rate limit exceeded. Please retry after a brief wait."; P5-B also contained error.error="AI_APICallError: Output token rate limit exceeded. Please retry after a brief wait." Yet those same results said "Provider warning type: none" and "Recovered transient provider error: no" and completed. The queued P5-B debugger result had the same rate-limit stderr. | Confirmed: the stderr classifier needs an authoritative marker and `\bAPIError\b` does not match inside `AI_APICallError`, so these lines were dropped before classification. | A line with the AI SDK marker (`AI_*Error`) alone counts only as a transient type (rate limit, transient, provider unavailable, transport), so it never stops a run live or fails one that answered; a run that answered reports `Recovered transient provider error: yes` with the type. `providerRetryWarningCount` counts the lines. | c14aa7d | fixed, not deployed (`bridge/measurement-fixes`) |
| B-024 | get_opencode_job({cwd:"C:\\Users\\10User\\Desktop\\charGPT-python",jobId:"debugger-1790690320064-96ce8870",detail:true}) reported durationMs 91434, agentRunMs 69546 and waitBeforeAgentMs 21946; its resultText said Duration ms 72559 and Agent run ms 66143. The PyTorch builder similarly showed queue durationMs 116495 / agentRunMs 68758 versus inner result Duration ms 55433 / Agent run ms 48087. | Confirmed: queue `agentRunMs` ran from supervisor spawn to `finishedAt`, so it included every post-agent phase (snapshots, validation, patch collection); the inner `Duration ms` covers `runOpenCode` only. | For finished jobs `agentRunMs` is the agent process alone (equal to `Agent run ms`) and `afterAgentMs` the post-agent work, from a per-job phase clock; the compact line prints `waitBeforeAgentMs=` like the JSON field; `Duration ms` says what it covers. | c14aa7d | fixed, not deployed (`bridge/measurement-fixes`) |
| B-025 | get_opencode_job detail for D4, P5-B debugger, P5-C and PyTorch builder showed waitBeforeAgentMs 21946, 33009, 41873 and 47787 respectively, while providerWaitMs was only 14, 18, 13 and 22. The job stage was starting_agent, but these long waits cost wall time before agent execution. | Measured with the new phase clock (PyTorch builder, cold process): before-agent 63.7 s = discovery attestation 15.4 s (cached for 30 min in a running bridge), worktree creation 24.7 s, attestation inside the new worktree 13.3 s (never cached: the key includes the new worktree path), final pre-spawn attestation 7.6 s, provider wait 30 ms. After the agent: patch collection 16.4 s (one full rehash). | Every job reports the phase split (`Timing ms` in the text, `phaseTimings` on queue records). Not changed: the three attestations and the worktree checkout; caching the in-worktree attestation by content is a security decision (see the follow-up section). Follow-up: the in-worktree attestation is cached by repository and base tree (speed-up option 3). | c14aa7d | fixed, not deployed (`bridge/long-run-hardening`) |
| B-026 | integrate_opencode_worktree dryRun:true for the one-line PyTorch header patch took 29099 ms; its reviewed apply with the exact previewReceipt took 123953 ms for a clean checkout and git diff --check validation. No progress breakdown exposed a reason for the roughly two-minute apply. | Measured: `git add -A` into a fresh temporary index re-reads every tracked file, about 15 s per call on 22,708 files; the dry run did it 2 times and the apply 10 times (7 target, 3 source captures). | `Integration timing` in the result (phase, ms, calls). Three repeats removed without weakening a check: the capture right after the receipt check (repeated by the final pre-apply capture) and the preliminary cleanup target/source checks (repeated by the final ones). Target and source captures of the first step run in parallel. Apply: 5 target + 2 source captures. Measured after: dry run 28.0 s, apply 115.9 s (was 29.1 s / 124.0 s); parallel hashing gained little on this disk (40.3 s of hashing in 28.0 s). Follow-up: target captures start from the target's own index and the back-to-back pre-apply repeat is gone (speed-up options 1 and 2). | c14aa7d | fixed, not deployed (`bridge/long-run-hardening`) |

End state: charGPT-python HEAD 2b2edfe, clean. P4-A/B/C/D and all P5-A/B/C are integrated; the D1-D4 and P5-B debugger fixes are integrated; final full pytest passed. Diagnose reported zero nonterminal jobs, active locks, provider leases, and unresolved integrations; its two failed jobs are historical queue records. No managed worktree from this run remains. One older Claude scratch worktree remains prunable in git worktree list. PyTorch benchmark checkout at C:\Users\10User\Desktop\bench-large remains at 71d9ed2 with only the one-line comment edit uncommitted. No bridge repository files other than this log were edited.

### Deep code review of the whole bridge (after the Phase 4 incident)

The user asked whether the system was now free of problems. It was not: eight parallel
reviewers read all of `server.js` (seven overlapping segments) and every `bin/` script, each
finding confirmed by re-reading the call paths and, where marked, reproduced in scratch
repositories. About 95 real defects, 13 of them HIGH. Fixes are written on six review branches
(`review/integration`, `review/integration2`, `review/queue`, `review/queue2`, `review/spawn`,
`review/bin`), each in its own worktree with its own test file (`tests/review-*.js`,
`bin/*.test.js`), then merged into `bridge/migration-fixes`. Every entry below is **fixed**:
each has a test that fails on the old code and passes now, and the whole suite (`npm test`,
`test:events`, `test:builder-fallback`, `tests/pipeline-*.js`) passes on the merged tree.
Merges: `204b886` integration (R-001..R-007), `bf96a02` bin (R-110..R-126), `0d73790` queue
(R-030..R-043), `a299993` spawn (R-080..R-107), `dcb86de` integration2 (R-010..R-029),
`75695ee` tools/pipelines (R-050..R-071), then `707dbce` (R-127..R-133 below). Not deployed
until the steps under "Deploying the review fixes" are done.

#### Integration: bytes, line endings, file modes (worst class: a patch applied in the user's checkout while the bridge reports failure, then quarantine)

| ID | Problem | Cause | Fix | Status |
|---|---|---|---|---|
| R-001 | Any patch touching a 100755 file failed `integration_post_apply_content_mismatch` on Windows (every patch on POSIX); rollback restored nothing (ownership check against the simulated snapshot) and recovery quarantined `affected_path_drift`. | The simulated post-apply fingerprint wrote the mode as `0o111`/`0` while the real snapshot wrote `mode & 0o111` on win32 (always 0) and `mode & 0o7777` on POSIX. Two encodings for one value. | One fingerprint-mode rule everywhere (exec bit only, always 0 on win32); symlink entries expected as plain files when `core.symlinks` is off. | fixed |
| R-002 | In a checkout cloned with the default `core.autocrlf=true`, the isolated apply fell back to a 3-way merge and wrote conflict markers into the user's file (reproduced); clean CRLF files showed as modified to bridge git after a timestamp change (`dirty_worktree_requires_checkpoint` on a clean tree); bridge worktrees were LF. | `buildTrustedGitEnv` sets `GIT_CONFIG_NOSYSTEM=1` / `GIT_CONFIG_GLOBAL=NUL`, which also drops `core.autocrlf`, `core.eol`, `core.safecrlf`; the temporary index seeded by `read-tree` has no stat data. | Read the user's effective EOL settings once with a plain environment and enforce them with `-c` in every bridge git call; never let `--3way` write into the real tree (hard failure + pre-image restore). | fixed |
| R-003 | Non-UTF-8 bytes (Latin-1/CP1252 sources) were replaced by U+FFFD in the patch; simulation and apply used the same corrupted patch, so the integration "succeeded" with different bytes on disk. | `runCommand` decodes stdout as utf8; the patch travelled as a string. | Diff as a Buffer, hash and write the Buffer; decode only for the preview. | fixed |
| R-004 | After a failed validation, rollback wrote LF bytes into CRLF files and reported success; recovery then classified the file "third" and quarantined. | `restoreFromGitHead` used `git cat-file blob` (no EOL conversion) for clean tracked files. | Restore from the journal's exact pre-image, else `git cat-file --filters`. | fixed |
| R-005 | Crash recovery of a patch that adds a new text file quarantined on Windows. | CRLF tolerance required an `ls-files --eol` record; a new file has none. | Tolerate a missing record for untracked files / journal the owned post-apply fingerprint. | fixed |
| R-006 | `replaceRollbackLeaf` deleted the target before writing the replacement. | Wrong order. | Write temp, then rename over. | fixed |
| R-007 | Bridge `git log` could run a repo-local `gpg.program` (reproduced); `core.fsmonitor`, `diff.external`, `pager`, `log.showSignature` were not on the denylist. | Incomplete `unsafePattern` and enforced config. | Extended denylist; `-c log.showSignature=false -c gpg.program= -c core.pager=cat`. | fixed |

#### Integration: journal recovery and locks

| ID | Problem | Cause | Fix | Status |
|---|---|---|---|---|
| R-010 | `git add unrelated.md` or an unrelated commit by the other client while an operation was unresolved quarantined the repository (`target_head_or_index_drift`), and nothing requalified it. Same class as B-012, for the index. | Recovery compared the SHA of the whole `ls-files --stage` and required an identical HEAD. | Per-affected-path index evidence in the journal; HEAD moves accepted when the affected paths did not change; requalification extended to this reason. | fixed |
| R-011 | Transient errors during recovery (git timeout, EBUSY on a file, SQLITE_BUSY, a failed restore) became a permanent quarantine labelled `journal_evidence_unreadable`. | One catch-all treated "evidence unavailable" as "drift proven". | Transient errors leave the operation non-terminal and retryable; distinct reasons for restore vs decode failures. | fixed |
| R-012 | A serial-integration lock refused because of a pending recovery was reported as `integration_lock_conflict` with "wait" advice; the inline recovery call was unreachable. | `integratePatchSerially` overwrote the error type. | Recover once and retry; pass through `integration_recovery_pending` with operation id and a real next step. | fixed |
| R-013 | `diagnose_opencode_bridge` never showed the integration journal or the blocked roots, while the queue pointed operators at it. | Missing section. | `integrationOperations` and `blockedRoots` sections. | fixed |
| R-014 | `list_agent_locks` threw `RangeError: Invalid time value` whenever a containment-quarantined lock existed; `ttlMs` had no upper bound. | `expires_at = MAX_SAFE_INTEGER` fed to `toISOString`. | Safe formatter; `ttlMs` max and clamp. | fixed |
| R-015 | `acquireHardLock` could report failure after COMMIT (post-commit `listLocksFromDb` threw SQLITE_BUSY), orphaning the lock for its TTL; same in `releaseHardLock`. | Fallible work after the transaction, inside the same catch. | Collect the list inside the transaction / separate try. | fixed |
| R-016 | `acquire_agent_lock` with `agent: "integration_recovery"` bypassed the recovery block. | The exemption keyed on a caller-controlled name. | Internal-only authority flag; reserved names rejected. | fixed |
| R-017 | An in-flight heartbeat pulse could turn a containment quarantine back into an expiring lease. | `UPDATE ... WHERE expires_at > now` matched MAX_SAFE_INTEGER. | Exclude quarantined rows; `stop()` awaits the pulse. | fixed |
| R-018 | Cleanup in `finally` (`rm`, `releaseHardLock`) could replace a committed integration result with an exception. | Unguarded calls. | Guarded and logged. | fixed |
| R-019 | A staged rename hid the deletion of its source from scope/forbidden validation (reproduced); `readOnlyHeadMove` had the same gap. | `git diff --name-only` without `--no-renames -z`. | `--no-renames -z` everywhere. | fixed |
| R-020 | A non-fast-forward HEAD move (`commit --amend`, `pull --rebase` by the user) still failed read-only jobs. | `--is-ancestor` failure returned null. | Any HEAD move is accepted for read locks. | fixed |
| R-021 | Ignored-file metadata drift (an IDE rewriting `.idea/workspace.xml`, a log appended) failed integrations; a large `node_modules` made the ignored listing exceed 30 MB and every snapshot fail closed. | `gitChangedFileSnapshot` fingerprinted ignored files by mtime and listed them file by file. | Ignored entries excluded from the checks that decide failure; `--directory` for the listing. | fixed |
| R-022 | Any `__pycache__`/`.pytest_cache`/`node_modules` in a worktree blocked its integration (`integration_source_unrepresentable`) and the error listed every path. | `rejectIgnoredSource` did not use the regenerable-directory grouping. | Tolerate regenerable groups; cap the list. | fixed |
| R-023 | Branch-mode integration used a two-dot `HEAD..branch` diff (reverting target commits made after the fork) and an unqualified ref; a failed `--name-only` gave `changedFiles = []`, so a non-empty patch got a journal with zero files and recovery closed it `recovered_noop` while the patch stayed applied. | Wrong base; fail-open on exit code. | `merge-base` and `refs/heads/`; fail closed; refuse a zero-file journal for a non-empty patch. | fixed |
| R-024 | Repositories with more than 25,000 tracked files could never integrate. | `captureGitIndexIdentity` applied the changed-file cap to all index entries. | Hash the index without an entry cap. | fixed |
| R-025 | Paths like `..cache/x` were rejected as symlink escapes. | `relative.startsWith("..")`. | Exact `..` segment check. | fixed |
| R-026 | `diffStatFromPatch` under-counted (`-- ` SQL comments taken as headers); stat previews were still capped by the full-preview size. | Header detection after the first hunk; cap not conditional. | Headers only before the first `@@`; cap only for full previews. | fixed |
| R-027 | `cleanupWorktree` reported a retained branch that no longer existed (incident class B-011). | `show-ref` failure treated as "identity unknown". | `already_absent`. | fixed |
| R-028 | Any EPERM/EBUSY while measuring an unregistered worktree directory failed the job. | Walk error escaped `reserveWorktreeArtifact`. | Per-entry catch. | fixed |
| R-029 | Integration-vs-writer conflict decisions used this process's `worktreeMode`, not the writer's. | The lock row did not record whether the writer edits the checkout. | `edits_checkout` on the lock row. | fixed |

#### Queue, leases, scheduler, startup recovery

| ID | Problem | Cause | Fix | Status |
|---|---|---|---|---|
| R-030 | After the laptop slept for more than 60 s (or 4 heartbeat failures), a pending job stayed `pending` with no reason while the scheduler looped at 0 ms; a running job's row stayed `running` forever; recovery skipped both. | Every update required `lease_expires_at > now`; the current owner could never re-take its own expired lease although generation + revision prove nobody else did; `nextQueueScheduleDelay` returned 0 without progress. | Same-owner re-acquire; terminal commit fenced by generation + revision instead of the lease; stale rows dropped from `QUEUE_JOBS`; non-zero delay without progress. | fixed |
| R-031 | A pipeline whose lease lapsed was stuck: every update failed `pipeline_concurrent_update`, the claim returned `owner_lease_active` because the owner (itself) was alive, `pipelineOwnershipLost` was never read. | `claimPersistedPipeline` required an unexpired lease even for the same instance and generation. | Same-generation re-claim; heartbeat retries it; otherwise the record leaves `PIPELINE_RUNS`. | fixed |
| R-032 | A queued writer blocked by a direct run's lock or an unresolved integration re-ran agent discovery and attestation every 2 s (hundreds of opencode processes over a 30-minute lock) and showed `queue_lock_conflict` instead of `integration_recovery_pending`; permanent refusals retried forever. | `findQueueWriteConflict` looked only at queue records; the execution path relabelled every lock error. | Hard locks and journal operations checked before the claim; error types preserved; permanent refusals fail; bounded backoff. | fixed |
| R-033 | A failed persist of the `blocked` state left a `running` record with no worker, holding a capacity slot forever. | Return value ignored. | Checked; cancelled or abandoned. | fixed |
| R-034 | A transient error writing the terminal record turned a completed job into `failed` and lost its result evidence. | One try/catch around execution and persistence. | Separate catch; bounded retries; evidence kept. | fixed |
| R-035 | A concurrent-update rejection overwrote the in-memory pipeline with the redacted durable summary, which a later write persisted. | `Object.assign(record, authoritative)` with the summary. | Copy only status/revision/owner fields. | fixed |
| R-036 | Contractor idempotency retries always conflicted. | The random `internalQueueJobId` was inside the fingerprint. | Excluded. | fixed |
| R-037 | Unique-constraint errors were never recognised (`SQLITE_CONSTRAINT_UNIQUE` never matches node:sqlite's `ERR_SQLITE_ERROR`/errcode 2067). | Wrong error code check. | errcode 2067 / message match. | fixed |
| R-038 | Re-summarising a scope contract reset its validation fingerprint to sha256(""). | Summary of a summary. | Keep existing fingerprint fields. | fixed |
| R-039 | Deferred recovery ran source cleanup at the same time as the live finalizer (double `worktree remove`, CAS failures after passed gates). | The recovery loops did not check `FINALIZING_PIPELINE_IDS`; the claim returned ok for the instance's own live pipeline. | Skip finalizing / already-owned pipelines. | fixed |
| R-040 | While an ordinary integration ran in the other process, background recovery added the repository to the blocked roots and told writers "a quarantined integration blocks writers" (false); quarantined-only repos took a repo-wide lock every 5 s. | `integration_recovery_lock_conflict` treated as blocked; no backoff. | Lock conflict = unknown, retry later; live operations skipped; backoff for quarantined-only repos. | fixed |
| R-041 | A failed database scan (SQLITE_BUSY at the 250 ms deferred timeout) unblocked quarantined roots for one pass; roots compared case-sensitively on Windows. | Pruning from an incomplete candidate list. | Roots tracked per database; one normaliser. | fixed |
| R-042 | `verifyReleaseIntegrity` fell back to `__filename` (undefined in ESM) and hashed the importer when imported. | `process.argv[1] \|\| __filename`. | `BRIDGE_SERVER_PATH`. | fixed |
| R-043 | Launching through a junction/symlink or as `node server` silently exited 0 ("connection closed"); full startup recovery ran before the MCP handshake; a non-ENOENT `readdir` error crashed startup. | `BRIDGE_RUN_AS_MAIN` compared `path.resolve` with a realpath; connect after recovery. | Realpath comparison; connect first with a bounded startup promise. | fixed |

#### Tool handlers, pipelines, parallel runs

| ID | Problem | Cause | Fix | Status |
|---|---|---|---|---|
| R-050 | One failed `integrate_opencode_worktree` call, a dry run included (flagged secret lines, dirty target, lock conflict, missing `reviewed`), marked a pipeline item `rejected` for good; the pipeline could only be abandoned. | Any `!result.ok` → `rejected`; the merge kept it; only pending/integrating items may be integrated. | Dry runs never change status; retryable outcomes go back to pending; `quarantined` only for the item's own operation; quarantined items re-checked against the journal. | fixed |
| R-051 | A pipeline writer that changed nothing blocked finalization forever (`pipeline_pending_integrations`); `get_opencode_job` advertised a deleted worktree. | The empty worktree was removed but its path stayed on the record; the merge built a pending item for it; `noChanges` was never set. | `worktreePath` cleared and `noChanges` set; merge skips it; `no_changes` counts as integrated; the parallel path removes empty worktrees too. | fixed |
| R-052 | Finalization failed terminally when the final validation touched an ignored cache (`.coverage`, `__pycache__`), when an IDE wrote an ignored file during a gate, or on a transient gate error (rate limit, lost read lock). Same class as B-012. | Whole-repo comparisons with ignored-file metadata; every failure set `failed`. | Compare tracked state only; drift and infrastructure errors return to `awaiting_finalization`. | fixed |
| R-053 | `run_opencode_agent` ignored `allowFallbackToBuild`, `subagentStrategy`, `proxyAgent`. | Destructured, never copied into the job. | Copied. | fixed |
| R-054 | `enqueue_opencode_job`'s assessment still treated a reader as locking the whole repository (L-015 fixed the scheduler, not the handler) and could report a writer as conflicting with itself. | No `scopeContract`/`jobId` passed. | Passed. | fixed |
| R-055 | `create_multi_agent_pipeline` defaulted a job's missing `cwd` to the bridge's own directory (`pipeline_multi_repository_unsupported`). | `process.cwd()` fallback. | Pipeline cwd; children in another project rejected. | fixed |
| R-056 | A read-only job failed as "read-only agent edited files" when the user committed a dirty file, tests wrote `coverage/`, or an editor saved during the review; the head-move tolerance was skipped whenever any file differed. Same class as L-020. | Reader `changedFiles` = diff of two working-tree snapshots including ignored files. | For attested read-only agents, external drift is reported, not failed; head move always consulted. | fixed |
| R-057 | Concurrent integrations on one pipeline overwrote each other's `integrationQueue`; finalize/refresh never re-read the journal after a crash. | Patch computed from a stale in-memory record. | Patch applied against the current record; reconcile at finalize and refresh. | fixed |
| R-058 | `executeOpenCodeJob`'s `finally` could throw before stopping the lock heartbeat, leaving the path lock renewed until the process exited. | Measurement before release. | Release first; measurement guarded. | fixed |
| R-059 | `get_opencode_job` showed a stale `runStage`/timing in sqlite mode. | Values from `record_json`. | Recomputed. | fixed |
| R-060 | `validate_delegation_plan` accepted parallel plans that `run_opencode_parallel` rejected; the slot check ignored provider keys. | Capacity check missing / total count. | Capacity check by provider key. | fixed |
| R-061 | Cancelling a pending pipeline child through the local path skipped pipeline reconciliation and ignored the persist result. | Missing calls. | Added. | fixed |
| R-062 | Parallel writers in two different repositories with the same relative path were rejected as overlapping. | Overlap check without cwd. | cwd-aware. | fixed |
| R-063 | Real paths containing `[`, `]`, `{`, `}`, `!` (Next.js `app/[slug]`) were rejected as wildcards. | `hasAmbiguousPathPattern`. | Literal existing paths accepted. | fixed |
| R-064 | Rotating the contractor authorization hash did not revoke queued contractor jobs. | Internal proof not bound to the hash. | Bound. | fixed |
| R-065 | The parallel group deadline (`max timeout + 60 s`) left no time for validation commands or read-only retries: a builder finishing at minute 27 of 30 had its 5-minute validation aborted. | Deadline excluded those budgets. | Included; reported. | fixed |
| R-066 | A throw in the post-run snapshot of `run_opencode_parallel` lost every job result and Run id. | No catch around the group-scope loop. | Per-cwd catch. | fixed |
| R-067 | Misleading parallel text ("rollback was attempted" when it was not; `before_wave` failures without a `JOB n` prefix / Run id). | Text. | Fixed. | fixed |
| R-068 | `finalizePipelineSourceCleanup` never recognised a registered worktree on Windows. | `git worktree list` prints forward slashes; compared with `path.resolve`. | Normalised. | fixed |
| R-069 | Finalize `dryRun` persisted a status change and took the repository read lock. | Refresh persisted before the dryRun check. | In-memory refresh; no lock. | fixed |
| R-070 | After a crash, cleanup recovery kept every authorized worktree when one item had finalized retained. | Exact-count match. | Per-item match. | fixed |
| R-071 | With `worktreeMode=all`, pipeline gates reviewed a fresh worktree from HEAD instead of the integrated checkout; the fixed gate jobId reused a branch name. | Gate jobs went through the worktree path. | Gates forced into the checkout; per-attempt jobId. | fixed |

#### Agent spawn, providers, environment, path helpers

| ID | Problem | Cause | Fix | Status |
|---|---|---|---|---|
| R-080 | A caller-supplied `modelRequirement.variant` starting with `-` became an extra option to `opencode run` (`--attach=`, `--file=`, `--agent=`). | Loose regex; `["--variant", value]` as two argv items. | Strict charset; `--variant=` single token. | fixed |
| R-081 | With a model override or the builder fallback, the provider slot was taken on the profile's provider, not the one that ran (Gemini over-subscribed). | Lease key computed before the override was applied. | Key from the overridden metadata. | fixed |
| R-082 | Ordinary 429 rate limits ("check your plan and billing details") were classified as billing errors: the run was killed and not retried. | Billing regex matched before the rate-limit check; text overrode the status code. | Status code first; 429/RESOURCE_EXHAUSTED = rate limited. | fixed |
| R-083 | Forbidden globs with `?`, `[..]`, `{..}` or a leading `**/` never matched, so forbidden edits were accepted. | `globToRegex` escaped those characters; `**/x` required a slash. | Full glob translation. | fixed |
| R-084 | Plugin integrity checked `~/.cache/opencode` while OpenCode loaded from `$XDG_CACHE_HOME`. | Hard-coded root. | `DEFAULT_OPENCODE_CACHE_HOME`. | fixed |
| R-085 | Waiting for a provider slot consumed the agent's run timeout (a builder that waited 25 of 30 minutes was killed as `agent_timeout` and blamed). | One budget for both. | Separate wait budget; `provider_slot_wait_timeout`. | fixed |
| R-086 | Non-ASCII text in agent output (Arabic, emoji) was corrupted when a multi-byte character was split across pipe reads; stderr fail-fast classified partial lines. | `chunk.toString()` per chunk. | `StringDecoder` per stream; line buffering. | fixed |
| R-087 | The tail of stdout could be dropped when the control-channel `exit` arrived first. | Result settled on `exit`; later data ignored. | Finish on `close` with a bounded fallback. | fixed |
| R-088 | Binary hunks in `.go`, `.rs`, `.pem`, … files passed the preview gate unread and skipped the secret scan. | Allow-list of text extensions. | Reject binary hunks unless a known-binary extension or an explicit flag. | fixed |
| R-089 | Edits inside `.git/` (hooks, config) were neither forbidden nor detectable. | Not in `DEFAULT_FORBIDDEN_EDIT_PATHS`; `git status` never lists `.git`. | Forbidden; control-surface fingerprint. | fixed |
| R-090 | `VAR=""` parsed as 0 (progress heartbeats off); unknown choice values fell back silently (`WORKTREE_MODE=writes` → `off`). | `Number("")`; no validation. | Blank = unset; invalid choice = startup error. | fixed |
| R-091 | One transient sqlite error during a provider-lease renewal killed the running agent. | Pulse catch returned false. | Fail only past the confirmed deadline. | fixed |
| R-092 | A containment quarantine was never written when the lease had already expired, freeing the slot while the process tree might still run. | `UPDATE ... WHERE expires_at > now`. | INSERT a quarantine row. | fixed |
| R-093 | Windows PID reuse could hold a containment quarantine indefinitely or misattribute processes. | Bare PIDs. | Creation time recorded and compared where available. | fixed |
| R-094 | The launch gate's `authority.ok === false` was ignored. | Only thrown errors blocked launch. | Treated as a gate failure. | fixed |
| R-095 | `validationCommand` guards could be bypassed (`node -p`, `--eval=`, `npm create`, `bunx`) and rejected valid commands (any argument equal to `x`/`exec`/`dlx`). | Position-insensitive checks. | Position-aware checks; interpreter option regex. | fixed |
| R-096 | Symlinked executables (Homebrew, nvm, Nix) were rejected; one bad PATH entry failed validation with an "untrusted" error. | Symlinks skipped; non-ENOENT errors thrown. | realpath; ENOTDIR/EACCES skipped. | fixed |
| R-097 | Provider status showed the wrong capacity ("capacity 4, 6 leases"); `LIKE` without `ESCAPE`. | Capacity read for the base key. | Per provider key. | fixed |
| R-098 | A bare `DEPENDENCY_REQUIRED` heading swallowed the next line and failed a finished job. | `\s+` matched newlines. | Single-line regex. | fixed |
| R-099 | A single read-only timeout was reported as "unavailable after 3 attempts". | Attempt count not tracked. | Real count; `agent_timeout` kept. | fixed |
| R-100 | `subagentStrategy: "direct"` could never succeed although the error message advertised it. | Actual mode not passed. | Works or removed. | fixed |
| R-101 | JSON files with a UTF-8 BOM (PowerShell 5.1 output) failed to parse with a confusing error. | No BOM strip. | Stripped after hashing. | fixed |
| R-102 | `allowedEdits: ["src/cli/*"]` silently widened to `src/cli/**`. | `normalizeLockPath` stripped `/*`. | Only `/**` stripped. | fixed |
| R-103 | Agents saw lower-cased paths when the caller gave absolute paths (the bug `pathSpeller` exists to prevent). | Key mismatch (absolute vs relative). | Relative keys. | fixed |
| R-104 | Long prompts failed on Windows (32,767-char command line) as `agent_exit_nonzero` with empty stderr. | Prompt as argv; `spawn_failed` not propagated. | `prompt_too_long`; spawn error code propagated. | fixed |
| R-105 | Repositories with their own `opencode.json` plugin config were rejected although OpenCode never loads it (`OPENCODE_DISABLE_PROJECT_CONFIG`). | Scan of a disabled config. | Skipped with a log line. | fixed |
| R-106 | The managed profile's `variant` was carried onto a different overridden model. | Fallback to `metadata.variant`. | Override's variant only. | fixed |
| R-107 | `timeoutMs` had no upper bound; huge values failed as a supervisor protocol error. | No `.max()`. | Bounded. | fixed |

#### Operational scripts (`bin/`)

| ID | Problem | Cause | Fix | Status |
|---|---|---|---|---|
| R-110 | The builder model fallback could never fire on Windows (a rate-limited muse-spark builder just failed). | Eligibility required `treeTerminationConfirmed === true`, which the Windows supervisor never reports; the unit test hard-coded `true`. | Windows-contained terminations are eligible; tests use the real Windows shape. | fixed |
| R-111 | The supervisor could `taskkill /T /F` a reused PID and its tree up to 45 minutes after the payload exited, and report success. | Only `close` was observed; PIDs probed after exit. | `exit` recorded; no kill by PID after exit. | fixed |
| R-112 | A Windows termination was reported contained while the payload's pipes were still open (an orphaned grandchild alive). | `taskkill` exit 0 short-circuited the pipe check. | Direct child close required. | fixed |
| R-113 | In working-tree mode `release:activate` used `C:\Users\10User` as the releases root: it would build `server-daily-*` there and `--prune` would delete every `server-*` entry in the home directory. | `dirname(dirname(server.js))`. | Fixed releases root; a release needs `release-manifest.json`. | fixed |
| R-114 | `--sync-clients` exited 0 when the Claude entry was not updated or was deleted (remove-then-add); `claude.exe` was not probed. | Failures returned as text. | Non-zero exit; old entry restored on failure; identical entries skipped. | fixed |
| R-115 | A failed config restore after a bad smoke deleted the release the live config pointed at. | `finally` removed the candidate whenever `activated` was false. | Delete only when the live config provably does not reference it. | fixed |
| R-116 | `--sync-clients` re-pinned a modified immutable-release `server.js`. | No manifest check. | Refused unless the hash matches the manifest. | fixed |
| R-117 | The doctor said "healthy" with a stale plugin-manifest pin or a stale Claude entry; a server.js mismatch threw a stack trace. | Checks missing. | Manifest and Claude checks; structured failures. | fixed |
| R-118 | `gc:apply` could `rm -rf` unintegrated writer worktrees and live databases when the repository was on an unplugged drive, invisible from an elevated shell, or renamed. | Orphan classification on one `existsSync`, before activity and dirt checks. | Activity, dirt, age and lease checks. | fixed |
| R-119 | Four scripts silently skipped `main()` when run through a junction (verified: `--self-test` printed nothing and exited 0, so `npm test` could pass without running them). | `path.resolve(argv[1])` vs realpath. | Realpath comparison; self-tests print "ok" and fail when nothing ran. | fixed |
| R-120 | Full activation froze uncommitted working-tree edits into an "immutable" release without warning (today's second-session scenario). | No dirty check. | Refused unless `--allow-dirty`. | fixed |
| R-121 | `rewriteConfig` missed TOML headers with trailing comments or `[[...]]` and could overwrite another server's `args`. | Header regex. | Fixed; other entries asserted unchanged. | fixed |
| R-122 | `sync-managed-runtime` pushed whatever tree it ran from into the live runtime, non-atomically. | Default source = own tree; `copyFile` in place. | Pinned tree as default; temp + rename. | fixed |
| R-123 | `pipeline-admin` exited 0 for "pipeline not found". | No isError. | Failure. | fixed |
| R-124 | A GC registry repair could abort `--apply` midway and lose the record of deletions. | Outside `try`; no busy timeout. | Guarded; timeout. | fixed |
| R-125 | `state-audit` said healthy with stuck integrations or lease-less running jobs. | Not checked. | Strict-mode failures. | fixed |
| R-126 | The supervisor never emitted the spawn error code (ENAMETOOLONG, ENOENT). | Recorded, not sent. | Sent. | fixed |

#### Found while merging the review branches (each branch was right alone, wrong together)

| ID | Problem | Cause | Fix | Status |
|---|---|---|---|---|
| R-127 | After the merge, recovery's check that no commit since the recorded HEAD touched the affected paths was always true, so a HEAD move that did change them would have been accepted. | review/queue2 set `GIT_LITERAL_PATHSPECS=1` on all bridge git; review/integration2 passed the paths as `:(literal)path`, pathspec magic that setting disables (verified: matched nothing). | Plain paths (literal is already the default). Covered by D1's `committedChanges` assertion. | fixed (`75695ee`) |
| R-128 | Forbidden-looking ignored files (`.env`, `*.pem`, `*.key`, `secrets/`) inside a collapsed ignored directory silently dropped out of every snapshot. | The same setting disabled the `:(glob,icase)` pathspecs used to list them. | Selected with `ls-files -o -i -x <pattern>` (gitignore exclude patterns, not pathspecs). Test M2 plus the self-test `.env` case. | fixed (`75695ee`) |
| R-129 | A job on a real file named like a pattern (`app/[slug]/page.tsx`) passed its plan checks and then had every lock refused. | review/queue2 taught the plan checks to accept existing literal paths, but `acquireHardLock` and the queue's copy of its rules called `hasAmbiguousPathPattern` without a cwd. | Both pass the project root. Test M1. | fixed (`75695ee`) |
| R-130 | A writer that rewrote `.git/config` or added a hook still passed every check. | The fix for R-089 added `gitControlSurfaceFingerprint` and the deny rules but no caller. | Single and parallel write jobs compare it before/after the agent and after validation; a change fails with `git_control_surface_modified`. Test M3. | fixed (`707dbce`) |
| R-131 | The pipeline job schema still accepted `subagentStrategy: "direct"` and an unbounded `timeoutMs`. | Outside the branch that fixed the main job schema (R-100, R-107). | Same bounds as the job schema. | fixed (`707dbce`) |
| R-132 | Status and diagnose still showed one capacity against every provider's leases. | R-097 fixed the snapshot, not its display. | Slots shown per provider key. | fixed (`707dbce`) |
| R-133 | The review tests were written but `npm test` did not run them. | New test files, old script. | `npm test` runs every `tests/review-*.js` and `bin/*.test.js`. | fixed (`14cb4b3`) |

#### Deploying the review fixes (each step needs the user's explicit approval)

1. `git merge --ff-only bridge/migration-fixes` in the live tree, then `node bin/release-activate.js --sync-clients` (it now exits 1 when the Claude entry is not brought in line).
2. `node bin/sync-managed-runtime.js --apply`: the builder and debugger profiles gained the `.git` deny rules and must equal `DEFAULT_FORBIDDEN_EDIT_PATHS`, or writer attestation rejects them.
3. Codex `tool_timeout_sec` 3900 is shorter than the longest job now that the provider-slot wait has its own budget: 20 min wait + 45 min builder + 15 min validation + 5 min = 5100 s. Raise it to 5100, or set `CODEX_OPENCODE_PROVIDER_WAIT_MAX_MS` in both clients (a shorter wait fails sooner with `provider_slot_wait_timeout`).
4. Restart Claude and Codex, then check the startup SHA in `get_opencode_bridge_status`.

Behaviour changes to expect: binary hunks outside known binary types need `acceptBinaryHunks: true`; `subagentStrategy: "direct"` is refused; an unknown value in a choice environment variable stops the bridge at startup (the current values in both clients were checked); queued contractor jobs minted before the upgrade lose their internal proof (the proof is now bound to the authorization hash); `release:activate` builds releases under `<state dir>/releases` when the entry runs a working tree.

Known limits left on purpose: allowed binary types (png, pdf, fonts, ...) are not secret-scanned; a quarantine whose affected files are still at the patched content stays quarantined until inspected (that is the evidence the quarantine protects); on POSIX a process-group PID reused within a few milliseconds of the group emptying could still be signalled.

### Phase 4 incident: the whole repository was quarantined by one failed integration

| ID | Problem | Cause | Fix | Commit | Status |
|---|---|---|---|---|---|
| B-012 | A failed integration of P4-D put the charGPT repository in quarantine (`repository_state_drift`). Every integration, every writer lock and every queued job on it stopped. | The apply was rejected because another process wrote a file during it (see B-013), and the bridge rolled back cleanly. Recovery then compared the whole target state, ignored files included, saw that the other file had changed, and quarantined. HEAD, the index and the patched path were all back at their pre-patch state. | Recovery closes the operation as `recovered_noop` (or `rolled_back`) when HEAD, the index and every affected path are at their preimage, whatever else changed; the result records `externalDriftOutsidePatch`. Quarantines left by the old rule (`repository_state_drift`) are re-checked under the integration lock on the next recovery and closed when that still holds, so the stuck operation clears itself after deploy and restart. | `964bfad` | fixed (in the live tree since `727ca74`) |
| B-013 | The P4-D apply failed with `changed_file_validation_error` on `.claude/orchestrator.lock`. | The orchestrator kept a heartbeat loop that rewrote its lease file inside the repository every 2 minutes. `TaskStop` killed the tool shell but not its `bash.exe` child on Windows, so the loop kept writing, once during the apply. | The rejection now names the file and says another process wrote it (a background loop, a test run, an editor), to stop it, dry-run again and apply with the new receipt. | `964bfad` | fixed (in the live tree since `727ca74`) |
| B-014 | While the repository was quarantined, a queued read-only reviewer stayed `pending` for more than 4 minutes with no reason, although its assessment said `can_run_immediately`. | The scheduler skipped every job of a blocked repository, readers included, and wrote nothing on the record. | Readers are scheduled while the journal is blocked (they do not mutate the checkout); held writers become `blocked` with `integration_recovery_pending` and a reason that points to `diagnose_opencode_bridge`. | `964bfad` | fixed (in the live tree since `727ca74`) |
| B-015 | The orchestrator's lease file (added for L-021) caused B-013. | A lease inside the repository is a file the bridge watches; a background loop to refresh it outlives `TaskStop` on Windows. | Rule: the orchestrator lease lives outside the repository, is refreshed only inline on each poll, and no orchestrator starts background loops. To be written into `.claude/agents/migration-orchestrator.md` when the charGPT repository is unblocked. | - | rule (pending doc change) |
| B-016 | `TaskStop` on a background shell does not stop the programs it started (Windows). | Claude Code harness behaviour on Windows (child processes are not in a job object). | Rule: never start long-running loops from an agent; if one was started, find and kill its process by PID. | - | rule |
| B-017 | The live bridge tree had uncommitted edits from another Claude session (pipeline finalization `GATE_VERDICT` gates, `ip-address` bump), so `git merge --ff-only` refused and the on-disk `server.js` no longer matched the pinned hash (a client restart would have failed the integrity check). | Two sessions edited the live tree; one did not commit. | The edits were reviewed and verified (`npm test`, `test:events`, `test:builder-fallback` all pass); they are committed as their own commit, then `bridge/migration-fixes` is rebased on top. Rule: bridge edits happen only in a worktree on a branch, never in the live tree, and every session commits before it ends. | `4dedea0` | fixed |
| B-018 | `run_opencode_parallel` runs are invisible to `list_opencode_jobs`, the direct-run audit and `diagnose`; while one runs, only the provider lease count shows it. | Parallel runs are a synchronous barrier by design and are excluded from both stores. | Each parallel job gets a direct-run audit record (`kind: parallel`) under its Run id, written before the agents start and finished with status, error type, timing and usage; a job with unsafe changed files is `failed`. `diagnose` counts and lists them with the direct runs. | c14aa7d | fixed, not deployed (`bridge/measurement-fixes`) |
| B-030 | After the review deploy the user restarted both clients, yet every running bridge (4 Claude sessions, 3 Codex bridges) still ran the old `server.js` (`f2422f2a…`), and `get_opencode_bridge_status` said "healthy". The synced builder/debugger profiles already carried the new `.git` deny rules, which the old code's attestation does not expect. | Closing the Claude window does not end its Code sessions (their `claude.exe` and the bridge under it stay alive), and Codex's `app-server` keeps its bridges. Status printed only the startup hash, so a restart that did not happen looked like one that did. | Status compares the startup hash with `server.js` on disk: a difference prints the process start time and a restart warning and makes the status "attention required"; `diagnose_opencode_bridge` reports `bridgeProcess` (`startupSha256`, `onDiskSha256`, `stale`). Self-test covers changed, unchanged and unreadable files. Verifying a restart: status must say "Bridge source on disk: same as at startup". | fixed (bridge-fixes, not deployed) |
| B-019 | The first concurrency test ran 4 builders at once (limit raised 2 -> 4): all four overlapped and finished in 3 to 4.3 minutes with no provider rate limit. | - | `CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT = "4"` in both client configs (backups `*.bak-20260929-conc`). | config | fixed |

### Phase 3 findings (fixes in `994daa3`, deployed, active since the restart)

| ID | Problem | Cause | Fix | Status |
|---|---|---|---|---|
| L-020 | A finished read-only review was marked `failed` (`repository_head_changed_during_execution`) and looked lost because the orchestrator committed during it. | The HEAD check did not tell a reader from a writer; read-only agents cannot commit. | A reader whose HEAD moved forward completes, with a `Repository HEAD moved during this read-only run` line listing the commits and whether they touched its read scope (`readOnlyHeadMove`). Writers and non-fast-forward moves still fail. Rule: no commits while a review of the same checkout runs. | fixed |
| L-015 | Enqueue told a reviewer it `must_wait` for an unrelated writer, then ran it at once. | The enqueue check built its candidate without the scope contract, so a reader with no locked paths counted as the whole repository. | The check uses the reader's read scope, as the scheduler does, and names the overlapping paths. | fixed |
| L-016 | Every queued job waited about 10 s (writers up to 30 s) before its agent started, shown as `waiting_for_provider_slot`. | Measured: the pre-spawn role attestation runs `opencode debug agent` and `opencode debug skill`, 3-4 s each; not a slot wait. | Stage renamed `starting_agent`; `startupMs` and `providerWaitMs` separate the two. The attestation stays (security). | fixed (explained) |
| L-018 | Parallel results gave only `Duration ms`. | - | `Agent run ms` (agent process only) next to `Duration ms` in direct and parallel results. | fixed |
| L-019 | `get_opencode_job` returned about 5k characters for a running job. | Full record by default. | Essential fields and result text by default; `detail: true` for the full record. | fixed |
| B-011 | `diagnose` offered already integrated writers for integration again and said `workPreserved: true` for deleted worktrees. | It only checked that a worktree path was recorded. | It checks the worktree on disk. | fixed |
| L-021 | Two orchestrators ran phase 3 at once. | The caller thought the first had stopped (it resumed from a message); nothing showed who owned the phase. | Rule: one orchestrator per phase, a lease (see B-015 for where it must live), no interim hand-backs. | rule |
| L-017 | A float32 test compared with numpy's default `rtol=1e-7` and failed on rounding. | The brief gave no tolerance. | Brief template requires rtol/atol on every float comparison. | rule |

### Phase 2 findings (fixes in `43c3608`, deployed)

| ID | Problem | Fix | Status |
|---|---|---|---|
| L-010 | Parallel writers silently turned `simple` into `strict`. | Shown as `strict (requested simple; parallel writers always use strict)`. | fixed |
| L-011 | Scope paths echoed lower-cased on NTFS. | Display only; matching follows the filesystem's case mode. | wont-fix |
| L-012 | The job's diff stat omitted new files. | Diff stat computed from the review patch, new files marked `(new)`. | fixed |
| L-013 | Dry runs always printed the whole patch; parallel jobs had no id. | `previewMode: "stat"`; each parallel job prints a `Run id` (not a queue id). | fixed |
| L-009, L-014 | Reports repeated themselves; reviewers listed validation they had not run. | Profiles defer to the bridge's return format; "Validation performed" lists only commands actually run. | fixed |

### Phase 1 findings (fixes in `2099723`, deployed)

| ID | Problem | Fix | Status |
|---|---|---|---|
| L-001 | Python/CMake manifests were not serial (shared) files. | Added to the default shared files as literal root paths (the overlap check is by prefix; globs do not match). | fixed |
| L-003 | A bridge process older than the pins rejected every job with a bare hash mismatch. | The message says the process is stale and to restart the client. | fixed |
| L-005, L-006 | Waiting jobs looked `running`; job lists were huge and gave retry advice to healthy jobs. | `runStage` and agent timing on records; compact `list_opencode_jobs` (`limit`, `detail`); recovery steps only for jobs that stopped short. | fixed |
| L-007 | A dry run without `validationCommand` gave a receipt the apply rejected as stale. | `integration_preview_contract_mismatch` names each differing argument. Rule: the apply uses exactly the dry run's arguments. | fixed |
| L-008 | Stored results cut off the agent's final report. | Head and tail kept; default cap 24000 characters (both client configs updated). | fixed |
| L-002 | Builders cannot run Python, so they write code blind. | Kept: in phases 1-3, 10 of 11 builders passed their tests first try (P3-C had one float32 tolerance failure); phase 4 is not integrated yet. | open (by design) |
| L-004 | A new repository had no git identity, so the first commit failed. | Set a local identity when creating a repository. | rule |

### Working environment

| ID | Problem | Cause | Rule |
|---|---|---|---|
| B-001 | Auto mode refused to deploy, commit in the live tree, or change bridge state after "ok" / "eh akif" / "اها انا موافق". | The classifier needs an explicit approval that names the action. | Ask for one sentence that names the action and its target (for example "موافق تنقل تصليح الـ quarantine للجسر الشغّال"). |
| B-002 | A command given to the user failed with `The token '&&' is not a valid statement separator`. | The user's terminal is Windows PowerShell 5.1. | Commands for the user use `;` and `if ($?) { ... }`, never `&&`, and no leading `>` or prompt text. |
| B-003 | New fixes were not active after deployment. | The running bridge verifies `server.js` only at startup. | After every `--sync-clients`, restart Claude (and Codex before it uses the bridge), then check the startup SHA in `get_opencode_bridge_status`. |
| B-004 | The fixes worktree checked out with CRLF. | System git has `core.autocrlf=true`. | `core.autocrlf false` in the bridge repository; new worktrees are checked for CRLF. |
| B-005 | Shell heredocs dropped backslashes (`\n` became a newline inside JS strings). | Bash heredoc and Python string escaping combined. | Text with backslashes is written with the Edit/Write tools, not heredocs. |
| B-006 | PowerShell `Set-Content -Encoding utf8` added a BOM and mangled Arabic text. | Windows PowerShell 5.1 defaults. | Files are written with the Write/Edit tools or `sed`, not `Set-Content`. |

## 2026-09-28

| ID | Problem | Fix | Status |
|---|---|---|---|
| B-007 | 2 of 20 real builders completed; builders were killed by the validation allowlist (only git may run). | Writers use `validationCommand: "git diff --check"` and real tests run in the checkout after integration. | rule |
| B-008 | Long builders hit the timeout. | Timeouts 15/30/45 min; Codex `tool_timeout_sec` 3900; progress heartbeats for Claude. | fixed |
| B-009 | The integration preview was too large to read. | Preview cap 400k, and `previewMode: "stat"` since `43c3608`. | fixed |
| B-010 | Model split. | Reviewer and tester on Gemini 3.8 Flash; builder, debugger and the rest on muse-spark; 2 slots per provider (4 since 2026-09-29). | config |
