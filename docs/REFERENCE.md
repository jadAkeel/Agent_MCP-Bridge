# Codex OpenCode MCP Bridge — Technical Reference

Detailed rules, tool behavior, and the complete configuration table. For daily use, start with [USER_GUIDE.md](USER_GUIDE.md).

## Official Safety Model

```text
Scope Contract = law
Queue = scheduler
Worktree = isolation
Lock = temporary collision guard
Changed-file validation = enforcement
Codex = final authority
```

Every write job must have an explicit Scope Contract. Locks are not the primary safety system; they only prevent obvious MCP-managed collisions before execution. The actual result is enforced by changed-file validation.

## Three Workflow Levels

| Task type | Tool | Lock | Queue | Worktree | Pipeline |
| --- | --- | --- | --- | --- | --- |
| Read-only review | `run_opencode_agent` reviewer/planner/tester/architect | shared consistency lease | no | no | no |
| Single small write | `validate_delegation_plan` + `run_opencode_agent` builder/debugger | simple | no | optional | no |
| Single risky write | validate + builder/debugger + reviewer/tester | simple | optional | recommended | no |
| Parallel independent writes | pipeline + queue | strict | yes | yes | yes |
| Shared-file change | serial builder/debugger | simple | optional | recommended | no/optional |
| Large feature | pipeline | strict | yes | yes | yes |

Use the simplest level that fits the task. Pipelines are advanced-only and are rejected when too small.

Daily mode is intentionally shorter: keep tiny work in Codex, use one direct read-only agent for a second opinion, and use one direct `builder` or `debugger` for a bounded write. Add queue, pipeline, reviewer, or tester stages only when concurrency or task risk justifies them. OpenCode contractor mode remains explicit opt-in.

## Scope Contract

Write jobs require:

```json
{
  "mode": "write",
  "read": [],
  "write": [],
  "allowedEdits": [],
  "forbidden": [],
  "shared": [],
  "serialOnly": [],
  "validationCommand": ""
}
```

Rules:

- Missing write contracts are rejected with `missing_scope_contract`.
- Empty write allowlists are rejected with `empty_allowed_edits`.
- Files outside `allowedEdits` are rejected after execution.
- Read-only agents that edit files are rejected.
- Forbidden files must never be edited.
- Shared and serial-only files require serial handling.
- `read` is guidance, not a restriction. The bridge prints it in the agent's prompt and uses it to decide whether a reader overlaps a writer, but nothing stops the agent from reading other files in the checkout or worktree: the managed agent profiles set no per-path read permission, and `external_directory: deny` only keeps them inside their working directory. Only edits are enforced. For real read isolation use a sanitized workspace (see [Sanitized Workspaces](#sanitized-workspaces)).

## Main Tools

- `get_opencode_bridge_status`: run the quick daily OpenCode/Git/agent/config check. Pass `deep: true` for full managed-role attestation during activation or audits; every actual agent execution still re-attests its selected role immediately before spawn.
- `validate_delegation_plan`: preflight one or more jobs without running OpenCode or acquiring locks.
- `run_opencode_agent`: run one bounded OpenCode agent.
- `integrate_opencode_worktree`: a dry run whose patch adds a line that looks like a credential gets no receipt (`integration_preview_contains_sensitive_text`). After checking the flagged lines in the worktree, `acceptFlaggedSecretLines: true` on the dry run issues the receipt. Integration waits for readers of the checkout, other integrations, and manual or in-place writers; worktree builders on other paths do not block it.
- A write job that changed no files has its worktree removed at once; failed jobs with changes are still retained.
- A dry run whose patch carries any file as a `GIT binary patch` hunk gets no receipt (`integration_preview_unreadable_text_file`) unless its extension is a known binary media, font or archive type (png, jpg, gif, ico, webp, pdf, zip, gz, woff, ttf, mp3, mp4, wasm, ...): the reviewer and the secret scan cannot read it. After inspecting such files in the worktree, `acceptBinaryHunks: true` on the dry run issues the receipt.
- The managed `opencode.jsonc` sets `"snapshot": false`; bridge jobs track changes with their own Git snapshots, so OpenCode's per-step undo snapshots only cost time and disk.
- A containment quarantine records the whole live process tree (supervisor, payload and their descendants) and is released only when all of them are gone.
- `diagnose_opencode_bridge` returns every unfinished job and direct or parallel run plus the 25 most recent finished ones; its summary counts cover all. `retainedWorktrees` lists every bridge-created worktree still registered (queued, direct and parallel jobs) with its `owner`, `inFlight` (its job is still running: do not integrate or remove it) and a recovery action.
- `release-activate.js --sync-clients` lists the uncommitted bridge files it is trusting when it re-pins server.js.
- An integration receipt is bound to the dry run's arguments (`allowedEdits`, `forbiddenEdits`, `sharedFiles`, `serialOnly`, `validationCommand`, `allowDirtyTarget`). An apply with different arguments fails with `integration_preview_contract_mismatch` and names each differing argument; pass the same `validationCommand` to both calls.
- `list_opencode_jobs` prints one compact line per job (newest 20; `limit`, and `detail: true` for full records). Queue records carry `runStage` (`starting_agent` until the agent process starts, then `agent_running`), `agentStartedAt`, `waitBeforeAgentMs` (claim to agent start: workspace checks, worktree creation, role attestation, snapshots and the provider slot wait), `agentRunMs` (for a finished job the agent process alone, the same number as `Agent run ms` in the result text), `afterAgentMs` (post-agent checks, validation and patch collection), `providerWaitMs` (the slot wait alone), `providerRetryWarningCount` (provider error lines OpenCode logged, including attempts it retried), `usage` (token counts from OpenCode's `step_finish` events, summed over retries) and `phaseTimings` (the per-phase split). The compact line prints the same names. Direct results print `Duration ms` (the OpenCode run only), `Agent run ms`, `Token usage` and a `Timing ms` block with the phases; a parallel job's block prints `Timing: agentRunMs=... startupMs=... providerWaitMs=... durationMs=...` and `Token usage`, and the `Timing ms` phase block only with `detail: true`.
- `get_opencode_job` returns the fields a caller acts on (status, stage, timing, usage, error, changed files, worktree, result text); `detail: true` returns the full record (scope contract, hashes, lease, owner, containment) and the stored detail text `resultDetailText`. The result text of a finished writer leaves out the worktree patch preview (it carries the diff stat and one line saying where the patch is: `integrate_opencode_worktree` with `dryRun: true`, or `detail: true`); the preview is kept apart as `resultDetailText`, and `resultDetailTextChars` says how much is stored. Given a `run_opencode_agent` audit id or a `run_opencode_parallel` Run id it returns that run's audit record (status, timing, usage), its retained worktree and the result text stored under the id (`resultText`, `resultTextChars`, `resultTextTruncated`; `detail: true` adds `resultDetailText`: a parallel job's bridge preamble, a direct writer's patch preview). Those runs cannot be cancelled. Their text is stored redacted and encrypted with the queue's key, capped at `CODEX_OPENCODE_QUEUE_RESULT_MAX_CHARS` (default 24000) in total, and pruned with the audit record; a run from before this was kept has none.
- A read-only job whose checkout HEAD moved during the run (another client committed, amended or rebased; read-only agents cannot move HEAD) completes with a `Repository HEAD moved during this read-only run` line listing the commits, whether history was rewritten (non-fast-forward), and whether they touched the job's read scope; the record carries `readOnlyHeadMove`. A reader whose attested policy denies every edit also keeps its result when another client edits or commits files in the checkout: the difference is reported as `readOnlyWorkspaceDrift`. Writers whose HEAD moved still fail with `repository_head_changed_during_execution`.
- The enqueue assessment judges a reader by its Scope Contract read paths, as the scheduler does, and names the overlapping paths when it says `must_wait`.
- A stored result (queue job, direct or parallel run) is limited to `CODEX_OPENCODE_QUEUE_RESULT_MAX_CHARS` (default 24000) and is shortened report-first: the worktree patch preview is never part of it (it is stored apart), then the long bridge preamble is replaced by a short summary (the full preamble moves to the detail text), and only if the agent's report still does not fit is its end cut, with a line saying how many characters were omitted. The report is never cut in the middle. Only that last case is `completionOutcome: "completed_with_truncated_output"` and `resultTextTruncated`; leaving the patch preview out is not a truncation.
- `diagnose_opencode_bridge` gives recovery steps only to jobs that stopped short; running and completed jobs get `None: ...`. A completed writer whose worktree no longer exists (integrated and cleaned up) is not offered for integration again, and `workPreserved` reflects whether the worktree is still on disk.
- `integrate_opencode_worktree` takes `previewMode: "stat"` on a dry run: per-file line counts (new files marked) instead of the whole patch; the receipt is the same. Job results compute `Worktree diff stat` from the review patch, so files the agent created are counted.
- Parallel writers always run with `strict` locks; a requested `simple` is shown as `strict (requested simple; ...)`. Each `run_opencode_parallel` job prints a `Run id`: it names the job's worktree and its direct-run audit record (`kind: parallel`, with the job's result text), which `get_opencode_job` and `diagnose_opencode_bridge` read. It is not a queue id and cannot be cancelled.
- Agent reports: the bridge's Return format replaces the profile's own report sections, and "Validation performed" lists only commands the agent ran.
- Default shared (serial) files also cover Python and CMake manifests: `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `requirements-dev.txt`, `Pipfile`, `Pipfile.lock`, `poetry.lock`, `uv.lock`, `conftest.py`, `tests/conftest.py`, `CMakeLists.txt` (root paths; the check is by path prefix).
- A plugin-manifest mismatch whose current hash is already pinned in `~/.claude.json` or `~/.codex/config.toml` says the bridge process is older than the install and must be restarted with its client.
- `run_opencode_parallel`: run independent jobs only when their write scopes are safe. Batches with more non-dry-run jobs on one provider than `CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT` are rejected (`parallel_batch_exceeds_provider_capacity`; counted per provider key, and `validate_delegation_plan` applies the same check): the extra jobs would wait for a slot and then run their full timeout inside the same call, past Codex's `tool_timeout_sec`.
- `enqueue_opencode_job`: schedule a job through the MCP queue.
- `diagnose_opencode_bridge`: show correlated jobs, pipelines, locks, provider leases, preserved work, retry safety, and recovery actions for one repository.
- `create_multi_agent_pipeline`: create an audited multi-agent plan with ownership, worktree, integration, and final-validation checks.
- `run_multi_agent_pipeline`: enqueue planned pipeline jobs.
- `get_multi_agent_pipeline` / `list_multi_agent_pipelines`: inspect pipeline status, queue jobs, integrations, and audit events.
- `abandon_multi_agent_pipeline`: explicitly terminalize an inactive obsolete pipeline after exact-id confirmation. It never deletes unintegrated worktrees.
- `resolve_integration_quarantine`: close a quarantined integration operation under the repository-wide recovery lock (refused while any job holds a lock there). `verify_restored` closes it as `recovered_verified` only when HEAD, the affected index entries and bytes match the journal, else lists every mismatch and changes nothing; `accept_current` needs `reason` and `confirmation` (the operation id) and closes it as `resolved_by_operator`, recording who, when, why and the accepted state. No journal row, pre-image or key is deleted. CLI: `node bin/pipeline-admin.js resolve-quarantine <operationId> --cwd <repo> (--verify-restored | --accept-current --reason <text>)`. Runbook: USER_GUIDE "A quarantine that does not clear".
- `integrate_opencode_worktree`: dry-run or serially integrate one reviewed worktree/branch.
- `finalize_multi_agent_pipeline`: run final validation and optional reviewer/tester gates. It accepts only a pipeline in `awaiting_finalization` (every job completed and every integration landed) or a crashed `finalizing` run; any earlier status returns `pipeline_jobs_incomplete`, and a second finalization of the same pipeline in one bridge returns `pipeline_finalization_in_progress`. A `completed` pipeline is terminal: finalizing it again returns the recorded result and reruns nothing. `dryRun: true` checks these preconditions and reports the validation command and gates that would run, without running an agent or changing the pipeline. The reviewer and tester gates run concurrently against the same validated target state. A gate passes only when its agent ends cleanly and the last line of its report is `GATE_VERDICT: pass` (bold or code emphasis allowed) with no other `GATE_VERDICT` mention anywhere in the report. `GATE_VERDICT: fail` fails with `pipeline_gate_verdict_fail`; no verdict with `pipeline_gate_verdict_missing`; a verdict that is not the last line, or that is quoted, listed, or otherwise decorated, with `pipeline_gate_verdict_misplaced`; and more than one mention with `pipeline_gate_verdict_ambiguous`. Each gate result records its `verdict` and the `checkedTargetStateSha256` it inspected.
- `acquire_agent_lock` / `release_agent_lock`: exceptional manual cleanup/debugging only.

`run_opencode_parallel` is a synchronous barrier. It returns terminal results for the direct jobs and measured overlap, not queue job IDs. Each job's block is compact: `Run id`, agent, `Status` (and error type), model, `Timing`, `Token usage`, provider warnings (rate limits stay visible), other abnormal facts (native fallback, API error, unverified model, denied permissions, truncated output, timeout, exit code), changed files, worktree path and branch with its diff stat, validation and `Unsafe changed files`, then the agent's report and any stderr summary. The bridge preamble (lock and scope echo, model evidence, phase timing split, tool outcomes) is left out unless the call passes `detail: true`. The job's result text is stored under its Run id, so `get_opencode_job` returns it again (and the preamble with `detail: true`) when the response is lost. Use queue or pipeline tools when jobs must be monitored or cancelled independently.

## Orchestrator Modes

By default, a requested OpenCode `orchestrator` is routed to the dedicated `opencode-orchestrator-mcp-planner`. That agent is read-only and has OpenCode's `task` permission denied, so it cannot launch nested writers. Codex remains the coordinator and calls bounded workers directly.

The managed orchestrator profiles live in `opencode/agents/` under three file names: `opencode-orchestrator-mcp-planner.md` is the read-only MCP planning target, `opencode-orchestrator-mcp-contractor.md` is the explicit contractor target, and `opencode-orchestrator-standalone.md` is the backup/standalone profile for direct OpenCode sessions. OpenCode derives each agent name from its file name. Through the bridge, the requested names `orchestrator`, `principal-engineer-orchestrator`, and `opencode-orchestrator-standalone` are aliases that resolve to the MCP planner, or to the contractor in explicit contractor mode; the standalone profile is never executed by the bridge. Operators may override the two MCP target names with `CODEX_OPENCODE_MCP_ORCHESTRATOR_AGENT` and `CODEX_OPENCODE_MCP_CONTRACTOR_ORCHESTRATOR_AGENT` only when a release intentionally ships different file names.

The managed `planner`, `architect`, `reviewer`, and `tester` agents also deny both edits and nested subagent launches.
Known write-capable agents such as `builder` and `debugger` are rejected under read-only locks; use them only as bounded worktree writers.

Contractor mode is disabled until the operator configures `CODEX_OPENCODE_CONTRACTOR_AUTHORIZATION_SHA256`. When the user explicitly requests the OpenCode Orchestrator by name for the current task, Codex may opt in with all three fields:

```text
orchestratorMode: contractor
userAuthorizedOrchestrator: true
contractorAuthorizationToken: <operator-held secret matching the configured hash>
```

The Bridge then routes the one outer job to `opencode-orchestrator-mcp-contractor`. That parent cannot edit, invoke a shell, or load skills; it may coordinate only an allowlisted set of OpenCode worker, planning, review, and test agents, and delegates repository commands or validation to those bounded subagents. Recursive orchestrator calls are denied by OpenCode task permissions. Because nested task execution has no interactive permission-response channel, every managed nested role defaults shell access to deny and exposes only the bridge-reviewed exact Git diagnostic allowlist. The Bridge isolates OpenCode's legacy home and every XDG control/state root, attests the exact parent and every allowlisted nested profile initially and immediately before execution, and uses an in-memory OpenCode session database. The whole contract must be a single bounded write job with explicit `lockedPaths`, `allowedEdits`, a write Scope Contract, and validation. It always runs in an isolated worktree, which is retained for Codex review and explicit integration. The Bridge independently runs the final validation gate even when a subagent reports its own check.

```text
User explicitly authorizes OpenCode Orchestrator
-> Codex creates one bounded contract
-> MCP contractor orchestrator
-> internal OpenCode subagents
-> consolidated diff/report
-> Codex review and integration decision
```

Contractor mode is rejected when the capability is unconfigured/invalid or the explicit authorization flag is absent, and it cannot be placed in `run_opencode_parallel` or a multi-job pipeline. The plaintext token is neither returned nor persisted. MCP validates the aggregate contract and final changed files; it does not expose per-subagent locks inside OpenCode, so use this mode only when the user deliberately chooses the broker workflow.

## Model Selection

Every managed agent profile pins one `provider/model` and variant in its frontmatter, and the bridge passes that pin explicitly on the OpenCode command line. Codex can ask for a different model per job without editing profiles: set `CODEX_OPENCODE_MODEL_ALLOWLIST` to the models the operator trusts, then send `scopeContract.modelRequirement` with the wanted `provider`, `model`, and optional `variant`. When the requirement matches an allowlist entry the bridge pins it for that job, reports `Model selection: operator_allowlist_override` together with the profile model it replaced, and still compares runtime-observed identity against the pinned model. A requirement outside the allowlist is rejected before any process starts, exactly as before. Silent fallback stays disabled and the sanitized reader always keeps its exact profile.

```text
CODEX_OPENCODE_MODEL_ALLOWLIST=opencode/muse-spark-1.3-contributor-free@high,opencode/gpt-5.3-codex,opencode/claude-sonnet-5@high
```

An entry without `@variant` accepts any requested variant. When the job names none, the override runs with no variant at all (no `--variant` argument): the profile's variant belongs to the profile's own model and is not carried over to the overriding model. An entry with `@variant` accepts only that variant, and a job that names no variant gets the entry's variant.

## Worktrees And Integration

Recommended production setting:

```text
CODEX_OPENCODE_WORKTREE_MODE=write
CODEX_OPENCODE_WORKTREE_ROOT=global
```

Worktree output is never merged automatically. The safe integration flow is:

```text
integrate_opencode_worktree(dryRun: true)
-> bridge returns a full-patch SHA-256, source/base identity, target-state digest, contract digest, and previewReceipt
-> Codex reviews the bounded patch preview, changed files, and immutable digests
-> integrate_opencode_worktree(reviewed: true, previewReceipt: <exact receipt>, validationCommand: "git diff --check")  # cleanupAfterSuccess defaults to true for bridge-created worktrees
-> validationCommand runs
-> rollback on validation failure
-> source is re-hashed; cleanup occurs only after an explicit passing gate
```

Non-dry-run integration without both `reviewed: true` and the exact unexpired preview receipt is rejected. Any source or target mutation after preview returns `integration_preview_stale`. Source cleanup is on by default: `cleanupAfterSuccess` defaults to `true` for a worktree the bridge created (one under the bridge-generated worktree root) and to `false` for a worktree path you made by hand. Pass `cleanupAfterSuccess: false` to keep a bridge-created source, or `true` to clean up a hand-made one. Cleanup requires `validationGate.status === "passed"` (a skipped validation keeps the source), and it rechecks the source patch immediately before removal. Branch cleanup uses an exact expected-object `update-ref` deletion; a branch moved or recreated during cleanup is retained and reported as partial. Pipeline cleanup is deferred until final validation, reviewer, and tester gates all succeed. Failed, partial, unreviewed, and not-yet-integrated worktrees are retained.

Before creating any writer worktree, the bridge rejects staged, unstaged, untracked, conflicted, or dirty-submodule state with `dirty_worktree_requires_checkpoint`—including dirt unrelated to the requested scope. A worktree starts from a pinned commit/tree and cannot safely reproduce uncheckpointed prerequisites. The bridge never stashes, resets, commits, or overlays the source checkout; create or select an external checkpoint and retry.

Writer worktrees intentionally do not share a mutable `node_modules` or equivalent dependency directory with the source checkout. Use a dependency-free check such as `git diff --check` before integration when the worktree has no installed packages, then run the full project tests from the source checkout after reviewed integration. If a task needs a new package, the writer must stop before adding an undeclared import and return a single-line structured request:

```text
DEPENDENCY_REQUIRED {"packages":[{"name":"package-name","version":"optional-range","reason":"why it is needed"}],"reason":"why the task cannot continue safely"}
```

The bridge reports this as `dependency_required`. Codex reviews and applies approved package/lockfile changes serially, creates a new clean checkpoint, and retries the bounded writer. This avoids both unreviewed dependency changes and unsafe shared dependency junctions.

## Project Policy

Pipeline creation loads `.mcp/agent-policy.json` when present.

Recommended policy:

```json
{
  "version": 1,
  "owners": {
    "apps/web/**": "web",
    "apps/api/**": "api",
    "packages/shared/**": "shared"
  },
  "forbiddenEdits": [
    ".env",
    ".env.*",
    "**/*.pem",
    "**/*.key",
    "**/secrets/**"
  ],
  "sharedFiles": [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "tsconfig.json",
    "packages/shared/**",
    "schema/**",
    "migrations/**"
  ],
  "serialOnly": [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "database/**",
    "migrations/**",
    "schema/**"
  ],
  "requiresWorktrees": true,
  "finalValidationCommand": "git diff --check"
}
```

The policy schema is strict and repository policy is tightening-only: it cannot disable required worktrees. A caller-supplied `trustedPolicySha256` is diagnostic only and grants no authority. A policy containing `finalValidationCommand` is accepted only when the operator environment pins its canonical repository root, exact repo-relative path, and bytes through `CODEX_OPENCODE_TRUSTED_POLICY_ROOT`, `CODEX_OPENCODE_TRUSTED_POLICY_PATH`, and `CODEX_OPENCODE_TRUSTED_POLICY_SHA256`, and pins the canonical Git executable hash in `CODEX_OPENCODE_VALIDATION_EXECUTABLE_SHA256_ALLOWLIST`. Copying approved bytes into another repository or path grants no authority. Repository policy may use only bounded, read/check Git vectors; package scripts and repository interpreters require an explicitly trusted coordinator command or an external sandbox. The executable, exact argument vector, policy bytes, and provenance are revalidated before each execution. Changing or revoking any pin fails closed.

The bridge also applies conservative defaults for env/secrets, manifests, lockfiles, shared packages, schemas, and migrations. Lock paths are resolved against the canonical repository root and stored in repository-relative form, so absolute paths plus redundant separators and `.` segments cannot bypass overlap checks; parent-traversal segments remain rejected. Filesystem case behavior is probed read-only from existing root entries and cached for the process; when it cannot be determined, lock identity conservatively folds case. Multiple readers may share a scope, overlapping readers/writers exclude each other, and an unscoped reader holds a repository-wide shared lease. Reviewed integration is repository-wide exclusive, while pipeline final validation/reviewer/tester gates hold a repository-wide shared consistency lease.

## Configuration

Recommended production environment fragment (the MCP `args` entry itself must
point at an immutable published release, not this working tree):

```text
CODEX_OPENCODE_WORKTREE_MODE=write
CODEX_OPENCODE_WORKTREE_ROOT=global
CODEX_OPENCODE_QUEUE_MODE=sqlite
CODEX_OPENCODE_QUEUE_WRITE_CONFLICT_POLICY=wait
CODEX_OPENCODE_DEFAULT_READ_LOCK_MODE=off
CODEX_OPENCODE_DEFAULT_WRITE_LOCK_MODE=simple
CODEX_OPENCODE_DEFAULT_PARALLEL_WRITE_LOCK_MODE=strict
CODEX_OPENCODE_WORKTREE_CLEANUP=never
CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT=4
CODEX_OPENCODE_QUEUE_HEARTBEAT_MS=15000
CODEX_OPENCODE_DEFERRED_RECOVERY_IDLE_MAX_MS=15000
CODEX_OPENCODE_QUEUE_LEASE_MS=60000
CODEX_OPENCODE_QUEUE_RETENTION_DAYS=30
CODEX_OPENCODE_AUDIT_RETENTION_DAYS=90
CODEX_OPENCODE_PROVIDER_LEASE_MS=240000
CODEX_OPENCODE_PROVIDER_HEARTBEAT_MS=20000
CODEX_OPENCODE_QUEUE_RESULT_MAX_CHARS=24000
CODEX_OPENCODE_INTEGRATION_PREVIEW_MAX_CHARS=400000
CODEX_OPENCODE_EXPECTED_SERVER_SHA256=<sha256-of-the-published-server.js>
CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256=<sha256-of-release-manifest.json>
```

The provider limit (4) and the preview cap (400000 characters) are the operator's current values. The built-in defaults are 2 and 12000; a full-patch dry run longer than the preview cap gets no review receipt. The variable table below lists every default.

The bridge adds `--pure` whenever `CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS=false`. In the pinned OpenCode runtime, `--pure` suppresses configured external plugins while retaining binary-bundled authentication hooks such as the Codex OAuth transport; the bridge must not set `OPENCODE_DISABLE_DEFAULT_PLUGINS`, because that also disables required built-in OAuth routing. Those internal hooks share the exact OpenCode-version trust boundary. A release-manifest-pinned process must keep external plugins disabled: startup and fresh health reject immutable release pinning with external plugins because the reviewed Antigravity plugin stores credentials under the same `XDG_CONFIG_HOME` that must remain writable for OAuth refresh.

Outside immutable production mode, the external-plugin verifier remains fail-closed: enabling plugins requires an exact `name@version` allowlist, a pinned integrity manifest, exact effective config origins, canonical cache resolution, the complete package/dependency tree and lock, host version, and non-secret settings. Unexpected sources, siblings, plugins, links, junctions, ranges, tags, URLs, local files, or hash/version/config drift are rejected. This is integrity enforcement against accidental/configuration drift, not protection from an attacker who can rewrite verified files between checks; use OS isolation for that threat.

### Immutable pure-profile authentication

The immutable fallback profile uses:

```text
OpenCode: 1.17.13
External plugins: disabled (--pure)
Builder model: openai/gpt-5.6-terra
Variant: high
Authentication: OpenCode built-in Codex OAuth transport
```

The release embeds only reviewed, nonsecret `opencode.jsonc` and `antigravity.json` files plus managed agents and skills. `XDG_CONFIG_HOME` points at the immutable release root, while built-in OAuth data remains in provider-owned OpenCode data storage. The builder and manifest never publish or hash `auth.json`, `antigravity-accounts.json`, or credential values. At runtime, isolated-role discovery may read a bounded, valid built-in `auth.json` object and pass it only as `OPENCODE_AUTH_CONTENT` to the one-shot child; it exists only in that child's environment for the lifetime of the single command and is never written to the isolated runtime disk, logged, returned, added to prompts, or persisted by the bridge. The Antigravity account file is never read by bridge code.

### Managed Gemini OAuth profile

The current local Codex entry uses the tested source `server.js` with its exact SHA-256 pin and the
managed writable OAuth profile. After editing server code, re-test it and update the server pin.
`CODEX_OPENCODE_BUILDER_MODEL_FALLBACK=true` permits one recorded switch from Muse to Gemini
for an eligible builder provider failure before any tools execute. Exact per-job model requirements
disable this switch; other agents do not receive this fallback.

The managed non-sanitized agents default to `opencode/muse-spark-1.3-contributor-free` with variant `high`. The `mcp-sanitized-reader` remains on `openai/gpt-5.6-terra` because its isolated execution forces pure mode. Gemini activation requires `CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS=true`, the exact `@cortexkit/opencode-antigravity-auth@2.2.1` allowlist, the reviewed plugin manifest hash, and a dedicated `XDG_CONFIG_HOME`. The executable still comes from a read-only published release and remains pinned by `CODEX_OPENCODE_EXPECTED_SERVER_SHA256`, but `CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256` must be unset in this hybrid mode.

`bin/fresh-healthcheck.js` supports both profiles. With a release-manifest pin it performs the complete immutable tree verification. Without that pin it verifies the exact server hash, starts a fresh MCP process, and relies on bridge health to attest the managed Gemini runtime and external-plugin policy; the result identifies this as `server-pinned` mode.

This is a deliberate reduction from full immutable-release assurance: OAuth refresh requires a writable runtime, and the managed agent and skill files in that runtime are attested against their effective OpenCode metadata but are not pinned by the release manifest. The bridge passes `--model opencode/muse-spark-1.3-contributor-free --variant high` explicitly and disables silent fallback. OpenCode `1.17.13` does not emit authoritative runtime model identity in every JSON stream, so successful live smoke tests prove the configured command and provider response, not cryptographic runtime-model attestation.

The reviewed plugin manifest requires OpenCode to report exactly `1.18.32`; upgrades require regenerating and re-pinning it. The MCP bridge does not use the optional plugin TUI, so this machine installs only the server plugin and its exact OpenCode host dependency. If the OpenCode plugin cache is cleared, rebuild that pinned server-only install from the repository root:

```powershell
$pluginCache = Join-Path $env:USERPROFILE '.cache\opencode\packages\@cortexkit\opencode-antigravity-auth@2.2.1'
New-Item -ItemType Directory -Path $pluginCache -Force | Out-Null
Copy-Item -LiteralPath '.\opencode\cortexkit-server-package.json' -Destination (Join-Path $pluginCache 'package.json') -Force
npm install --prefix $pluginCache --ignore-scripts --legacy-peer-deps
npm audit --prefix $pluginCache --omit=dev
```

This is an unofficial OAuth plugin. It stores a Google refresh token in the provider-owned local Antigravity account file and its maintainers warn that using it may violate Google's terms or lead to account restrictions. The package remains independently audited and its integrity verifier remains tested, but it is incompatible with the full immutable production profile. The bridge never reads, hashes, copies, logs, returns, or writes its account file or credentials. Only the reviewed nonsecret `opencode.jsonc` and `antigravity.json` inputs are hash-pinned. Keep debug, automatic updates, and quota/account fallback disabled; never commit the credential file, and prefer a dedicated low-privilege account.

On the Codex MCP server entry, set `startup_timeout_sec = 120` and a `tool_timeout_sec` that covers the longest job the bridge allows. Codex otherwise defaults MCP tool calls to 60 seconds, which is shorter than any real agent job. The bound is:

```text
tool_timeout_sec >= provider slot wait   (CODEX_OPENCODE_PROVIDER_WAIT_MAX_MS, default 20 min)
                  + longest agent timeout (the largest of the read-only, write, builder, orchestrator and
                                           contractor timeouts; contractor 20 min by default)
                  + validation timeout    (CODEX_OPENCODE_VALIDATION_TIMEOUT_MS, default 5 min)
                  + margin                (5 min)
```

With the built-in timeouts this is 20 + 20 + 5 + 5 = 50 min = `3000` s. With a 45 min builder (`CODEX_OPENCODE_BUILDER_TIMEOUT_MS=2700000`) and a 15 min validation (`CODEX_OPENCODE_VALIDATION_TIMEOUT_MS=900000`) it is 20 + 45 + 15 + 5 = 85 min = `5100` s, the operator's current `tool_timeout_sec`. The old figure of 1500 s is below the built-in bound. When you raise a bridge timeout, raise `tool_timeout_sec` too, or Codex abandons long jobs while they still run and their result is lost. `npm run release:activate -- --sync-clients` computes the bound from the configured environment (the same formula, using the built-in default for any timeout that is not set), warns when `tool_timeout_sec` is lower, and prints the value to use. It does not count a job's own `timeoutMs` (a job may ask for up to 24 h) or a read-only retry budget larger than every agent timeout (`CODEX_OPENCODE_READ_ONLY_RETRY_MAX_ELAPSED_MS`, 8 min by default). The bundled TUI is a separate client with its own 25-minute timeout, which is below this bound; override it with `CODEX_OPENCODE_MCP_CLIENT_TIMEOUT_MS` only when needed.

The bridge resolves `opencode` from `PATH` by default instead of using a machine-specific executable path. Portable overrides are available through `CODEX_OPENCODE_EXECUTABLE`, `CODEX_OPENCODE_AGENT_DIR`, `CODEX_OPENCODE_SKILL_DIR`, and `CODEX_OPENCODE_STATE_DIR`; production source-evidence paths are bound to the verified release as described below.

Daily releases use `npm run release:activate`: it runs the release gate (`bin/release-gate.js`, the same as `npm run test:release`: `npm test`, the concurrency test, `npm audit --omit=dev` and a health smoke of the tree's `server.js` with the configured profile), or with `--skip-tests --gate-receipt <file>` checks that a green receipt of exactly this source tree, at most 24 h old, exists; `--skip-tests` alone is refused. It then builds a new release next to the active one, updates the server path and hash in the Codex config, and restores the previous config if the fresh health check fails. The next paragraph describes the stricter fully immutable profile.

For production, point the Codex MCP entry at a new published snapshot outside the working tree and set both integrity hashes. `npm run release:build -- C:\absolute\new-release` copies only the bounded runtime, reviewed nonsecret config/settings, managed agents, and complete managed skill trees, installs `node_modules` fresh from `package-lock.json` with `npm ci` (npm and its cache or the registry must be reachable); rejects links and credential-bearing config keys; rewrites only the staged manifest paths; creates an exact-file manifest; and refuses to overwrite an existing destination. The server hash pins the entry point; the manifest hash pins every shipped file, including `bin/`, `opencode.jsonc`, `antigravity.json`, managed profiles/skills, and `node_modules`. `XDG_CONFIG_HOME`, `CODEX_OPENCODE_AGENT_DIR`, `CODEX_OPENCODE_SKILL_DIR`, and the plugin-manifest path must point at exact verified release locations, and external plugins must remain disabled. No global agent, skill, or config tree is staged or replaced during activation. Effective agents and authoritative `debug skill` names, origins, and complete trees must match before affected roles can spawn. Read-only ACL verification, atomic config replacement, fresh-process health, and automatic config rollback follow the archived manual procedure in [archive/SAFE_PUBLISH_MANIFEST.md](archive/SAFE_PUBLISH_MANIFEST.md); daily releases use `npm run release:activate`.

`CODEX_OPENCODE_WORKTREE_ROOT=global` keeps generated worktrees under the bridge state directory instead of adding `.codex-worktrees/` to each repository. SQLite lock, queue, and pipeline state is also stored under the bridge state directory in per-repository hashed databases; `.mcp/` remains reserved for an optional repository policy file and is not used for runtime databases.

`lockMode: off` on a read-only job means the agent has no write lock or write authority; the bridge still acquires a shared consistency lease. Durable queued write jobs require `CODEX_OPENCODE_WORKTREE_MODE=write` or `all` and are rejected with `queue_write_requires_worktree` otherwise.

## Behaviour after the 2026-09-29 review

- Environment values are validated at startup: a choice variable (`CODEX_OPENCODE_WORKTREE_MODE`, `..._QUEUE_MODE`, `..._LOG_LEVEL`, ...) set to an unknown value stops the bridge with a message naming the allowed values instead of silently falling back. A numeric variable that is unset or empty keeps its default; any other value must be an integer in range (a `..._MS` value at most 2147483647, the timer limit), or the bridge stops at startup naming the variable (R-137).
- Bridge git carries the operator's system/global `core.autocrlf`, `core.eol`, `core.safecrlf` and `core.symlinks` (repository-local values still win), treats every path it passes as a literal (`GIT_LITERAL_PATHSPECS=1`), and never runs repository-configured programs (`gpg.program`, `core.pager`, `core.fsmonitor` hooks, `diff.external`). Repository-local config that names such a program is refused (`git_repository_config_unsafe`).
- Integration applies the patch to an isolated index and checks out only the patch paths; a conflict fails before any file of the checkout is written. Patches are handled as bytes. Rollback restores the exact pre-apply bytes.
- The integration journal records each affected path's index entry. Recovery judges only those paths: another client staging or committing unrelated work no longer quarantines the repository, and transient errors (a locked file, a busy database, a git timeout) leave the operation for the next recovery pass instead of quarantining it. Old `repository_state_drift` and `target_head_or_index_drift` quarantines are re-checked and closed when the affected paths prove the pre-state. `diagnose_opencode_bridge` lists the journal under `integrationOperations`.
- `integrate_opencode_worktree` prints `Integration timing` (total, then each phase with its call count: whole-tree target captures, source patch captures, the fresh-index content hash inside them, simulation, apply, validation, worktree removal). The target and source captures run in parallel; an apply does five target captures and two source captures (before 2026-09-29 it did seven and three).
- `DEFAULT_FORBIDDEN_EDIT_PATHS` and the managed builder/debugger profiles also deny `.git`, `.git/**`, `**/.git`, `**/.git/**`, and a write job whose `.git/config`, hooks or worktree `.git` file changed fails with `git_control_surface_modified`.
- Forbidden-path globs support `?`, `[...]`, `[!...]`, `{a,b}` and a leading `**/` (which also matches the root). `dir/*` in `allowedEdits` means one level, not `dir/**`. A real file whose name contains `[`, `]`, `{`, `}` or `!` (`app/[slug]/page.tsx`) is accepted as a path.
- A queue or pipeline lease that lapsed (a sleeping laptop) is re-taken by its own owner. A queued writer waiting on a direct run's lock or an unresolved integration shows that cause (`integration_recovery_pending` or the lock id) and backs off up to 60 s; a lock request that can never be granted fails with `lock_request_rejected`.
- Pipelines: a dry run never changes an integration item; retryable integration failures return the item to `pending`; a writer that changed nothing counts as integrated; ignored-file changes and transient gate errors return the pipeline to `awaiting_finalization` instead of failing it.
- 429 responses are rate limits even when the message mentions billing; only explicit billing markers (`insufficient_quota`, `CreditsError`, 402) are billing errors. The builder model fallback works on Windows.
- `subagentStrategy: "direct"` is no longer accepted (a subagent run as a top-level agent falls back to the default agent); use `proxy`. Agent timeouts and lock TTLs are capped at 24 h.

## Sanitized Workspaces

`verify_sanitized_workspace` and the optional per-job `sanitizedWorkspace` contract support exact, read-only workspace waves without widening the declared root to a Git repository:

```json
{
  "root": "C:\\absolute\\sanitized-workspace",
  "manifestPath": "C:\\trusted\\sanitized-manifest.json",
  "manifestSha256": "<64-hex-sha256>",
  "requiredFiles": ["filtered/input.jsonl", "instructions.md"],
  "forbiddenFiles": ["raw/**", "**/*.xlsx", "credentials/**"]
}
```

The pinned version-1 manifest contains an exact `files` map (`relative/path` to SHA-256) and exact `directories` array. Verification rejects traversal, absolute/case-colliding/duplicate entries, additions, removals, mutations, missing required files, forbidden files, unsupported entries, symlinks, and Windows junctions/reparse links. The bridge verifies immediately before and after each single/queued/parallel wave. Sanitized jobs are always read-only, use `subagentStrategy: "reject"`, run at the exact manifest root without a Git worktree, and are automatically routed without fallback to the bridge-owned `mcp-sanitized-reader`. Its exact mode/model/variant/temperature/prompt and edit/task/bash/web/skill/external permissions are re-attested immediately before spawn.

Every bridge child forces `OPENCODE_DISABLE_PROJECT_CONFIG=true`, so a repository cannot register a local/remote MCP server, formatter, provider endpoint, or agent override through `opencode.json[c]` or `.opencode`. Sanitized children go further: they use an inline bridge-owned config with no plugins, MCP servers, LSP, formatter, sharing, external skills, or Claude compatibility; the session database is `:memory:`; and the bounded built-in OpenCode `auth.json` is supplied only through `OPENCODE_AUTH_CONTENT` in the child environment. OpenCode still creates home/cache/state/log/repository bookkeeping plus automatic tool-output and process-temp permissions, so `HOME`/`USERPROFILE`, every `XDG_*` root, and `TEMP`/`TMP`/`TMPDIR` all point into one fresh per-run runtime outside the manifest. Only that runtime's exact tool-output and `tmp/opencode` scratch directories are accepted as external-path exceptions, and the bridge overwrites and removes the whole runtime tree before it can report success. It never points either exception or an OpenCode control/state root at the original repository or shared user state.

This contract is file-level integrity, not data minimization or an OS sandbox. It cannot filter rows/columns inside CSV, JSONL, Parquet, workbooks, databases, archives, or embedded documents; those transformations must happen outside the bridge before the manifest is created. A same-user native process can still race filesystem checks, and a hard process/OS crash may require inspection of a retained uniquely prefixed temporary runtime before the next cleanup. Use a VM/container and a pure/no-network provider path for hostile or high-sensitivity inputs.

Every `CODEX_OPENCODE_*` variable that `server.js` reads is listed here with its built-in default. An unset or empty numeric value keeps its default; an invalid one stops the bridge at startup; a choice variable set to an unknown value stops the bridge at startup. Where the operator's live value differs from the default, the row says so.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_OPENCODE_READ_ONLY_AGENT_TIMEOUT_MS` | `180000` | Planner/reviewer/tester timeout. |
| `CODEX_OPENCODE_WRITE_AGENT_TIMEOUT_MS` | `600000` | Generic writer timeout. |
| `CODEX_OPENCODE_BUILDER_TIMEOUT_MS` | `900000` | Builder/debugger timeout. |
| `CODEX_OPENCODE_ORCHESTRATOR_TIMEOUT_MS` | `360000` | Per-attempt orchestrator planning timeout. It is one of the agent timeouts the client `tool_timeout_sec` bound covers (see the client timeout formula above). |
| `CODEX_OPENCODE_CONTRACTOR_TIMEOUT_MS` | `1200000` | Explicit contractor orchestration timeout; write jobs are not retried automatically. |
| `CODEX_OPENCODE_CONTRACTOR_AUTHORIZATION_SHA256` | unset | SHA-256 of the operator-held Contractor capability. Contractor mode is disabled when unset and requires the matching `contractorAuthorizationToken` plus explicit user authorization. |
| `CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS` | `false` | `false` uses `--pure` and permits full release-manifest pinning. The Gemini hybrid profile sets `true` with an exact plugin allowlist/manifest and server hash, but cannot claim full immutable-release assurance. |
| `CODEX_OPENCODE_AGENT_DIR` | global OpenCode `agents` | Managed source-profile directory. With release pins enabled this must be the verified release's `opencode/agents`. |
| `CODEX_OPENCODE_SKILL_DIR` | global OpenCode `skills` | Managed source-skill directory. With release pins enabled this must be the verified release's `opencode/skills`; affected roles reject effective name/origin/tree drift before spawn. |
| `CODEX_OPENCODE_VALIDATION_TIMEOUT_MS` | `300000` | Validation command timeout. |
| `CODEX_OPENCODE_MAX_PROCESS_OUTPUT_CHARS` | `2097152` | Per-stream subprocess capture cap. MCP results contain the bounded final response and tool outcome summary, not raw JSON events. |
| `CODEX_OPENCODE_MAX_ASSISTANT_RESPONSE_CHARS` | `131072` | Maximum assistant final response returned to MCP. |
| `CODEX_OPENCODE_REQUIRE_RUNTIME_MODEL_EVIDENCE` | `false` | When `true`, reject non-dry runs unless OpenCode emits matching root-session provider/model evidence. Configured profile metadata alone is never relabelled as runtime proof. |
| `CODEX_OPENCODE_MODEL_ALLOWLIST` | unset | Comma-separated `provider/model` or `provider/model@variant` entries a job may select through `scopeContract.modelRequirement`. A matching requirement becomes an explicit `--model`/`--variant` pin for that job and is attested against runtime evidence like any other run; a requirement that is not listed still fails with `configured_model_requirement_mismatch`. The sanitized reader is never overridable. |
| `CODEX_OPENCODE_SOURCE_DIRT_POLICY` | `strict` | `strict` rejects any uncommitted change in the source checkout before a writer worktree. `unrelated_ok` tolerates changes outside the job's locked/allowed paths (overlapping changes are still rejected) so daily work does not need a checkpoint for every unrelated edit; the tolerated files are reported on the worktree summary, and integration into that dirty target then requires `allowDirtyTarget: true` after review. A freshly created worktree must always be clean. |
| `CODEX_OPENCODE_INTEGRATION_PREVIEW_MAX_CHARS` | `12000` | Maximum exact patch preview eligible for a single-use review receipt; oversized or redacted evidence fails closed. A dry run with `previewMode: "stat"` is not subject to the cap. The operator's current value is `400000`. |
| `CODEX_OPENCODE_MAX_IGNORED_SNAPSHOT_FILES` | `20000` | Cap on ignored-file snapshot entries. Ignored files inside build/cache directories (`build/`, `dist/`, `out/`, `obj/`, `bin/`, `.venv/`, `node_modules/`, `__pycache__/`, `.pytest_cache/`, `CMakeFiles/`, `cmake-build-*/`, ...) always count as one entry per directory, fingerprinted over their member names; `.env`, `*.pem`, `*.key` and `secrets/` files keep their own entry. Only more other ignored files than this fails closed. `CODEX_OPENCODE_MAX_SNAPSHOT_FILES` counts non-ignored changed files only. Ignored contents are not read. |
| `CODEX_OPENCODE_GIT_HEAVY_TIMEOUT_MS` | `300000` | Timeout for `git worktree add/remove` and temporary-index rebuilds, which rehash the whole checkout. |
| `CODEX_OPENCODE_CONTAINMENT_RELEASE_GRACE_MS` | `600000` | A containment quarantine (unconfirmed process-tree termination) is released only after every recorded process is gone and this long has passed, because children OpenCode started are not recorded and can outlive it on Windows. |
| `CODEX_OPENCODE_MAX_SNAPSHOT_FILES` | `25000` | Fail-closed cap for the complete changed-file snapshot set. |
| `CODEX_OPENCODE_MAX_SNAPSHOT_FILE_BYTES` | `1048576` | Files above this size and secret-pattern paths use metadata-only snapshots and are never retained for rollback. |
| `CODEX_OPENCODE_MAX_SNAPSHOT_TOTAL_BYTES` | `134217728` | Aggregate rollback-content budget; execution fails closed when exceeded. |
| `CODEX_OPENCODE_WORKTREE_ROOT` | `global` | Generated worktree root under the bridge state directory; set an explicit path only when needed. |
| `CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT` | `2` | Cross-process provider/account lease limit shared by direct, queued, and parallel calls. Without an explicit `CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY`, each configured provider (OpenCode Zen builders, Google Antigravity reviewers/testers) has its own slots; the slot is taken on the provider that actually runs (a model override or the builder's Gemini fallback counts against Gemini). The operator's current value is `4`. |
| `CODEX_OPENCODE_PROVIDER_WAIT_MAX_MS` | `1200000` | How long a job may wait for a provider slot. The wait is not part of the agent's run timeout (the run clock starts when the slot is granted); a longer wait fails with `provider_slot_wait_timeout` without starting the agent. Codex's `tool_timeout_sec` must cover wait + longest agent timeout + validation + 5 min: 3000 s with the built-in timeouts, 5100 s with a 45 min builder and 15 min validation (`release-activate --sync-clients` computes it and warns). |
| `CODEX_OPENCODE_STARTUP_RECOVERY_WAIT_MS` | `120000` | The bridge answers the MCP handshake before its startup recovery; tool calls wait for the recovery this long, then return `startup_recovery_pending`. |
| `CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY` | `opencode-default-account` | Operator-defined account-pool key used by the global provider lease. |
| `CODEX_OPENCODE_QUEUE_MODE` | `sqlite` | Durable default with restart recovery and cross-process idempotency; use `memory` only for explicitly ephemeral single-process experiments. |
| `CODEX_OPENCODE_QUEUE_PARALLEL_LIMIT` | `6` | Per-process queue scheduling limit; provider/account leases impose the cross-process execution cap. |
| `CODEX_OPENCODE_QUEUE_WRITE_CONFLICT_POLICY` | `wait` | `wait` or `reject`. |
| `CODEX_OPENCODE_QUEUE_BLOCKED_POLL_MS` | `2000` | Retry interval for jobs blocked by a lock held by another bridge process. |
| `CODEX_OPENCODE_QUEUE_HEARTBEAT_MS` | `15000` | Owner-instance/job heartbeat interval. |
| `CODEX_OPENCODE_TOOL_PROGRESS_INTERVAL_MS` | `30000` | Interval of MCP progress notifications during a tool call whose request carries a `progressToken`; `0` disables them (an empty value keeps the default). Claude Code aborts a stdio tool call after 30 idle minutes, and these notifications keep a long builder job from looking idle. |
| `CODEX_OPENCODE_DEFERRED_RECOVERY_IDLE_MAX_MS` | `15000` | Longest interval between orphaned-work scans while the bridge is idle. Scans run every 5 s while any state database has non-terminal work, then back off by doubling; databases whose size and mtime are unchanged are not reopened. This bounds how long another bridge's crashed job can stay `running` before it is marked `interrupted`. |
| `CODEX_OPENCODE_QUEUE_LEASE_MS` | `60000` | Queue ownership lease; reconciliation also requires an expired instance lease and dead PID where verifiable. |
| `CODEX_OPENCODE_QUEUE_STALE_AFTER_MS` | `7200000` | Legacy/unowned pending-record age before explicit startup/operator reconciliation as `not_resumable`. |
| `CODEX_OPENCODE_QUEUE_RETENTION_DAYS` | `30` | Strictly positive terminal job/pipeline retention; `0` is rejected because no durable archive mode exists. |
| `CODEX_OPENCODE_AUDIT_RETENTION_DAYS` | `90` | Retention for finished lock/run and integration audit evidence, while active, quarantined, cleanup-pending, and referenced rows are preserved. |
| `CODEX_OPENCODE_STATE_DB_MAX_BYTES` | `2147483648` | Soft per-database live-page cap; terminal updates and cancellation remain admitted. Use an OS quota for a hard disk boundary. |
| `CODEX_OPENCODE_RETAINED_WORKTREE_MAX_COUNT` | `64` | Backpressure limit for retained worktree recovery artifacts. |
| `CODEX_OPENCODE_RETAINED_WORKTREE_MAX_BYTES` | `21474836480` | Soft retained-worktree byte cap; worktrees are never age-deleted automatically. |
| `CODEX_OPENCODE_INTEGRATION_PREVIEW_GLOBAL_MAX` | `256` | Maximum live single-use previews across this bridge process. |
| `CODEX_OPENCODE_INTEGRATION_PREVIEW_PROJECT_MAX` | `64` | Maximum live single-use previews for one canonical project. |
| `CODEX_OPENCODE_CALLER_MODEL` | `trusted_stdio` | Only the single trusted stdio principal is supported; shared/multiplexed caller configurations are rejected. |
| `CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST` | `git` | Executables a validation command may start. The daily profile uses `git,npm,node,pnpm,yarn,python,pytest`. The command is checked before any agent starts. On Windows, `npm`/`pnpm`/`yarn` batch shims run as `node <entry.js>` without a shell. `npx`, shells, and inline eval are always rejected. |
| `CODEX_OPENCODE_ATTESTATION_CACHE_TTL_MS` | `1800000` | How long agent, skill, and plugin attestation results are reused. Entries are dropped immediately when an agent file, skill file, or OpenCode config file changes. The last check before each spawn is never cached. `0` disables the cache. |
| `CODEX_OPENCODE_SYNC_MANAGED_RUNTIME` | on | When a release runs with separate `CODEX_OPENCODE_AGENT_DIR`/`SKILL_DIR`, startup copies the release's agent and skill profiles there (add and update only, never delete). `false` disables it. |
| `CODEX_OPENCODE_VALIDATION_EXECUTABLE_SHA256_ALLOWLIST` | unset | Canonical executable SHA-256 pins required for repository-policy validation. |
| `CODEX_OPENCODE_TRUSTED_POLICY_ROOT` | unset | Canonical repository root approved for policy authority. Required with the policy path and hash. |
| `CODEX_OPENCODE_TRUSTED_POLICY_PATH` | unset | Exact repo-relative policy path approved for authority. Required with the policy root and hash. |
| `CODEX_OPENCODE_TRUSTED_POLICY_SHA256` | unset | Operator-held exact hash of trusted policy bytes. Required with the policy root and path; caller arguments cannot replace it. |
| `CODEX_OPENCODE_STATE_DIR` | `<CODEX_HOME>/codex-opencode-mcp` (`CODEX_HOME` defaults to `~/.codex`) | Bridge state directory: per-repository SQLite databases, generated worktrees (with `CODEX_OPENCODE_WORKTREE_ROOT=global`), the queue encryption key and the bridge's own OpenCode home. |
| `CODEX_OPENCODE_EXECUTABLE` | `OPENCODE_EXE`, else `opencode` from `PATH` | OpenCode executable to run. |
| `CODEX_OPENCODE_EXPECTED_SERVER_SHA256` | unset | When set, startup fails unless `server.js` has exactly this SHA-256. Used by both the strict and the server-pinned Gemini profile; `release:activate --sync-clients` re-pins it. |
| `CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256` | unset | Strict immutable-release pin: the SHA-256 (64 hex characters) of the release manifest. When set, startup verifies every shipped file, requires external plugins to be off, and requires the agent, skill and config paths to be release subtrees. Must stay unset in the Gemini hybrid profile. |
| `CODEX_OPENCODE_EXTERNAL_PLUGIN_ALLOWLIST` | unset | Comma-separated exact `name@version` plugins allowed when `CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS=true`. |
| `CODEX_OPENCODE_PLUGIN_MANIFEST_PATH` | unset | Path of the plugin integrity manifest. Required, with the next variable, when external plugins are allowed. |
| `CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256` | unset | SHA-256 of that plugin integrity manifest; `release:activate --sync-clients` re-pins it. |
| `CODEX_OPENCODE_MCP_ORCHESTRATOR_AGENT` | `opencode-orchestrator-mcp-planner` | Agent a requested `orchestrator` resolves to (read-only planner). Change only when a release ships different file names. |
| `CODEX_OPENCODE_MCP_CONTRACTOR_ORCHESTRATOR_AGENT` | `opencode-orchestrator-mcp-contractor` | Agent used in explicit contractor mode. Same rule. |
| `CODEX_OPENCODE_BUILDER_MODEL_FALLBACK` | unset (off) | Only the value `true` permits one recorded switch from the builder's model to Gemini (`google/antigravity-gemini-3.8-flash`, variant `high`) after an eligible provider failure before any tool ran. Not for dry runs, jobs with an exact model requirement, or other agents. |
| `CODEX_OPENCODE_PASSTHROUGH_ENV` | unset | Comma-separated names of extra environment variables passed to OpenCode child processes. Without it only a fixed base set is passed (`PATH`, home, temp and `XDG_*` folders, locale). A name that looks like a secret (api key, token, auth, credential, password, secret, private key) is still dropped unless `CODEX_OPENCODE_ALLOW_SENSITIVE_ENV=true`. |
| `CODEX_OPENCODE_ALLOW_SENSITIVE_ENV` | unset (off) | Only the value `true` lets secret-looking names listed in `CODEX_OPENCODE_PASSTHROUGH_ENV` reach OpenCode. |
| `CODEX_OPENCODE_LOG_LEVEL` | `warn` | `off`, `error`, `warn`, `info` or `debug`: the lowest level of the JSON log lines the bridge writes to stderr. |
| `CODEX_OPENCODE_WORKTREE_MODE` | `off` | `off` runs jobs in the checkout; `write` runs every write job in an isolated worktree; `all` also runs read-only jobs in one. Contractor jobs always use a worktree, and queued write jobs need `write` or `all` (`queue_write_requires_worktree`). Production uses `write`. |
| `CODEX_OPENCODE_WORKTREE_CLEANUP` | `never` | `always`, `on_success` or `never`. Legacy: the bridge validates it and shows it in `get_opencode_bridge_status`, but it changes no behaviour. An executed writer worktree is kept until reviewed integration (see `cleanupAfterSuccess`), and a job that changed no files has its worktree removed at once. |
| `CODEX_OPENCODE_WORKTREE_BRANCH_PREFIX` | `agent` | First part of the local branch name of a writer worktree (`<prefix>/<role>/<job>`). |
| `CODEX_OPENCODE_DEFAULT_READ_LOCK_MODE` | `off` | Lock mode of a read-only job that names none. `off` is the only accepted value. |
| `CODEX_OPENCODE_DEFAULT_WRITE_LOCK_MODE` | `simple` | `simple` or `strict`: lock mode of a write job that names none. |
| `CODEX_OPENCODE_DEFAULT_PARALLEL_WRITE_LOCK_MODE` | `strict` | Lock mode of parallel writers. `strict` is the only accepted value. |
| `CODEX_OPENCODE_READ_ONLY_AGENT_MAX_RETRIES` | `2` | Retries (after the first attempt) of a read-only agent after a transient provider error; `0` turns them off. Writers are never retried. |
| `CODEX_OPENCODE_READ_ONLY_RETRY_BASE_DELAY_MS` | `1000` | Base of the exponential back-off between read-only retries (doubles per attempt, plus jitter; a longer provider Retry-After wins). |
| `CODEX_OPENCODE_READ_ONLY_RETRY_MAX_ELAPSED_MS` | `480000` | Time budget for all attempts of one read-only run, retries and back-off included. It is never shorter than the run's own agent timeout. The client-timeout check in `release:activate` does not add it. |
| `CODEX_OPENCODE_QUEUE_READONLY_RETRIES` | `0` | Unsupported: any other value stops the bridge at startup, because retries happen inside read-only execution. |
| `CODEX_OPENCODE_QUEUE_WRITE_RETRIES` | `0` | Unsupported in the same way. |
| `CODEX_OPENCODE_QUEUE_RESULT_MAX_CHARS` | `24000` | Longest stored queue result; a longer one keeps its start and its end and drops the middle. |
| `CODEX_OPENCODE_PARALLEL_LIMIT` | `6` | Most jobs one `run_opencode_parallel` call (or one `validate_delegation_plan` batch) accepts; a larger batch is rejected with `parallel_plan_rejected`. The provider limit applies separately. |
| `CODEX_OPENCODE_PROVIDER_LEASE_MS` | `240000` | Provider slot lease: a holder that stops renewing it loses the slot after this long. |
| `CODEX_OPENCODE_PROVIDER_HEARTBEAT_MS` | `20000` | How often a running job renews its provider lease (at most a third of the lease). |
| `CODEX_OPENCODE_PROVIDER_LEASE_POLL_MS` | `250` | Base interval for polling a busy provider while a job waits for a slot (random jitter up to the same amount is added). |
| `CODEX_OPENCODE_POLICY_MAX_BYTES` | `131072` | Largest accepted `.mcp/agent-policy.json` or sanitized-workspace manifest file. |
| `CODEX_OPENCODE_SANITIZED_MAX_FILES` | `25000` | Most files (and most manifest entries or directories) in a sanitized workspace. |
| `CODEX_OPENCODE_SANITIZED_MAX_BYTES` | `1073741824` | Most total bytes of the files in a sanitized workspace. |
| `CODEX_OPENCODE_TERMINAL_JOB_MAX_ROWS` | `50000` | Finished job rows kept per state database; older finished jobs are pruned (unfinished jobs and jobs that belong to a pipeline are kept). |
| `CODEX_OPENCODE_TERMINAL_PIPELINE_MAX_ROWS` | `10000` | Finished pipeline rows kept per state database. |
| `CODEX_OPENCODE_TERMINAL_INTEGRATION_MAX_ROWS` | `10000` | Finished integration-operation rows kept per state database (unresolved and quarantined operations are kept). |

## Operational Boundaries

- Bridge-owned Git commands run with a reduced environment, system/global configuration disabled, credential prompting disabled, and a process-unique nonexistent `core.hooksPath`. On Windows the bridge also forces `core.longpaths=true` for its own Git commands and its OpenCode children, because generated worktree roots plus repository-relative paths routinely exceed the legacy 260-character limit and global Git configuration is intentionally ignored. Repository-local filter/diff/merge drivers, credential/header rewrites, executable core controls, and config includes are rejected as `git_repository_config_unsafe` before worktree creation or patch capture. Worktrees start from a pinned committed `HEAD` and tree. Under the default `CODEX_OPENCODE_SOURCE_DIRT_POLICY=strict`, any source dirt—including unrelated dirt—is rejected as `dirty_worktree_requires_checkpoint`; `unrelated_ok` tolerates dirt outside the job scope and reports it. A newly created worktree that is not immediately clean is rejected as `worktree_created_dirty` and retained as evidence.
- Executed writer worktrees are never removed by the job/queue/parallel cleanup setting. They remain the review and recovery source until receipt-bound integration with a passing validation gate, which removes a bridge-created worktree by default (`cleanupAfterSuccess: false` keeps it). Every durable queued writer is worktree-isolated so a child that survives an owner crash cannot modify the target checkout.
- SQLite queue acceptance persists an AES-256-GCM encrypted replay request before publishing the job to the in-process scheduler. Job results, pipeline details, and integration rollback preimages are encrypted with the same state-root key while list records keep hashes/lengths only. The separate 32-byte `queue-request.key` is required for restart recovery and backup; contractor capability tokens are removed before encryption. Rotating legacy backups/WAL copies remains an operator responsibility. Supply a stable `idempotencyKey` so an identical resubmission returns the original job and a changed request fails with `queue_idempotency_conflict`. Startup and periodic recovery take over only after both durable owner leases expire, and integration journal recovery runs before project jobs are scheduled. Legacy rows without encrypted payloads remain explicitly `not_resumable`.
- Terminal retention defaults to 30 days and audit retention to 90 days; both must be positive. Row/live-byte/preview/worktree caps apply backpressure without deleting active, quarantined, cleanup-pending, referenced, or retained recovery evidence. Provider leases heartbeat every 20 seconds and expire after four minutes without renewal, keeping crash recovery within the five-minute objective while tolerating short local stalls.
- A successful OpenCode process must emit a non-empty terminal JSON text event. Exit code 0 without a final response is rejected as `agent_empty_final_response`.
- Transient 429/5xx/transport/timeouts are retried only for read-only work with no completed tool outcome, using one bounded exponential-backoff/jitter/Retry-After controller and one elapsed-time budget. Writes, hard quota, auth/OAuth refresh, billing, model/configuration errors, truncation, and structured terminal errors are never retried. Queue retries do not multiply the inner policy.
- The active agent debug record is used to pin `--model provider/model` and `--variant`; configured and runtime-observed evidence are reported separately. Silent bridge fallback is disabled.
- Raw process-capture or assistant-final truncation is terminal `essential_output_truncated`; bounded head/tail evidence and stream hashes/counts are retained rather than reporting a false success. If only durable result storage cannot hold the agent's report within `CODEX_OPENCODE_QUEUE_RESULT_MAX_CHARS` (the patch preview and the bridge preamble are given up first, see above), the job remains `completed` with `completionOutcome: "completed_with_truncated_output"`, and the bounded text, original character count, SHA-256, and truncation flag are retained.
- Running queue cancellation owned by a live bridge terminates the exact spawned OpenCode process tree through an independently heartbeated supervisor, then records `agent_cancelled`. Hard-lock, queue-ownership, and provider-capacity renewal failures abort active children before the last confirmed lease expires; a single transient failure is tolerated. If containment cannot be confirmed, the provider lease and hard lock are durably quarantined instead of being released. POSIX uses a verified process group; Windows `taskkill /T /F` remains best-effort without a native Job Object helper. A dead-owner orphan is terminalized from lease evidence without blindly killing a possibly reused PID, and any orphaned writer remains confined to its retained worktree.
- Cross-process cancellation uses a bounded revision/owner CAS loop: a claim race is reloaded as an active cancellation request, and a stale cancellation snapshot cannot replace newer worktree or containment evidence. A terminal pipeline child transactionally fails/cancels its parent, cancels inactive siblings, requests cancellation of active siblings, and later claims reject children whose released parent is no longer running.
- Every non-read hard-lock acquisition checks the durable integration journal in the same SQLite transaction. An unresolved or quarantined operation blocks writers until recovery reaches `committed`, `rolled_back`, or `recovered_noop`, or an operator closes a quarantine with `resolve_integration_quarantine` (`recovered_verified` after the exact pre-state is proven, `resolved_by_operator` with a recorded reason). Retention never prunes those two: their rows and pre-images are the audit trail. Queue heartbeats touch only databases with locally owned active jobs/pipelines, and periodic maintenance processes one known database per tick to avoid cumulative event-loop stalls.
- `cwd` scopes project state but is not caller authorization. This release supports one trusted stdio principal only and rejects a shared/multiplexed caller model; deploy separate OS principals/bridge instances if callers do not mutually trust one another.
- Path-only change evidence is never enough to overwrite a user or concurrent process. Ordinary job/parallel violations retain affected workspace/worktree files as unresolved evidence. Receipt-bound integration rolls back only bytes that still exactly match the bridge-owned post-patch snapshot; ambiguous mutations are retained and reported.
- Validation commands use a minimal credential-free environment and an operator executable allowlist. An approved `npm test` still executes repository code and therefore remains an authorization decision, not a sandbox.
- The bridge is a coordination and change-scope boundary, not an operating-system sandbox. Do not use it to execute untrusted or malicious repositories outside an appropriate VM/container.
- Node may print an experimental `node:sqlite` warning. On the supported Node version this is expected; test failure is determined by the command exit code and assertions, not that warning.
