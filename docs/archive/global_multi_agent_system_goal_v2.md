> **Historical record (archived 2026-09-24).** Line numbers, file names, release names, and procedures in this document may be out of date. Current docs: [USER_GUIDE.md](../USER_GUIDE.md) and [REFERENCE.md](../REFERENCE.md).

# Global Multi-Agent Orchestration System v2

## Purpose

This document is the authoritative v2 architecture specification for the global Codex to OpenCode multi-agent orchestration system.

It describes the approved architecture, responsibilities, routing rules, lock rules, handoff protocol, Spec Kit policy, validation strategy, and the Managed Fast Delegation capability. It is intended to be readable by a future human maintainer, Codex orchestrator, OpenCode orchestrator, reviewer, tester, or implementation agent without requiring previous conversation history.

The system goal is:

```text
User
  ↓
Codex
  ↓
MCP Bridge
  ↓
OpenCode
  ↓
OpenCode Agents
```

Codex is the primary orchestrator. OpenCode is the execution backend. The MCP bridge provides the controlled protocol boundary between them.

## Hardened Operating Invariants (2026-08-09)

These invariants supersede any older example in this document that conflicts with them:

- An executed writer worktree is retained until Codex reviews an exact preview receipt, integration applies and validates successfully, and cleanup is explicitly requested. Job success alone never deletes output.
- Writer worktree creation rejects every dirty source state as `dirty_worktree_requires_checkpoint`; the bridge never commits, stashes, resets, or overlays user changes.
- File scope controls edits, not row-level reads. Sensitive audits use an externally prepared read-only sanitized workspace with raw artifacts physically absent and exact manifest verification before and after each wave.
- Provider retries are bounded and read-only-only; requested, configured, and runtime-observed model evidence is distinct. Silent model/agent fallback is disabled.
- External plugins remain off/`--pure` by default. Opt-in requires exact name/version and an out-of-band pinned integrity manifest; the bridge never persists provider or Contractor credentials.
- Repository policy is untrusted and tightening-only. Validation commands require exact out-of-band policy approval plus an operator executable/argument policy and run with `shell:false` in a credential-free environment.
- Queue ownership uses process-instance leases and heartbeats. Audit records are not replayable jobs, and a foreign live job is never failed merely because it is absent from local memory.
- Direct parallel execution is one synchronous barrier and returns terminal per-job results, not queue IDs. Use queue/pipeline tools for monitoring or individual cancellation.
- Subagent routing rejects by default; any explicit proxy must be a verified read-only agent and the actual route/model is reported.
- Locks are renewable coordination leases, not OS filesystem locks. Receipt-bound source/target/base digests and before/after snapshots detect external mutations.
- Truncated essential output, incomplete snapshots, or unsafe rollback are terminal and cannot be reported as full success.

No finite review or test suite proves zero future defects. Host compromise, malicious repositories, provider outages, semantic data leakage, and unofficial OAuth supply-chain/account risk require external controls such as a VM/container and least-privilege accounts.

---

## Core Architecture

### Normal System Flow

```text
User
  ↓
Codex App
  ↓
Codex Orchestrator
  ↓
MCP Bridge
  ↓
OpenCode CLI
  ↓
OpenCode Agent
  ↓
Result back to Codex
  ↓
Codex review
  ↓
Validation when possible
  ↓
Final answer to user
```

### Responsibilities

Codex is responsible for:

- Understanding the user request.
- Inspecting the real repository and relevant files.
- Planning the work.
- Choosing whether to work directly or delegate.
- Sending bounded task packets to OpenCode when delegation is useful.
- Owning MCP-level lock decisions for Codex-delegated OpenCode work.
- Reviewing all delegated results before accepting them.
- Running or requesting validation when possible.
- Returning the final answer to the user.

OpenCode is responsible for:

- Executing bounded delegated tasks.
- Running specific OpenCode agents by role.
- Returning concise, structured results.
- Respecting scope, permissions, lock boundaries, and forbidden edits.
- Acting as backup or standalone orchestrator only in the modes documented below.

The MCP bridge is responsible for:

- Exposing OpenCode capabilities to Codex through MCP tools.
- Listing available OpenCode agents.
- Routing requested agents directly to matching OpenCode agents.
- Running single-agent and parallel-agent jobs.
- Enforcing explicit fallback behavior.
- Enforcing hard locks for MCP-delegated write work.
- Rejecting unsafe overlapping parallel writes.
- Reporting command shape, actual agent, fallback status, duration, exit status, and relevant errors.
- Avoiding logging secrets, API keys, tokens, full environment variables, or huge prompts.

### Review and Validation Flow

Delegated work is never accepted blindly.

The required flow is:

```text
OpenCode result
  ↓
Codex reads and reviews result
  ↓
Codex checks files or diff when relevant
  ↓
Codex runs validation when practical
  ↓
Codex reports result, risks, and remaining validation
```

Validation may include tests, lint, type checks, smoke checks, dry runs, command inspection, or manual file review depending on the task.

### Handoff Flow

When Codex cannot continue, Codex emits a `HANDOFF_TO_OPENCODE` block. OpenCode's global orchestrator can then continue from the handoff and the current repository state.

---

## Global Scope

This is a global setup.

It is not project-local by default.

Approved global targets include:

```text
~/.codex/agents/
~/.config/opencode/agents/
codex-opencode-mcp/
```

Current concrete paths include:

```text
%USERPROFILE%\.codex\agents\
%USERPROFILE%\.config\opencode\agents\
<repo>\
```

The global system must not create project-local orchestration files unless explicitly requested for a specific project.

Do not create these by default:

```text
repo/.opencode/
repo/.specify/
repo/specs/
```

Project-local setup can be added later only when the user explicitly asks for it or a project workflow already requires it.

---

## Codex Orchestrators

Two Codex orchestrators exist.

### Orchestrator A: Spec Kit Aware

File:

```text
~/.codex/agents/principal-engineer-orchestrator.toml
```

Role:

- Principal engineer orchestrator.
- Primary Codex orchestrator with optional Spec Kit support.
- Uses Spec Kit only when the user task explicitly requires Spec Kit or when the current workflow already uses Spec Kit.
- Does not initialize Spec Kit automatically for global Codex/OpenCode bridge work.
- Supports normal Codex orchestration and Managed Fast Delegation Mode.

Use this orchestrator when:

- The task explicitly requires Spec Kit.
- The repository already has an active Spec Kit workflow.
- The work needs spec, plan, task, or analysis artifacts as the source of truth.
- The user wants the Spec Kit-aware orchestration path.

### Orchestrator B: Non-Spec-Kit

File:

```text
~/.codex/agents/principal-engineer-orchestrator-plain.toml
```

Role:

- Principal engineer orchestrator.
- Primary Codex orchestrator for lightweight planning, delegation, implementation supervision, review, and validation.
- Never initializes Spec Kit.
- Does not create `.specify/`, `specs/`, or project-local Spec Kit files.
- Supports normal Codex orchestration and Managed Fast Delegation Mode.

Use this orchestrator when:

- The task does not require Spec Kit.
- The user wants normal repository work with practical planning.
- The work should avoid Spec Kit artifacts completely.
- The user wants fast, direct orchestration without external planning-framework artifacts.

If a task requires Spec Kit while using the non-Spec-Kit orchestrator, the orchestrator must return a clear note recommending the Spec Kit-aware orchestrator instead.

---

## Managed Fast Delegation Mode

Managed Fast Delegation Mode is an optional behavior inside both existing Codex orchestrators.

It does not create a new Codex orchestrator.

It uses a dedicated MCP-safe OpenCode planning agent while preserving the regular standalone orchestrator.

It accepts the requested role `orchestrator`, routes that MCP call to `opencode-orchestrator-mcp-planner`, then routes implementation to direct MCP-managed writer agents.

### Purpose

The purpose is to let Codex quickly obtain a bounded OpenCode plan and execute it through visible, independently scoped writer agents when the user explicitly asks for speed, delegation, or OpenCode orchestration.

Codex remains the primary authority. OpenCode orchestrator performs read-only analysis and returns a concise plan. Codex reviews the plan, invokes direct builder/debugger jobs, reviews and integrates their worktrees, validates the result, and gives the final answer.

### Normal Mode

Normal mode remains the default.

```text
Codex
  ↓
planner
builder
reviewer
tester
  ↓
Codex review
  ↓
validation
  ↓
final answer
```

Normal Codex orchestration includes understanding the request, planning, splitting work when useful, delegating to specific agents when needed, reviewing, validating, and returning the final answer.

### Managed Fast Delegation Mode

Managed Fast Delegation Mode is used only when explicitly triggered.

```text
Codex
  ↓
OpenCode orchestrator (planning-only)
  ↓
direct builder/debugger jobs through MCP
  ↓
reviewer/tester gates
  ↓
Codex review
  ↓
reviewed worktree integration and validation
  ↓
final answer
```

### Trigger Examples

Examples that may trigger Managed Fast Delegation Mode:

```text
خلّي OpenCode orchestrator يحلها
اعطيها للـ OpenCode orchestrator
بدّي سرعة
delegate this to OpenCode
OpenCode يحل ويرجع ملخص
خليها على OpenCode ويرجع summary
```

Managed Fast Delegation Mode must not be triggered silently for ordinary tasks. The user's request must clearly ask for speed, delegation, or OpenCode orchestrator handling.

### Rules

- Use the dedicated OpenCode `opencode-orchestrator-mcp-planner` only for read-only planning through MCP.
- Codex remains the primary authority.
- `opencode-orchestrator-mcp-planner` must not write or invoke any subagent through MCP; `edit` and `task` are both denied.
- Codex invokes direct `builder` or `debugger` jobs with explicit Scope Contracts.
- Codex performs final review.
- Codex previews and reviews worktree integration before applying it.
- Codex performs final validation.
- Send compact context only.
- Send a bounded task only.
- Do not send full conversation history.
- Use MCP routing so bridge policy and agent discovery remain enforceable.
- Do not silently fallback to `build`.
- If `opencode-orchestrator-mcp-planner` is missing, return a clear error and never fall back to a write-capable agent.
- Every direct writer uses explicit locks, allowed-edit boundaries, changed-file validation, and worktree review.

### Delegation Task Packet

The task packet should be compact and explicit:

```text
Role:
orchestrator

Mode:
Delegated Executor

Task:
<bounded task>

Scope:
<files/directories/repo area>

Allowed edits:
<paths or none>

Forbidden edits:
<paths or none specified>

Permissions:
<read-only / write allowed / bash ask / bash allowed>

Constraints:
- Stay inside scope.
- Do not expand the task.
- Do not create new agents.
- Do not silently fallback to build.
- Return concise results.
```

When the task is write-capable through MCP, include lock details:

```text
Lock owner:
Codex

Lock type:
<read / write / serial_integration>

Locked paths:
<concrete paths>

Shared files:
<files frozen unless explicitly assigned>

Validation command:
<command or none known>
```

### Expected OpenCode Result Format

OpenCode orchestrator should return:

```text
1. Summary
2. Files inspected
3. Files changed
4. Changes made or proposed
5. Risks
6. Validation performed
7. Validation still recommended
8. Final recommendation
```

If OpenCode needs files outside the granted scope or lock, it must not edit them. It should return:

```text
NEEDS_INTEGRATION:
- file/path needed
- reason
- recommended change
```

### Final Codex Responsibility

Codex must:

- Review the OpenCode result.
- Inspect files, diffs, or command output when relevant.
- Run validation when possible.
- Identify risks and assumptions.
- Return the final user-facing answer.

Codex must not blindly trust the delegated result.

---

## OpenCode Orchestrator Modes

The MCP-safe planner exists at:

```text
~/.config/opencode/agents/opencode-orchestrator-mcp-planner.md
```

The regular backup/standalone orchestrator remains at:

```text
~/.config/opencode/agents/opencode-orchestrator-standalone.md
```

### Mode 1: MCP Delegated Planner

Use this mode when Codex calls OpenCode orchestrator through MCP with a bounded task.

Responsibilities:

- Treat Codex as the primary orchestrator.
- Stay inside the delegated scope.
- Remain read-only.
- Never launch internal OpenCode subagents.
- Return proposed non-overlapping scopes for direct MCP-managed writer calls.
- Return a concise structured result.

The MCP bridge enforces this mode by routing to `opencode-orchestrator-mcp-planner`, whose `edit` and `task` permissions are denied.

### Mode 2: Backup Orchestrator

Use this mode when Codex cannot continue or the user provides a `HANDOFF_TO_OPENCODE` block.

Responsibilities:

- Read the handoff.
- Understand original goal, completed work, remaining work, risks, and validation state.
- Inspect the current repository state.
- Continue the plan conservatively.
- Delegate to OpenCode subagents when useful.
- Review subagent results.
- Run validation when possible.
- Produce a final report.

### Mode 3: Standalone Orchestrator

Use this mode when OpenCode is launched directly without Codex/MCP.

Responsibilities:

- Inspect the current repository.
- Read local project instructions when present.
- Plan lightly and practically.
- Use OpenCode subagents as temporary executors.
- Manage local scoped ownership internally when parallel writes are needed.
- Run work serially when ownership is unclear.
- Do not request locks from Codex.
- Do not create repo-local `.opencode/` automatically.
- Do not initialize Spec Kit automatically.

In standalone mode, OpenCode subagents do not wait for Codex locks because Codex is not the active orchestrator.

---

## Direct Agent Routing

Direct routing is required.

Requested OpenCode agent names must route to the matching OpenCode agent when it exists:

```text
planner      -> planner
reviewer     -> reviewer
builder      -> builder
tester       -> tester
architect    -> architect
debugger     -> debugger
orchestrator -> opencode-orchestrator-mcp-planner
```

Equivalent command shape:

```text
opencode run --agent <requested-agent>
```

Examples:

```text
planner      -> opencode run --agent planner
reviewer     -> opencode run --agent reviewer
builder      -> opencode run --agent builder
tester       -> opencode run --agent tester
architect    -> opencode run --agent architect
debugger     -> opencode run --agent debugger
orchestrator -> opencode run --agent opencode-orchestrator-mcp-planner
```

Prohibited silent routing:

```text
requested reviewer -> actual build
requested planner  -> actual build
requested builder  -> actual build
requested orchestrator -> actual build
```

Fallback to `build` is allowed only when explicitly requested by the caller and reported clearly.

Missing-agent behavior:

```text
requested: unknown-agent
actual: none
fallback: false
error: agent not found
```

Explicit fallback behavior:

```text
requested: unknown-agent
actual: build
fallback: true
fallback_reason: requested agent not found and fallback to build was explicitly allowed
```

Every routed result should report:

- requested agent
- actual agent used
- fallback status
- fallback reason, if any
- command shape
- working directory
- exit code or API error state
- duration
- stderr summary if failed

---

## Compact Task Packet

Codex should send compact task packets to OpenCode.

The default packet format is:

```text
Role:
<agent>

Task:
<bounded task>

Scope:
<files/directories/modules, or current repo>

Lock granted:
<paths, if write task>

Allowed edits:
<paths or none>

Forbidden edits:
<paths or none specified>

Shared files:
<shared files frozen unless explicitly assigned>

Permissions:
<read-only / write allowed / bash ask / bash allowed>

Return format:
1. Summary
2. Files inspected
3. Files changed
4. Changes made or proposed
5. Risks
6. Validation performed
7. Validation still recommended
8. Final recommendation
```

Task packets must not include:

- Full conversation history.
- Secrets.
- API keys.
- Tokens.
- Full environment dumps.
- Huge unrelated file contents.
- Vague whole-project authority.

---

## Parallel Execution

Parallel execution is useful only when ownership is clear.

### Read-Only Parallel

Read-only parallel work is allowed for roles such as:

```text
planner
reviewer
architect
explorer
tester when read-only
debugger when no edits are allowed
```

Read-only jobs may inspect overlapping files but must not edit.

### Write Parallel

Parallel writes are allowed only with explicit, concrete, non-overlapping write locks.

Safe example:

```text
builder-auth:
  lock: services/auth/
  allowed edits: services/auth/

builder-billing:
  lock: services/billing/
  allowed edits: services/billing/
```

Unsafe example:

```text
agent A edits shared/types.ts
agent B edits shared/types.ts
```

Unsafe example:

```text
agent A edits package.json
agent B edits package.json
```

### Shared File Restrictions

Shared or global files must not be edited in parallel.

Examples include:

```text
package files
lockfiles
shared types
schemas
DTOs
API contracts
OpenAPI specs
database migrations
generated files
global config
test infrastructure
```

These require a serial integration step.

---

## Lock System

The lock system applies to Codex-delegated work that enters OpenCode through the MCP bridge.

In that flow:

- Codex is the external write coordinator.
- The MCP bridge is the executable hard-lock source.
- OpenCode agents are temporary executors.
- OpenCode subagents cannot grant Codex locks to themselves.
- Write agents may edit only paths explicitly granted by Codex through the lock plan.

The lock system does not apply when the user launches OpenCode directly without Codex/MCP. In standalone OpenCode mode, OpenCode orchestrator manages local scoped ownership internally or runs serially.

### Lock Tools

The MCP bridge exposes:

```text
acquire_agent_lock
release_agent_lock
list_agent_locks
```

Normal delegation should prefer lock fields on:

```text
run_opencode_agent
run_opencode_parallel
```

because the bridge can automatically acquire and release hard locks for write or serial lock plans.

### Lock Types

| Lock Type | Purpose | Parallel Allowed |
|---|---|---|
| read | exploration, planning, review, no-edit validation | yes |
| write | implementation inside concrete non-overlapping paths | yes, if no overlap |
| serial_integration | shared/global files or integration work | no |

### Required Write Lock Fields

Write-capable MCP jobs require:

```text
lockType: "write"
lockedPaths: [<concrete paths>]
allowedEdits: [<concrete paths inside lockedPaths>]
forbiddenEdits: [<paths or none>]
```

`ownedPaths` may remain accepted as a backward-compatible alias for `lockedPaths`, but new callers should use `lockedPaths`.

### Rejection Rules

The MCP bridge must reject or fail unsafe write jobs when:

- Locks are missing.
- Locks overlap.
- Locks are ambiguous.
- Locks use wildcards in unsafe ways.
- Locks are too broad, such as `.` or a drive root.
- Write paths include shared/global files that require serial integration.
- `allowedEdits` are outside `lockedPaths`.
- `allowedEdits` overlap `forbiddenEdits`.
- `allowedEdits` overlap `sharedFiles`.
- A read lock changed files.
- A write job changed files outside granted `allowedEdits`.
- OpenCode native fallback was detected unexpectedly.

### Integration Locks

Use serial integration for:

```text
package.json / pyproject.toml / dependency files
lockfiles
shared types
schemas
DTOs
API contracts
OpenAPI specs
database migrations
generated files
global configuration
test infrastructure
cross-module integration files
```

Serial integration work should be performed by one owner at a time.

---

## Handoff Protocol

The handoff protocol lets OpenCode continue when Codex stops, loses context, reaches limits, or intentionally hands off work.

Codex should emit:

```text
HANDOFF_TO_OPENCODE
```

Complete handoff format:

```text
HANDOFF_TO_OPENCODE

1. Original goal
<the user's original objective>

2. Current working directory
<absolute path>

3. Current repo state
<branch, dirty files, important untracked files, active locks if known>

4. Codex plan
<current plan and rationale>

5. Completed work
<what has already been done>

6. Remaining work
<specific next tasks>

7. Files changed
<paths and concise change summaries>

8. Commands run
<commands and real results>

9. Validation result
<tests/checks passed, failed, blocked, or not run>

10. Risks
<known risks, assumptions, unresolved questions>

11. Next recommended task
<one clear next action>

12. Scope and permissions
<allowed edits, forbidden edits, bash permissions, validation commands>

13. Expected final response
<format or criteria for the final report>
```

OpenCode orchestrator in Backup Orchestrator mode should:

- Read the handoff.
- Inspect the repo before editing.
- Continue only the remaining work.
- Preserve completed work.
- Respect scope and permissions.
- Validate when possible.
- Produce a final report with files changed, validation, risks, and next steps.

---

## Spec Kit Policy

Spec Kit is controlled by the selected Codex orchestrator and the task context.

### Spec Kit-Aware Orchestrator

The Spec Kit-aware orchestrator may use Spec Kit only when:

- The user explicitly asks for Spec Kit.
- The repository already uses Spec Kit for the current workflow.
- The current task is explicitly governed by Spec Kit artifacts.

It must not initialize Spec Kit automatically just because Managed Fast Delegation Mode was triggered.

For global Codex/OpenCode MCP bridge setup, validation, routing, lock, handoff, or agent-configuration work, it should avoid creating project-local Spec Kit artifacts unless explicitly requested.

### Non-Spec-Kit Orchestrator

The non-Spec-Kit orchestrator must never initialize Spec Kit.

It must not create:

```text
.specify/
specs/
project-local Spec Kit files
```

If the task requires Spec Kit, it must return a clear note recommending the Spec Kit-aware orchestrator.

---

## Testing Strategy

Testing should prove the orchestration system works as a global, reusable setup.

### Integration Tests

Verify:

- MCP bridge starts.
- MCP client can connect.
- `list_opencode_agents` returns expected agents.
- OpenCode can execute a bounded task through MCP.
- Codex can review returned results.
- Local validation can run after delegated work.

### Delegation Tests

Verify:

- Codex can delegate to planner.
- Codex can delegate to builder.
- Codex can delegate to reviewer.
- Codex can delegate to tester.
- Codex can delegate read-only planning to OpenCode `orchestrator` in Managed Fast Delegation Mode.
- OpenCode orchestrator returns the expected plan and proposed writer scopes.
- OpenCode orchestrator write or nested-writer requests are rejected.
- Codex reviews the plan before invoking direct writer agents.

### Routing Tests

Verify direct routing:

```text
planner      -> planner
reviewer     -> reviewer
builder      -> builder
tester       -> tester
architect    -> architect
debugger     -> debugger
orchestrator -> opencode-orchestrator-mcp-planner
```

Verify:

- Unknown agent returns a clear error.
- Fallback to `build` occurs only when explicitly allowed.
- Fallback reason is reported.
- Native OpenCode fallback is detected and reported as unsafe when it means the requested role may not have executed.

### Lock Tests

Verify:

- Read-only parallel jobs can run.
- Write jobs require explicit locks.
- Parallel writes with non-overlapping locks can run.
- Parallel writes with overlapping paths are rejected.
- Shared/global files require serial integration.
- Jobs that edit outside allowed paths are rejected.
- Read locks that produce edits are rejected.

### Handoff Tests

Verify:

- Codex can emit a complete `HANDOFF_TO_OPENCODE` block.
- OpenCode orchestrator can read the handoff.
- OpenCode can identify completed and remaining work.
- OpenCode can continue from current repo state.
- OpenCode can validate and return a final report.

### Config Tests

Verify:

- The dedicated `opencode-orchestrator-mcp-planner` safety agent is installed.
- The two existing Codex orchestrators still parse and load.
- The global OpenCode `opencode-orchestrator-mcp-planner` and `opencode-orchestrator-standalone` agents exist.
- No repo-local `.opencode/`, `.specify/`, or `specs/` are created unless explicitly requested.

---

## Definition of Done

The system is considered ready when:

```text
list_opencode_agents works
run_opencode_agent routes planner directly
run_opencode_agent routes reviewer directly
run_opencode_agent routes builder directly
run_opencode_agent routes tester directly
run_opencode_agent routes architect directly when available
run_opencode_agent routes debugger directly when available
run_opencode_agent routes requested orchestrator to opencode-orchestrator-mcp-planner
unknown agent returns clear error
fallback to build is explicit, not silent
run_opencode_parallel allows safe read-only parallel work
run_opencode_parallel rejects unsafe overlapping writes
write delegation requires concrete locks
shared/global file edits require serial integration
global opencode-orchestrator-mcp-planner.md and opencode-orchestrator-standalone.md exist
opencode-orchestrator-mcp-planner enforces read-only delegated planning with task denied
OpenCode orchestrator supports Backup Orchestrator mode
OpenCode orchestrator supports Standalone Orchestrator mode
handoff protocol is documented and usable
Managed Fast Delegation Mode works
Codex review after delegation works
OpenCode orchestrator delegation works
Dedicated opencode-orchestrator-mcp-planner safety routing is verified
Direct routing is verified
Handoff is verified
Validation is verified
reviewer validates result
tester or local validation passes
Spec Kit-aware orchestrator uses Spec Kit only when explicitly required or already active
Non-Spec-Kit orchestrator never initializes Spec Kit
No repo-local .opencode/ is created unless explicitly requested
No repo-local .specify/ or specs/ is created unless explicitly requested
```

---

## Final Goal

The final architecture is a global multi-agent orchestration layer where Codex remains the primary orchestrator, the MCP bridge provides controlled direct access to OpenCode, and OpenCode agents act as bounded executors.

Normal work flows from Codex to specific OpenCode agents such as planner, builder, reviewer, tester, architect, or debugger. When explicitly requested for speed or delegation, either Codex orchestrator may use Managed Fast Delegation Mode to obtain a bounded read-only plan from OpenCode `orchestrator`, run direct scoped writer jobs, review and integrate their worktrees, validate the result, and return the final answer.

OpenCode orchestrator can also act as a backup orchestrator from a handoff or as a standalone orchestrator when OpenCode is launched directly. Locks apply only to Codex-delegated MCP write work; standalone OpenCode manages its own local scoped execution.

The intended workflow is planned, delegated, reviewed, validated, and recoverable:

```text
READY: Codex ↔ MCP Bridge ↔ OpenCode Agents supports direct routing, safe locks, managed planning, isolated implementation, handoff, review, integration, and validation as a global system.
```
