# Codex OpenCode MCP Bridge

This bridge lets Codex call OpenCode agents through MCP while keeping Codex as the final orchestrator and reviewer.

One-sentence architecture: Codex decides what to delegate and merge, MCP Bridge enforces scope/routing/scheduling/validation, and OpenCode agents execute bounded tasks.

For the concise operator decision tree, agent roles, daily workflow, and release checklist, read [docs/OPERATOR_QUICKSTART.md](docs/OPERATOR_QUICKSTART.md). Production uses `server.js`; `server.v2.js` remains an explicitly gated experimental modularization target.

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

## Main Tools

- `get_opencode_bridge_status`: run the quick daily OpenCode/Git/agent/config check. Pass `deep: true` for full managed-role attestation during activation or audits; every actual agent execution still re-attests its selected role immediately before spawn.
- `validate_delegation_plan`: preflight one or more jobs without running OpenCode or acquiring locks.
- `run_opencode_agent`: run one bounded OpenCode agent.
- `run_opencode_parallel`: run independent jobs only when their write scopes are safe.
- `enqueue_opencode_job`: schedule a job through the MCP queue.
- `diagnose_opencode_bridge`: show correlated jobs, pipelines, locks, provider leases, preserved work, retry safety, and recovery actions for one repository.
- `create_multi_agent_pipeline`: create an audited multi-agent plan with ownership, worktree, integration, and final-validation checks.
- `run_multi_agent_pipeline`: enqueue planned pipeline jobs.
- `get_multi_agent_pipeline` / `list_multi_agent_pipelines`: inspect pipeline status, queue jobs, integrations, and audit events.
- `abandon_multi_agent_pipeline`: explicitly terminalize an inactive obsolete pipeline after exact-id confirmation. It never deletes unintegrated worktrees.
- `integrate_opencode_worktree`: dry-run or serially integrate one reviewed worktree/branch.
- `finalize_multi_agent_pipeline`: run final validation and optional reviewer/tester gates.
- `acquire_agent_lock` / `release_agent_lock`: exceptional manual cleanup/debugging only.

`run_opencode_parallel` is a synchronous barrier. It returns terminal results for the direct jobs and measured overlap, not queue job IDs; callers must not poll `get_opencode_job` for those results. Use queue or pipeline tools when jobs must be monitored or cancelled independently.

## Orchestrator Modes

By default, a requested OpenCode `orchestrator` is routed to the dedicated `mcp-orchestrator`. That agent is read-only and has OpenCode's `task` permission denied, so it cannot launch nested writers. Codex remains the coordinator and calls bounded workers directly.

The managed `planner`, `architect`, `reviewer`, and `tester` agents also deny both edits and nested subagent launches.
Known write-capable agents such as `builder` and `debugger` are rejected under read-only locks; use them only as bounded worktree writers.

Contractor mode is disabled until the operator configures `CODEX_OPENCODE_CONTRACTOR_AUTHORIZATION_SHA256`. When the user explicitly requests the OpenCode Orchestrator by name for the current task, Codex may opt in with all three fields:

```text
orchestratorMode: contractor
userAuthorizedOrchestrator: true
contractorAuthorizationToken: <operator-held secret matching the configured hash>
```

The Bridge then routes the one outer job to `mcp-contractor-orchestrator`. That parent cannot edit, invoke a shell, or load skills; it may coordinate only an allowlisted set of OpenCode worker, planning, review, and test agents, and delegates repository commands or validation to those bounded subagents. Recursive orchestrator calls are denied by OpenCode task permissions. Because nested task execution has no interactive permission-response channel, every managed nested role defaults shell access to deny and exposes only the bridge-reviewed exact Git diagnostic allowlist. The Bridge isolates OpenCode's legacy home and every XDG control/state root, attests the exact parent and every allowlisted nested profile initially and immediately before execution, and uses an in-memory OpenCode session database. The whole contract must be a single bounded write job with explicit `lockedPaths`, `allowedEdits`, a write Scope Contract, and validation. It always runs in an isolated worktree, which is retained for Codex review and explicit integration. The Bridge independently runs the final validation gate even when a subagent reports its own check.

```text
User explicitly authorizes OpenCode Orchestrator
-> Codex creates one bounded contract
-> MCP contractor orchestrator
-> internal OpenCode subagents
-> consolidated diff/report
-> Codex review and integration decision
```

Contractor mode is rejected when the capability is unconfigured/invalid or the explicit authorization flag is absent, and it cannot be placed in `run_opencode_parallel` or a multi-job pipeline. The plaintext token is neither returned nor persisted. MCP validates the aggregate contract and final changed files; it does not expose per-subagent locks inside OpenCode, so use this mode only when the user deliberately chooses the broker workflow.

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
-> integrate_opencode_worktree(reviewed: true, previewReceipt: <exact receipt>, cleanupAfterSuccess: true)
-> validationCommand runs
-> rollback on validation failure
-> source is re-hashed; cleanup occurs only after an explicit passing gate
```

Non-dry-run integration without both `reviewed: true` and the exact unexpired preview receipt is rejected. Any source or target mutation after preview returns `integration_preview_stale`. Source cleanup is opt-in, requires `validationGate.status === "passed"`, and rechecks the source patch immediately before removal. Branch cleanup uses an exact expected-object `update-ref` deletion; a branch moved or recreated during cleanup is retained and reported as partial. Pipeline cleanup is deferred until final validation, reviewer, and tester gates all succeed. Failed, partial, unreviewed, and not-yet-integrated worktrees are retained.

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

## LangGraph TUI

Run:

```powershell
npm run tui
```

The TUI uses `@langchain/langgraph` to drive the lifecycle menu and starts this bridge as a stdio MCP client. It shows bounded pipeline/job state, agent strategy, task hash/length, the exact provider/model/variant requested from active OpenCode debug configuration, separately available runtime-observed evidence, context/scope, locks, allowed edits, validation command, retained worktree identity, changed files, integration queue, final gates, and audit events. OpenCode's JSON event stream may not expose authoritative runtime model metadata, so the bridge never relabels a configured CLI pin as runtime attestation.

The TUI shows operational context and model metadata. It does not expose private chain-of-thought.

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
CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT=2
CODEX_OPENCODE_QUEUE_HEARTBEAT_MS=15000
CODEX_OPENCODE_QUEUE_LEASE_MS=60000
CODEX_OPENCODE_QUEUE_RETENTION_DAYS=30
CODEX_OPENCODE_AUDIT_RETENTION_DAYS=90
CODEX_OPENCODE_PROVIDER_LEASE_MS=240000
CODEX_OPENCODE_PROVIDER_HEARTBEAT_MS=20000
CODEX_OPENCODE_QUEUE_RESULT_MAX_CHARS=8000
CODEX_OPENCODE_INTEGRATION_PREVIEW_MAX_CHARS=12000
CODEX_OPENCODE_EXPECTED_SERVER_SHA256=<sha256-of-the-published-server.js>
CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256=<sha256-of-release-manifest.json>
```

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

The managed non-sanitized agents default to `google/antigravity-gemini-3.8-flash` with variant `high`. The `mcp-sanitized-reader` remains on `openai/gpt-5.6-terra` because its isolated execution forces pure mode. Gemini activation requires `CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS=true`, the exact `@cortexkit/opencode-antigravity-auth@2.2.1` allowlist, the reviewed plugin manifest hash, and a dedicated `XDG_CONFIG_HOME`. The executable still comes from a read-only published release and remains pinned by `CODEX_OPENCODE_EXPECTED_SERVER_SHA256`, but `CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256` must be unset in this hybrid mode.

`bin/fresh-healthcheck.js` supports both profiles. With a release-manifest pin it performs the complete immutable tree verification. Without that pin it verifies the exact server hash, starts a fresh MCP process, and relies on bridge health to attest the managed Gemini runtime and external-plugin policy; the result identifies this as `server-pinned` mode.

This is a deliberate reduction from full immutable-release assurance: OAuth refresh requires a writable runtime, and the managed agent and skill files in that runtime are attested against their effective OpenCode metadata but are not pinned by the release manifest. The bridge passes `--model google/antigravity-gemini-3.8-flash --variant high` explicitly and disables silent fallback. OpenCode `1.17.13` does not emit authoritative runtime model identity in every JSON stream, so successful live smoke tests prove the configured command and provider response, not cryptographic runtime-model attestation.

The reviewed plugin manifest requires OpenCode to report exactly `1.17.13`; upgrades require regenerating and re-pinning it. The MCP bridge does not use the optional plugin TUI, so this machine installs only the server plugin and its exact OpenCode host dependency. If the OpenCode plugin cache is cleared, rebuild that pinned server-only install from the repository root:

```powershell
$pluginCache = Join-Path $env:USERPROFILE '.cache\opencode\packages\@cortexkit\opencode-antigravity-auth@2.2.1'
New-Item -ItemType Directory -Path $pluginCache -Force | Out-Null
Copy-Item -LiteralPath '.\opencode\cortexkit-server-package.json' -Destination (Join-Path $pluginCache 'package.json') -Force
npm install --prefix $pluginCache --ignore-scripts --legacy-peer-deps
npm audit --prefix $pluginCache --omit=dev
```

This is an unofficial OAuth plugin. It stores a Google refresh token in the provider-owned local Antigravity account file and its maintainers warn that using it may violate Google's terms or lead to account restrictions. The package remains independently audited and its integrity verifier remains tested, but it is incompatible with the full immutable production profile. The bridge never reads, hashes, copies, logs, returns, or writes its account file or credentials. Only the reviewed nonsecret `opencode.jsonc` and `antigravity.json` inputs are hash-pinned. Keep debug, automatic updates, and quota/account fallback disabled; never commit the credential file, and prefer a dedicated low-privilege account.

On the Codex MCP server entry, set `startup_timeout_sec = 120` and `tool_timeout_sec = 1500`. Codex otherwise defaults MCP tool calls to 60 seconds, which is shorter than the bridge's builder and orchestrator limits. The bundled TUI uses the same 25-minute client timeout; override it with `CODEX_OPENCODE_MCP_CLIENT_TIMEOUT_MS` only when needed.

The bridge resolves `opencode` from `PATH` by default instead of using a machine-specific executable path. Portable overrides are available through `CODEX_OPENCODE_EXECUTABLE`, `CODEX_OPENCODE_AGENT_DIR`, `CODEX_OPENCODE_SKILL_DIR`, and `CODEX_OPENCODE_STATE_DIR`; production source-evidence paths are bound to the verified release as described below.

For production, point the Codex MCP entry at a new published snapshot outside the working tree and set both integrity hashes. `npm run release:build -- C:\absolute\new-release` copies only the bounded runtime, reviewed nonsecret config/settings, managed agents, and complete managed skill trees; rejects links and credential-bearing config keys; rewrites only the staged manifest paths; creates an exact-file manifest; and refuses to overwrite an existing destination. The server hash pins the entry point; the manifest hash pins every shipped file, including `bin/`, `opencode.jsonc`, `antigravity.json`, managed profiles/skills, and `node_modules`. `XDG_CONFIG_HOME`, `CODEX_OPENCODE_AGENT_DIR`, `CODEX_OPENCODE_SKILL_DIR`, and the plugin-manifest path must point at exact verified release locations, and external plugins must remain disabled. No global agent, skill, or config tree is staged or replaced during activation. Effective agents and authoritative `debug skill` names, origins, and complete trees must match before affected roles can spawn. Read-only ACL verification, atomic config replacement, fresh-process health, and automatic config rollback follow [docs/SAFE_PUBLISH_MANIFEST.md](docs/SAFE_PUBLISH_MANIFEST.md).

`CODEX_OPENCODE_WORKTREE_ROOT=global` keeps generated worktrees under the bridge state directory instead of adding `.codex-worktrees/` to each repository. SQLite lock, queue, and pipeline state is also stored under the bridge state directory in per-repository hashed databases; `.mcp/` remains reserved for an optional repository policy file and is not used for runtime databases.

`lockMode: off` on a read-only job means the agent has no write lock or write authority; the bridge still acquires a shared consistency lease. Durable queued write jobs require `CODEX_OPENCODE_WORKTREE_MODE=write` or `all` and are rejected with `queue_write_requires_worktree` otherwise.

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

Useful defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_OPENCODE_READ_ONLY_AGENT_TIMEOUT_MS` | `180000` | Planner/reviewer/tester timeout. |
| `CODEX_OPENCODE_WRITE_AGENT_TIMEOUT_MS` | `600000` | Generic writer timeout. |
| `CODEX_OPENCODE_BUILDER_TIMEOUT_MS` | `900000` | Builder/debugger timeout. |
| `CODEX_OPENCODE_ORCHESTRATOR_TIMEOUT_MS` | `360000` | Per-attempt orchestrator planning timeout; three attempts remain within the 25-minute MCP client limit. |
| `CODEX_OPENCODE_CONTRACTOR_TIMEOUT_MS` | `1200000` | Explicit contractor orchestration timeout; write jobs are not retried automatically. |
| `CODEX_OPENCODE_CONTRACTOR_AUTHORIZATION_SHA256` | unset | SHA-256 of the operator-held Contractor capability. Contractor mode is disabled when unset and requires the matching `contractorAuthorizationToken` plus explicit user authorization. |
| `CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS` | `false` | `false` uses `--pure` and permits full release-manifest pinning. The Gemini hybrid profile sets `true` with an exact plugin allowlist/manifest and server hash, but cannot claim full immutable-release assurance. |
| `CODEX_OPENCODE_AGENT_DIR` | global OpenCode `agents` | Managed source-profile directory. With release pins enabled this must be the verified release's `opencode/agents`. |
| `CODEX_OPENCODE_SKILL_DIR` | global OpenCode `skills` | Managed source-skill directory. With release pins enabled this must be the verified release's `opencode/skills`; affected roles reject effective name/origin/tree drift before spawn. |
| `CODEX_OPENCODE_VALIDATION_TIMEOUT_MS` | `300000` | Validation command timeout. |
| `CODEX_OPENCODE_MAX_PROCESS_OUTPUT_CHARS` | `2097152` | Per-stream subprocess capture cap. MCP results contain the bounded final response and tool outcome summary, not raw JSON events. |
| `CODEX_OPENCODE_MAX_ASSISTANT_RESPONSE_CHARS` | `131072` | Maximum assistant final response returned to MCP. |
| `CODEX_OPENCODE_REQUIRE_RUNTIME_MODEL_EVIDENCE` | `false` | When `true`, reject non-dry runs unless OpenCode emits matching root-session provider/model evidence. Configured profile metadata alone is never relabelled as runtime proof. |
| `CODEX_OPENCODE_INTEGRATION_PREVIEW_MAX_CHARS` | `12000` | Maximum exact patch preview eligible for a single-use review receipt; oversized or redacted evidence fails closed. |
| `CODEX_OPENCODE_MAX_IGNORED_SNAPSHOT_FILES` | `20000` | Fail-closed cap for metadata-only ignored-file snapshots; ignored contents are not read. |
| `CODEX_OPENCODE_MAX_SNAPSHOT_FILES` | `25000` | Fail-closed cap for the complete changed-file snapshot set. |
| `CODEX_OPENCODE_MAX_SNAPSHOT_FILE_BYTES` | `1048576` | Files above this size and secret-pattern paths use metadata-only snapshots and are never retained for rollback. |
| `CODEX_OPENCODE_MAX_SNAPSHOT_TOTAL_BYTES` | `134217728` | Aggregate rollback-content budget; execution fails closed when exceeded. |
| `CODEX_OPENCODE_WORKTREE_ROOT` | `global` | Generated worktree root under the bridge state directory; set an explicit path only when needed. |
| `CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT` | `2` | Cross-process provider/account lease limit shared by direct, queued, and parallel calls. |
| `CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY` | `opencode-default-account` | Operator-defined account-pool key used by the global provider lease. |
| `CODEX_OPENCODE_QUEUE_MODE` | `sqlite` | Durable default with restart recovery and cross-process idempotency; use `memory` only for explicitly ephemeral single-process experiments. |
| `CODEX_OPENCODE_QUEUE_PARALLEL_LIMIT` | `6` | Per-process queue scheduling limit; provider/account leases impose the cross-process execution cap. |
| `CODEX_OPENCODE_QUEUE_WRITE_CONFLICT_POLICY` | `wait` | `wait` or `reject`. |
| `CODEX_OPENCODE_QUEUE_BLOCKED_POLL_MS` | `2000` | Retry interval for jobs blocked by a lock held by another bridge process. |
| `CODEX_OPENCODE_QUEUE_HEARTBEAT_MS` | `15000` | Owner-instance/job heartbeat interval. |
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
| `CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST` | `git` | Operator allowlist for validation executables; add `npm` deliberately when reviewed project scripts are required. |
| `CODEX_OPENCODE_VALIDATION_EXECUTABLE_SHA256_ALLOWLIST` | unset | Canonical executable SHA-256 pins required for repository-policy validation. |
| `CODEX_OPENCODE_TRUSTED_POLICY_ROOT` | unset | Canonical repository root approved for policy authority. Required with the policy path and hash. |
| `CODEX_OPENCODE_TRUSTED_POLICY_PATH` | unset | Exact repo-relative policy path approved for authority. Required with the policy root and hash. |
| `CODEX_OPENCODE_TRUSTED_POLICY_SHA256` | unset | Operator-held exact hash of trusted policy bytes. Required with the policy root and path; caller arguments cannot replace it. |

## Operational Boundaries

- Bridge-owned Git commands run with a reduced environment, system/global configuration disabled, credential prompting disabled, and a process-unique nonexistent `core.hooksPath`. Repository-local filter/diff/merge drivers, credential/header rewrites, executable core controls, and config includes are rejected as `git_repository_config_unsafe` before worktree creation or patch capture. Worktrees start from a pinned committed `HEAD` and tree. Any source dirt—including unrelated dirt—is rejected as `dirty_worktree_requires_checkpoint`; a newly created worktree that is not immediately clean is rejected as `worktree_created_dirty` and retained as evidence.
- Executed writer worktrees are never removed by the job/queue/parallel cleanup setting. They remain the review and recovery source until receipt-bound integration and explicit validated cleanup. Every durable queued writer is worktree-isolated so a child that survives an owner crash cannot modify the target checkout.
- SQLite queue acceptance persists an AES-256-GCM encrypted replay request before publishing the job to the in-process scheduler. Job results, pipeline details, and integration rollback preimages are encrypted with the same state-root key while list records keep hashes/lengths only. The separate 32-byte `queue-request.key` is required for restart recovery and backup; contractor capability tokens are removed before encryption. Rotating legacy backups/WAL copies remains an operator responsibility. Supply a stable `idempotencyKey` so an identical resubmission returns the original job and a changed request fails with `queue_idempotency_conflict`. Startup and periodic recovery take over only after both durable owner leases expire, and integration journal recovery runs before project jobs are scheduled. Legacy rows without encrypted payloads remain explicitly `not_resumable`.
- Terminal retention defaults to 30 days and audit retention to 90 days; both must be positive. Row/live-byte/preview/worktree caps apply backpressure without deleting active, quarantined, cleanup-pending, referenced, or retained recovery evidence. Provider leases heartbeat every 20 seconds and expire after four minutes without renewal, keeping crash recovery within the five-minute objective while tolerating short local stalls.
- A successful OpenCode process must emit a non-empty terminal JSON text event. Exit code 0 without a final response is rejected as `agent_empty_final_response`.
- Transient 429/5xx/transport/timeouts are retried only for read-only work with no completed tool outcome, using one bounded exponential-backoff/jitter/Retry-After controller and one elapsed-time budget. Writes, hard quota, auth/OAuth refresh, billing, model/configuration errors, truncation, and structured terminal errors are never retried. Queue retries do not multiply the inner policy.
- The active agent debug record is used to pin `--model provider/model` and `--variant`; configured and runtime-observed evidence are reported separately. Silent bridge fallback is disabled.
- Raw process-capture or assistant-final truncation is terminal `essential_output_truncated`; bounded head/tail evidence and stream hashes/counts are retained rather than reporting a false success. If only durable queue-result storage exceeds `CODEX_OPENCODE_QUEUE_RESULT_MAX_CHARS`, the job remains `completed` with `completionOutcome: "completed_with_truncated_output"`, and the bounded text, original character count, SHA-256, and truncation flag are retained.
- Running queue cancellation owned by a live bridge terminates the exact spawned OpenCode process tree through an independently heartbeated supervisor, then records `agent_cancelled`. Hard-lock, queue-ownership, and provider-capacity renewal failures abort active children before the last confirmed lease expires; a single transient failure is tolerated. If containment cannot be confirmed, the provider lease and hard lock are durably quarantined instead of being released. POSIX uses a verified process group; Windows `taskkill /T /F` remains best-effort without a native Job Object helper. A dead-owner orphan is terminalized from lease evidence without blindly killing a possibly reused PID, and any orphaned writer remains confined to its retained worktree.
- Cross-process cancellation uses a bounded revision/owner CAS loop: a claim race is reloaded as an active cancellation request, and a stale cancellation snapshot cannot replace newer worktree or containment evidence. A terminal pipeline child transactionally fails/cancels its parent, cancels inactive siblings, requests cancellation of active siblings, and later claims reject children whose released parent is no longer running.
- Every non-read hard-lock acquisition checks the durable integration journal in the same SQLite transaction. An unresolved or quarantined operation blocks writers until recovery reaches `committed`, `rolled_back`, or `recovered_noop`. Queue heartbeats touch only databases with locally owned active jobs/pipelines, and periodic maintenance processes one known database per tick to avoid cumulative event-loop stalls.
- `cwd` scopes project state but is not caller authorization. This release supports one trusted stdio principal only and rejects a shared/multiplexed caller model; deploy separate OS principals/bridge instances if callers do not mutually trust one another.
- Path-only change evidence is never enough to overwrite a user or concurrent process. Ordinary job/parallel violations retain affected workspace/worktree files as unresolved evidence. Receipt-bound integration rolls back only bytes that still exactly match the bridge-owned post-patch snapshot; ambiguous mutations are retained and reported.
- Validation commands use a minimal credential-free environment and an operator executable allowlist. An approved `npm test` still executes repository code and therefore remains an authorization decision, not a sandbox.
- The bridge is a coordination and change-scope boundary, not an operating-system sandbox. Do not use it to execute untrusted or malicious repositories outside an appropriate VM/container.
- Node may print an experimental `node:sqlite` warning. On the supported Node version this is expected; test failure is determined by the command exit code and assertions, not that warning.

## Test

Fast daily checks (no model request):

```powershell
npm run test:quick
npm run doctor -- --cwd C:\absolute\repository
```

`doctor` verifies the configured server hash/release identity, Git availability, and every bridge state database without starting OpenCode. It fails when an expired active job or pipeline needs operator attention. Use the regular bridge status for agent discovery and the live profile smoke only when provider readiness must be proven.

```powershell
npm test
```

This runs:

```text
node --check server.js
node --check bin/tui.js
node --check bin/e2e.js
node --check bin/e2e-contractor.js
node --check bin/e2e-concurrency.js
node --check bin/mcp-robustness.js
node --check bin/state-audit.js
node --check bin/build-release.js
node --check bin/fresh-healthcheck.js
node bin/build-release.js --self-test
node bin/fresh-healthcheck.js --self-test
node bin/tui.js --smoke
node bin/state-audit.js --self-test
node bin/mcp-robustness.js
node server.js --self-test
```

Dependency security check (requires registry access):

```powershell
npm audit --omit=dev
```

Run the live, isolated A-to-Z check separately because it invokes configured OpenCode models:

```powershell
npm run test:e2e
npm run test:e2e:contractor
```

The ordinary live check creates a temporary Git repository, verifies bridge health, performs read-only orchestration, preflights and runs one scoped builder in a worktree, runs reviewer/tester gates, previews integration, integrates after review, validates the exact changed file, and then removes the temporary fixture on success. The contractor check separately exercises explicit authorization, isolated home/XDG/auth/session state, exact parent and nested-role attestation, one completed nested Builder task, reviewed integration, cleanup, and unchanged shared OpenCode data/cache metadata.

Run the cross-process concurrency stress without invoking models:

```powershell
npm run test:concurrency
```

Measure the active daily profile without invoking a model:

```powershell
$env:MCP_BENCH_CONFIG = 'C:\absolute\path\to\.codex\config.toml'
$env:MCP_BENCH_ITERATIONS = '3'
node bin/mcp-health-benchmark.js 'C:\absolute\healthy\git-checkout'
```

This benchmarks quick health by default and prints every sample plus p50/p95. Set `MCP_BENCH_DEEP=true` only when measuring the slower full activation/audit path.

This starts independent MCP server processes against temporary repositories and shared SQLite state. It verifies normal-job shared readers, reader/writer exclusion, disjoint read/write concurrency, absolute/relative/dot/separator/case path identity, rejected traversal aliases, repository-wide serial integration, overlapping/disjoint writer races, crash-orphan worktree isolation, release cleanup, SQLite busy retry behavior, and the cross-process provider/account concurrency ceiling.

For the complete deterministic local assurance suite, including dependency auditing, run:

```powershell
npm run test:assurance
```

`test:assurance` is the full release gate and includes v1, v2, concurrency, and the current dependency advisory audit. It is intentionally not the daily inner loop.

To retire an inactive obsolete pipeline without editing SQLite or deleting its recovery sources:

```powershell
npm run pipeline:abandon -- --cwd C:\absolute\repository --pipeline <pipeline-id> --confirm <pipeline-id>
```

The exact repeated id is a destructive-intent guard. Active child jobs and in-progress integration journals are rejected; cancel active jobs first. Terminal audit retention removes the resulting cancelled record later according to `CODEX_OPENCODE_QUEUE_RETENTION_DAYS`.

`npm test` now includes a protocol-robustness fixture. It sends malformed MCP frames and invalid tool arguments, confirms the bridge remains alive, proves rejected input creates no locks, crashes a process holding a short lock lease, restarts a second bridge, and verifies SQLite integrity plus foreign-key consistency. `npm run test:concurrency` also runs those SQLite checks after its multi-process stress workload.

To inspect real durable state without modifying it, run:

```powershell
npm run audit:state
```

It opens only regular top-level bridge databases plus `projects/*.sqlite` under `CODEX_OPENCODE_STATE_DIR` (or the default bridge state directory) in read-only mode and reports `integrity_check`, `foreign_key_check`, and active jobs/pipelines whose owner leases have expired. Add `-- --strict` to make expired active rows fail the command; use `-- --json` for automation. An expired row is an operational warning, not database corruption: allow normal deferred recovery to run before manual investigation.

## Full Guide

See [MCP_BRIDGE_COMPLETE_GUIDE.md](MCP_BRIDGE_COMPLETE_GUIDE.md) for detailed operating rules, manual examples, validation errors, and the final checklist.
