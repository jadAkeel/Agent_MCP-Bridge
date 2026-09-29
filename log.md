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
| B-018 | After the review deploy the user restarted both clients, yet every running bridge (4 Claude sessions, 3 Codex bridges) still ran the old `server.js` (`f2422f2a…`), and `get_opencode_bridge_status` said "healthy". The synced builder/debugger profiles already carried the new `.git` deny rules, which the old code's attestation does not expect. | Closing the Claude window does not end its Code sessions (their `claude.exe` and the bridge under it stay alive), and Codex's `app-server` keeps its bridges. Status printed only the startup hash, so a restart that did not happen looked like one that did. | Status compares the startup hash with `server.js` on disk: a difference prints the process start time and a restart warning and makes the status "attention required"; `diagnose_opencode_bridge` reports `bridgeProcess` (`startupSha256`, `onDiskSha256`, `stale`). Self-test covers changed, unchanged and unreadable files. Verifying a restart: status must say "Bridge source on disk: same as at startup". | fixed (bridge-fixes, not deployed) |
| B-018 | `run_opencode_parallel` runs are invisible to `list_opencode_jobs`, the direct-run audit and `diagnose`; while one runs, only the provider lease count shows it. | Parallel runs are a synchronous barrier by design and are excluded from both stores. | Proposed: record each parallel job in the direct-run audit with its Run id. | - | open |
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
