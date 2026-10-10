# Deep review: direct-run result verbosity (A) and retry churn on provider failures (B)

Repository: C:\Users\10User\codex-opencode-mcp, branch bridge/housekeeping at b74fbc7 (= main).
Read-only review. No tracked file was changed (git status: only the pre-existing `?? .measure-tools.mjs`).
The project DB was opened with `node:sqlite` `{ readOnly: true }`. Scratch scripts and outputs in this folder:
`render.mjs` / `render-out.txt` (A), `db-*.mjs`, `db-timing.json`, `db-refused.json` (B).

---------------------------------------------------------------------------------------------------

## A. Result verbosity of run_opencode_agent

### A.1 Where the direct-run text is assembled

| Piece | Source |
|---|---|
| Lock lines `Temporary lock acquired/released` | lib/execute-job.js:1156 |
| Bridge preamble (98 lines incl. blanks) | lib/result-format.js:27-124 `formatSingleResultParts` |
| `Assistant final response:` + report | lib/result-format.js:127 |
| `STDERR summary:` (header printed even when empty) | lib/result-format.js:128 |
| Read-only drift line (only when drift) | lib/execute-job.js:1158, 162-170 |
| `Worktree review:` + `formatWorktreeSummary` + changed files + diff stat + FULL patch preview | lib/execute-job.js:1136-1146, lib/worktrees.js:975-1000 |
| Native fallback / API error / final response verification (3 blocks, 3 lines each) | lib/execute-job.js:1115-1131 |
| Self-check / validation fix pass / validation gate | lib/execute-job.js:1159, lib/validation-command.js:140 |
| `Write lock verification:` Accepted, or the full rejection block (disallowedFiles, rollback) | lib/execute-job.js:1090-1114 |
| `Direct run audit: <runId>; terminal metadata persisted.` (the only place the Run id appears) | bin/direct-run-audit.js:255, appended at :344-348 by `auditStore.run` (lib/tools/locks-status.js:911-928) |

The response text is built at lib/execute-job.js:1178-1196. The stored copy (`resultRecord`, lib/execute-job.js:1163-1202) is
`fitRedactedJobResult({ head: lockLines + full preamble, headStandIn: lockLines + compactJobLines, report, tail })`:
the FULL preamble is stored as `text` whenever it fits the 24 000-char cap; `detailText` is only the moved head (when cut) and the patch preview.
That record feeds both the direct-run audit (`opencode_direct_runs.result_sealed`, bin/direct-run-audit.js:298-311, read back by
lib/tools/jobs.js:68-118 `directRunView`, `detail: true` adds `resultDetailText`) and the queue (`queueResultFields`, lib/queue.js:58-68).

The parallel path already does the compact layout this finding asks for (lib/tools/parallel.js:722-746: head = `compactJobLines` + worktree summary
+ diff stat + validation gate + `Unsafe changed files`; `detailText` = lock line + preamble; `detail: true` appends it, parallel.js:942).

### A.2 Measured size (real formatter, representative successful read-only explore run)

`render.mjs` imports the real `createResultFormatRuntime` and renders a typical result (Gemini Flash, 6 steps, no worktree, lockMode off, an 11-section
report that is mostly "None"):

| Block | Lines | Chars |
|---|---|---|
| Whole response | 152 | 4 043 |
| Bridge preamble | 98 (26 of them blank) | 2 918 |
| Agent report (11-section template) | 32 | 487 |
| Tail (stderr header, worktree, 3 verifications, gate, write-lock verdict, audit) | 17 | 521 |
| Existing `compactJobLines` for the same run | 6 | 288 |

The lead's measured ~130 lines / ~5 KB is the same shape (longer Windows paths and a longer report).

Side finding: the 26 blank lines are not intentional. `formatSingleResultParts` builds an array with `cond ? "..." : null` entries and joins with
`.join("\n")` without filtering (result-format.js:124), so every null becomes an empty line. Only the two `""` at :121 and :123 are meant as blanks.

### A.3 Line inventory (lib/result-format.js:29-123 plus the tail)

Legend. C = constant or an echo of the request for a successful run. N = carries information only when non-default (abnormal).
I = always informative (outcome, timing, usage). R = a caller rule in C:\Users\10User\.claude\CLAUDE.md depends on it.
"in compact" = already printed by `compactJobLines` (result-format.js:189-250) when relevant.

| Line (result-format.js) | Typical success value | Class | Compact handling |
|---|---|---|---|
| 29 Requested agent | explore | C (echo) | `Agent: explore` |
| 30 Requested agent mode | subagent | C | drop |
| 31 Actual agent used | explore | N (only if differs) | `Agent: x (ran as y)` |
| 32 Actual agent mode | subagent | C | drop |
| 33-34 Fallback used / reason | no | N | in compact when yes |
| 35 Subagent proxy used | no | N | in compact when yes |
| 36 Subagent strategy | direct | C | drop |
| 37 OpenCode native fallback detected | no | N | in compact when yes |
| 38 OpenCode API error detected | no | N | in compact when yes |
| 39 Provider error type | none | N | in compact when set |
| 40 Provider paused until | (absent) | N | in compact |
| 41 Recovered transient provider error | no | N | in compact when yes |
| 42 Provider warning type | none | N | in compact when set |
| 43 Provider error lines in stderr | 0 | N | in compact when >0 |
| 44 Token usage | steps=... | I | in compact |
| 45 Heaviest tool calls | (null -> blank line) | N | in compact when set |
| 46-48 Configured provider/model/variant | google/... high | I | `Model: p/m (variant v)` |
| 49 Model selection | managed_profile | N | in compact when override |
| 50-58 managed profile / external runner / guard / sidecar | (null) | N | in compact when set |
| 59-60 Runtime-observed provider/model | same as configured | C when verified | drop (conflict line covers mismatch) |
| 61-63 Actual provider/model/evidence | same as configured | C when verified | drop |
| 64 Runtime model verification | verified | N | in compact when unverified |
| 65 Runtime model evidence required | no | C | drop |
| 66 Runtime model identities conflict | no | N | in compact when yes |
| 67 Event stream integrity | valid | N | in compact when not valid |
| 68 Permission denials observed | 0 | N | in compact when >0 |
| 69 `Silent model fallback: disabled` | literal constant | C | drop |
| 70-72 Model fallback used / details | no | N | in compact when used |
| 73 Provider/account concurrency key | google:default | C | drop |
| 74-76 Provider capacity wait / budget / slot wait | 0 | N | `providerWaitMs` in Timing |
| 77 Assistant final response detected | yes | N | in compact when no |
| 78-79 Response / raw output truncated | no | N | in compact when yes |
| 80 Proxy reason | (null) | N | in compact |
| 81 Working directory | cwd echo | C | drop |
| 82-84 Worktree path / branch / cleanup | writer only | R (worktree path) | keep for writers |
| 85 continued worktree summary | (null) | N/R | in compact |
| 86 Command shape | opencode run ... | C (debug) | drop |
| 87 Dry run | no | N | `Status: dry_run` |
| 88 Error type | none | N, R on failure | `Status: failed; error type: X` |
| 89 Read-only HEAD move | (null) | R (CLAUDE.md troubleshooting) | in compact |
| 90-95 Agent timeout / Timeout ms / Timed out / idle / rate limit / timed-out writer | no / config echo | N | in compact when set |
| 96 Read-only unavailable | no | N | in compact when yes |
| 97-98 Retry attempts used / Max retries | 0 / 1 | N / C | in compact when >0 |
| 99-111 Lock mode/type, orchestrator, Lock granted, Allowed/Forbidden edits, Scope Contract role/mode/read/write/forbidden, Shared files frozen | echo of request | C | drop (detail) |
| 112-113 Dependency request (+ error) | none | N, R (DEPENDENCY_REQUIRED) | in compact when set |
| 114 Files changed | none detected | R | in compact |
| 115 Exit code | 0 | N | in compact when non-zero |
| 116 Duration ms + 140-char parenthetical | ... | C text | drop (Timing covers it) |
| 117-119 Agent run ms | ... | I | `Timing: agentRunMs=...` |
| 120 Timing ms + 9-11 phase lines + run split | ... | I (diagnostic) | detail only |
| 122 Tool outcomes | read:completed, ... | I (diagnostic) | detail only |
| tail: Temporary lock acquired/released | not acquired / not needed (reader) | C for readers; R-ish for writers (release failure, quarantine) | one line only when a lock was acquired or release failed |
| tail: `STDERR summary:` | empty | N | only when stderr non-empty (as parallel.js:734) |
| tail: `Worktree review: / Worktree: not used` | reader | C | drop for readers |
| tail: Worktree changed files / diff stat | writer | R (changed files) | keep for writers |
| tail: Worktree patch preview (full patch) | writer | R (CLAUDE.md "read ... the diff") | see A.4 decision |
| tail: 3 verification blocks "Accepted. ..." | Accepted | C on success, R when Rejected | only when Rejected |
| tail: Validation gate: skipped / details | skipped | N / R when it ran | only when it ran (as parallel.js:731) |
| tail: Write lock verification Accepted / rejection block | Accepted | C on success, R when rejected (= "Unsafe changed files") | `Unsafe changed files: none detected`; full block when rejected |
| tail: Direct run audit: <runId> | ... | R (Run id) | keep; also print `Run id:` first |

Caller-rule lines (CLAUDE.md): Run id (only in the audit line today), Files changed, Worktree path, Worktree changed files / diff, Dependency request
(DEPENDENCY_REQUIRED), the scope verdict (Write lock verification / disallowed files; parallel calls it `Unsafe changed files`), the lock release
outcome, the read-only HEAD move note, `Status` / error type. All of them are either in `compactJobLines` already or in the worktree/verification tail.

### A.4 Proposed compact default for single runs

Same contract as L-025 for parallel blocks: everything a caller decides on first, abnormal values always, normal values never; full block on request.

1. New `formatDirectRunCompact(...)` in lib/result-format.js (or inline at execute-job.js:1178) producing:
   ```
   Run id: <directRunId> (get_opencode_job with detail: true returns the full bridge block)
   ...compactJobLines({ resolution, result, unsafeFiles: validation.disallowedFiles })   // Agent, Status, Model, Timing, Token usage, abnormal lines, Files changed
   Lock: <id> (<type>: <paths>) released            // only when a lock was acquired; the release text verbatim when not "yes"
   Worktree path / Worktree branch / Worktree cleanup (+ reason/error)   // writers
   Worktree changed files: ... / Worktree diff stat: ...                // writers
   Unsafe changed files: none detected | <list> + the existing rejection block (execute-job.js:1090-1113)
   <verification block>  // only the ones that say Rejected
   <self-check / fix pass / validation gate>  // only when the gate ran
   <read-only drift line>  // only when present
   Assistant final response:
   <report>
   STDERR summary: ...     // only when stderr is non-empty
   Worktree patch preview  // decision below
   Direct run audit: <runId>; terminal metadata persisted.   // appended by the audit wrapper, unchanged
   ```
   `executeOpenCodeJob` already receives the run id as `jobId` for direct runs (locks-status.js:911-926), so `Run id:` needs no new plumbing.
2. `run_opencode_agent` gets a tool-level `detail: boolean` (like parallel.js:19), not in the shared `jobInputShape`. `detail: true` returns today's text.
3. Storage: `resultRecord.text` = the compact text (without the patch), `resultRecord.detailText` = lock lines + full preamble + all verification blocks
   + patch preview. `get_opencode_job` with `detail: true` already returns `resultDetailText` (jobs.js:87). `cappedResult` gives the default text priority
   and the detail what is left of 24 000 chars (direct-run-audit.js:117-139); the preamble (~3 KB) fits; a very large patch is truncated in detail as it
   is today.
4. Independent one-line fix: filter `null` (not `""`) in result-format.js:124 so the detail view loses its 26 blank lines.
5. Patch preview decision (writers only): it is the review content CLAUDE.md step 1 asks for and is not constant, so the conservative default keeps it in
   the direct response (the stored text already replaces it with `patchPreviewOmittedLine`). Dropping it from the response too (the integrate dry run
   shows the same patch, and CLAUDE.md already says to use `previewMode: "stat"` when the diff was read) is the biggest saving for writers but changes
   the review flow; leave it to the owner.
6. Queue: `resultRecord` also feeds queue `resultText` (lib/queue.js:58-68). Making it compact shortens every `get_opencode_job` poll of a queue job as
   well; the full preamble moves to `resultDetailText`. Either accept that (recommended, it is the same L-025 rule) or keep the queue text full with a
   separate field.
7. Optional, separate change: a read-only return format (server.js:255-267 `DEFAULT_RETURN_FORMAT` has 11 sections; a reviewer/explore answer leaves
   7-8 of them "None"). Either a role-specific shorter format or "omit sections that would say None". About 300 chars (~80 tokens) per read-only report
   plus the agent's own output tokens. `parseDependencyRequest` (opencode-command.js:126-139) does not need the section, so dropping it is safe.

Saving estimate (render.mjs): compact = 41 lines / 1 007 chars versus 152 lines / 4 043 chars: 3 036 chars saved, about 760-870 tokens per read-only
job (4 or 3.5 chars per token). On the lead's ~5 KB block the constant part is larger (paths), so ~3.5-4 KB / ~900-1 000 tokens. For writers the
preamble saving is the same plus ~10 tail lines; the patch preview is unchanged unless item 5 is taken. Once the agent report dominates, the
remaining cost is the report itself (item 7).

Risk: low for correctness (no decision logic changes; every abnormal value stays visible through `compactJobLines`, which parallel already relies on
and tests/review-l025.js:195-235 covers). The risk is consumers that parse the old wording.

### A.5 Blast radius (literal wording pinned by tests and scripts)

Production code: only server.js:1635 parses result text (ops-log failure classifier) and it already accepts both `Error type: X` and
`Status: failed; error type: X`. No lib code regex-parses the stored result text.

Tests and scripts that call run_opencode_agent (or the formatter) and assert preamble-only wording:
- tests/review-l025.js:177, 191, 232-237, 252-257, 325, 332: the direct-run tests (audit regex, `Worktree patch preview:\ndiff --git` in the response,
  stored `resultText` contains `Write lock verification:`, `Worktree diff stat:`, `Worktree patch preview: omitted`). Needs updating to the new split.
- tests/review-measurement.js:274-277: direct run response must contain `Timing ms: total=` and `worktreeSetup=` (moves to detail).
  :140-142 and tests/review-queue-features.js:571-573 call `formatSingleResult` directly (unaffected if the function stays).
- tests/review-flex-runners.js:196 `errorTypeOf = /^Error type: (\S+)/` (16 uses) and :370-376 (`Role enforcement`, `External runner`,
  `Configured provider`, `Model selection: external_runner`, `Provider/account concurrency key`). Role enforcement / external runner / model selection
  stay in compact; `Configured provider` and the concurrency key do not.
- tests/review-prod-core.js:54 and tests/review3-g08.js:97 `errorTypeOf` helpers (g08 already falls back to the `Status:` form; prod-core does not).
- tests/review-flex-self-check.js:207-222 (`Validation gate: passed`, `Error type: self_check_failed`), tests/review-queue-features.js:697-749
  (`Validation fix pass`, `Validation gate`), tests/review-round5.js:523 (`^Error type: agent_idle_timeout$` on the preamble), tests/review3-g09.js (1),
  tests/review-tools-pipelines.js:332, 781 (`Temporary lock released: yes|no (`).
- Scripts: bin/e2e.js:60 and bin/e2e-contractor.js:61 (`^Error type:` - with compact a failure would pass unnoticed unless switched to the
  `Status:` form), bin/e2e.js:259-261 and bin/e2e-contractor.js:290 (`Write lock verification: Accepted`, `Worktree path:`, `Worktree changed files:`),
  bin/mcp-profile-smoke.js:68-70 (`Configured provider|model|variant:` lines), bin/live-smoke.js:246-248 (`Runtime-observed provider/model`,
  `Actual provider/model`), bin/mcp-health-benchmark.js:71 (`Dry run: yes`), bin/e2e-concurrency.js:326/355 (`Temporary lock acquired.` - this is the
  lock tool, check before changing).
- Docs: docs/REFERENCE.md and docs/USER_GUIDE.md describe the result (B-197 touched them); no grep hit for the constant lines themselves.
Rough size: ~10 test files and 7 scripts; most fixes are switching to the `Status:` form or passing `detail: true`.

---------------------------------------------------------------------------------------------------

## B. Retry churn on provider failures

### B.1 Order of work for a queued write job (current code)

1. Scheduler pass, lib/queue/scheduler.js:84-198: runtime concurrency (91), capacity (93-96), `releaseResumedPauseWaits` (104; reads provider pauses
   only for records that already wait with `startAfterReason: provider_pause`, :29-58), memory gate (105-109), per record: integration recovery (123),
   cancellation (135), `startAfter` hold (146), drain (150), blocked backoff (152-158), `planned` durable write (161), write-conflict probe (172),
   `startQueueRecord` (193). There is NO check of provider pauses, rate-limit pauses or quota cooldowns for a job that is not already waiting.
2. lib/queue/start.js:236-330: `claimQueueRecord` (237), then `executeOpenCodeJob` (268) inside `providerSlotWaitStorage`.
3. lib/execute-job.js `executeOpenCodeJob`:
   - preflight: lock plan (194), queue writer needs worktree (225), validation command preflight (242), sanitized preflight (275),
     `verifyJobWorkspaceReadiness` git status (298; `dirty_worktree_requires_checkpoint` is found here, ~2 s), mark `preflight` (323);
   - discovery: `resolveAgent` (326), `readAgentDebugMetadata` attestation in the checkout (403), mark `discovery` (409);
   - `acquireHardLock` (503) + durable `onLockAcquired` (551), mark `lock` (553);
   - `createWorktreeForJob` git worktree add + checkpoint checks (564; `worktree_source_checkpoint_changed` here) + durable `onWorktreePrepared`
     (615), mark `worktreeSetup` (616);
   - worktree attestation `readAgentDebugMetadata` in the worktree (644), mark `worktreeAttestation` (659); durable ownership assert (687);
   - pre-agent snapshots in parallel: changed files, git control surface, HEAD, writable-scope state (716-723), mark `preAgentSnapshot` (745);
   - `runAgent` (775/909) -> lib/opencode-run.js `runOpenCodeWithPolicy` (535) -> bin/builder-model-fallback.js `runBuilderModelFallback` (74-80)
     -> `runOpenCode` (9): plugin policy (54-56), prompt length (78), pre-lease attestation `attestForSpawn` (188; B-161 moved it before the slot,
     B-171 reuses a <=10 min attestation), slot request `acquireProviderLease` (209) -> lib/provider-leases.js `waitForProviderLease` (407):
     quarantine reclaim (433), provider DB open (439), and at :451 the FIRST AND ONLY read of `provider_cooldowns` for this job (operator pause,
     rate-limit pause, quota cooldown, quota-group keys). A pause returns `failBeforeSpawn` (opencode-run.js:213-231: `agentNeverStarted`,
     `exitCode: provider_capacity_unavailable`, `providerCooldownUntil`). Otherwise the slot loop waits up to the slot budget
     (`provider_slot_wait_timeout`), re-attests after a wait >60 s (278-308), then spawns (317).
   - After a refusal nothing short-circuits: `evaluateAgentRun` (803) still takes the post-agent snapshots, HEAD and control-surface checks
     (812-870), the validation gate is skipped (891), the post-validation snapshot (961), `collectWorktreeDiff` (1015), empty-worktree cleanup (1054),
     report (1151-1177).
4. start.js:484 records `providerRefusedUntil`; `commitQueueTerminalRecord` (65-121) calls `scheduleQueueRetryPolicy` (89-90) -> lib/queue/retry.js
   `applyQueueRetryPolicy` (209-317): uncounted pause wait (250) or B-169 zero-output rate limit (254-257), `chooseRetryModel` (151-177), requeue as a
   new job row with `startAfter` only when every candidate is paused at that moment.

So the hypothesis is confirmed in code: a job whose model is already paused pays preflight, discovery attestation, path lock, worktree creation,
worktree attestation, snapshots, (today also the pre-lease attestation unless cached), the refusal, then post-agent checks, patch collection and
worktree removal.

### B.2 Measurements (project DB 811d2d8b1d6369400b1b9e83.sqlite, read-only)

`record_json` keys of a failed row (first one printed): actualModel, actualProvider, afterAgentMs, agent, agentRunMs, agentStartedAt, allowedEdits,
attemptHistory, autoIntegrateRequested, autoIntegration, cancellationRequested(At), changedFiles, childContainmentIdentity, childProcessId/Role/StartedAt,
completionOutcome, configuredModel/Provider/Variant, containmentQuarantined, createdAt, cwd, dependencyRequest, dirtyFiles, disjointFiles, durationMs,
errorReasonChars/Sha256, errorType, finishedAt, heartbeatAt, heavyToolCalls, idempotencyKey, jobId, leaseExpiresAt, lockMode, lockedPaths, maxAttempts,
maxRetries, mode, noChanges, orphanChildProcess*, overlappingFiles, owner*, parentJobId, pauseWaitRequeues, phaseTimings{phases{preflight, discovery,
lock, worktreeSetup, worktreeAttestation, preAgentSnapshot, openCodeRun, postAgentChecks, validation, postValidationChecks, patchCollect, cleanup,
report}, run{preSlotMs, providerWaitMs, finalAttestationMs, spawnGateMs, afterExitMs}, totalMs, beforeAgentMs, agentProcessMs, afterAgentMs},
privateDetails*, providerRefusedUntil, providerRetryWarningCount, providerWaitMs, readOnlyHeadMove, requestFingerprint, requeueSequence, requeuedAs,
requeuedAt, requeuedFrom, resultDetailTextChars, resultText*, retryAttempt, retryCount, revision, runStage, runtimeObserved*, sanitizedWorkspace,
scopeContract, selfCheck, slotWaitRequeues, startAfter, startAfterReason, startedAt, status, task*, usage, validationFixPass, validationResultSha256,
waitBeforeAgentMs, worktree*.

The whole DB is the batch: 437 root jobs (no `requeuedFrom`) and 1 222 rows (10-01: 72/72, 10-03: 305/1 070, 10-04: 60/80). All jobs are writers.

Failed attempts by errorType and where they ended (wall = finishedAt - startedAt; medians; "refused" = `providerRefusedUntil` set, i.e. refused at
the slot because a pause existed; db-refused.json has every phase):

| errorType / class | n | wall median | wall sum | before agent / notes |
|---|---|---|---|---|
| provider_rate_limited, refused at slot | 361 | 97 s | 898 min | never spawned; output 0; all uncounted (B-078) |
| provider_rate_limited, spawned | 86 | 256 s | 594 min | 62 with zero output; 77 counted, 9 gave up (pre-B-169 code) |
| opencode_quota_exhausted, spawned | 92 | 185 s | 356 min | all had output; 85 counted, 7 gave up |
| opencode_quota_exhausted, refused at slot | 54 | 54 s | 71 min | never spawned; uncounted |
| agent_metadata_unavailable | 42 | 274 s | 486 min | 36 never spawned (10-04, no retry then; B-165 later); 28 rows have no phaseTimings |
| provider_slot_wait_timeout, not spawned | 37 | 1 241 s | 797 min | 740 min of it waiting in the slot loop holding a queue slot and an empty worktree; uncounted (B-071) |
| provider_paused (operator), refused at slot | 36 | 72 s | 53 min | never spawned; uncounted |
| worktree_source_checkpoint_changed | 32 | 27 s | 19 min | rejected in createWorktreeForJob, no phaseTimings |
| opencode_transient_provider_error | 32 | 1 733 s | 1 086 min | spawned; slot wait median 312 s |
| dirty_worktree_requires_checkpoint | 27 | 2 s | 1 min | rejected at preflight (cheap) |

The 451 attempts refused at the slot (rate_limited 361 + quota 54 + paused 36): 1 021 min wall (17.0 h of queue-slot time), phase sum 953 min:

| Phase (sum over the 451) | minutes |
|---|---|
| preflight (git status, readiness; host under load) | 173.0 |
| discovery (routing + attestation) | 38.1 |
| lock | 11.4 |
| worktreeSetup (git worktree add + checkpoint) | 146.9 |
| worktreeAttestation | 122.7 |
| preAgentSnapshot | 39.1 |
| openCodeRun (up to the refusal) | 197.1 |
| after the refusal: postAgentChecks 45.6, postValidationChecks 24.3, patchCollect 102.3, cleanup 44.1, report 8.2 | 224.3 |

Medians for one rate-limited refusal: preflight 18.5 s, worktreeSetup 16.9 s, worktreeAttestation 4.1 s, snapshot 4.2 s, then 5.3 + 12.8 + 5.2 s of
post-refusal checks, patch collection and cleanup. 100% of the 451 is spent before the (non-)spawn; 24% of it after the refusal.

Was the pause knowable before setup? Lower bound: an earlier attempt had already been refused on the same (model, pause-until) before this attempt was
claimed in 349 of 451 refusals (275 rate-limited, 46 quota, 28 operator pause), 618 min of wall time. Upper bound: all 451. Only 20 distinct pauses
produced the 451 refusals (median 22, max 66 refusals per pause). Of the 333 refusals that were retries, only 68 had a `startAfter`: the pause usually
began after the requeue chose the model and before the claim, a window nothing checks.

Machine time of attempts that failed for reasons knowable before setup (rate-limited/paused/quota refused at the slot, plus slot-wait timeouts):
451 refusals 1 021 min + 37 slot-wait timeouts 797 min = 1 818 min (30.3 h) of queue-slot wall time; of that, setup and post-refusal work that a
pre-check avoids is ~953 min (refusals) + ~45 min (slot timeouts: 35 min before the slot, 10 min after); the remaining 740 min is slot waiting.

Two caveats on the DB:
- The batch ran on pre-B-161 code (8cab0ab): the slot came before the final attestation, so a refusal then did not pay the final attestation; today
  `attestForSpawn` (opencode-run.js:188) runs before the slot, so a refusal pays it too unless B-171 reuses the worktree attestation (likely, it is
  seconds old).
- On that code a refused attempt reported the profile model (Muse) as `configuredModel` although the slot keys used the override
  (8cab0ab lib/opencode-run.js:104-106 vs :284). 392 refused rows say Muse while their `scopeContract.modelRequirement` is nemotron, gpt-6.1-sol,
  gemini-flash, big-pickle, longcat, mimo; their `attemptHistory` labels are therefore misleading. Current code sets `configuredMetadata` from the
  attested, overridden metadata before the slot (opencode-run.js:174, 190), so new rows are right. My per-model analysis uses the requirement.
- Rejections that return before the phase clock is summarized (agent routing/metadata errors, dirty checkpoint, worktree creation failures) store no
  `phaseTimings` (28 + 27 + 32 rows), only start/finish.

### B.3 What B-197, B-162 and B-169 changed, and what remains

- B-162 (log.md:180, bridge/latency, deployed): first rate-limit pause 30 -> 10 min, doubling 10/20/40 to the unchanged 60 min cap. Fewer jobs are
  held by stale pauses; it does nothing about when the pause is checked.
- B-169 (log.md:187, deployed; retry.js:251-257): a run stopped by `provider_rate_limited` / `opencode_rate_limited` / `opencode_quota_exhausted`
  with no output tokens, no final answer and no changed file is a pause wait, not an attempt (shares the 24-wait cap and `pauseWaitRequeues`).
  On this batch 62 of the 86 spawned rate-limited attempts would now be uncounted (they counted then: 77 counted, 9 gave up). The cost of the attempt
  is unchanged.
- B-197 (log.md:42, c9d5ac4, 2026-10-08, on main; bin/builder-model-fallback.js:39-54, 74-130; opencode-run.js:566-583): for UNPINNED
  builder/debugger/tester runs whose primary is opencode/muse-spark, a pre-spawn pause refusal or a zero-output rate-limit stop is rerouted inside the
  same attempt to google/antigravity-gemini-3.8-flash@high (if allowlisted), with full attestation and leases; both paused keeps the original pause.
  It happens after the whole setup, and it does not apply to pinned jobs: a retry policy pins `scopeContract.modelRequirement` at enqueue
  (retry.js:141-145), and `pausedProviderFallbackEligible` refuses any `modelRequirement` (builder-model-fallback.js:40). Every refused row of this
  batch had a requirement, so B-197 would not have removed any of them.
- Also relevant and already in place: B-071 (slot-wait timeouts uncounted, cap 12), B-078 (pause refusals uncounted, cap 24; enqueue-time
  `startAfter` when every model of a `models` job is paused, server.js:3542-3548), B-080/B-134 (scheduler releases pause waits when a model frees,
  scheduler.js:29-58), B-152 (dirty/checkpoint/capacity refusals become blocked waits, start.js:16-21, 194-234), B-165 (uncounted infra retries for
  attestation failures, retry.js:232-237, 282-283).

What remains: the pause is only consulted at the slot (provider-leases.js:451), after all setup. Enqueue (B-078) and requeue (`chooseRetryModel`)
check pauses once, but a pause that appears between that decision and the claim (the common case here) is discovered ~1-2 minutes of work later.
The post-refusal checks also run for an agent that never started.

### B.4 Does a rate-limited attempt count toward maxAttempts (current code)?

- Refused at the slot because the provider, model or a quota-group key was already paused (`providerRefusedUntil` set): not counted (B-078),
  up to `RETRY_POLICY_MAX_PAUSE_WAITS` = 24 (lib/queue.js:139; retry.js:249-250).
- Spawned and stopped by a rate limit or quota with zero output, no final answer and no changed file: not counted (B-169), same 24 cap
  (retry.js:254-257).
- Spawned with any output, or after 24 pause waits: counted.
- `provider_slot_wait_timeout`: not counted up to 12 (retry.js:244-245).
- Every uncounted case still creates a new job row and pays the full setup again; a job without `models`/`maxAttempts` is not retried at all;
  a direct read-only run retries `opencode_rate_limited` internally (opencode-run.js:514-533) but not a pause refusal or quota.
- Max seen in this DB: `pauseWaitRequeues` 7, `slotWaitRequeues` 2, so no chain hit a cap.

### B.5 Proposal

1. Fast pause refusal at the top of `executeOpenCodeJob` (before `verifyJobWorkspaceReadiness`, execute-job.js:~297), for both queue and direct runs,
   when the model is known from the request: pinned `scopeContract.modelRequirement` that `allowlistedModelOverride` accepts. One read of
   `activeProviderPauses()` (server.js:3602-3610, one provider DB snapshot). Check the provider key, the model pause key and
   `quotaGroupProviderKeys` exactly like `waitForProviderLease` (provider-leases.js:409, 451) and the scheduler's `pausedUntil` (scheduler.js:42-46).
   If paused, return the same shape `failBeforeSpawn` returns (`exitCode: "provider_capacity_unavailable"`, `errorType` = the cooldown's type,
   `providerCooldownUntil`, `agentNeverStarted`, `configuredProvider/Model` of the requirement). The queue then records `providerRefusedUntil`
   (start.js:484) and B-078 accounting and `chooseRetryModel` work unchanged. Saves essentially all of the ~953 min on this batch (the attempt costs
   milliseconds instead of ~97 s median). Do not apply it when B-197 could reroute (unpinned builder/debugger/tester on Muse with the fallback free);
   for unpinned jobs the model is only known after attestation, so skip (fail open) or use the cached attestation's model.
2. Scheduler hold, lib/queue/scheduler.js between :146 and :150: for a pending/planned record whose every candidate (`pauseWaitCandidates`, :18-24)
   is paused, set `startAfter` = earliest pause end and `startAfterReason: "provider_pause"` (one durable write, as B-078 does at enqueue) and skip
   it. B-080's releaser (:29-58) frees it when a model frees. No claim, no row, no `pauseWaitRequeues` increment. Read the pauses once per pass
   (`releaseResumedPauseWaits` already throttles a read per `queueBlockedPollMs`). On this batch at least 349 attempt rows (618 min) would never
   have been created. When only the pinned model is paused but another policy model is free, let item 1 refuse fast so the retry chooser moves on
   (re-pinning in place would change the encrypted request and its idempotency fingerprint).
3. Short-circuit after a never-started refusal: in execute-job.js after `runAgent` (909), when `result.agentNeverStarted` and the worktree is not a
   continuation, skip post-agent snapshots and patch collection, remove the empty worktree, report. 224 min of the 953 on this batch; still useful
   for refusals that slip past 1-2 (race with a new pause).
4. Lower priority: a non-binding capacity probe before claiming (holders >= limit for the job's provider) to keep the 37 slot-wait timeouts
   (797 min holding queue slots, 740 of it waiting) from occupying queue capacity; fairness and TOCTOU make this the riskiest item.

Risk and safety: the slot check at provider-leases.js:451 stays the authoritative gate, so a stale or failed pre-check only falls back to today's
behaviour. The pre-check should fail open on a provider DB error (B-132's fail-closed rule protects releases, not an advisory skip). Keep B-197
eligibility in mind (do not hold or refuse a job that would reroute). Quota groups must be included or a codex/openai pair slips through. A fast
refusal still counts toward the 24-wait cap; the scheduler hold does not. Direct runs pinned to a paused model would now refuse in milliseconds with
the same message; that is a behaviour improvement, but tests that expect the refusal after worktree creation (worktree path in the rejection) need a
look (tests/review-provider-fallback.js, tests/review-flex-fallback.js, tests/review-provider-quota.js).

### B.6 Not verified

- Behaviour of current code on a real batch: the DB predates B-161/B-162/B-165/B-169/B-171/B-197; phase costs today differ (attestation moved and
  cached). The ordering conclusion is from current code, the minutes are from 10-03.
- Pause start times are not stored (expired `provider_cooldowns` rows are deleted, provider-leases.js:443), so "knowable before claim" uses earlier
  refusals as proof (lower bound).
- Queue concurrency at the time (memory notes 14 workers) is not in the DB, so wall minutes are queue-slot time, not elapsed batch time.
- I did not run `npm test` or any bridge tool.
