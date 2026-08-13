# MCP Bridge Complete Guide

## 1. One-Sentence Architecture

Codex is the primary orchestrator, the MCP Bridge is the safety/routing/scheduling/validation boundary, and OpenCode agents are bounded execution workers whose results Codex reviews before any merge.

## 2. Three Workflow Levels

| Task type | Tool | Lock | Queue | Worktree | Pipeline |
| --- | --- | --- | --- | --- | --- |
| Read-only review | `run_opencode_agent` reviewer/planner/tester/architect | off | no | no | no |
| Single small write | `validate_delegation_plan` + `run_opencode_agent` builder/debugger | simple | no | optional | no |
| Single risky write | validate + builder/debugger + reviewer/tester | simple | optional | recommended | no |
| Parallel independent writes | pipeline + queue | strict | yes | yes | yes |
| Shared-file change | serial builder/debugger | simple | optional | recommended | no/optional |
| Large feature | pipeline | strict | yes | yes | yes |

### Level 1: Simple Read-Only Task

Use for planning, review, architecture analysis, and testing analysis.

Flow:

```text
Codex
-> run_opencode_agent(planner/reviewer/tester/architect)
-> lockMode: off
-> MCP verifies no files changed
-> Codex final answer
```

Do not use queue, worktree, pipeline, or manual locks for this level.

### Level 2: Single Write Task

Use for one bounded implementation or bugfix.

Flow:

```text
Codex
-> validate_delegation_plan
-> run_opencode_agent(builder/debugger)
-> explicit Scope Contract
-> lockMode: simple
-> MCP temporary lock
-> changed-file validation
-> optional reviewer/tester
-> Codex final review
```

Do not manually acquire locks. Do not use a pipeline unless the task is large.

### Level 3: Large Or Parallel Write Task

Use for independent multi-area implementation.

Flow:

```text
Codex
-> create_multi_agent_pipeline
-> validate ownership zones
-> enqueue jobs
-> use one worktree per writer
-> strict non-overlapping allowedEdits
-> queue schedules jobs
-> MCP validates changed files
-> Codex reviews patch previews
-> integrate_opencode_worktree serially, one at a time
-> final validation
-> finalize_multi_agent_pipeline
-> Codex final decision
```

Parallel writers must never edit overlapping normalized paths.

## 3. Scope Contract As The Central Authority

Scope Contract = law. Queue = scheduler. Worktree = isolation. Lock = temporary collision guard. Changed-file validation = enforcement. Codex = final authority.

Every write job must include an explicit Scope Contract:

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

- Write jobs without a Scope Contract are rejected with `missing_scope_contract`.
- Write jobs with empty `allowedEdits` are rejected with `empty_allowed_edits`.
- `allowedEdits` must stay inside `write`.
- Results touching files outside `allowedEdits` are rejected.
- Read-only jobs that edit any file are rejected.
- `forbidden` files must never be edited.
- `shared` and `serialOnly` files require serial handling.
- Pipelines and large write tasks require final validation.

## 4. Agent Routing Rules

Use direct writer agents for write work:

- `builder`
- `debugger`

Use read-only agents for analysis:

- `planner`
- `architect`
- `reviewer`
- `tester`
- `explore`

Do not silently fall back to another agent. If fallback is allowed explicitly, the result reports the requested and actual agent.

Discovered `subagent` agents are rejected by default during preflight. `subagentStrategy: "proxy"` is a compatibility opt-in and is accepted only when the proxy's effective debug metadata proves that it cannot edit, delegate, or access external directories. The bridge pins the attested provider/model and variant on the OpenCode command and reports configured and runtime-observed model evidence separately.

Use `get_opencode_bridge_status` before the first production run or after changing OpenCode, Git, PATH, agent files, worktree settings, or queue settings. It reports executable discovery, versions, available agents, and the bridge's effective safety configuration without exposing credentials.

## 5. Read-Only Jobs

Read-only jobs use `lockMode: "off"`. They may inspect files, propose changes, review architecture, or analyze tests.

Example:

```json
{
  "agent": "reviewer",
  "task": "Review the API service for regressions.",
  "lockMode": "off",
  "scopeContract": {
    "mode": "read",
    "read": ["apps/api/**"],
    "forbidden": [".env", ".env.*"]
  }
}
```

If a read-only job edits files, MCP rejects the result and rolls back unsafe changes when possible.

## 6. Single Writer Jobs

Single writer jobs use direct `builder` or `debugger` calls with `lockMode: "simple"` and an explicit Scope Contract.

Example:

```json
{
  "agent": "builder",
  "task": "Implement the web navbar fix only.",
  "write": true,
  "lockMode": "simple",
  "lockedPaths": ["apps/web/src/nav"],
  "allowedEdits": ["apps/web/src/nav"],
  "scopeContract": {
    "mode": "write",
    "read": ["apps/web/src/nav", "packages/ui"],
    "write": ["apps/web/src/nav"],
    "allowedEdits": ["apps/web/src/nav"],
    "forbidden": [".env", ".env.*", "package-lock.json"],
    "shared": [],
    "serialOnly": [],
    "validationCommand": "git diff --check"
  }
}
```

## 7. Parallel Writer Jobs

Parallel writer jobs require strict non-overlapping `allowedEdits`.

Rules:

- Each writer needs an explicit Scope Contract.
- Each writer needs concrete, normalized `lockedPaths` and `allowedEdits`.
- Wildcard and ambiguous write paths are rejected for parallel execution.
- Overlapping write paths are rejected before execution.
- `shared` edits are rejected with `shared_file_parallel_write`.
- `serialOnly` edits are rejected with `serial_only_parallel_write`.

`run_opencode_parallel` is a synchronous barrier: it returns only after every direct child has reached a terminal state. It does not return queue IDs and its jobs cannot be polled or cancelled individually. Use queue or pipeline tools for durable operation IDs, monitoring, and per-job cancellation. Direct jobs have individual timeouts plus one group deadline; an infrastructure failure becomes that job's terminal result and does not cancel independent siblings. Writer worktrees are retained. The result reports measured execution intervals and whether jobs actually overlapped.

## 8. Queue Behavior

The queue is a scheduler, not a safety replacement.

Queue responsibilities:

- schedule jobs
- track `pending`, `blocked`, `running`, `completed`, `failed`, and `cancelled`
- wait on conflicting write scopes
- cancel pending or blocked jobs
- preserve audit trail
- coordinate large tasks

Queue does not replace:

- Scope Contract
- worktree isolation
- temporary locks
- changed-file validation
- Codex review

Read-only queued jobs can run in parallel. Write jobs with overlapping normalized write scopes wait or reject depending on `CODEX_OPENCODE_QUEUE_WRITE_CONFLICT_POLICY`.

Jobs blocked by a lock in another bridge process are polled again every `CODEX_OPENCODE_QUEUE_BLOCKED_POLL_MS` (default 2000 ms), so they resume after that external lock is released. SQLite acceptance commits an AES-256-GCM encrypted replay request before exposing the job to the scheduler; the separate state-root `queue-request.key` must be backed up with the databases. Contractor capability tokens are never persisted. A stable caller `idempotencyKey` deduplicates an identical request and rejects changed content. Each owned job records an opaque process instance, owner generation/PID, child PID evidence, heartbeat, and lease expiry; automatic locks are renewed with that heartbeat. Startup takes over queued work only after both durable owner leases expire. Legacy rows without encrypted payloads remain explicitly `not_resumable`; expired active work remains `interrupted` for manual inspection rather than unsafe automatic re-execution.

## 9. Worktree Behavior

Recommended production setting:

```text
CODEX_OPENCODE_WORKTREE_MODE=write
CODEX_OPENCODE_WORKTREE_ROOT=global
```

Worktrees are configurable, but write isolation is the professional default for real multi-agent workflows.

Rules:

- Write jobs run in generated worktrees when worktree mode is enabled.
- Worktree output is never merged automatically.
- Every executed writer worktree and local branch is retained for review, regardless of job success or the legacy cleanup setting.
- Before creating a writer worktree, any staged, unstaged, untracked, conflicted, or dirty-submodule source state fails closed as `dirty_worktree_requires_checkpoint`; the bridge never stashes, commits, resets, or overlays user changes.
- MCP returns pinned base commit/tree, patch SHA-256, changed files, diff stat, branch, and worktree path.
- Codex reviews the patch before integration.
- Integration is serial.
- Failed validation rolls back only files that still match exact bridge-owned bytes; ambiguous concurrent changes are retained and reported.

## 10. Serial Integration

Use `integrate_opencode_worktree` after Codex reviews a worktree or branch result.

Safe sequence:

```text
integrate_opencode_worktree(dryRun: true)
-> bridge returns source/target/contract digests, patch SHA-256, bounded preview, and an expiring previewReceipt
-> Codex reviews the exact preview evidence
-> integrate_opencode_worktree(reviewed: true, previewReceipt: <exact receipt>, cleanupAfterSuccess: true)
-> bridge simulates the patch in an isolated Git index and requires exact post-apply bytes
-> validationCommand runs
-> validation may not mutate even an allowed reviewed file
-> rollback only exact bridge-owned bytes; retain ambiguous external mutations
-> source is re-hashed and is removed only after an explicit passing validation gate
```

Non-dry-run integration without `reviewed: true` and the exact unexpired single-use receipt is rejected. Source, target, or contract drift after preview returns `integration_preview_stale`; oversized or credential-redacted preview evidence never receives a receipt. After apply, every reviewed file must byte-match the isolated simulation, and validation must preserve that exact snapshot. `cleanupAfterSuccess` is opt-in and is ignored unless reviewed integration and validation both succeed. Pipeline cleanup is deferred until final validation, reviewer, and tester gates pass. Failed integration or validation preserves the source worktree and never overwrites an ambiguous concurrent edit.

## 11. Pipeline Usage

Pipelines are advanced-only.

Use a pipeline only when:

- multiple agents are needed
- multiple ownership zones exist
- parallel or staged execution is useful
- final validation is required
- integration queue is needed
- worktrees are used or recommended

Do not use a pipeline for:

- a simple review
- a single small builder task
- one debugger fix
- a small documentation edit

Write pipelines require:

- explicit Scope Contracts
- `finalValidationCommand`
- non-overlapping ownership zones
- worktree policy
- serial integration
- final reviewer/tester gates when configured

Repository `.mcp/agent-policy.json` is strict, versioned, size-bounded, and tightening-only. A raw `finalValidationCommand` is never trusted merely because it is in the repository, and caller `trustedPolicySha256` is diagnostic only. The operator must pin the canonical repository in `CODEX_OPENCODE_TRUSTED_POLICY_ROOT`, the exact repo-relative path in `CODEX_OPENCODE_TRUSTED_POLICY_PATH`, the policy bytes in `CODEX_OPENCODE_TRUSTED_POLICY_SHA256`, and the canonical Git binary in `CODEX_OPENCODE_VALIDATION_EXECUTABLE_SHA256_ALLOWLIST`. Matching bytes copied to another repository or path remain untrusted. Only bounded Git read/check vectors are accepted from repository policy. Policy, executable, arguments, and provenance are revalidated before execution; any mutation or revocation fails closed.

Pipelines with fewer than two jobs are rejected with `pipeline_too_small`.

## 12. Lock Rules

Locks are temporary collision guards, not the main safety system.

Normal write workflow:

```text
run_opencode_agent
-> MCP acquires temporary lock
-> agent runs
-> MCP validates changed files
-> MCP releases lock
```

Do not use this as the normal workflow:

```text
acquire_agent_lock
-> run_opencode_agent
-> release_agent_lock
```

Manual locks exist only for exceptional cleanup/debugging. Misuse is reported as `manual_lock_misuse`.

Lock modes:

- `off`: read-only agents
- `simple`: one writer
- `strict`: parallel write preflight validation
- `serial_integration`: repository-wide exclusive integration; it conflicts with readers, writers, and other integrations even when their paths are disjoint

All manual and automatic lock paths are canonicalized to repository-relative form. Absolute and relative spellings of the same repository path therefore conflict. SQLite uses a composite path/run primary key so multiple readers can share a path while writers remain exclusive. These are renewable coordination leases, not operating-system filesystem locks; preview identity and before/after state checks reject external edits that occur outside the bridge.

## 13. Orchestrator Modes

For normal MCP calls, a requested OpenCode `orchestrator` is routed to the dedicated `mcp-orchestrator`. It is read-only and has the OpenCode `task` permission denied, which technically blocks hidden nested subagents. Codex plans, coordinates, and invokes direct workers by default.

Managed read-only planner, architect, reviewer, and tester agents deny edits and nested subagent launches as well.
Known write-capable agents such as builder and debugger cannot be routed under a read-only lock; they must use bounded write scopes and isolated worktrees.

Explicit contractor mode is disabled unless the operator configures `CODEX_OPENCODE_CONTRACTOR_AUTHORIZATION_SHA256` with the SHA-256 of an operator-held secret. When the user requests the OpenCode Orchestrator by name for the current task, Codex must send `orchestratorMode: contractor`, `userAuthorizedOrchestrator: true`, and the matching plaintext `contractorAuthorizationToken` in one `run_opencode_agent` write job. The token is checked with a timing-safe comparison and is not returned or persisted.

The contractor receives one aggregate Scope Contract with explicit locked and allowed paths. The Bridge routes it to `mcp-contractor-orchestrator`, forces an isolated worktree, and preserves the worktree for Codex review. The contractor parent cannot edit, invoke a shell, or load skills, but it may coordinate an OpenCode task-permission allowlist containing bounded builder, debugger, reviewer, tester, planner, architect, and explore agents. Nested task execution is noninteractive, so every managed nested role defaults shell access to deny and exposes only the exact bridge-reviewed Git diagnostic allowlist. The Bridge isolates legacy OpenCode home plus every XDG control/state path and attests the exact parent and every allowlisted nested profile initially and immediately before execution. The parent delegates repository commands and requested checks to those agents; the Bridge independently executes the final validation gate. Recursive orchestrator calls are denied technically. It returns one consolidated result.

Contractor mode must run alone:

```text
Explicit user request
-> Codex outer contract
-> MCP contractor orchestrator
-> internal OpenCode subagents
-> aggregate changed-file validation
-> Codex review
```

It is rejected when the capability is unconfigured/invalid, explicit authorization is absent, or the job is placed inside `run_opencode_parallel` or a multi-job pipeline. MCP sees the outer contractor and validates the aggregate lock, scope, and changed files; individual internal subagent locks are not visible to MCP. Codex must inspect the consolidated patch before integration.

## 14. Shared, Forbidden, And Serial-Only Files

`.mcp/agent-policy.json` is loaded by pipeline creation when present.

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

Rules:

- Environment and secret files are forbidden by default.
- Package manifests, lockfiles, shared packages, schema, and migrations are shared/serial by default.
- `forbiddenEdits` are always rejected when changed.
- `sharedFiles` cannot be edited by parallel writers.
- `serialOnly` files force serial execution.
- `requiresWorktrees: false` cannot weaken bridge or caller protection.
- A project validation command requires an exact operator-reviewed policy SHA-256 and an allowed executable/argument shape; `shell:false` alone is not a trust decision.
- Shell wrappers, package executors, inline interpreter evaluation, traversal, and linked policy paths are rejected. Use a VM/container for malicious repositories.

## 15. Validation And Errors

Structured errors include `errorType`, requested/actual agent, reason, suggested fix, scope/path information, lock mode, worktree mode, conflicting paths, changed files, and duration when available.

Transient provider header/connection warnings do not stop an otherwise completed job merely because OpenCode logged an earlier warning. Recovery requires all of the following: the warning is transient, stdout contains no structured error event, and the last substantive event is a non-empty terminal text response. Structured provider evidence takes precedence over raw stderr. Authentication/expired OAuth, hard quota, billing, and hard model errors are terminal. Transient 429/5xx/transport failures are retried only for read-only work with no completed tool outcome, through one bounded exponential-backoff/jitter/Retry-After controller and one elapsed-time budget; write work and queue layers do not multiply retries. Requested/configured/runtime-observed model evidence is reported separately and silent fallback is disabled.

Important error types:

- `missing_scope_contract`
- `empty_allowed_edits`
- `forbidden_file_changed`
- `shared_file_parallel_write`
- `serial_only_parallel_write`
- `orchestrator_write_visibility_risk`
- `manual_lock_misuse`
- `worktree_required_for_pipeline`
- `pipeline_too_small`
- `integration_requires_review`
- `final_validation_required`
- `changed_file_validation_error`
- `write_lock_conflict`
- `integration_merge_conflict`
- `validation_command_failed`
- `dirty_worktree_requires_checkpoint`
- `integration_preview_stale`
- `essential_output_truncated`
- `queue_job_interrupted`
- `queue_job_not_resumable`
- `policy_validation_command_untrusted`
- `sanitized_workspace_integrity_failed`

## 16. Recommended Production Config

```text
CODEX_OPENCODE_WORKTREE_MODE=write
CODEX_OPENCODE_WORKTREE_ROOT=global
CODEX_OPENCODE_QUEUE_MODE=sqlite
CODEX_OPENCODE_QUEUE_WRITE_CONFLICT_POLICY=wait
CODEX_OPENCODE_QUEUE_BLOCKED_POLL_MS=2000
CODEX_OPENCODE_QUEUE_STALE_AFTER_MS=7200000
CODEX_OPENCODE_DEFAULT_READ_LOCK_MODE=off
CODEX_OPENCODE_DEFAULT_WRITE_LOCK_MODE=simple
CODEX_OPENCODE_DEFAULT_PARALLEL_WRITE_LOCK_MODE=strict
CODEX_OPENCODE_WORKTREE_CLEANUP=never
CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT=2
CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY=opencode-default-account
CODEX_OPENCODE_QUEUE_HEARTBEAT_MS=15000
CODEX_OPENCODE_QUEUE_LEASE_MS=60000
CODEX_OPENCODE_CONTRACTOR_TIMEOUT_MS=1200000
CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST=git
CODEX_OPENCODE_TRUSTED_POLICY_ROOT=C:\\absolute\\reviewed-repository
CODEX_OPENCODE_TRUSTED_POLICY_PATH=.mcp/agent-policy.json
CODEX_OPENCODE_TRUSTED_POLICY_SHA256=<sha256-of-exact-agent-policy.json>
CODEX_OPENCODE_VALIDATION_EXECUTABLE_SHA256_ALLOWLIST=<sha256-of-canonical-git-executable>
CODEX_OPENCODE_EXPECTED_SERVER_SHA256=<sha256-of-published-server.js>
CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256=<sha256-of-release-manifest.json>
CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS=false
XDG_CONFIG_HOME=C:\\absolute\\release
CODEX_OPENCODE_AGENT_DIR=C:\\absolute\\release\\opencode\\agents
CODEX_OPENCODE_SKILL_DIR=C:\\absolute\\release\\opencode\\skills
CODEX_OPENCODE_PLUGIN_MANIFEST_PATH=C:\\absolute\\release\\opencode\\plugin-integrity-manifest.json
CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256=<sha256-of-plugin-integrity-manifest.json>
```

Set `startup_timeout_sec = 120` and `tool_timeout_sec = 1500` on the Codex `[mcp_servers.opencode]` entry so the MCP client does not stop a valid builder/orchestrator run at its default 60-second limit. The TUI also uses a 25-minute request timeout and accepts `CODEX_OPENCODE_MCP_CLIENT_TIMEOUT_MS` as an override.

The bridge resolves `opencode` from `PATH` by default and derives agent/skill/state directories from the current user's home directory. Use `CODEX_OPENCODE_EXECUTABLE`, `CODEX_OPENCODE_AGENT_DIR`, `CODEX_OPENCODE_SKILL_DIR`, or `CODEX_OPENCODE_STATE_DIR` only when an explicit portable override is needed. Pinned production releases require `XDG_CONFIG_HOME` to equal the release root and require exact release-local config, agent, skill, and plugin-manifest paths. Only reviewed nonsecret `opencode.jsonc` and `antigravity.json` are copied and hash-pinned. Builder/manifest tooling never publishes or hashes provider auth/account files. For isolated-role runtime discovery, the bridge may pass a bounded valid built-in `auth.json` object to one one-shot child through `OPENCODE_AUTH_CONTENT`; it does not log, return, prompt, or persist that content, and never reads `antigravity-accounts.json`.

With `CODEX_OPENCODE_WORKTREE_ROOT=global`, worktrees live under the bridge state directory rather than inside repositories. Runtime SQLite state uses per-repository hashed database names in the same state directory; `.mcp/` is reserved for optional `agent-policy.json` and is not polluted with runtime databases.

Use `CODEX_OPENCODE_WORKTREE_CLEANUP=never`. Execution never deletes a writer's output; only receipt-bound reviewed integration may honor `cleanupAfterSuccess`, and only after an explicit passing validation gate. Retained worktrees are deliberate recovery artifacts and should be inspected and cleaned through the integration lifecycle.

Worktrees are created from a pinned committed `HEAD` and tree. If the source checkout is dirty, the bridge rejects the writer with `dirty_worktree_requires_checkpoint` because an isolated checkout would omit those user changes. Create/select an external checkpoint and retry; disabling worktrees is not an automatic workaround for parallel writers. Repository policy trust comes only from operator environment hashes, never a caller field. Coordinator-approved package scripts still execute repository code and require deliberate executable allowlisting or an external sandbox. This bridge is not a substitute for a VM/container when the repository itself is untrusted.

The production Builder uses OpenCode `1.17.13`, `openai/gpt-5.6-terra` with variant `high`, and the binary-bundled Codex OAuth transport. `--pure` disables configured external plugins; do not set `OPENCODE_DISABLE_DEFAULT_PLUGINS`, which would also remove required built-in authentication. Immutable release pinning and `CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS=true` are deliberately incompatible because the reviewed Antigravity plugin stores its account under the read-only config root. The exact external-plugin integrity verifier remains available and tested for separately reviewed, unpinned development deployments, and the installed package remains part of the dependency audit matrix.

## 17. Sanitized Sensitive-Data Workspaces

Path allowlists and `forbiddenEdits` restrict changes; they do not prove which rows or records an agent read. For sensitive audits, prepare a separate read-only workspace in which raw workbooks, evaluation artifacts, credentials, and forbidden rows are physically absent. Supply `sanitizedWorkspace` with an absolute root, externally pinned manifest path/SHA-256, and required/forbidden file lists. The version-1 manifest is an exact map of file SHA-256 values and directories.

The bridge verifies the exact root before and after each single, queued, parallel, or pipeline wave. Additions, removals, mutations, missing required files, forbidden files, case collisions, traversal, symlinks, junctions/reparse links, unsupported entries, or configured size/count excesses fail as `sanitized_workspace_integrity_failed`. Sanitized jobs cannot use repository validation code, cannot widen to a Git root or worktree, and route without fallback to the exact bridge-owned `mcp-sanitized-reader`. The bridge attests its mode/model/variant/temperature/prompt plus edit/task/bash/web/skill/external denial immediately before spawn.

OpenCode project config is disabled for every bridge child. Sanitized children additionally replace global configuration with an inline no-plugin/no-MCP/no-LSP/no-formatter/no-share profile, use an in-memory session database, pass bounded built-in auth only in the child environment, and isolate unavoidable OpenCode home/cache/state/log/repository/tool-output and process-temp state in one unique temporary runtime. `HOME`, `USERPROFILE`, every `XDG_*` root, and `TEMP`/`TMP`/`TMPDIR` are relocated into that runtime; only its exact tool-output and `tmp/opencode` scratch directories are accepted as external-directory exceptions. The original repository and shared user state remain inaccessible. Runtime files are overwritten and removed before success. Row/column filtering remains an external preprocessing responsibility, and OS isolation is still required against same-user races, hard crashes, or hostile native provider code.

## 18. Manual Test Examples

For a live isolated end-to-end verification, run `npm run test:e2e`. It exercises health discovery, planning-only orchestration, direct scoped implementation in a worktree, read-only reviewer/tester gates, reviewed integration, and final changed-file validation in a temporary Git repository.

For model-free cross-process pressure testing, run `npm run test:concurrency`. It starts independent MCP server processes sharing repositories and SQLite state, and covers simultaneous readers/writers, canonical paths, repository-wide integration exclusion, cold database races, provider leases, queue owner leases/heartbeats/crash reconciliation/cancellation, direct-parallel terminal results, and final lock cleanup.

Check syntax and self-tests:

```powershell
npm test
```

The standard test command must also pass from a published release with both hashes, `XDG_CONFIG_HOME` at the release root, pure mode, and immutable release-local agent/skill/plugin-manifest paths. Build a new non-overwriting snapshot with `npm run release:build -- <absolute-new-directory>`. Then follow [docs/SAFE_PUBLISH_MANIFEST.md](docs/SAFE_PUBLISH_MANIFEST.md): complete the mandatory live/concurrency/audit matrix; validate the exact candidate TOML; run pinned tests and fresh health; apply and verify read/execute-only release ACLs; atomically replace only Codex config; run active fresh health; and atomically restore the old config on failure. No global OpenCode tree is staged or replaced. Effective managed skill names and canonical origins come from OpenCode `debug skill`, while complete effective tree hashes must match release-pinned sources immediately before affected roles spawn. OpenCode JSON mode is parsed into a bounded final response plus tool outcomes; tool-only exit 0, hard quota, authentication, and billing failures are terminal errors rather than successful or generic timeout results.

Run the LangGraph TUI:

```powershell
npm run tui
```

Create a pipeline from the TUI with JSON matching `create_multi_agent_pipeline`. Monitor status in the dashboard, inspect each agent task/model/context/scope, dry-run integrations, then integrate reviewed worktrees one at a time.

Minimal Level 2 validation:

```json
{
  "jobs": [
    {
      "agent": "builder",
      "task": "Edit only apps/web/src/nav.",
      "write": true,
      "lockMode": "simple",
      "lockedPaths": ["apps/web/src/nav"],
      "allowedEdits": ["apps/web/src/nav"],
      "scopeContract": {
        "mode": "write",
        "read": ["apps/web/src/nav"],
        "write": ["apps/web/src/nav"],
        "allowedEdits": ["apps/web/src/nav"],
        "forbidden": [".env", ".env.*"],
        "shared": [],
        "serialOnly": [],
        "validationCommand": "git diff --check"
      }
    }
  ]
}
```

## 19. Final Operating Checklist

Before running an agent:

- Is this read-only or write?
- Is the agent direct and explicit?
- Is Scope Contract present?
- Are `allowedEdits` non-empty for write jobs?
- Are forbidden files protected?
- Are shared/serial-only files handled serially?
- Are write paths non-overlapping?
- Is the writer source completely clean and checkpointed?
- Will every writer use an isolated retained worktree?
- Is queue needed?
- Is pipeline actually justified?
- Is final validation defined?
- If project policy supplies validation, is its exact hash approved out of band?
- If plugins are enabled, does the exact plugin manifest verify?
- For sensitive data, is an exact sanitized workspace contract present?

After running an agent:

- Did it edit only allowed files?
- Did any read-only agent edit files?
- Did forbidden/shared/serial-only files change?
- Did validation pass?
- Does Codex approve the patch?
- Does the integration preview receipt still match source, target, base, and contract state?
- Did integration and an explicit validation gate pass before any requested cleanup?
- Is final validation required before answering?
- Are all unresolved rollback files, truncation, retained worktrees, and external risks reported?
