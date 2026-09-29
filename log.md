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

### Phase 4 incident: the whole repository was quarantined by one failed integration

| ID | Problem | Cause | Fix | Commit | Status |
|---|---|---|---|---|---|
| B-012 | A failed integration of P4-D put the charGPT repository in quarantine (`repository_state_drift`). Every integration, every writer lock and every queued job on it stopped. | The apply was rejected because another process wrote a file during it (see B-013), and the bridge rolled back cleanly. Recovery then compared the whole target state, ignored files included, saw that the other file had changed, and quarantined. HEAD, the index and the patched path were all back at their pre-patch state. | Recovery closes the operation as `recovered_noop` (or `rolled_back`) when HEAD, the index and every affected path are at their preimage, whatever else changed; the result records `externalDriftOutsidePatch`. Quarantines left by the old rule (`repository_state_drift`) are re-checked under the integration lock on the next recovery and closed when that still holds, so the stuck operation clears itself after deploy and restart. | `362a97f` | fixed, not deployed |
| B-013 | The P4-D apply failed with `changed_file_validation_error` on `.claude/orchestrator.lock`. | The orchestrator kept a heartbeat loop that rewrote its lease file inside the repository every 2 minutes. `TaskStop` killed the tool shell but not its `bash.exe` child on Windows, so the loop kept writing, once during the apply. | The rejection now names the file and says another process wrote it (a background loop, a test run, an editor), to stop it, dry-run again and apply with the new receipt. | `362a97f` | fixed, not deployed |
| B-014 | While the repository was quarantined, a queued read-only reviewer stayed `pending` for more than 4 minutes with no reason, although its assessment said `can_run_immediately`. | The scheduler skipped every job of a blocked repository, readers included, and wrote nothing on the record. | Readers are scheduled while the journal is blocked (they do not mutate the checkout); held writers become `blocked` with `integration_recovery_pending` and a reason that points to `diagnose_opencode_bridge`. | `362a97f` | fixed, not deployed |
| B-015 | The orchestrator's lease file (added for L-021) caused B-013. | A lease inside the repository is a file the bridge watches; a background loop to refresh it outlives `TaskStop` on Windows. | Rule: the orchestrator lease lives outside the repository, is refreshed only inline on each poll, and no orchestrator starts background loops. To be written into `.claude/agents/migration-orchestrator.md` when the charGPT repository is unblocked. | - | rule (pending doc change) |
| B-016 | `TaskStop` on a background shell does not stop the programs it started (Windows). | Claude Code harness behaviour on Windows (child processes are not in a job object). | Rule: never start long-running loops from an agent; if one was started, find and kill its process by PID. | - | rule |
| B-017 | The live bridge tree had uncommitted edits from another Claude session (pipeline finalization `GATE_VERDICT` gates, `ip-address` bump), so `git merge --ff-only` refused and the on-disk `server.js` no longer matched the pinned hash (a client restart would have failed the integrity check). | Two sessions edited the live tree; one did not commit. | The edits were reviewed and verified (`npm test`, `test:events`, `test:builder-fallback` all pass); they are committed as their own commit, then `bridge/migration-fixes` is rebased on top. Rule: bridge edits happen only in a worktree on a branch, never in the live tree, and every session commits before it ends. | pending | open (waiting for the user's approval to commit in the live tree) |
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
