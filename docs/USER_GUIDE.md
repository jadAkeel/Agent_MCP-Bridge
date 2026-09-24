# Codex OpenCode MCP Bridge — User Guide

A complete, plain-language guide to what this project is, how it works, and how to use it every day.

- New here? Read sections 1–4, then jump to [section 5 (first session)](#5-your-first-session).
- Something broke? Go to [section 11 (troubleshooting)](#11-troubleshooting).
- Maintaining the machine? See [sections 10](#10-housekeeping-and-maintenance) and [12](#12-updating-and-rolling-back).

---

## Contents

1. [What this project is](#1-what-this-project-is)
2. [The pieces](#2-the-pieces)
3. [How a request flows through the system](#3-how-a-request-flows-through-the-system)
4. [The safety model](#4-the-safety-model)
5. [Your first session](#5-your-first-session)
6. [Everyday usage](#6-everyday-usage)
7. [Choosing agents and models](#7-choosing-agents-and-models)
8. [Parallel work](#8-parallel-work)
9. [Reviewing and integrating changes](#9-reviewing-and-integrating-changes)
10. [Housekeeping and maintenance](#10-housekeeping-and-maintenance)
11. [Troubleshooting](#11-troubleshooting)
12. [Updating and rolling back](#12-updating-and-rolling-back)
13. [Reference: MCP tools](#13-reference-mcp-tools)
14. [Reference: configuration](#14-reference-configuration)
15. [Reference: repository layout](#15-reference-repository-layout)
16. [Glossary](#16-glossary)

---

## 1. What this project is

You talk to **Codex** as you normally would. When a task would benefit from help, Codex hands part of it to an **OpenCode agent**, for example a reviewer, a debugger or a builder. It does this through this **MCP bridge**.

The bridge sits between the two. Its job is to make that hand-off **safe, predictable and tidy**:

- **Scope.** An agent can only touch the files it was explicitly allowed to touch.
- **Isolation.** Agents that write code work in a separate copy of the project (a *worktree*), never in your real checkout.
- **Review.** Nothing lands in your project until Codex shows you the exact change and you approve it.
- **Parallelism.** Several agents can work at once without stepping on each other.
- **State.** Nothing is lost if a process crashes, because jobs, locks and results are stored durably.
- **Cleanup.** Leftovers can be inventoried and removed with one command.

In one sentence: **Codex decides, the bridge enforces, and OpenCode agents execute bounded tasks.**

---

## 2. The pieces

| Piece | What it is | Where it lives |
| --- | --- | --- |
| **Codex** | The AI you talk to. It is the orchestrator and the only one allowed to integrate changes. | The Codex app/CLI |
| **Codex orchestrator profile** | The Codex agent you select for work, `principal-engineer-orchestrator`. | `codex/agents/*.toml`, installed into `~/.codex` |
| **MCP bridge** | A Node.js MCP server (`server.js`) that exposes 22 tools to Codex. | Production runs from an immutable release folder, not this checkout |
| **OpenCode** | The agent runtime that actually runs the helper agents. Pinned to version `1.17.13`. | Installed on `PATH` |
| **OpenCode agents** | Role profiles such as `builder`, `reviewer` and `debugger`. Each has fixed permissions and a pinned model. | `opencode/agents/*.md`, copied to the runtime folder automatically when a release starts |
| **Skills** | Reusable instruction packs the agents load, such as `code-review-checklist` and `debugging-investigation`. | `opencode/skills/` |
| **State store** | SQLite databases (one per project) holding jobs, locks, queues and audit records, plus retained worktrees. | `~/.codex/codex-opencode-mcp` |


---

## 3. How a request flows through the system

```text
 You ──► Codex (orchestrator)
           │  1. understands the task, picks the smallest fitting agent
           │  2. writes a Scope Contract (which files may be read / edited)
           ▼
        MCP bridge
           │  3. validates the contract (validate_delegation_plan)
           │  4. takes a lock on the paths, queues the job if needed
           │  5. for writers: creates an isolated git worktree from your last commit
           ▼
        OpenCode agent (builder / debugger / reviewer / ...)
           │  6. does the bounded work, returns a report
           ▼
        MCP bridge
           │  7. checks every changed file against the contract
           │  8. keeps the worktree for review, releases the lock
           ▼
        Codex
           │  9. shows you the diff
           │ 10. dry-run integration → preview receipt (exact patch hash)
           │ 11. after your approval: integrate, run validation, roll back on failure
           │ 12. clean up the worktree
           ▼
 Your project now contains the reviewed change.
```

**Read-only jobs** (review, planning, analysis) skip steps 5 and 9–12. They run directly against your project and return an answer, because they cannot edit anything.

---

## 4. The safety model

```text
Scope Contract           = the law      (what may be touched)
Queue                    = scheduler    (who runs when)
Worktree                 = isolation    (writers never touch your checkout)
Lock                     = collision guard (no two jobs on the same files at once)
Changed-file validation  = enforcement  (anything outside the contract is rejected)
Codex                    = final authority (only Codex integrates, only after review)
```

What this means in practice:

- An agent that edits a file it was not allowed to edit gets its whole result **rejected**.
- Read-only roles (`planner`, `architect`, `reviewer`, `tester`, `explore`) **cannot edit**, and cannot launch nested agents.
- Secrets (`.env`, `*.pem`, `*.key`, `secrets/**`) are forbidden by default.
- Package manifests, lockfiles, schemas and migrations are **serial-only**, so two agents never change them at the same time.
- The bridge **never** stashes, resets or commits your own work.
- The bridge is a coordination boundary, **not** an operating-system sandbox. Do not point it at untrusted or malicious repositories.

---

## 5. Your first session

### Before you start (one time)

1. The target project must be a **git repository with at least one commit**. For a brand-new folder:
   ```bash
   git init && git add -A && git commit -m "initial"
   ```
2. If Codex was open before the bridge was last updated, **restart Codex** so it loads the current bridge.

### Steps

1. Open Codex **in the project you want to work on**, not in this bridge repository.
2. Select the agent **`principal-engineer-orchestrator`**.
3. Type:
   > Run `get_opencode_bridge_status` for this project, then ask an OpenCode reviewer for a short opinion on the code.
4. Wait about 1–2 minutes. You should see:
   - bridge status **healthy**;
   - a review written by the OpenCode reviewer.

If both appear, the whole system works end to end.

---

## 6. Everyday usage

Talk to Codex like you would talk to a senior engineer. You do not need to name tools; Codex chooses them. Some example prompts:

| You want | Example prompt |
| --- | --- |
| A second opinion | "Ask an OpenCode reviewer to review `src/payments.ts`." |
| A plan | "Have the OpenCode planner outline how to add CSV export." |
| Find where something lives | "Use the OpenCode explore agent to find where login tokens are created." |
| Fix a bug | "The signup form crashes on empty email. Have a debugger find the cause and fix it." |
| Build a feature | "Add a `--verbose` flag to the CLI. Let a builder implement it, then show me the diff." |
| Review before merge | "Before integrating, have a reviewer and a tester check the builder's worktree." |
| Parallel work | "Run two builders in parallel: one on `apps/web`, one on `apps/api`." |
| Pick a model | "Use `google/antigravity-gemini-3.8-flash@high` for this job." |
| Check state | "Run `diagnose_opencode_bridge` and tell me if anything is stuck." |

### What you will see for a code change

1. Codex describes the plan and the files the agent may edit.
2. The agent works in a worktree (typically 1–5 minutes).
3. Codex shows **which files changed and the diff**.
4. Codex asks for your approval, then integrates and runs the check.
5. The worktree is cleaned up.

**Your project is never modified without you seeing the change first.**

### Tips

- **Keep tiny edits in Codex itself.** Delegation has overhead, roughly a minute even for trivial work.
- **Uncommitted files are fine**, as long as they are not the files the job needs to edit. See `dirty_worktree_requires_checkpoint` in [section 11](#11-troubleshooting).
- **Do not ask for the OpenCode Orchestrator** unless you specifically want OpenCode to coordinate its own sub-agents. Codex is already the orchestrator.

---

## 7. Choosing agents and models

### Codex orchestrator profile

There is one profile: `principal-engineer-orchestrator`. It uses GitHub Spec Kit only when you ask for it by name or the repository already has `.specify/` or `specs/`.

### OpenCode roles

| Role | Does | Can edit? |
| --- | --- | --- |
| `explore` | Locates files and patterns | No |
| `planner` | Turns requirements into steps | No |
| `architect` | Analyses boundaries and trade-offs | No |
| `reviewer` | Reviews a patch | No |
| `tester` | Designs or inspects verification | No |
| `builder` | Implements an approved, bounded change | Yes, inside its contract and worktree |
| `debugger` | Diagnoses and minimally fixes a defect | Yes, inside its contract and worktree |

Orchestrator profiles (advanced):

| Profile | Behaviour |
| --- | --- |
| `opencode-orchestrator-mcp-planner` | Where a request for "orchestrator" goes by default. Read-only and cannot launch sub-agents. |
| `opencode-orchestrator-mcp-contractor` | Explicit opt-in only. Coordinates internal OpenCode sub-agents for one bounded contract. It is disabled until the operator configures `CODEX_OPENCODE_CONTRACTOR_AUTHORIZATION_SHA256`, and it needs your explicit authorization plus the matching token. |
| `opencode-orchestrator-standalone` | For direct OpenCode sessions only. The bridge never runs it and redirects to the planner instead. |

### Models

- Each role pins one model in its profile. The managed roles default to `google/antigravity-gemini-3.8-flash` with variant `high`.
- You can ask for a **different model per job**, but only if it is in the operator allowlist `CODEX_OPENCODE_MODEL_ALLOWLIST`, for example:
  ```text
  CODEX_OPENCODE_MODEL_ALLOWLIST=google/antigravity-gemini-3.8-flash@high,opencode/gpt-5.3-codex
  ```
  - `provider/model` accepts any variant.
  - `provider/model@variant` accepts only that variant.
- When an allowlisted override is used, the result says `Model selection: operator_allowlist_override` and names the model it replaced.
- A model that is **not** allowlisted is rejected before anything runs (`configured_model_requirement_mismatch`). There is no silent fallback.
- **To allow a new model:** add it to `CODEX_OPENCODE_MODEL_ALLOWLIST` in `~/.codex/config.toml` under `[mcp_servers.opencode.env]`, restart Codex, then run `npm run smoke:live`.

> **Model identity note.** OpenCode 1.17.13 does not report which model actually answered. The bridge therefore reports the *configured* model and never claims runtime proof it does not have. Keep `CODEX_OPENCODE_REQUIRE_RUNTIME_MODEL_EVIDENCE=false`, because `true` rejects every real run on this OpenCode version.

---

## 7b. Using the bridge from Claude Code

The same bridge works from Claude Code. It was registered once with the same command and environment as the Codex entry:

```bash
claude mcp get opencode
```

If it is missing, register it from this repository (`--sync-clients` reads the active release from `~/.codex/config.toml`):

```bash
npm run release:activate -- --sync-clients
```

Every `release:activate` re-registers Claude Code automatically, so both clients always run the same release. Claude's delegation rules live in `~/.claude/CLAUDE.md` (a copy is kept in `claude/CLAUDE.md`). Codex and Claude Code may work on the same repository at the same time: locks and the provider limit are shared, so overlapping writers wait or fail with a clear lock message.

---

## 8. Parallel work

The bridge lets several agents run together **only when their write scopes cannot collide**:

- **Readers** can share files.
- A **reader and a writer** on the same files exclude each other.
- **Writers** on overlapping paths run one after another.
- **Writers** on separate paths run at the same time, each in its own worktree.
- **Integration** is always one at a time per repository.
- A **provider limit** (`CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT`, default `2`) caps how many model calls run at once across all Codex windows. This protects your account from rate limits.

Three ways Codex can run parallel work:

| Tool | Behaviour |
| --- | --- |
| `run_opencode_parallel` | Runs a small batch and waits for all of them. Simplest option. |
| `enqueue_opencode_job` | Durable queue. Jobs survive restarts, and you can inspect or cancel them individually. |
| `create_multi_agent_pipeline` → `run_multi_agent_pipeline` → `finalize_multi_agent_pipeline` | For large features: ownership, worktrees, integration order and final review/test gates. |

Pipelines are for genuinely large work. The bridge rejects a pipeline that is too small.

---

## 9. Reviewing and integrating changes

Writer output is **never merged automatically**. Integration happens in two steps:

1. **Dry run.** `integrate_opencode_worktree(dryRun: true)` returns:
   - the patch;
   - its SHA-256;
   - the source and target identity;
   - a single-use, expiring **preview receipt**.
2. **Apply.** `integrate_opencode_worktree(reviewed: true, previewReceipt: <receipt>, cleanupAfterSuccess: true)`:
   - applies exactly that patch;
   - runs the validation command;
   - **rolls back** if validation fails;
   - removes the worktree only after a passing check.

Safety checks during integration:

- If anything changed between preview and apply, the bridge refuses with `integration_preview_stale`. Preview again.
- Failed, partial, unreviewed or not-yet-integrated worktrees are **kept**, so you never lose work.
- If an agent needs a new package, it stops and returns `DEPENDENCY_REQUIRED {...}`. Codex then:
  1. adds the dependency itself, after your review;
  2. commits;
  3. retries the job.

---

## 10. Housekeeping and maintenance

Run all of these from `C:\Users\10User\codex-opencode-mcp`, the bridge repository.

| Command | What it does | When |
| --- | --- | --- |
| `npm run gc` | Dry run. Lists orphan worktrees, stale records, worktrees awaiting review, and dead project databases. Changes nothing. | Any time |
| `npm run gc:apply` | Removes orphans (source repository gone), repairs the registry, prunes dead databases. | **Weekly** |
| `npm run gc -- --include-retained --older-than 14 --apply` | Also removes reviewed-and-abandoned worktrees older than 14 days. Branches are kept. | Monthly, or when space is tight |
| `npm run doctor -- --cwd C:\path\to\project` | Fast integrity check with no model call. Covers the server hash, Git, databases and stuck jobs. | Start of day, or after a crash |
| `npm run smoke:live` | Starts the bridge exactly as Codex does and runs one tiny real agent job. | After any config or release change |
| `npm run smoke:live:health` | Same as above, without the model call. | Quick check |
| `npm run audit:state` | Read-only SQLite integrity report. | Investigating problems |
| `npm run tui` | Terminal dashboard of jobs, pipelines, locks and worktrees. | Watching work live |
| `npm run release:activate -- --prune` | Runs a normal release, then deletes old releases and config backups. It keeps the active release, the previous one, and the two newest backups. | When releases pile up |

The garbage collector is conservative:

- It **never** touches a project with live jobs, pipelines, locks or leases.
- It **keeps** any worktree that still has uncommitted files, unless you pass `--force-dirty`.
- It deletes `agent/*` branches only with `--delete-branches`.

Before deleting a kept branch, inspect it:

```bash
git log main..agent/<role>/<job>
```

---

## 11. Troubleshooting

When something fails, the bridge returns an error type. Copy it and look it up here.

| Error / symptom | Meaning | What to do |
| --- | --- | --- |
| `dirty_worktree_requires_checkpoint` | You have uncommitted changes in the files the job needs. | Commit or revert those files, then retry. |
| `configured_model_requirement_mismatch` | A model was requested that is not in the allowlist. | Use an allowlisted model, or add it to `CODEX_OPENCODE_MODEL_ALLOWLIST`. |
| `opencode_model_evidence_required` | Runtime model proof was required, but OpenCode does not emit it. | Keep `CODEX_OPENCODE_REQUIRE_RUNTIME_MODEL_EVIDENCE=false`, and do not set `requireRuntimeEvidence: true` on the job. |
| `missing_scope_contract` / `empty_allowed_edits` | A write job was submitted without a proper contract. | Ask Codex to validate the plan with explicit allowed edits. |
| `integration_preview_stale` | Something changed between preview and apply. | Run the dry-run preview again. |
| `dependency_required` | The agent needs a new package. | Let Codex add it, commit, and retry. |
| `validation_command_untrusted` | The job's `validationCommand` cannot run: its program is not in `CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST`, or it uses `npx`, a shell, or inline eval. It is rejected before any agent starts. | Use a plain command such as `npm test`, or add the program to the allowlist. |
| `validation_command_failed` | The validation command ran and returned a non-zero exit code. | Read the validation output in the result; fix the code or the command. |
| `queue_write_requires_worktree` | A queued write job needs worktree mode. | Keep `CODEX_OPENCODE_WORKTREE_MODE=write`. |
| `agent_empty_final_response` | The agent exited without an answer. | Retry. If it repeats, run `npm run smoke:live`. |
| `essential_output_truncated` | The output was too large to trust. | Narrow the task. |
| `worktree_created_dirty` | A new worktree was not clean. It is kept as evidence. | Run `npm run gc` and inspect it. |
| `git_repository_config_unsafe` | The repository has git config the bridge refuses to run with, such as filters or hooks. | Remove the unsafe local git config. |
| `Filename too long` | Windows path limit. | Already handled: the bridge forces `core.longpaths=true`. If you see it, you are on an old release. |
| Tool call times out after 60 s | The Codex MCP entry is missing its timeouts. | Set `startup_timeout_sec = 120` and `tool_timeout_sec = 1500`. |
| Codex acts like the old bridge | The session started before an update. | Restart Codex. |
| Stuck job / lock | A crash left state behind. | Run `npm run doctor -- --cwd <project>`, then ask Codex to run `diagnose_opencode_bridge`. |

**The general recovery recipe:**

1. `npm run doctor -- --cwd <project>`
2. `npm run smoke:live`
3. Restart Codex.
4. If it still fails, read the error type and use the table above.

---

## 12. Updating and rolling back

Production never runs this mutable checkout. It runs a **release folder** whose `server.js` hash is pinned in `~/.codex/config.toml`.

### Changing bridge code, agent profiles, or skills

Run one command from the bridge repository:

```bash
npm run release:activate
```

It does the whole release in order and stops at the first failure:

1. Runs `npm test`. If it fails, nothing is built.
2. Builds a new folder next to the active release, for example `server-daily-20260924-3`.
3. Writes a candidate config with the new path and hash and checks it in a fresh bridge process.
4. Backs up `~/.codex/config.toml` as `config.toml.rollback-<time>`, then swaps in the new config.
5. Runs the health smoke against the live config. If it fails, it restores the backup automatically.
6. Lists old releases and backups. Add `--prune` to delete them.

Then **restart Codex** so new sessions use the new bridge.

Useful options: `--check-only` builds and health-checks a candidate without activating it. `--skip-tests` skips step 1 right after a green `npm test`.

Agent and skill profiles ship inside the release. When the release starts, it copies them into the runtime folder named by `CODEX_OPENCODE_AGENT_DIR` and `CODEX_OPENCODE_SKILL_DIR`. It only adds and updates files, never deletes. `npm run sync:runtime` still exists for a manual dry run.

### Rolling back

1. Copy the newest `config.toml.rollback-*` over `~/.codex/config.toml`.
2. Restart Codex.
3. Run `npm run smoke:live`.

### Before pushing source changes

```bash
npm run test:release
```

This runs `npm test`, the concurrency test, and `npm audit --omit=dev`.

### Current state on this machine

| Item | Value |
| --- | --- |
| Active release | `C:\Users\10User\codex-opencode-mcp-releases\server-daily-20260924-3` |
| Rollback release | `C:\Users\10User\codex-opencode-mcp-releases\server-daily-20260924-2` |
| Config backup | `~/.codex/config.toml.rollback-20260924065005` |
| Runtime agents | `~/.codex/opencode-gemini-runtime-v1/opencode/agents` |
| State | `~/.codex/codex-opencode-mcp` |

---

## 13. Reference: MCP tools

You normally let Codex call these tools. They are listed so you recognise them in its output.

| Group | Tool | Purpose |
| --- | --- | --- |
| Health | `get_opencode_bridge_status` | Quick daily check. `deep: true` gives a full attestation. |
| | `diagnose_opencode_bridge` | Correlated jobs, locks, leases, preserved work and recovery actions for one repository. |
| | `list_opencode_agents` | Available agents and their metadata. |
| Single jobs | `validate_delegation_plan` | Preflights jobs without running anything. |
| | `run_opencode_agent` | Runs one bounded agent. |
| | `run_opencode_parallel` | Runs independent jobs together and waits for all of them. |
| Queue | `enqueue_opencode_job` | Durable queued job. |
| | `list_opencode_jobs` / `get_opencode_job` | Inspect queued jobs. |
| | `cancel_opencode_job` | Cancel a queued or running job. |
| | `inspect_opencode_queue_recovery` | Recovery state after a crash. |
| Pipelines | `create_multi_agent_pipeline` | Plan a multi-agent feature. |
| | `run_multi_agent_pipeline` | Enqueue its jobs. |
| | `get_multi_agent_pipeline` / `list_multi_agent_pipelines` | Inspect pipelines. |
| | `finalize_multi_agent_pipeline` | Final validation and reviewer/tester gates. |
| | `abandon_multi_agent_pipeline` | Retire an obsolete pipeline. Never deletes unintegrated work. |
| Integration | `integrate_opencode_worktree` | Dry-run preview, then receipt-bound apply. |
| Locks (manual) | `acquire_agent_lock` / `release_agent_lock` / `list_agent_locks` | Exceptional debugging only. |
| Sanitized data | `verify_sanitized_workspace` | Verifies a hash-pinned, read-only data workspace. |

---

## 14. Reference: configuration

The configuration lives in `~/.codex/config.toml`, under `[mcp_servers.opencode]` and `[mcp_servers.opencode.env]`. An annotated example is in [codex/config.example.toml](../codex/config.example.toml).

### Settings that matter day to day

| Variable | Recommended | Effect |
| --- | --- | --- |
| `CODEX_OPENCODE_REQUIRE_RUNTIME_MODEL_EVIDENCE` | `false` | `true` rejects every real run on OpenCode 1.17.13. |
| `CODEX_OPENCODE_SOURCE_DIRT_POLICY` | `unrelated_ok` | Uncommitted changes outside the job's files are tolerated. `strict` rejects any dirt. |
| `CODEX_OPENCODE_MODEL_ALLOWLIST` | your trusted models | Models a job may select per request. |
| `CODEX_OPENCODE_WORKTREE_MODE` | `write` | Writers run in isolated worktrees. |
| `CODEX_OPENCODE_WORKTREE_ROOT` | `global` | Worktrees live in the state folder, not inside your projects. |
| `CODEX_OPENCODE_QUEUE_MODE` | `sqlite` | Durable queue with restart recovery. |
| `CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT` | `4` | Maximum simultaneous model calls across all sessions. The built-in default is `2`. |
| `CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST` | `git,npm,node,pnpm,yarn,python,pytest` | Programs a job's `validationCommand` may start. The built-in default is `git` only. |
| `CODEX_OPENCODE_ATTESTATION_CACHE_TTL_MS` | default (30 min) | Reuses agent and plugin checks between jobs. Any change to an agent, skill, or config file resets it. `0` turns it off. |
| `CODEX_OPENCODE_EXPECTED_SERVER_SHA256` | release hash | Pins the exact bridge build. It must match the release. |
| `startup_timeout_sec` / `tool_timeout_sec` | `120` / `1500` | Needed so long agent jobs are not cut off at 60 s. |

### Timeouts

| Variable | Default |
| --- | --- |
| `CODEX_OPENCODE_READ_ONLY_AGENT_TIMEOUT_MS` | 3 min |
| `CODEX_OPENCODE_BUILDER_TIMEOUT_MS` | 15 min |
| `CODEX_OPENCODE_ORCHESTRATOR_TIMEOUT_MS` | 6 min per attempt |

The complete variable table is in [REFERENCE.md](REFERENCE.md#configuration).

### Optional project policy

A project can add `.mcp/agent-policy.json` to declare:

- owners;
- forbidden files;
- shared files;
- serial-only files.

Policy can only make things **stricter**. See "Project Policy" in [REFERENCE.md](REFERENCE.md#project-policy).

---

## 15. Reference: repository layout

| Path | Contents |
| --- | --- |
| `server.js` | Production MCP bridge, the single file that is deployed. |
| `opencode/agents/` | Managed OpenCode agent profiles. |
| `opencode/skills/` | Managed skills. |
| `opencode/*.jsonc`, `*.json` | Reviewed, non-secret OpenCode and plugin config. |
| `codex/agents/` | Codex orchestrator profiles. |
| `codex/config.example.toml` | Example Codex MCP entry. |
| `bin/daily-doctor.js` | `npm run doctor` |
| `bin/bridge-gc.js` | `npm run gc` / `gc:apply` |
| `bin/live-smoke.js` | `npm run smoke:live` |
| `bin/sync-managed-runtime.js` | Agent/skill copy used at startup; `npm run sync:runtime` for a manual dry run |
| `bin/release-activate.js` | `npm run release:activate` |
| `bin/build-release.js` | Release builder used by `release:activate` |
| `bin/fresh-healthcheck.js` | Fresh-process health check used during activation. |
| `bin/tui.js` | `npm run tui` dashboard. |
| `bin/e2e*.js` | Live and concurrency end-to-end tests. |
| `tests/server-self-test.js` | The bridge's self-test suite (`npm test` runs it). |
| `tests/pipeline-*.js` | Pipeline admin and abandonment tests. |
| `docs/USER_GUIDE.md` | This guide. |
| `docs/REFERENCE.md` | Detailed rules, tool behavior, and the full configuration table. |
| `docs/archive/` | Historical audits, hardening reports, and design notes. Not current. |

### Test commands

| Command | Use |
| --- | --- |
| `npm run test:quick` | Fast loop while editing. |
| `npm test` | Production gate. |
| `npm run test:concurrency` | Multi-process stress, with no model calls. |
| `npm run test:e2e` | Live end-to-end with real models. Slower and uses your quota. |
| `npm run test:release` | `npm test`, the concurrency test, and a dependency audit. |

---

## 16. Glossary

| Term | Meaning |
| --- | --- |
| **MCP** | Model Context Protocol. The standard way Codex talks to external tools such as this bridge. |
| **Orchestrator** | The one agent that plans, delegates and integrates. Here that is always Codex. |
| **Agent / role** | An OpenCode profile with a fixed job and permissions, such as a builder or a reviewer. |
| **Scope Contract** | The explicit list of files a job may read and edit, plus forbidden paths and the validation command. |
| **Worktree** | A separate git checkout of your project where a writer agent works. Your real folder is untouched. |
| **Lock** | A short-lived claim on paths so two jobs do not collide. |
| **Queue** | Durable job scheduler that survives restarts. |
| **Pipeline** | A planned multi-agent workflow with ordered jobs and final gates. |
| **Preview receipt** | A single-use token binding an approved dry-run patch to the actual apply. |
| **Integration** | Applying a reviewed worktree patch to your real project. |
| **Checkpoint** | A commit that captures the state a job starts from. |
| **Release** | An immutable copy of the bridge that production runs, pinned by hash. |
| **Allowlist** | The operator-approved list of models that jobs may request. |
| **GC** | Garbage collection: the cleanup command for leftover worktrees and databases. |
