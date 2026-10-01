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

- **Scope.** An agent's edits are checked against the files it was explicitly allowed to edit; anything else is rejected.
- **Isolation.** Agents that write code work in a separate copy of the project (a *worktree*), never in your real checkout.
- **Review.** Nothing lands in your project until Codex shows you the exact change and you approve it.
- **Parallelism.** Several agents can work at once without stepping on each other.
- **State.** Nothing is lost if a process crashes, because jobs, locks and results are stored durably.
- **Cleanup.** Leftovers can be inventoried and removed with one command.

Claude Code can use the same bridge in the same way, side by side with Codex (see [section 7b](#7b-using-the-bridge-from-claude-code)); where this guide says Codex, Claude Code works the same unless noted.

In one sentence: **Codex decides, the bridge enforces, and OpenCode agents execute bounded tasks.**

---

## 2. The pieces

| Piece | What it is | Where it lives |
| --- | --- | --- |
| **Codex** | The AI you talk to. It is the orchestrator and the only one allowed to integrate changes. | The Codex app/CLI |
| **Codex orchestrator profile** | The Codex agent you select for work, `principal-engineer-orchestrator`. | `codex/agents/*.toml`, installed into `~/.codex` |
| **MCP bridge** | A Node.js MCP server (`server.js`) that exposes 26 tools to its MCP clients, Codex and Claude Code. | This checkout, pinned by hash, or an immutable release folder (see [section 12](#12-updating-and-rolling-back)) |
| **OpenCode** | The agent runtime that actually runs the helper agents. Version `1.18.32`: the plugin manifest (`openCodeVersion` in `opencode/plugin-integrity-manifest.json`) requires exactly that version for the Gemini profile. | Installed on `PATH` |
| **OpenCode agents** | Role profiles such as `builder`, `reviewer` and `debugger`. Each has fixed permissions and a pinned model. | `opencode/agents/*.md`, copied to the runtime folder automatically when a release starts |
| **Skills** | Reusable instruction packs the agents load, such as `code-review-checklist` and `debugging-investigation`. | `opencode/skills/` |
| **State store** | SQLite databases (one per project) holding jobs, locks, queues and audit records, plus retained worktrees. | `~/.codex/codex-opencode-mcp` |


---

## 3. How a request flows through the system

```text
 You ──► Codex (orchestrator)
           │  1. understands the task, picks the smallest fitting agent
           │  2. writes a Scope Contract (which files to read, which may be edited)
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
Scope Contract           = the law      (what may be edited)
Queue                    = scheduler    (who runs when)
Worktree                 = isolation    (writers never touch your checkout)
Lock                     = collision guard (no two jobs on the same files at once)
Changed-file validation  = enforcement  (anything outside the contract is rejected)
Codex                    = final authority (only Codex integrates, only after review)
```

What this means in practice:

- An agent that edits a file it was not allowed to edit gets its whole result **rejected**.
- The contract's `read` list only **guides** the agent. It is printed in the agent's prompt and used to decide whether a reader overlaps a writer, but it does not stop an agent from reading other files in the project or worktree. Only edits are enforced. For real read isolation, use a sanitized workspace (`sanitizedWorkspace`, see [REFERENCE.md](REFERENCE.md#sanitized-workspaces)): the agent then runs in a folder that holds only the manifest-pinned files. Even that is a file-level check, not an operating-system sandbox.
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
| Pick a model | "Use `opencode/muse-spark-1.3-contributor-free@high` for this job." |
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

- Each role pins one model in its profile. The managed roles default to `opencode/muse-spark-1.3-contributor-free` with variant `high`.
- You can ask for a **different model per job**, but only if it is in the operator allowlist `CODEX_OPENCODE_MODEL_ALLOWLIST`, for example:
  ```text
  CODEX_OPENCODE_MODEL_ALLOWLIST=opencode/muse-spark-1.3-contributor-free@high,opencode/gpt-5.3-codex
  ```
  - `provider/model` accepts any variant.
  - `provider/model@variant` accepts only that variant.
- When an allowlisted override is used, the result says `Model selection: operator_allowlist_override` and names the model it replaced.
- A model that is **not** allowlisted is rejected before anything runs (`configured_model_requirement_mismatch`). There is no silent fallback.
- **To allow a new model:** add it to `CODEX_OPENCODE_MODEL_ALLOWLIST` in `~/.codex/config.toml` under `[mcp_servers.opencode.env]`, restart Codex, then run `npm run smoke:live`.

> **Model identity note.** OpenCode (observed on 1.17.13) does not report in every stream which model actually answered. The bridge therefore reports the *configured* model and never claims runtime proof it does not have. Keep `CODEX_OPENCODE_REQUIRE_RUNTIME_MODEL_EVIDENCE=false`, because `true` rejects every real run whose stream lacks that proof.

---

## 7b. Using the bridge from Claude Code

The same bridge works from Claude Code. It was registered once with the same command and environment as the Codex entry:

```bash
claude mcp get opencode
```

If it is missing, or the bridge fails to start with `External plugin manifest hash mismatch` or a `server.js` hash mismatch, run the sync (it reads the active entry from `~/.codex/config.toml`):

```bash
npm run release:activate -- --sync-clients
```

The sync first re-pins `CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256` from the manifest file itself (a model switch or an OpenCode upgrade regenerates the manifest, so the hash is never copied by hand) and `CODEX_OPENCODE_EXPECTED_SERVER_SHA256` from the `server.js` the entry points at (this only moves while the entry runs a working tree instead of an immutable release), health-checks the result, then re-registers Claude Code with the same command and environment. Every `release:activate` does both automatically, so both clients always run the same release. Restart the Claude Code session afterwards. Claude's delegation rules live in `~/.claude/CLAUDE.md` (a copy is kept in `claude/CLAUDE.md`). Codex and Claude Code may work on the same repository at the same time: locks and the provider limit are shared, so overlapping writers wait or fail with a clear lock message.

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
2. **Apply.** `integrate_opencode_worktree(reviewed: true, previewReceipt: <receipt>, validationCommand: "git diff --check")`:
   - applies exactly that patch;
   - runs the validation command;
   - **rolls back** if validation fails;
   - removes the worktree only after a passing check. This cleanup is on by default for worktrees the bridge created (`cleanupAfterSuccess` defaults to true). Pass `cleanupAfterSuccess: false` to keep the worktree.

Safety checks during integration:

- If anything changed between preview and apply, the bridge refuses with `integration_preview_stale`. Preview again. The exception is a target whose HEAD only moved forward past commits that touch none of the patched paths: the receipt still applies and the result says `Target moved N commit(s) since preview; none touched the patched paths`.
- Many disjoint worktrees (for example one new file each) can be previewed and applied together with `integrate_opencode_worktrees`: one receipt, and either every item lands or none does.
- Failed, partial, unreviewed or not-yet-integrated worktrees are **kept**, so you never lose work.
- If an agent needs a new package, it stops and returns `DEPENDENCY_REQUIRED {...}`. Codex then:
  1. adds the dependency itself, after your review;
  2. commits;
  3. retries the job.

---

## 10. Housekeeping and maintenance

Run all of these from `<bridge-dir>`, your clone of the bridge repository (placeholders as in [ONBOARDING.md](ONBOARDING.md)).

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
| `npm run incidents` (`-- --days 30`) | Groups the operations log (below) by event and error type, newest problems first, and prints a draft `log.md` row for each recurring one. Also warns when OpenCode's own database has grown too large. | **Weekly**, and after a bad day |

**Operations log.** Every warning and error the bridge raises is also written, with credentials already redacted, to `<state-dir>\logs\bridge-YYYY-MM-DD.jsonl` (default state dir `%USERPROFILE%\.codex\codex-opencode-mcp`), one JSON line each. Files older than 30 days are deleted, and a day's file stops at 20 MB per bridge process. The client only shows the bridge's stderr, so this file is where a failure from the middle of a migration can be found afterwards. `npm run doctor` counts its recurring problems too. `CODEX_OPENCODE_OPS_LOG=off` turns it off. To turn a recurring problem into a fix, check the draft row against the code, give it a real B-xxx id in `log.md`, and hand it to a fix session.
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
| `agent_timeout` / `agent_idle_timeout` with `outcome=timed_out_with_changes` | The agent ran out of time (or was silent past `CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_MS`) after it had already changed files. The worktree is kept. | Inspect the worktree; integrate it if the change is complete, or `requeue_opencode_job` with a longer `timeoutMs`. |
| `opencode_quota_exhausted` with "Provider ... is paused until ..." | An earlier job hit the provider's hard quota and the provider gave a reset time. Until then every new job on that provider fails at once, in every bridge process. `get_opencode_bridge_status` lists it under `Paused providers`. | Wait until the time shown, then enqueue again. An allowlisted model on another provider helps only when `CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY` is unset, so that each provider has its own key. |
| `essential_output_truncated` | The output was too large to trust. | Narrow the task. |
| `worktree_created_dirty` | A new worktree was not clean. It is kept as evidence. | Run `npm run gc` and inspect it. |
| `git_repository_config_unsafe` | The repository has git config the bridge refuses to run with, such as filters or hooks. | Remove the unsafe local git config. |
| `Filename too long` | Windows path limit. | Already handled: the bridge forces `core.longpaths=true`. If you see it, you are on an old release. |
| Tool call times out after 60 s, or Codex gives up on a long job that is still running | The Codex MCP entry is missing its timeouts, or `tool_timeout_sec` is below the longest job the bridge allows. | Set `startup_timeout_sec = 120` and `tool_timeout_sec` to the bound in [section 14](#timeouts): `3000` with the built-in timeouts. `npm run release:activate -- --sync-clients` prints the exact value. |
| Codex acts like the old bridge | The session started before an update. | Restart Codex. |
| Stuck job / lock | A crash left state behind. | Run `npm run doctor -- --cwd <project>`, then ask Codex to run `diagnose_opencode_bridge`. |
| `integration_recovery_pending` with "quarantined", or `Failure [integration-quarantine]` from the doctor | An interrupted integration left a state the bridge could not explain; every writer of that repository waits. | Follow [A quarantine that does not clear](#a-quarantine-that-does-not-clear). |

**The general recovery recipe:**

1. `npm run doctor -- --cwd <project>`
2. `npm run smoke:live`
3. Restart Codex.
4. If it still fails, read the error type and use the table above.

### A quarantine that does not clear

**What it is.** Before the bridge applies a reviewed patch to your checkout, it writes a journal entry with the exact bytes of every file the patch touches. If the bridge dies in the middle, it uses that record to undo the patch. When it finds something it cannot explain, for example a file that is neither the old version nor the patched one, it **quarantines** the operation instead of guessing. While the quarantine lasts, every writer in that repository is refused with `integration_recovery_pending`. Readers still work.

**How you notice.** Writers fail with `integration_recovery_pending` and the message says "quarantined". `get_opencode_bridge_status` shows `Integration quarantines: 1 (oldest <n> min: <operation id>, reason <reason>)`. `npm run doctor` fails with `Failure [integration-quarantine]` once a quarantine is older than 30 minutes (`--quarantine-max-age-min <n>` changes that).

**Step 1: look at it.** Ask Codex (or Claude) to run `diagnose_opencode_bridge` for the repository and read `integrationOperations.unresolved`. Note the `operationId`, the `reason`, the `affectedPaths` and `quarantinedMinutes`. Then look at those paths in the checkout: `git status`, `git diff -- <path>`.

**Step 2: wait for the ones that clear themselves.** Two reasons clear on their own, within a few minutes and after every bridge restart, once the affected paths and their index entries are back at their old state: `target_head_or_index_drift` and `repository_state_drift`. For those, undo any staging of the affected paths (`git restore --staged <path>`) and wait.

**Before the first resolve after an upgrade or a rollback: restart every bridge.** Restart Codex and Claude Code (and any other client) so no bridge process still runs a version older than the one with `resolve_integration_quarantine`. An older bridge does not know the two closed statuses: its recovery pass treats them as unknown and quarantines the operation again (`journal_status_unknown`), overwriting the recorded resolution. For the same reason, rolling back to a release older than this one re-blocks every repository whose quarantine was resolved.

**Step 3: resolve the others.** Run the commands below from the bridge repository; `--cwd` is the absolute path of the blocked repository. They start the bridge from the `opencode` entry in `~/.codex/config.toml`. Pick one of two modes. Both refuse to run while any job holds a lock in the repository, so let running jobs finish first (`list_opencode_jobs`). Neither mode deletes a journal row, a pre-image, the key or a database. Both record who resolved it, when and in which mode.

- **The old state is what you want** (the patch should not stay, and you have put the files back): first make each affected path exactly what it was before the integration. Usually that is the committed version (`git checkout -- <path>`); if the file had uncommitted edits before, put those back too. Then run:

  ```bash
  node bin/pipeline-admin.js resolve-quarantine <operationId> --cwd <repository> --verify-restored
  ```

  (or the MCP tool `resolve_integration_quarantine` with `mode: "verify_restored"`). It closes the operation as `recovered_verified` only if HEAD, the index entries and the exact bytes of every affected path match the journal. Otherwise it lists each path that is still wrong, with the expected and current hash, and changes nothing. Fix those paths and run it again.

- **The checkout as it is now is what you want** (you inspected it: the drift is your own edit, or the patch is half applied and you will fix it by hand, or the journal's evidence is unreadable, `journal_evidence_unreadable`): run

  ```bash
  node bin/pipeline-admin.js resolve-quarantine <operationId> --cwd <repository> --accept-current --reason "<what you inspected and why you keep it>"
  ```

  This mode exists only on this command line: an MCP client (Codex, Claude, any agent) that asks for `accept_current` is refused with `integration_quarantine_accept_requires_operator`, so a person has to look first. It closes the operation as `resolved_by_operator` and records your reason, your OS user name and the current state of each affected path. It does not change the affected files. Afterwards, you own the checkout's state: review `git diff` and commit or revert as usual.

The command prints `Writers unblocked: yes`, or names another operation that still blocks the repository. Resolve that one the same way.

**If the operation belonged to a pipeline.** After `verify_restored` the pipeline can integrate that job again. After `accept_current` the pipeline item stays `quarantined`: retire the pipeline with `npm run pipeline:abandon -- --cwd <repository> --pipeline <id> --confirm <id>` (it keeps every worktree).

**Never do this.** Do not delete the state database, journal rows or the encryption key. Do not edit `integration_operations` by hand. Do not use `accept_current` without looking at the affected paths. All of these lose the only record of what the patch changed, and the next integration could overwrite someone's work.

---

## 12. Updating and rolling back

The client entry runs either this checkout or a **release folder**, and in both cases the `server.js` hash is pinned in `~/.codex/config.toml` (`CODEX_OPENCODE_EXPECTED_SERVER_SHA256`). A release is the stricter profile, and a release builds from any clone (log.md B-037; ONBOARDING step 15). A new install may still run the checkout, re-pinned with `npm run release:activate -- --sync-clients` after every change to `server.js`.

### Changing bridge code, agent profiles, or skills

Run one command from the bridge repository:

```bash
npm run release:activate
```

It does the whole release in order and stops at the first failure:

1. Checks that the tree can become a release at all: every published file and folder exists (including `opencode/.gitignore`) and `opencode/plugin-integrity-manifest.json` points at this tree's `opencode.jsonc` and `antigravity.json` (as committed it names them `opencode/opencode.jsonc` and `opencode/antigravity.json`, relative to the tree that holds it, so any clone or worktree passes; log.md B-037). Then it runs the release gate, the same as `npm run test:release` (see [below](#before-pushing-source-changes)). If anything fails, nothing is built.
2. Builds a new folder next to the active release, for example `server-daily-20260924-3`, checks that the source tree is still the one the gate tested, and stores the gate's receipt next to it as `server-daily-20260924-3.gate-receipt.json`.
3. Writes a candidate config with the new path and hash and checks it in a fresh bridge process.
4. Backs up `~/.codex/config.toml` as `config.toml.rollback-<time>`, then swaps in the new config.
5. Runs the health smoke against the live config. If it fails, it restores the backup automatically.
6. Lists old releases and backups. Add `--prune` to delete them.

Then **restart Codex** so new sessions use the new bridge.

Useful options: `--check-only` builds and health-checks a candidate without activating it. To skip step 1 right after a green `npm run test:release`, pass its receipt: `npm run release:activate -- --skip-tests --gate-receipt .release-gate/receipt.json`. Activation refuses `--skip-tests` without a receipt, a receipt of a failed run, a receipt of a different source tree (any change to `server.js`, `bin/`, `tests/`, `package*.json` or the shipped agent and skill profiles since the gate ran), and a receipt older than 24 hours.

Agent and skill profiles ship inside the release. When the release starts, it copies them into the runtime folder named by `CODEX_OPENCODE_AGENT_DIR` and `CODEX_OPENCODE_SKILL_DIR`. It only adds and updates files, never deletes. `npm run sync:runtime` still exists for a manual dry run.

### Rolling back

1. Copy the newest `config.toml.rollback-*` over `~/.codex/config.toml`.
2. Restart Codex.
3. Run `npm run smoke:live`.

### Before pushing source changes

```bash
npm run test:release
```

This is the release gate (`bin/release-gate.js`). It runs, in order and stopping at the first failure: a check that `node_modules` holds exactly what `package-lock.json` pins for every production package (version and integrity in `node_modules/.package-lock.json`, and each package's own `package.json`; run `npm ci` if it fails), `npm test`, the concurrency test, `npm audit --omit=dev` (needs the npm registry), and a health smoke that starts this tree's `server.js` with the environment of the `opencode` entry in `~/.codex/config.toml` (`--config <file>` names another). It then writes `.release-gate/receipt.json`: the source-tree digest, the git HEAD, the time, every step's exit code and duration, and for a failed step the last 30 lines of its output.

The end of the output lists each step, the concurrency test's check count, and `skipped: <n>` with the name and reason of every skipped test. A skip is not a pass: read the reasons before you release. The only expected skip on this machine is the tracked-symlink case in `tests/review-b030.js` when Windows cannot create symlinks (no Developer Mode). If a file of the source tree changes while the gate runs, the receipt is marked failed.

### Example of an installed release layout

An operator who runs from releases ends up with a layout like this. `<releases-dir>` is the folder that holds the release folders: `--releases-root` when given, otherwise the parent of the active release, otherwise `<state-dir>\releases`. The release names and the backup time are illustrative.

| Item | Value |
| --- | --- |
| Active release | `<releases-dir>\server-daily-20260924-3` |
| Rollback release | `<releases-dir>\server-daily-20260924-2` |
| Config backup | `~/.codex/config.toml.rollback-20260924065005` |
| Runtime agents | `<runtime-dir>\opencode\agents` |
| State | `<state-dir>` (default `~/.codex/codex-opencode-mcp`) |

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
| | `list_opencode_jobs` / `get_opencode_job` | Inspect queued jobs. A running job's line shows how long its agent has been silent (`idle 3m`); a finished one may show `outcome=completed_no_changes` (a writer that changed nothing), `outcome=completed_with_truncated_output` or `outcome=timed_out_with_changes`. |
| | `cancel_opencode_job` | Cancel a queued or running job. |
| | (job option) `validationFixPasses: 1` | A write job whose validation command failed gets one more agent run in the same worktree with the validation output (builders cannot run checks themselves), then validates again. |
| | `requeue_opencode_job` | Run a failed, cancelled or interrupted job again as a new job from its stored request (optional new `model` from the allowlist, new `timeoutMs`). Completed and unfinished jobs are refused. |
| | `set_opencode_concurrency` | Raise or lower the provider slot limit and the queue parallel limit without restarting (running jobs keep going). `reset: true` returns to the environment values. |
| | `inspect_opencode_queue_recovery` | Recovery state after a crash. |
| Pipelines | `create_multi_agent_pipeline` | Plan a multi-agent feature. |
| | `run_multi_agent_pipeline` | Enqueue its jobs. |
| | `get_multi_agent_pipeline` / `list_multi_agent_pipelines` | Inspect pipelines. |
| | `finalize_multi_agent_pipeline` | Final validation and reviewer/tester gates. |
| | `abandon_multi_agent_pipeline` | Retire an obsolete pipeline. Never deletes unintegrated work. |
| Integration | `integrate_opencode_worktree` | Dry-run preview, then receipt-bound apply. |
| Batch integration | `integrate_opencode_worktrees` | The same for 1 to 25 disjoint worktrees at once: one receipt, one all-or-nothing apply. |
| | `resolve_integration_quarantine` | Close a quarantine recovery cannot clear: `verify_restored` or `accept_current`. See [A quarantine that does not clear](#a-quarantine-that-does-not-clear). |
| Locks (manual) | `acquire_agent_lock` / `release_agent_lock` / `list_agent_locks` | Exceptional debugging only. |
| Sanitized data | `verify_sanitized_workspace` | Verifies a hash-pinned, read-only data workspace. |

---

## 14. Reference: configuration

The configuration lives in `~/.codex/config.toml`, under `[mcp_servers.opencode]` and `[mcp_servers.opencode.env]`. An annotated example is in [codex/config.example.toml](../codex/config.example.toml).

### Settings that matter day to day

| Variable | Recommended | Effect |
| --- | --- | --- |
| `CODEX_OPENCODE_REQUIRE_RUNTIME_MODEL_EVIDENCE` | `false` | `true` rejects every real run whose OpenCode stream carries no runtime model identity (see the model identity note in section 7). |
| `CODEX_OPENCODE_SOURCE_DIRT_POLICY` | `unrelated_ok` | Uncommitted changes outside the job's files are tolerated. `strict` rejects any dirt. |
| `CODEX_OPENCODE_MODEL_ALLOWLIST` | your trusted models | Models a job may select per request. |
| `CODEX_OPENCODE_WORKTREE_MODE` | `write` | Writers run in isolated worktrees. |
| `CODEX_OPENCODE_WORKTREE_ROOT` | `global` | Worktrees live in the state folder, not inside your projects. |
| `CODEX_OPENCODE_QUEUE_MODE` | `sqlite` | Durable queue with restart recovery. |
| `CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT` | `4` | Maximum simultaneous model calls across all sessions. The built-in default is `2`. |
| `CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST` | `git,npm,node,pnpm,yarn,python,pytest` | Programs a job's `validationCommand` may start. The built-in default is `git` only. |
| `CODEX_OPENCODE_ATTESTATION_CACHE_TTL_MS` | default (30 min) | Reuses agent and plugin checks between jobs. Any change to an agent, skill, or config file resets it. `0` turns it off. |
| `CODEX_OPENCODE_EXPECTED_SERVER_SHA256` | release hash | Pins the exact bridge build. It must match the release. |
| `startup_timeout_sec` / `tool_timeout_sec` | `120` / `3000` | Needed so long agent jobs are not cut off at 60 s. `3000` fits the built-in timeouts; a 45 min builder with a 15 min validation needs `5100`, which is the operator's current value. See [Timeouts](#timeouts). |

### Timeouts

| Variable | Default |
| --- | --- |
| `CODEX_OPENCODE_READ_ONLY_AGENT_TIMEOUT_MS` | 3 min |
| `CODEX_OPENCODE_WRITE_AGENT_TIMEOUT_MS` | 10 min |
| `CODEX_OPENCODE_BUILDER_TIMEOUT_MS` | 15 min |
| `CODEX_OPENCODE_ORCHESTRATOR_TIMEOUT_MS` | 6 min per attempt |
| `CODEX_OPENCODE_CONTRACTOR_TIMEOUT_MS` | 20 min |
| `CODEX_OPENCODE_VALIDATION_TIMEOUT_MS` | 5 min |
| `CODEX_OPENCODE_PROVIDER_WAIT_MAX_MS` | 20 min (how long a job may wait for a provider slot) |
| `CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_MS` | off (`0`). When set, an agent that writes nothing to stdout or stderr for that long is stopped and the job fails as `agent_idle_timeout`; keep it at 10 minutes or more, because a long reasoning step or tool call is silent. |

The Codex `tool_timeout_sec` must cover the longest job the bridge allows. Codex gives up on a tool call after that time, and the job's result is lost even if the job is still running. The bound is:

```text
tool_timeout_sec >= provider slot wait + longest agent timeout + validation timeout + 5 min margin
```

With the built-in timeouts (20 + 20 for the contractor + 5 + 5 minutes) that is `3000` s. With a 45 min builder and a 15 min validation (20 + 45 + 15 + 5 minutes) it is `5100` s, the operator's current value. When you raise one of the timeouts above, raise `tool_timeout_sec` too. `npm run release:activate -- --sync-clients` computes the bound from your configured timeouts and warns when `tool_timeout_sec` is lower. It does not count a job that asks for its own longer `timeoutMs`.

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
| `bin/release-gate.js` | `npm run test:release`; the gate and receipt `release:activate` requires |
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
| `npm test` | Full self-test suite. |
| `npm run test:concurrency` | Multi-process stress, with no model calls. Prints one line per check with its duration and `Checks: <n> passed, skipped: <n>`. |
| `npm run test:e2e` | Live end-to-end with real models. Slower and uses your quota. |
| `npm run test:release` | Release gate: `npm test`, the concurrency test, a dependency audit and a health smoke; writes the receipt `release:activate` checks. |

---

## 16. Glossary

| Term | Meaning |
| --- | --- |
| **MCP** | Model Context Protocol. The standard way Codex talks to external tools such as this bridge. |
| **Orchestrator** | The one agent that plans, delegates and integrates. Here that is always Codex. |
| **Agent / role** | An OpenCode profile with a fixed job and permissions, such as a builder or a reviewer. |
| **Scope Contract** | The explicit list of files a job should read (guidance only) and may edit (enforced), plus forbidden paths and the validation command. |
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
