> **Historical record (archived 2026-09-24).** Line numbers, file names, release names, and procedures in this document may be out of date. Current docs: [USER_GUIDE.md](../USER_GUIDE.md) and [REFERENCE.md](../REFERENCE.md).

# Codex ↔ OpenCode MCP Bridge Deep System Review

**Review date:** 2026-08-03 (Asia/Beirut)

**Remediation date:** 2026-08-03 (Asia/Beirut)

**System reviewed:** source repository, active Codex configuration, active OpenCode configuration, installed releases, bridge state, custom agents, live MCP behavior, and disposable end-to-end fixtures.

> **Remediation update:** The detailed findings below preserve the original audit evidence. A subsequent authorized remediation pass fixed 13 of the 15 non-informational findings and mitigated the remaining two. The active release and current verdict are updated below.

> **Runtime update — 2026-08-04:** This note supersedes older runtime/version/quota statements in the historical evidence below. The active MCP release is `server-51749b3f004b4f40-lock-807d1e50d2b0a8da`; both source and release `server.js` hash to `51749b3f004b4f40cae151d28a915a4dbb7465cbbb81ba3ae1dce977ba576668`, and the release manifest hashes to `33ea47eea671da3a69420f206fae2be5fd5e8fda24485e4d4cb014a9d0ff56e6`. OpenCode is now `1.17.13`. The Builder uses `google/antigravity-gemini-3.6-flash` variant `high` through the pinned `@cortexkit/opencode-antigravity-auth@2.0.0` Google OAuth plugin. A direct request returned `MODEL_36_OK`, the active MCP health check passed, release self-tests passed, dependency audits reported zero known vulnerabilities, and the full isolated `npm run test:e2e` pipeline passed through Builder, Reviewer, Tester, preview, and integration. The detailed 2026-08-03 audit remains below as historical evidence rather than the current runtime snapshot.

> **Full hardening update - 2026-08-09:** The dated audit findings and line numbers below are retained as historical evidence, not current operating guidance. The hardened source makes writer retention integration-owned, rejects every dirty writer source, adds exact sanitized-workspace verification, pins provider/model/plugin evidence, centralizes bounded read-only retries, uses queue owner leases/heartbeats, requires receipt-bound integration, and treats locks as advisory coordination. Current verification, release, activation, residual risks, and rollback evidence are recorded in `MCP_BRIDGE_HARDENING_REPORT.md`; that report and `MCP_BRIDGE_COMPLETE_GUIDE.md` supersede conflicting historical statements here.

## 1. Title and review date

This is an evidence-based architecture, security, reliability, configuration, and operational review of the Codex ↔ OpenCode MCP Bridge at:

- Source: C:\Users\10User\codex-opencode-mcp
- Active Codex configuration: C:\Users\10User\.codex
- Active OpenCode configuration: C:\Users\10User\.config\opencode
- Installed releases: C:\Users\10User\codex-opencode-mcp-releases
- Active release: C:\Users\10User\codex-opencode-mcp-releases\server-7fe9678a5b50b8ba-lock-fd589adb560b2faf

The original audit was read-only except for this report and disposable temporary fixtures. After the user explicitly requested fixes, the remediation pass updated the source, documentation, selected active agents, active Codex MCP configuration, and installed release. No commit, push, merge, or deployment to an external service was performed.

## 2. Executive summary

The bridge now has a materially stronger verified posture: local stdio transport, Zod schemas, explicit write Scope Contracts, realpath-aware path rejection, SQLite cross-process locks, isolated writer worktrees, bounded metadata-only ignored-file snapshots, changed-file validation, rollback attempts, process-tree cancellation, lease/heartbeat-based orphaned-queue recovery, structured OpenCode JSONL parsing, final-response enforcement, provider/quota classification, bounded MCP output, and full release-manifest verification.

The active server hash is `7fe9678a5b50b8babafe9266a166393d6a41d9fba4c845c4a2ad9e768fde9a0c`. The pinned release-manifest hash is `8da0fef3e8385493dd9bbdc581745531dd5a0ff53fbbd371e873313047ed95b4`, covering exactly 7,861 shipped files; all 7,862 release files including the manifest are marked ReadOnly.

The system is not currently reliable enough for unattended production delegation. Three high-severity issues were confirmed:

1. A zero-exit OpenCode run with no assistant final response is classified as success.
2. Gemini daily-quota HTTP 429 errors remain inside OpenCode logs, are retried with long backoff, and surface to the bridge only as generic timeouts.
3. The rollback/change-detection baseline reads and hashes every ignored file. In this repository that is 7,885 files and 56.08 MiB per relevant scan, and it can include ignored secret files.

The normal E2E and the one explicitly authorized Contractor E2E both failed because Gemini 3.6 Flash had exhausted a free-tier daily request quota of 20. OpenCode retried the normal Builder eight times and the Contractor's nested Builder nine times. The bridge did terminate the exact child process tree at its configured timeout, and neither test changed its fixture. Both retained failure fixtures were subsequently verified and deleted.

The bridge's safety preflights worked well: missing agents, parent traversal, outside-root absolute paths, unauthorized Contractor mode, Contractor-in-parallel, planning-mode nested writers, and read-only edit scopes were rejected before execution.

## 3. Final verdict

**Current verdict after remediation: suitable for supervised production-style use with bounded scopes and manual integration; unattended operation remains conditional on provider capacity and operator policy.**

Recommended operating posture:

- The bridge now rejects exit 0 without a non-empty terminal assistant text event.
- Hard quota, authentication, and billing diagnostics fail fast when OpenCode emits them at ERROR level; Gemini capacity itself remains an external dependency.
- Ignored and protected/large files use bounded metadata-only snapshots; their contents are not retained by the bridge.
- Contractor mode is disabled in the active configuration until the operator deliberately configures a capability hash. A boolean alone can no longer enable it.
- Keep integration manual and reviewed, especially for generated worktree patches.

Original finding counts:

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 3 |
| Medium | 10 |
| Low | 2 |
| Informational | 4 |

No claim is made that every possible vulnerability or failure mode has been found.

Remediation disposition:

| Disposition | Findings |
|---|---|
| Fixed and verified | H-01, H-03, M-01, M-02, M-03, M-04, M-05, M-06, M-08, M-09, M-10, L-01 |
| Fixed in bridge with synthetic failure verification; external provider quota remains | H-02 |
| Mitigated: capability required and active feature disabled; no host-UI identity binding exists | M-07 |
| Mitigated: ERROR-only OpenCode launch logging plus bridge redaction; provider error logs remain locally controlled by OpenCode | L-02 |

## 4. Review scope and limitations

### Verified scope

- Current dirty source worktree and tracked/untracked file inventory.
- Active Codex and OpenCode configuration, without reading credential file contents.
- Active custom agent files, frontmatter/TOML policy, models, modes, and source/active hashes.
- Active installed server release, package files, dependency tree, ACL, and startup integrity configuration.
- Complete server.js control flow relevant to routing, prompts, paths, worktrees, locks, queue, timeout, rollback, integration, persistence, and self-tests.
- MCP handshake, tool discovery, status, agent discovery, locks, and queue state.
- Model catalogs and agent resolution.
- Source and release tests and dependency audits.
- Direct OpenCode read-only delegation.
- One normal disposable E2E.
- One explicitly authorized Contractor disposable E2E.
- Non-destructive rejection tests for unsafe delegation plans.
- OpenCode session metadata and relevant non-secret log evidence for calls created during this audit.

### Limitations

- No destructive testing, exploitation of real repositories, production integration, deployment, commit, push, or history rewrite was performed.
- Symlink/junction escape was assessed from code and policy but was not exploited.
- Provider authentication failure was not fully reproduced. An isolated XDG test produced a model-not-found error before authentication; it is therefore not proof of correct auth-failure classification.
- Live integration could not be reached in either E2E because the Builder failed first. Integration behavior was exercised by server self-tests, not a complete live model workflow.
- Codex custom-agent model usability was inferred from active configuration and the current Codex runtime; each Codex subagent was not separately spawned.
- Dependency audit reports known advisories, not absence of supply-chain compromise.
- OpenCode's built-in internal agents were inventoried, but the detailed permission matrix focuses on the managed custom agents.

Labels used below:

- **Verified fact:** observed in a real file, command, database record, or live result.
- **Inference:** reasoned from verified implementation behavior.
- **External blocker:** provider/quota or other state outside the bridge.
- **Unverified assumption:** plausible but not demonstrated.
- **Recommendation:** proposed change, not current behavior.

## 5. System versions

| Component | Version | Command | Exit | Duration |
|---|---|---|---:|---:|
| Node.js | v24.11.1 | node --version | 0 | 191 ms |
| npm | 11.6.2 | npm --version | 0 | 1,816 ms |
| Codex CLI | codex-cli 0.133.0 | codex --version | 0 | 481 ms |
| OpenCode CLI | 1.15.7 | opencode --version | 0 | 1,896 ms |
| Git | 2.39.1.windows.1 | git --version | 0 | 90 ms |
| MCP SDK | 1.30.0 | npm ls --depth=0 | 0 | verified |
| LangGraph | 1.4.8 | npm ls --depth=0 | 0 | verified |
| Zod | 4.4.3 | npm ls --depth=0 | 0 | verified |
| OpenCode plugin | 1.15.7 | npm ls --prefix active OpenCode config | 0 | verified |

Source package requires Node >=22.5.0; active Node satisfies it.

## 6. Architecture overview

The bridge is a single-process Node.js ESM MCP server. Codex starts it over stdio from the installed release. The server discovers OpenCode agents by invoking the OpenCode CLI, validates the requested job, builds a compact prompt and optional Scope Contract, creates a worktree for writes, starts OpenCode without a shell, validates changed files and optional validation commands, and returns a text result to Codex.

Key implementation points:

- server.js imports the MCP SDK and connects via StdioServerTransport at lines 8144-8146.
- OpenCode execution uses spawn with shell false at lines 339-444.
- OpenCode command shape is run --pure --format json --agent at lines 1399-1425.
- Agent routing is implemented at lines 720-880.
- Scope/path validation is implemented at lines 894-970 and 4657-4778.
- Worktree creation and cleanup are at lines 1994-2132.
- Changed-file snapshots and rollback are at lines 1601-1780.
- Serial integration is at lines 2170-2529.
- SQLite lock/queue state is at lines 2586-2930 and 5464-5864.
- Contractor authorization is at lines 4395-4555.
- Startup server hash verification is at lines 8129-8145.

The bridge does not automatically invoke OpenCode Orchestrator for normal named-agent jobs. Only an orchestrator alias or explicit MCP orchestrator name is routed to opencode-orchestrator-mcp-planner or opencode-orchestrator-mcp-contractor.

## 7. Mermaid architecture diagram

### Default direct-delegation mode

~~~mermaid
flowchart LR
    U["User"] --> C["Codex Principal Orchestrator"]
    C -->|"MCP stdio + bounded job"| B["Installed MCP Bridge"]
    B --> V["Schema, routing, Scope Contract and path validation"]
    V --> L["SQLite lock / optional worktree"]
    L --> O["OpenCode CLI --pure --format json"]
    O --> A{"Direct managed agent"}
    A --> PL["Planner"]
    A --> BU["Builder"]
    A --> DE["Debugger"]
    A --> RE["Reviewer"]
    A --> TE["Tester"]
    A --> EX["Explore: currently routing-mismatched"]
    PL --> R["Raw JSON event stream + changed-file evidence"]
    BU --> R
    DE --> R
    RE --> R
    TE --> R
    EX --> R
    R --> G["Validation / rollback / retained worktree"]
    G --> C
    C -->|"reviewed=true only after review"| I["Serial integration decision"]
~~~

### Explicit Contractor mode

~~~mermaid
flowchart LR
    U["User explicitly authorizes Contractor for current task"] --> C["Codex Principal Orchestrator"]
    C -->|"one outer job + boolean authorization + aggregate Scope Contract"| B["MCP Bridge"]
    B --> P["Authorization, single-job, write-scope and path gates"]
    P --> W["Retained isolated Git worktree + write lock"]
    W --> CO["opencode-orchestrator-mcp-contractor"]
    CO -->|"task allowlist only"| SA{"Allowed OpenCode subagents"}
    SA --> BU["Builder"]
    SA --> DE["Debugger"]
    SA --> RE["Reviewer"]
    SA --> TE["Tester"]
    SA --> PL["Planner / Architect / Explore"]
    SA --> CO
    CO --> CR["Consolidated result and diff"]
    CR --> B
    B --> CV["Aggregate changed-file validation; no direct integration"]
    CV --> C
    C --> PR["Patch preview and Codex review"]
    PR -->|"reviewed=true"| SI["Serial integration + validation"]
~~~

## 8. Component inventory

| Component | Purpose | Runtime status |
|---|---|---|
| server.js | MCP server, policy, queue, locks, worktrees, integration | Active from installed release |
| package.json / package-lock.json | Runtime dependencies and scripts | Active copies match source |
| bin/tui.js | LangGraph-style pipeline TUI | Source-only; absent from active release |
| bin/e2e.js | Normal full E2E | Source-only; absent from active release |
| bin/e2e-contractor.js | Contractor E2E | Source-only; absent from active release |
| codex/agents | Source Codex custom agents | All active copies match |
| opencode/agents | Source OpenCode custom agents | All active copies match |
| C:\Users\10User\.codex\config.toml | Active Codex/MCP configuration | Points to active release |
| C:\Users\10User\.config\opencode\opencode.jsonc | Active OpenCode defaults | Loaded |
| C:\Users\10User\.codex\codex-opencode-mcp | Global bridge SQLite/worktree state | Active |
| installed releases | Content-addressed-looking server directories | Nine present; active directory is user-writable |

Repository stack: Node.js ESM, MCP SDK, Zod schemas, Node built-in SQLite, Git worktrees, OpenCode CLI subprocesses, and a LangGraph TUI.

## 9. Runtime and source paths

### Active server and integrity

| Item | Source SHA-256 | Active release SHA-256 | Match |
|---|---|---|---|
| server.js | 60dadee4e3e0fed5dd21f7bd6136982e74f7c6d5faf204c3e030b8f080dd8f84 | same | Yes |
| package-lock.json | fd589adb560b2fafcb5c3cb0dcc440f7e936333b4e7f6d12e5116dfa55e5fbcf | same | Yes |
| package.json | ff6d9b5c06c5ec808e4e83580490439d1155a377fb73545ec65789b483be17c9 | same | Yes |

Active Codex config points to:

C:\Users\10User\codex-opencode-mcp-releases\server-60dadee4e3e0-lock-fd589adb560b\server.js

Configured expected server hash equals the active and source server hash. The directory suffix also reflects the server and lock hashes.

### Source and active agents

All seven source Codex agent files and all ten source OpenCode agent files match their active copies byte-for-byte. No active/source agent mismatch was found.

### Dirty source worktree

The source worktree was already heavily dirty before the review:

- 21 tracked files modified.
- New bin directory and scripts.
- New codex/agents/worker.toml.
- New OpenCode explore and MCP orchestrator files.
- server.js had approximately 3,619 added/changed lines in the pre-existing diff.

These changes were preserved. This report is the only audit-created repository file.

### Runtime versus source-only/legacy

- Active runtime server: installed release server.js.
- Runtime package dependencies: installed release node_modules.
- Source bin scripts: used only when explicitly run from source; absent from active release.
- opencode-orchestrator-mcp-planner: runtime target for MCP planning-only orchestrator aliases.
- opencode-orchestrator-mcp-contractor: runtime target only for explicit Contractor mode.
- opencode-orchestrator-standalone (legacy standalone profile): active in OpenCode for standalone/backup use, but MCP orchestrator aliases are routed away from it.

## 10. Default communication flow

1. Codex connects to the installed bridge over stdio.
2. MCP initialization completes and tools/list returns 18 tools.
3. Codex calls validate_delegation_plan or a run/queue tool.
4. Zod validates the tool input.
5. The bridge normalizes the job, Scope Contract, lock type/mode, paths, shared files, and timeouts.
6. The bridge discovers agents with opencode agent list and may confirm one with opencode debug agent.
7. Named primary/all agents run directly. Orchestrator aliases alone route to MCP orchestrators.
8. Read-only jobs use no lock by active policy. Write jobs require a Scope Contract, concrete lockedPaths and allowedEdits, and a write lock.
9. Active worktree policy creates an isolated worktree for writes.
10. The bridge builds a compact prompt and starts OpenCode with shell disabled.
11. It captures stdout/stderr up to 30 MiB each.
12. It snapshots Git changes, validates paths, attempts rollback for disallowed changes, and runs an optional validation command without a shell.
13. Write worktree output is returned for Codex review. Integration is a separate tool call.

**Verified:** OpenCode Orchestrator is not automatically activated for planner, builder, debugger, reviewer, or tester.

**Verified exception:** explore is mode subagent. The default proxy target is write-capable build, and the bridge correctly rejects that proxy for a read-only job. Therefore Explore does not currently participate successfully in the intended direct flow without a configuration change.

## 11. Contractor communication flow

The Contractor flow is a distinct bridge policy:

1. Codex submits one job with orchestratorMode contractor.
2. The job must set userAuthorizedOrchestrator true.
3. The job must be a bounded write job with a write Scope Contract, concrete locks/edits, and simple or strict lock mode.
4. Contractor mode is rejected in parallel or multi-job execution.
5. The request routes to opencode-orchestrator-mcp-contractor.
6. A retained worktree is mandatory.
7. The Contractor has edit denied and can invoke only planner, architect, builder, debugger, reviewer, tester, explore, or explorer.
8. Other orchestrators are not in the task allowlist, preventing recursive orchestrator calls at the OpenCode permission layer.
9. The bridge observes the aggregate outer worktree, not each nested subagent.
10. Codex must review the returned worktree/patch and separately call integration with reviewed true.

Verified constraints:

- Explicit boolean authorization required: yes.
- One outer job only: yes.
- Contractor direct edit denied: yes.
- Task allowlist enforced: yes.
- Recursive orchestrator omitted from allowlist: yes.
- Worktree forced and retained until later action: yes.
- Authorization stored only in the job, not a persistent global mode: yes.
- Final integration requires a separate reviewed flag: yes.

Important trust limitation: the bridge trusts the MCP caller's boolean authorization. It does not cryptographically bind that flag to a user message or task identifier.

## 12. MCP tool inventory

The installed release exposed exactly 18 tools:

| Tool | Purpose |
|---|---|
| acquire_agent_lock | Exceptional manual path lock |
| release_agent_lock | Token-protected manual lock release |
| list_agent_locks | Active lock listing |
| list_opencode_agents | Agent and effective permission discovery |
| get_opencode_bridge_status | Runtime health and policy status |
| validate_delegation_plan | Non-executing preflight |
| run_opencode_agent | One synchronous agent job |
| enqueue_opencode_job | Persistent/memory queue submission |
| list_opencode_jobs | Queue listing |
| get_opencode_job | One queue record/result |
| cancel_opencode_job | Pending cancellation or running cancellation request |
| create_multi_agent_pipeline | Policy-checked pipeline plan |
| run_multi_agent_pipeline | Queue pipeline jobs |
| get_multi_agent_pipeline | Pipeline state |
| finalize_multi_agent_pipeline | Final validation/reviewer/tester gates |
| list_multi_agent_pipelines | Pipeline listing |
| integrate_opencode_worktree | Reviewed serial patch integration |
| run_opencode_parallel | Independent parallel jobs |

Independent installed-release handshake evidence:

- Connect: 897 ms.
- Tool count: 18.
- Status: healthy.
- OpenCode version: 1.15.7.

## 13. Agent and model matrix

### Codex managed agents

| Agent | Runtime/source file | Role | Model / effort | Write capability | MCP delegation |
|---|---|---|---|---|---|
| principal-engineer-orchestrator | active/source TOML | Primary controller | gpt-5.6-sol / high | Yes, coordinator-controlled | Enabled/inherited; intended owner |
| principal-engineer-orchestrator-plain | active/source TOML | Lightweight primary controller | gpt-5.6-sol / high | Yes | Enabled/inherited; intended owner |
| worker | active/source TOML | Bounded implementation | gpt-5.6-luna / high | Yes | Instruction says deny; no technical mcp_servers.opencode disable |
| reviewer | active/source TOML | Read-only review | gpt-5.6-terra / high | No; read-only sandbox | Explicitly disabled |
| debugger | active/source TOML | Debug/minimal fix | gpt-5.6-terra / high | Yes when asked | Explicitly disabled |
| tester | active/source TOML | Tests and verification | Not explicitly pinned; inherits runtime default | May edit tests | Explicitly disabled |
| explorer | active/source TOML | Read-only exploration | Not explicitly pinned; inherits runtime default | No; read-only sandbox | Explicitly disabled |

The four explicitly intended Codex mappings in the request match: Principal Sol/high, Worker Luna/high, Reviewer Terra/high, Debugger Terra/high.

### OpenCode managed agents

| Agent | Mode | Model / variant | Edit | Task/subagents | Shell | Web | External dir |
|---|---|---|---|---|---|---|---|
| builder | all | google/gemini-3.6-flash / high | Allow except secret patterns | Deny | Ask; exact Git reads allow | Deny | Deny |
| debugger | all | openai/gpt-5.6-terra / high | Allow except secret patterns | Deny | Ask; exact Git reads allow | Deny | Deny |
| reviewer | all | openai/gpt-5.6-terra / high | Deny | Deny | Ask; exact Git reads allow | Deny | Deny |
| tester | all | openai/gpt-5.6-luna / high | Deny | Deny | Ask; exact Git reads allow | Deny | Deny |
| planner | all | openai/gpt-5.6-luna / medium | Deny | Deny | Ask; exact Git reads allow | Deny | Deny |
| explore | subagent | openai/gpt-5.6-luna / medium | Deny | Deny | Ask; limited Git reads allow | Deny | Deny |
| architect | all | openai/gpt-5.5 / high | Deny | Deny | Ask; exact Git reads allow | Deny | Deny |
| opencode-orchestrator-mcp-planner | all | openai/gpt-5.6-terra / high | Deny | Deny | Ask; exact Git reads allow | Deny | Deny |
| opencode-orchestrator-mcp-contractor | all | openai/gpt-5.6-terra / high | Deny | Allowlisted roles only | Ask; exact Git reads allow | Deny | Deny |
| opencode-orchestrator-standalone (legacy standalone) | all | openai/gpt-5.6-terra / high | Deny | Available for backup/standalone policy | Ask; exact Git reads allow | Deny | Deny |

All requested OpenCode mappings resolve as intended, except the operational Explore mode problem. Architect is an additional gpt-5.5/high agent not included in the requested target map.

Runtime built-ins also discovered: build, plan, general, compaction, summary, and title. Active OpenCode defaults map build/plan/general/explore to Gemini 3.6 Flash, but custom agent frontmatter overrides the managed custom names above.

## 14. Permission and trust-boundary matrix

| Boundary | Enforcement | Assessment |
|---|---|---|
| Codex → MCP | Local stdio, MCP schema | Strong local boundary; no remote listener observed |
| MCP → OpenCode | Sanitized agent name, shell false, bounded timeout | Strong command-injection posture |
| User auth → Contractor | Boolean supplied by MCP caller | Weak provenance; trusted-caller model |
| Contractor → subagents | OpenCode task allowlist | Good technical allowlist |
| Subagent → filesystem | Agent edit policy plus worktree and final Git validation | Defense in depth, but lexical paths and aggregate-only nested visibility |
| Agent → shell | Ask by default; exact Git commands allow | Noninteractive asks are auto-rejected and currently break common agent commands |
| Agent → web | Denied in managed custom agents | Good |
| Agent → external directory | Denied in managed custom agents | Good, subject to junction/realpath caveat |
| OpenCode output → Codex | Raw JSON event stream | Weak semantic validation; no required final-answer parser |
| Worktree → source integration | Separate dry-run/reviewed integration | Good |
| Release → runtime | Expected server SHA-256 only | Partial integrity; dependencies and lock not checked at startup |
| Codex worker → bridge | Text instruction only | Technical MCP disable missing |

## 15. Worktree, lock, queue, and integration design

### Worktrees

- Active mode: write.
- Root: global under C:\Users\10User\.codex\codex-opencode-mcp\worktrees.
- Cleanup: never during execution for every writer, including direct, queued, parallel, pipeline, and Contractor work.
- Cleanup is owned by receipt-bound reviewed integration and requires an explicit passing validation gate plus `cleanupAfterSuccess: true`; pipeline cleanup waits for final gates.
- Worktree creation uses Git argument arrays and a generated branch/path.
- Any dirty source state is rejected as `dirty_worktree_requires_checkpoint`; no stash, reset, commit, or overlay is performed.
- Failed E2Es retained their worktrees by design; the audit removed their verified temp fixture roots.

### Locks

- SQLite with WAL and 5-second busy timeout.
- BEGIN IMMEDIATE serializes acquisition.
- Random 32-byte release token.
- Read/read does not conflict; other overlapping path locks do.
- Windows comparisons are case-insensitive.
- Automatic lock leases are renewed by the owning heartbeat while execution is active.
- No active lock remained after testing.

### Queue

- Active mode: sqlite.
- Parallel limit default: 6.
- Write conflict policy: wait with 2-second poll.
- Owned jobs record bridge instance/generation/PID, heartbeat, and lease expiry; foreign live jobs are not reconciled by age alone.
- The 7,200,000 ms stale threshold applies only to legacy/unowned non-replayable records.
- Retention: 14 days.
- Result text is redacted and bounded; task prompts and credentials are not persisted.
- Expired active work is marked interrupted and expired pending work not resumable only after ownership checks.

### Integration

- Requires explicit allowedEdits.
- Rejects dirty targets by default.
- A dirty target is allowed only through explicit `allowDirtyTarget`; the bridge reports exact risk evidence and does not bypass receipt identity.
- Dry run holds the serial integration lease and returns patch/source/target/contract digests plus an expiring signed receipt.
- Apply requires the exact receipt and rejects source or target drift as `integration_preview_stale`.
- Patch collection uses an isolated temporary Git index and includes committed, staged, unstaged, and untracked source changes relative to the pinned base without mutating the source index.
- Validation uses an operator allowlist and credential-free environment; target state is rechecked after validation and rollback is attempted on failure.

## 16. Security findings

### H-03 — Ignored files are read and hashed during rollback/change snapshots

- **Severity:** High
- **Status:** Confirmed
- **Affected:** gitChangedFiles, gitChangedFileSnapshot, captureRollbackBaseline
- **Evidence:** server.js lines 1601-1641 and 1711-1717 include ignored files, read every listed file, retain baseline buffers, and hash them. Current repository: 7,885 ignored files, 56.08 MiB.
- **Scenario:** A repository contains ignored .env, keys, credentials, datasets, node_modules, or large generated artifacts. A normal agent job reads those contents into the bridge process even though they are outside the task.
- **Impact:** Unnecessary secret exposure in process memory, high I/O, memory pressure, slow jobs, and denial-of-service risk.
- **Existing mitigation:** Contents are not intentionally logged; agent edit patterns deny common secret paths.
- **Fix:** Never include all ignored files in the general snapshot. Capture only pre-existing tracked/untracked paths relevant to allowed, forbidden, shared, and changed paths. Explicitly exclude secret patterns and cap file size/count.
- **Verification:** Add a fixture with a large ignored file and a sentinel ignored secret; assert the baseline does not open them and job latency/memory remain bounded.

### M-07 — Contractor authorization is an unbound caller boolean

- **Severity:** Medium
- **Status:** Potential
- **Affected:** userAuthorizedOrchestrator and orchestratorPolicyError
- **Evidence:** server.js lines 4439-4440 and 4499-4505 accept a true field from the MCP caller.
- **Scenario:** A confused or compromised MCP client sets the boolean without an actual user authorization.
- **Impact:** Contractor mode can be activated inside the caller's local privilege boundary.
- **Existing mitigation:** Local stdio server, one-job rule, bounded write contract, worktree, task allowlist, final review.
- **Fix:** Bind authorization to a short-lived capability created by an explicit user-confirmation step, include task/scope hash and expiry, and consume it once.
- **Verification:** Forged, expired, replayed, scope-changed, and cross-task capabilities must fail.

### M-08 — Path policy is lexical and does not resolve symlinks/junctions

- **Severity:** Medium
- **Status:** Potential
- **Affected:** unsafePathReason, comparePathCandidates, isWithinAnyPath, worktree root checks
- **Evidence:** server.js lines 910-946, 1650-1700, and 1902-1967 use path.resolve/relative and string comparison; no realpath/lstat/reparse-point validation exists.
- **Scenario:** An allowed in-repo directory contains a junction/symlink to an external sensitive directory. A tool writes through the in-repo lexical path; Git may not report the external target change.
- **Impact:** Scope/worktree escape and undetected external modification.
- **Existing mitigation:** Managed OpenCode agents deny external_directory and run writers in worktrees.
- **Fix:** Resolve the nearest existing ancestor with realpath, reject reparse points/symlinks crossing the real repository/worktree root, and re-check every changed target before and after execution.
- **Verification:** Disposable Windows junction and Unix symlink fixtures must be rejected.

### M-09 — Codex worker MCP denial is instruction-only

- **Severity:** Medium
- **Status:** Potential
- **Affected:** active/source codex/agents/worker.toml
- **Evidence:** worker instructions say not to call the bridge, but unlike debugger/reviewer/tester/explorer the file has no mcp_servers.opencode enabled=false stanza.
- **Scenario:** A worker ignores or is prompt-injected around its text instruction and invokes OpenCode delegation.
- **Impact:** Delegation and orchestration authority escapes the primary Codex controller.
- **Existing mitigation:** Clear developer instruction and parent-orchestrator workflow.
- **Fix:** Add the same technical MCP disable used by the other non-primary Codex agents.
- **Verification:** Spawn a worker in a disposable task and confirm OpenCode MCP tools are absent, not merely forbidden by text.

### M-10 — Raw agent event streams can expose repository/task data and exhaust consumers

- **Severity:** Medium
- **Status:** Confirmed
- **Affected:** runSpawnCommand and formatSingleResult
- **Evidence:** server.js allows 30 MiB each for stdout and stderr, then returns raw stdout. The three-agent audit result was hundreds of kilobytes and contained full tool outputs/source chunks.
- **Scenario:** A repository file or agent emits huge or sensitive content. Raw events are copied into MCP results and potentially model context.
- **Impact:** Context exhaustion, latency, log/data exposure, hidden failures after truncation.
- **Existing mitigation:** 30 MiB process cap and 8,000-character queue result cap.
- **Fix:** Parse JSONL, retain a bounded structured summary, final assistant text, errors, model, tool outcomes, and changed-file evidence; store raw output only in a protected diagnostic artifact with explicit opt-in.
- **Verification:** Oversized output fixture must return a small structured truncation error and preserve terminal failure information.

### L-02 — OpenCode logs contain full prompts and provider request/error bodies

- **Severity:** Low
- **Status:** Confirmed
- **Affected:** OpenCode local logging, outside bridge sanitizer
- **Evidence:** audit logs included full Scope Contract/task/system prompt and full 429 response body.
- **Scenario:** Users put secrets or sensitive repository content directly in task prompts.
- **Impact:** Plaintext local persistence beyond the task lifetime.
- **Existing mitigation:** Local user storage; bridge's own logEvent removes prompt/stdout/stderr/env fields.
- **Fix:** Reduce OpenCode log level/retention, redact prompts and request bodies, document that task prompts must not include credentials.
- **Verification:** Inject a non-secret sentinel and confirm it does not persist after configured redaction.

### Informational security positives

- I-01: Active/source/release hashes match for server, package manifest, lockfile, and all custom agents.
- I-02: The installed release completed an independent MCP handshake, advertised the expected 18 tools, and reported a healthy bridge state.
- I-03: Live preflights rejected traversal, outside-root paths, missing agents, unauthorized Contractor mode, Contractor parallelism, nested planning writers, and read-only edits.
- I-04: npm audit --omit=dev reported zero known vulnerabilities for source and active release dependencies.

## 17. Reliability findings

### H-01 — Exit 0 with no assistant final response is accepted as success

- **Severity:** High
- **Status:** Confirmed
- **Affected:** detectsOpenCodeApiError, classifyResultError, runOpenCode
- **Evidence:** server.js lines 675-692 and 1375-1442 check timeout, native fallback, JSON error events, and exit code, but do not require a final assistant text event. Three delegated audit sessions had zero assistant text parts and ended only with tool-calls, while bridge output said Error type: none.
- **Scenario:** Agent edits or inspects, a permission/tool event ends the session, and OpenCode exits 0 without a conclusion.
- **Impact:** False success, missing review/test result, hidden incomplete work.
- **Existing mitigation:** Changed-file and validation gates protect filesystem scope, but not communication completeness.
- **Fix:** Parse JSONL; require exactly one non-empty terminal assistant text event with finish reason stop. Treat missing/empty final as agent_empty_final_response.
- **Verification:** Fixtures for empty output, tool-call-only exit, whitespace final, truncated final, and valid final.

### H-02 — Gemini quota 429 is hidden, retried, and misclassified as timeout

- **Severity:** High
- **Status:** Confirmed; external quota is the trigger, bridge classification is internal
- **Affected:** OpenCode subprocess/error propagation and bridge timeout classification
- **Evidence:** Normal Builder: eight 429 RESOURCE_EXHAUSTED log events from 09:36:41 to 09:40:57, then 300,177 ms agent_timeout. Contractor nested Builder: nine 429 events, then 600,188 ms outer timeout. Bridge reported OpenCode API error detected: no.
- **Scenario:** Daily quota is exhausted. OpenCode marks the response retryable and backs off until the bridge kills the tree.
- **Impact:** Five-to-ten-minute stalls, incorrect troubleshooting signal, wasted calls, failed normal and Contractor workflows.
- **Existing mitigation:** Exact timeout and Windows taskkill /PID /T /F; no write retries at bridge queue layer.
- **Fix:** Make OpenCode emit provider errors to JSON stdout/stderr promptly or inspect a structured child error channel; classify quota_daily_exhausted separately; stop immediately for daily/project hard quota; cap transient 429 retries by attempt and elapsed time.
- **Verification:** Mock 429 retryable, 429 daily quota, 401, and quota-exhausted responses and assert fast correct classification.

### M-01 — Noninteractive shell policy rejects normal compound diagnostic commands

- **Severity:** Medium
- **Status:** Confirmed
- **Affected:** OpenCode custom agent bash permission patterns
- **Evidence:** Planner, Reviewer, and Tester all attempted compound or slightly variant Git/Node commands. OpenCode auto-rejected them because only exact individual patterns are allowlisted. All three then produced no final answer.
- **Impact:** Read-only reviews silently become incomplete, even though each component command is safe.
- **Existing mitigation:** Conservative ask policy.
- **Fix:** Teach agents to make separate exact allowed calls, or add narrowly parsed allow rules for common safe variants. Keep shell metacharacters denied.
- **Verification:** Run the same three audit jobs and require final text with no permission requests.

### M-02 — Explore is not usable in the default direct read-only path

- **Severity:** Medium
- **Status:** Confirmed
- **Affected:** explore mode and default proxy routing
- **Evidence:** opencode debug agent explore reports mode subagent. Default proxy is build. Live preflight rejected read_only_proxy_unsafe.
- **Impact:** Intended direct Explore delegation fails.
- **Existing mitigation:** Safe rejection prevents accidental write-capable proxy execution.
- **Fix:** Install Explore as mode all/primary, or add an explicit read-only primary proxy such as planner with preserved Explore instructions.
- **Verification:** Requested and actual agent must both be Explore (or documented read-only proxy), model Luna/medium, no fallback, final response present.

### M-03 — Installed release package test command is broken

- **Severity:** Medium
- **Status:** Confirmed
- **Affected:** installed release contents/package.json
- **Evidence:** npm test in the active release exited 1 in 4,594 ms because bin/tui.js is absent. Direct node server.js --self-test passed.
- **Impact:** Operators cannot validate an installed release with its advertised standard test command.
- **Existing mitigation:** Direct server self-test exists.
- **Fix:** Either include bin scripts in releases or publish a release-specific package.json whose test script only references shipped files.
- **Verification:** npm test must pass from a freshly installed immutable release.

### M-04 — Release is user-mutable and startup integrity covers only server.js

- **Severity:** Medium
- **Status:** Confirmed
- **Affected:** active release ACL and verifyReleaseIntegrity
- **Evidence:** owner QSC-PC\10User has FullControl. Startup lines 8129-8137 hash only process.argv[1]/server.js. Lockfile and node_modules are not verified.
- **Impact:** Dependency or package-script tampering can survive the server hash check.
- **Existing mitigation:** Active server hash is pinned and currently matches; lockfile hash is encoded in directory name; dependency audit is clean.
- **Fix:** Install release read-only for the runtime identity, verify an operator-hash-pinned exact manifest covering server, package, lock, and dependency tree, and reject unexpected files. This is not a public-key signature.
- **Verification:** Mutate a disposable dependency while preserving server.js and assert startup fails.

### M-05 — Running queue cancellation does not cancel the child process

- **Severity:** Medium
- **Status:** Confirmed from code
- **Affected:** cancel_opencode_job and queue execution
- **Evidence:** running cancellation sets cancellationRequested and explicitly warns the process may finish. startQueueRecord checks the flag only before executeOpenCodeJob; no running child handle is exposed to cancellation.
- **Impact:** Expensive or unsafe jobs continue consuming time/quota after cancellation.
- **Existing mitigation:** Normal timeout eventually kills the process tree.
- **Fix:** Register child handles by job ID, propagate AbortSignal, kill the exact tree, then mark cancelled only after process exit and validation/rollback.
- **Verification:** Disposable sleeping fake OpenCode process must disappear immediately after cancel.

### M-06 — Recent persisted running jobs are not resumed after restart

- **Severity:** Medium
- **Status:** Confirmed from code and persisted-state behavior
- **Affected:** SQLite queue recovery
- **Evidence:** nonterminal records not present in memory are only reclassified after the two-hour stale threshold. They can be treated as running conflicts but are not resumed.
- **Impact:** Up to two hours of blocked paths and ambiguous job state after a crash.
- **Existing mitigation:** Stale reconciliation correctly marked three old records queue_job_abandoned.
- **Fix:** On startup, atomically mark all orphaned running records interrupted, verify/clean retained worktrees and locks, and provide explicit resume/retry policy.
- **Verification:** Kill/restart a disposable bridge mid-job and assert deterministic interrupted recovery within seconds.

### L-01 — Read-only change detection silently degrades outside Git

- **Severity:** Low
- **Status:** Potential
- **Affected:** gitChangedFiles
- **Evidence:** if all Git change commands fail, the function returns an empty list. Write jobs normally fail worktree setup outside Git, but read-only jobs can still run.
- **Impact:** A misconfigured read-only agent that edits a non-Git directory may evade bridge detection.
- **Existing mitigation:** Managed read-only agents have edit denied.
- **Fix:** Require Git for protected read-only enforcement or implement filesystem snapshots for explicit read scopes.
- **Verification:** Disposable non-Git read-only agent with a controlled edit attempt must fail closed.

## 18. Model/provider/quota findings

### Catalog versus runtime status

| Model | Catalog | Agent resolves | Auth/live inference | Tool calls | Multi-step | Quota |
|---|---|---|---|---|---|---|
| openai/gpt-5.6-terra | Yes | Debugger/Reviewer/MCP orchestrators | Passed | Passed | Passed, but permission/final issues observed | Sufficient during audit |
| openai/gpt-5.6-luna | Yes | Tester/Planner/Explore | Passed in multi-step audit sessions | Passed | Sessions ran many tools but produced no final after rejected bash | Sufficient during audit |
| google/gemini-3.6-flash | Yes | Builder | Provider reached; no auth error | Pre-existing same-day MODEL_OK session showed skill tools | Current multi-tool jobs blocked | Free-tier daily request limit 20 exhausted |
| openai/gpt-5.5 | Yes | Architect | Resolution only | Not live-tested | Not live-tested | Unverified |
| opencode/big-pickle | Yes | Fallback mentioned in agent text only | Not tested | Not tested | Not tested | Unverified |

The agent files mention big-pickle fallback, but the bridge does not implement provider/model fallback. An agent cannot choose its textual fallback when its initial model call never returns. Current Gemini quota therefore makes Builder and Contractor workflows unreliable.

Minimal live Reviewer through the bridge:

- Actual model: openai/gpt-5.6-terra, high.
- Final response: MODEL_OK.
- Exit: 0.
- Duration: 39,551 ms.
- Mandatory skill calls: three.

Current account assessment: OpenAI models were usable. Gemini authentication/provider routing reached the API, but quota was insufficient for even the one-file Builder E2E. The current account cannot reliably support multi-tool Builder jobs until quota resets or capacity is increased.

## 19. Test and verification results

| Check | Result | Exit | Duration | Evidence |
|---|---|---:|---:|---|
| node --version | Passed | 0 | 191 ms | v24.11.1 |
| codex --version | Passed | 0 | 481 ms | 0.133.0 |
| opencode --version | Passed | 0 | 1,896 ms | 1.15.7 |
| git --version | Passed | 0 | 90 ms | 2.39.1.windows.1 |
| codex mcp list | Passed | 0 | 2,226 ms | opencode enabled, active release path |
| opencode models openai | Passed | 0 | 8,163 ms | desired OpenAI models present |
| opencode models google | Passed | 0 | 7,702 ms | Gemini 3.6 Flash present |
| opencode models opencode | Passed | 0 | 10,968 ms | big-pickle present |
| opencode debug agent, 10 agents | Passed | 0 each | 6.5–8.4 s each | names/modes/models resolved |
| source npm test | Passed | 0 | 32,563 ms | syntax, TUI smoke, self-tests |
| active release npm test | Failed | 1 | 4,594 ms | missing bin/tui.js |
| active release node server.js --self-test | Passed | 0 | 15,531 ms | Self tests passed |
| source npm audit --omit=dev | Passed | 0 | 17,627 ms | 0 vulnerabilities |
| release npm audit --omit=dev | Passed | 0 | 17,638 ms | 0 vulnerabilities |
| git diff --check | Passed | 0 | 928 ms | only LF/CRLF warnings |
| installed MCP handshake/tools/list | Passed | 0 | connect 897 ms | 18 tools |
| bridge status | Passed | 0 | live | healthy |
| source/release hashes | Passed | 0 | live | server/package/lock match |
| active/source agent hashes | Passed | 0 | live | 17/17 match |
| missing OpenCode executable health | Passed | tool call 0 | 3,328 ms | attention required, ENOENT |
| invalid model | Passed as failure handling | 1 | 16,454 ms | structured model-not-found error |
| unsafe delegation preflights | Passed | rejected before run | 0–21 s | seven expected rejections |
| direct read-only delegated audit | Failed communication | process 0 | about 2 min wall | no assistant finals |
| minimal OpenAI Reviewer | Passed | 0 | 39,551 ms | MODEL_OK |
| normal E2E | Blocked by external dependency | script failure | 335,519 ms | Gemini 429 → Builder timeout |
| Contractor E2E | Blocked by external dependency | script failure | 612,003 ms | authorized routing; nested Gemini 429 → timeout |
| live integration after model edit | Blocked | not reached | — | Builder failed first |
| provider auth failure | Not conclusively run | — | — | isolated setup failed at model resolution |

### Post-remediation verification addendum

| Check | Result | Evidence |
|---|---|---|
| Source `npm test` | Passed | Syntax, TUI smoke, expanded self-tests |
| Final release `npm test` with both integrity pins | Passed | `bin/` present; manifest verified before self-tests |
| Full release manifest | Passed | Exactly 7,861 hashed files; unexpected/missing/modified/link entries fail startup |
| Active release handshake | Passed | 6,849 ms; 18 tools; bridge healthy |
| Live Reviewer final-response check | Passed | 54,458 ms; final detected; `REMEDIATION_OK`; error type none |
| Live separate shell diagnostics | Passed | Three skill calls plus two separate completed bash calls |
| Explore read-only routing | Passed | Accepted via documented read-only `planner` proxy; no write-capable proxy |
| Contractor default security | Passed | Forged token rejected as `orchestrator_contractor_disabled`; active capability unconfigured |
| Exit-0 tool-only/empty final fixtures | Passed as expected rejection | `agent_empty_final_response` |
| Quota/auth/billing fixtures | Passed as expected rejection | Distinct provider types; hard quota process terminated early in synthetic probe |
| Queue cancellation fixture | Passed | Exact child tree exited 130 and reported cancelled |
| Queue restart fixtures | Passed | Immediate `queue_job_interrupted` / `queue_job_not_resumable` |
| Ignored secret/large-file snapshot behavior | Passed | Metadata fingerprints; content not retained; count/size caps |
| Junction/symlink fixture | Passed | Outside-root link rejected |
| Non-Git protected execution fixture | Passed as expected rejection | `git_state_required` |
| Dependency audit during final release install | Passed | 0 known vulnerabilities |

The post-remediation pass did not rerun the expensive Gemini Builder or Contractor live E2E because the original blocker was an external daily quota. The new fast-fail provider path was verified synthetically, while the live OpenAI Reviewer path verified the real JSON event parser and final-response gate.

## 20. Confirmed working behavior

- Active Codex configuration loads and sees the MCP server.
- Installed MCP initialization and tools/list work.
- All 18 tools are discoverable.
- Bridge status reports healthy in the actual environment.
- Agent discovery finds all required managed agents.
- Server startup hash is enforced and matches.
- Source and active custom agents match.
- Source and active release package hashes match.
- Path traversal and outside-root absolute paths are rejected.
- Missing agents fail closed without fallback unless explicitly allowed.
- Read-only jobs cannot request edit scopes.
- Write jobs require Scope Contracts, locks, and allowed edits.
- Unauthorized Contractor mode is rejected.
- Contractor mode cannot run as a parallel outer job.
- Planning-only orchestrator requests to invoke writers are rejected.
- Contractor routes to opencode-orchestrator-mcp-contractor and its task allowlist permits Builder but excludes orchestrators.
- Windows process-tree timeout terminated both live E2E child trees; no fixture-referencing process remained.
- Source self-tests cover core lock, queue, worktree, validation, rollback, and integration paths.
- npm audit found no known production dependency advisories.

## 21. Failed or blocked behavior

### Failed

- Installed release npm test: package script references omitted bin files.
- Three read-only delegated audit agents: OpenCode exit 0, but no assistant final response.
- Intended direct Explore delegation: safe preflight rejection because Explore proxies to write-capable build.

### Blocked by external dependency

- Normal E2E: Gemini free-tier daily quota exhausted.
- Contractor E2E: same quota exhausted in nested Builder.
- Live model-driven integration: Builder never produced a patch.
- Reliable Gemini multi-tool Builder operation: current quota demonstrably insufficient.

### Not run or inconclusive

- Destructive security exploitation.
- Real junction/symlink escape.
- Live integration conflict after a model-generated patch.
- Conclusive provider-authentication failure classification.
- Independent live inference for Architect and Debugger.

## 22. Remaining risks

- Prompt injection in repository files can influence agents. Filesystem gates limit edits but cannot prove the truth of textual test/review claims.
- Nested Contractor subagents are visible to OpenCode but only aggregate changes are visible to the bridge.
- A malicious/compromised local MCP client can assert Contractor authorization.
- Junction/symlink paths are not canonicalized to real filesystem targets.
- OpenCode local logs and database retain prompts/tool activity.
- Raw JSON event streams remain large and semantically unvalidated.
- Validation commands are trusted coordinator input and can execute arbitrary binaries without a shell.
- Queue crash recovery is delayed rather than resumable.
- Dependencies are not verified by an operator-hash-pinned exact runtime manifest.
- Dirty source trees make integration riskier; the bridge correctly defaults to rejecting dirty integration targets.
- No guarantee exists that every vulnerability class has been exhausted.

## 23. Recommended fixes, prioritized

### Priority 0 — before unattended use

1. Parse OpenCode JSONL and require a non-empty terminal assistant final response.
2. Surface provider errors immediately; fail fast on hard/daily quota and authentication failures.
3. Remove ignored-tree content reads from snapshots; scope and cap all baseline I/O.

### Priority 1 — before routine team use

4. Fix OpenCode bash policies/agent prompts so safe diagnostics do not request noninteractive approval.
5. Make Explore a directly runnable read-only agent or use a safe read-only proxy.
6. Add technical MCP disable to Codex worker.
7. Add realpath/reparse-point enforcement.
8. Implement true running-job cancellation with exact process-tree termination.
9. Fix release packaging so npm test works from the installed release.
10. Sign and verify a complete release manifest, not only server.js.

### Priority 2 — hardening

11. Replace raw event-stream MCP results with bounded structured results.
12. Add deterministic queue restart recovery.
13. Redact/reduce OpenCode local logs and document retention.
14. Add mocked provider failure tests for 401, 403, 429 transient, 429 daily quota, 5xx, empty final, and truncated output.
15. Add Windows junction and case/separator regression tests.
16. Add a quota-aware configured Builder fallback rather than relying on agent prose.

## 24. Operating guide

### Recommended supervised workflow

1. Run get_opencode_bridge_status.
2. Run validate_delegation_plan.
3. Prefer direct named agents.
4. For a write, use one explicit Scope Contract with concrete repo-relative paths.
5. Require a worktree and validation command.
6. Inspect requested agent, actual agent, model, errors, final response, changed files, diff, and validation.
7. Reject empty/tool-call-only results even if exit is 0.
8. Run Reviewer and Tester separately after Builder.
9. Dry-run integration.
10. Set reviewed true only after Codex/human review.
11. Validate the target again after integration.

### Current Gemini rule

If Gemini returns 429 daily quota, stop. Do not retry normal or Contractor workflows until quota resets/capacity changes or a tested fallback is configured.

### Contractor rule

Use Contractor only when the user explicitly names/authorizes it, the task is bounded, the aggregate scope is concrete, the fixture/worktree is disposable or reviewable, and one outer job is acceptable.

## 25. Ready-to-copy prompts

### 1. Codex direct-delegation mode

~~~text
Act as the Codex Principal Orchestrator. Inspect the repository first. Delegate directly through the OpenCode MCP bridge to the smallest appropriate named agents; do not invoke OpenCode Orchestrator. Preflight every job. Keep read-only discovery separate from writes. For each write, use an isolated worktree, one explicit Scope Contract, concrete lockedPaths and allowedEdits, forbidden/shared paths, a timeout, and a validation command. Review every requested/actual agent, model, final response, diff, and test result before deciding whether to integrate.
~~~

### 2. Explicit OpenCode Contractor mode

~~~text
I explicitly authorize OpenCode Contractor Orchestrator for this task only. Codex remains the primary controller. Create one bounded aggregate Scope Contract for [TASK] in a disposable or retained isolated worktree. Allowed edits: [PATHS]. Forbidden/shared paths: [PATHS]. Validation: [COMMAND]. Run exactly one outer Contractor job, allow only the configured subagents, do not permit direct Contractor edits or recursive orchestrators, and return one consolidated diff/report for Codex review. Do not integrate until Codex has reviewed a dry-run preview.
~~~

### 3. Read-only architecture review

~~~text
Use direct OpenCode Planner and Architect agents in read-only mode. Inspect [SCOPE]. Do not edit files, do not invoke writer agents, and do not use OpenCode Orchestrator. Return verified architecture, entry points, data/control flow, risks, exact file/line evidence, and unknowns. Require a non-empty final response from each agent.
~~~

### 4. Bug investigation

~~~text
Use direct OpenCode Debugger for a bounded investigation of [SYMPTOM]. First inspect logs, failing tests, and relevant code. Separate hypotheses from confirmed root cause. Do not edit until Codex approves a write Scope Contract. Return reproduction, evidence, root cause, minimal fix, affected paths, and verification plan.
~~~

### 5. Builder → Reviewer → Tester workflow

~~~text
Codex: preflight and run one bounded OpenCode Builder worktree job for [TASK] with allowedEdits [PATHS], forbidden/shared paths [PATHS], timeout [MS], and validation [COMMAND]. If and only if Builder returns a non-empty final response, an in-scope diff, and successful validation, run direct read-only Reviewer on the worktree, then direct read-only Tester. Reject tool-call-only or quota/timeout results. Dry-run integration and wait for Codex review.
~~~

### 6. Security review

~~~text
Use direct OpenCode Reviewer in read-only mode to review [SCOPE] for authorization, path traversal, symlink/junction escape, command injection, secrets/logging, process cleanup, concurrency, output trust, and dependency risks. Do not edit or call writer agents. Return severity, status, exact evidence, scenario, impact, mitigation, fix, and verification for each finding.
~~~

### 7. Contractor disposable fixture test

~~~text
I explicitly authorize one OpenCode Contractor-mode E2E test for this audit only. Create a verified disposable Git repository under the system temp directory. Give the Contractor one write path and one deterministic one-line change, with all other files forbidden/shared. Require one allowlisted Builder, diff review, git diff --check, dry-run integration, reviewed integration, and cleanup. Use explicit timeouts. On timeout, kill only the exact child process tree. Validate the fixture path before deletion. Do not touch the real source worktree.
~~~

## 26. Recommended use cases

- Large feature implementation with clear modules and ownership.
- Multi-module changes that can be decomposed safely.
- Repository exploration using directly runnable read-only agents.
- Bug investigation with evidence and a later bounded fix.
- Independent code review.
- Test planning and validation.
- Architecture analysis.
- Bounded parallel implementation with non-overlapping paths.
- Explicit Contractor orchestration for one aggregate bounded task after quota and final-response fixes.

## 27. When not to use the system

- Tiny one-line changes where orchestration overhead dominates.
- Vague tasks without concrete acceptance criteria or path scope.
- Repositories containing unprotected/ignored secrets until ignored-file scanning is fixed.
- Destructive production operations.
- Deployments without human approval.
- Highly coupled changes that cannot be split safely.
- Gemini-heavy workflows under the current quota.
- Tasks requiring unavailable/unsupported models or permissions.
- Non-Git write projects under the current worktree design.
- Any workflow that treats exit 0 as success without checking a final response and artifacts.

## 28. Troubleshooting guide

### Codex does not see the MCP server

Run codex mcp list. Confirm opencode is enabled, points to the active release server.js, Node exists, startup timeout is adequate, and the expected server hash matches. Run an independent handshake/tools-list test.

### OpenCode agent is missing

Run opencode agent list and opencode debug agent NAME. Compare active/source agent files. Do not enable fallback to build unless a write-capable fallback is actually acceptable.

### Wrong model is selected

Run opencode models PROVIDER and opencode debug agent NAME. Check custom agent frontmatter, active opencode.jsonc defaults, requested agent, actual agent, and fallback/proxy fields.

### Agent permissions are wrong

Inspect opencode debug agent output, not only frontmatter. Remember bash true means the tool exists; individual calls may still be ask/deny. Split commands into exact allowlisted invocations.

### A job times out

Determine whether the cause is provider quota, permission wait, tool loop, or real computation. Inspect structured bridge fields and sanitized local logs. Confirm the exact PID tree is gone. Retain and inspect the worktree before cleanup.

### Gemini returns HTTP 429

If the response is daily/free-tier quota exhaustion, stop immediately. Do not loop. Wait for quota reset, increase quota/billing, or use a tested configured fallback. Current bridge output may say agent_timeout; check logs for RESOURCE_EXHAUSTED.

### A process remains running

Identify it by exact PID and command line. Terminate only that tree. On Windows use taskkill /PID exact_pid /T /F after verifying the PID belongs to the job. Re-check process state.

### A worktree is retained

Run git worktree list from the owning repository. Inspect status/diff and branch. Integrate only after preview/review, or remove only the verified worktree and branch. Never recursively delete an unverified path.

### Integration fails

Do not force it. Inspect dirty-target overlap, patch check, allowed/forbidden paths, validation output, index reset, and rollback report. Resolve in a fresh disposable worktree if needed.

### Active and source agent files differ

Hash both copies, identify which is intended, review the diff, update through the normal installation process, and re-run opencode debug agent. Do not overwrite active files blindly.

### Codex config fails to load

Validate TOML syntax, paths, quotes/backslashes, command, args, environment value types, startup/tool timeouts, and expected hash. Restore from a reviewed backup only when necessary; do not expose auth.json.

## 29. Maintenance checklist

- [ ] Verify node, codex, opencode, npm, and Git versions.
- [ ] Run codex mcp list.
- [ ] Run installed-release MCP handshake and tools/list.
- [ ] Run get_opencode_bridge_status.
- [ ] Hash server, package.json, package-lock.json, and active agents.
- [ ] Verify an operator-hash-pinned complete release manifest.
- [ ] Run npm test from source and installed release.
- [ ] Run npm audit --omit=dev.
- [ ] Run git diff --check.
- [ ] Run opencode models for required providers.
- [ ] Run opencode debug agent for every managed agent.
- [ ] Confirm read-only agents cannot edit or delegate.
- [ ] Confirm Codex non-primary agents cannot see the bridge.
- [ ] Test missing executable, missing agent, invalid model, auth failure, 429, empty final, timeout, and cancellation.
- [ ] Test Windows junction/symlink boundaries.
- [ ] Test queue crash/restart recovery.
- [ ] Test output-size limits and terminal-error preservation.
- [ ] Run normal E2E only when Builder quota is available.
- [ ] Run Contractor E2E only with explicit authorization and a disposable fixture.
- [ ] Inspect and clean retained worktrees safely.
- [ ] Review queue retention and abandoned records.
- [ ] Review OpenCode log retention/redaction.
- [ ] Never treat exit 0 alone as job success.

## 30. Glossary

- **Codex Principal Orchestrator:** User-facing primary controller responsible for delegation, review, and integration decisions.
- **MCP:** Model Context Protocol; the local stdio interface between Codex and the bridge.
- **OpenCode agent:** Configured role/model/permission profile executed by OpenCode CLI.
- **Scope Contract:** Normalized read/write/forbidden/shared/validation boundary for a job.
- **allowedEdits:** Exact files/directories whose changes may be accepted.
- **lockedPaths:** Paths protected by the bridge's coordination lock.
- **shared files:** Frozen paths that must not change in the job.
- **serial-only paths:** Global/risky files that cannot be written in parallel.
- **worktree:** Isolated Git checkout used for writer execution.
- **planning-only orchestrator:** opencode-orchestrator-mcp-planner role that cannot edit or call writers.
- **Contractor:** Explicitly authorized opencode-orchestrator-mcp-contractor that coordinates allowlisted nested agents inside one aggregate contract.
- **legacy orchestrator:** OpenCode backup/standalone orchestrator not used by normal MCP alias routing.
- **native fallback:** OpenCode silently substituting another agent; treated as an error by the bridge.
- **final response:** Non-empty terminal assistant text event. The remediated bridge requires one for every non-dry-run success.
- **external blocker:** Provider/quota state outside the bridge that prevents completion.
- **queue_job_interrupted:** Orphaned active job failed immediately after bridge restart.
- **queue_job_not_resumable:** Orphaned queued job failed immediately because full execution requests are intentionally not persisted.
- **reviewed integration:** Separate integration call with reviewed true after Codex inspects the preview.

---

### Audit cleanup and change declaration

- Normal E2E retained fixture removed after validating it was under the system temp directory and no other process referenced it.
- Contractor E2E retained fixture removed with the same validation.
- Both exact outer child PIDs were no longer running.
- No active MCP lock remained.
- The original audit performed no production/configuration edits. The authorized remediation pass later updated the scoped source, documentation, active agent copies, Codex MCP configuration, and installed release.
- One generated intermediate release was removed after verifying it was inactive and referenced by no non-audit process; it was reproducible build output and is not recoverable from that deleted path.
- No commit, push, merge, or external-service deployment was performed, and no unrelated modification was made.

## 31. 2026-08-07 parallel-safety hardening addendum

This addendum supersedes earlier statements that non-terminal SQLite queue records are reconciled immediately. Immediate reconciliation was unsafe when two Codex tasks used separate MCP server processes against the same repository.

### Confirmed findings and remediation

1. **Critical lock-path aliasing fixed.** Before remediation, `src` and an absolute path to the same directory could both acquire write locks. Every Scope Contract and hard-lock path is now canonicalized to repository-relative form before validation, scheduling, persistence, and comparison.
2. **Shared-reader schema fixed.** The original SQLite primary key allowed only one row per path, so the second read lock failed even though read/read conflicts were intentionally permitted. The lock table now uses `(normalized_path, run_id)` and migrates the legacy schema transactionally.
3. **Serial integration made real.** Reviewed worktree/branch integration now acquires a repository-wide `serial_integration` lease. It conflicts with every active reader, writer, and integration, including disjoint paths, and is released in a `finally` block.
4. **Cross-process queue reconciliation fixed.** Recent non-terminal rows missing from one process's memory are preserved for other active bridge processes. Reconciliation occurs only after `CODEX_OPENCODE_QUEUE_STALE_AFTER_MS`.
5. **SQLite startup contention fixed.** Busy handling is enabled before WAL/schema work; retry with bounded exponential backoff handles simultaneous first-open and short `SQLITE_BUSY`/`SQLITE_LOCKED` races.
6. **Git change detection fails closed.** If any required working-tree, staged, untracked, or ignored-file query fails, protected execution stops instead of accepting a partial file list.
7. **Policy symlink boundary hardened.** `.mcp/agent-policy.json` loading now applies the same real-path/symlink/junction boundary checks as job scopes.
8. **In-memory retention bounded.** Expired terminal queue and pipeline objects are pruned along with persisted retention cleanup.
9. **Recovered transport timeouts no longer create false failures.** A stderr-only `ProviderHeaderTimeout`/connection warning is downgraded only when OpenCode finishes with a non-empty terminal text event and no structured stdout error. Hard provider errors and incomplete results remain terminal.

### Verification evidence

- `npm test`: passed, including syntax, TUI smoke, migration, canonicalization, shared-reader, serial-integration, stale-queue, symlink-policy, rollback, and release-integrity assertions.
- `npm run test:concurrency`: passed once after the final busy-timeout setting and five consecutive stress runs before it. Each run starts two independent MCP servers sharing one repository/state database and executes 20 overlapping-writer races plus 10 disjoint-writer races.
- `npm run test:e2e`: passed in 247.5 seconds with healthy bridge status, planning, Builder worktree implementation, Reviewer, Tester, integration preview, reviewed integration, and exact changed-file validation.
- A later exact-workflow run exposed a recovered `ProviderHeaderTimeoutError` that the older parser treated as `opencode_api_error` despite a complete Reviewer report. Regression tests now cover recovered transient, unrecovered transient, structured-error-plus-text, and hard-auth-error-plus-text cases. The remediated source A-to-Z run then passed in 227.4 seconds.
- Root `npm audit --omit=dev`: zero known vulnerabilities.
- OpenCode package `npm audit --omit=dev`: zero known vulnerabilities.
- `git diff --check` for the implementation files: passed; line-ending warnings only.

### Remaining boundaries

No finite review can prove that software has zero future defects. The verified design prevents the reproduced concurrency failures and fails closed on scope/Git uncertainty. Provider outages, quota exhaustion, operating-system failure, malicious repositories, and the unofficial Google OAuth plugin remain external or supply-chain risks. Writer parallelism is safe only for genuinely independent scopes; shared manifests, schemas, migrations, entry points, and integration remain serial work.
