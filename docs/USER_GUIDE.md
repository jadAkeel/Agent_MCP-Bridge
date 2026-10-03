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
| **MCP bridge** | A Node.js MCP server (`server.js`) that exposes 28 tools to its MCP clients, Codex and Claude Code. | This checkout, pinned by hash, or an immutable release folder (see [section 12](#12-updating-and-rolling-back)) |
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
- **codex and agy as runners (optional):** with `CODEX_OPENCODE_EXTERNAL_RUNNERS=codex,agy`, allowlist entries such as `codex/gpt-6.1-sol@high` or `agy/default` run the Codex CLI or the Antigravity CLI instead of OpenCode, in the same worktree and with the same checks. The result says `Role enforcement: none (runner codex)`: the CLI does not follow the OpenCode role's permissions. agy runs only worktree writers; if it changes the checkout you work in or a profile file such as `~/.codex/config.toml` or `~/.gitconfig`, the job fails with `external_runner_wrote_outside_worktree` and agy is paused for an hour (`resume_opencode_provider agy` ends it early). A failed runner's files are kept in the folder the result names as `Runner sidecar:`. Do not set `CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY` together with the runner settings: the bridge refuses to start. Details: `docs/REFERENCE.md`, "External runners".

> **Model identity note.** OpenCode (observed on 1.17.13) does not report in every stream which model actually answered. The bridge therefore reports the *configured* model and never claims runtime proof it does not have. Keep `CODEX_OPENCODE_REQUIRE_RUNTIME_MODEL_EVIDENCE=false`, because `true` rejects every real run whose stream lacks that proof.

---

## 7b. Using the bridge from Claude Code

The same bridge works from Claude Code. It was registered once with the same command and environment as the Codex entry:

```bash
claude mcp get opencode
```

If it is missing, or the bridge fails to start with `External plugin manifest hash mismatch`, a `server.js` hash mismatch, `lib/ does not match CODEX_OPENCODE_EXPECTED_LIB_SHA256`, or `CODEX_OPENCODE_EXPECTED_LIB_SHA256 is not set`, run the sync (it reads the active entry from `~/.codex/config.toml`):

```bash
npm run release:activate -- --sync-clients
```

The sync first re-pins `CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256` from the manifest file itself (a model switch or an OpenCode upgrade regenerates the manifest, so the hash is never copied by hand), `CODEX_OPENCODE_EXPECTED_SERVER_SHA256` from the `server.js` the entry points at, and `CODEX_OPENCODE_EXPECTED_LIB_SHA256` from the `lib/` folder next to it (these two only move while the entry runs a working tree instead of an immutable release), health-checks the result, then re-registers Claude Code with the same command and environment. The lib pin exists since the server.js split (log.md B-092): most of the bridge's code lives in `lib/`, so the server pin alone no longer covers it. A config written before the split has no lib pin yet; a server-pinned bridge started from it refuses to start until the first sync adds the line. Every `release:activate` does both automatically, so both clients always run the same release. Restart the Claude Code session afterwards. Claude's delegation rules live in `~/.claude/CLAUDE.md` (a copy is kept in `claude/CLAUDE.md`). Codex and Claude Code may work on the same repository at the same time: locks and the provider limit are shared, so overlapping writers wait or fail with a clear lock message.

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

### Long batches in the queue

For a large batch of independent jobs (one output file each) the queue can run without you
between jobs (log.md B-060, B-061, Q-005 to Q-010):

- **Fallback models.** Give `enqueue_opencode_job` a `models` list (allowlisted
  `provider/model[@variant]`, tried in order) and optionally `maxAttempts` (default 4). A job that
  fails for a provider reason (rate limit, pause, quota, 5xx), stops as idle, times out, ends with
  no answer, changes no file, fails its validation or is stopped by a sleep or stall (lease fence,
  supervisor watchdog) is requeued by the bridge on the next model
  that is not paused. `list_opencode_jobs` shows `attempt=2/4 model=...`; after the last attempt
  the job shows `outcome=gave_up`. Jobs with such a policy that a client restart interrupted are
  resumed by the next bridge as their next attempt.
- **Silent rate limits** are detected while the job runs (`provider_rate_limited`), and that
  model is paused for 30 minutes, then 60.
- **Pause and resume** a provider or one model yourself with `pause_opencode_provider` /
  `resume_opencode_provider`; cap all agents on all providers with
  `set_opencode_concurrency({ globalWorkerLimit: 8 })`, and give single providers their own slots
  with `set_opencode_concurrency({ providerLimits: { codex: 5, agy: 2 } })` (`null` clears one,
  `reset: true` clears all); the queue worker and the other client pick it up within seconds.
- **Shared quotas.** With `CODEX_OPENCODE_QUOTA_GROUPS=chatgpt:codex,openai` a rate limit on
  either side (the codex runner or an OpenCode `openai/...` model) pauses both, and a job with
  `models: ["codex/...", "openai/..."]` waits for the pause instead of trying the other one.
- **Self-checks.** The bridge runs the exact commands you list in
  `scopeContract.selfCheckCommands` (for example `node tools/validate.cjs out/x.json`) in the
  worktree after the agent finished, and gives the agent another run with a failing check's
  output, up to `selfCheckPasses` (default 2). The agent itself still has no shell.
- **Auto-integration.** With `autoIntegrate: true` a finished writer whose patch only adds new
  files is integrated and committed by the bridge (see [section 9](#9-reviewing-and-integrating-changes)).
- **Memory and stalls.** The queue starts nothing while free memory is under 1 GB, and an agent
  silent for 10 minutes is stopped (both on by default).
- **Issue log.** Every failure is one line in `<state-dir>\logs\issues.md` (section 10).

Example job (one of many, each with its own file):

```json
{ "agent": "builder", "task": "Write batch 012 ...", "cwd": "C:\\path\\to\\repo", "write": true, "lockMode": "simple",
  "lockedPaths": ["out/backend/batch-012.json"], "allowedEdits": ["out/backend/batch-012.json"],
  "validationCommand": "node tools/validate.cjs out/backend/batch-012.json",
  "models": ["opencode/muse-spark-1.3-contributor-free@high", "google/antigravity-gemini-3.8-flash@high"],
  "autoIntegrate": true, "idempotencyKey": "backend-012",
  "scopeContract": { "mode": "write", "read": ["BRIEF.md", "pools", "out/backend"], "write": ["out/backend/batch-012.json"],
    "allowedEdits": ["out/backend/batch-012.json"], "forbidden": [".env"],
    "validationCommand": "node tools/validate.cjs out/backend/batch-012.json",
    "selfCheckCommands": ["node tools/validate.cjs out/backend/batch-012.json"] } }
```

A bridge ends with its client, and so do the jobs it runs. For a run that must outlast the client,
use the queue worker below.

### Unattended runs (queue worker)

`bin/queue-worker.js` (`npm run worker`) runs the queue of one repository without Codex or Claude
Code open (log.md Q-011). It is the bridge itself, started without a client: the same jobs,
retries, fallback models, pauses, auto-integration and logs.

1. **Write `jobs.jsonl`**: one job per line, exactly the `enqueue_opencode_job` input (the example
   above, on one line), each with its own `idempotencyKey`. A misspelt field is refused, not
   ignored, and `cwd` must be the repository the worker runs for.
2. **Start the worker** from the bridge folder your clients run (the same `server.js`, so the
   integrity pins match):

   ```powershell
   node <bridge-dir>\bin\queue-worker.js --repo C:\path\to\repo --enqueue C:\path\to\jobs.jsonl --env-from codex
   ```

   `--env-from codex` (or `claude`) copies the environment of your registered client entry, so the
   state directory, model allowlist, pins and limits are the clients'; a variable you set in the
   shell wins. Every line is checked before anything starts: one bad line is reported with its
   line number and nothing runs. Running the same file again adds only the new lines and prints,
   for each line already queued, its job and status. A line whose job was cancelled or failed does
   not run again: the worker warns about it; requeue that job (`requeue_opencode_job`) or give the
   line a new `idempotencyKey`. Add `--until-empty` to exit by itself when nothing is left.
3. **Watch it**: `list_opencode_jobs` from Codex or Claude Code shows the jobs as usual (same state
   directory), or run `node bin\queue-worker.js --repo C:\path\to\repo --status` for the worker's
   pid and heartbeat, a parked queue, the counts (pending, waiting for a pause, running,
   completed, auto-integrated, failed, gave up) and the paused providers; `--status` only reads.
   Every 10 minutes the worker writes a `queue_worker.summary` line to the operations log. A
   `resume_opencode_provider` from a client reaches the worker's jobs that wait for a pause within
   a few seconds.
4. **Add jobs to a running worker** (log.md Q-015): the worker reads `--enqueue` only at its
   start, and a second worker is refused, so put more jobs in a new file (same format) and run:

   ```powershell
   node <bridge-dir>\bin\queue-worker.js --repo C:\path\to\repo --add C:\path\to\more-jobs.jsonl --env-from codex
   ```

   Every line is checked as at a start (one bad line adds nothing), lines already queued are
   reported instead of added, and it prints `Added N job(s) to the queue of ...; the running
   worker (pid X) picks them up at its next check.` The running worker starts them within about
   15 seconds. Without a running worker for the repository `--add` is refused: start one with
   `--enqueue` instead.
5. **Stop it**: `--repo C:\path\to\repo --stop`, or Ctrl+C in its window. Nothing new starts and
   the worker exits when its running jobs end. `--stop --now` (or a second Ctrl+C) cancels the
   running jobs; they end `cancelled` and `requeue_opencode_job` can run them again. A third Ctrl+C
   exits at once (exit code 2, logged as `queue_worker.stopped` with `forced_exit`). A Ctrl+C while
   the worker is still starting (checking or enqueueing the file) stops it before any job starts:
   the jobs it had already enqueued are cancelled and it exits with code 1. Jobs the worker leaves behind are **parked**: the next worker you
   start for the repository runs them, and Codex or Claude Code do not take them over, so the rest
   of the batch does not end up running in a client window. To hand them to the clients instead,
   run `node bin\queue-worker.js --repo C:\path\to\repo --release`.
6. **Afterwards**: `npm run issues` lists one line per failure (rate limit, idle stop, timeout,
   failed validation, no output, retry, gave up, failed auto-integration) between the worker's
   `queue_worker.started` and `queue_worker.stopped` lines; `npm run incidents` groups the
   recurring warnings and errors (the worker's progress lines are not incidents; a refused start
   is one `queue_worker.refused` warning).

Good to know:

- One worker per repository. A second one exits with code 1 while the first is alive. After a
  crash or a killed process a restart works as soon as the old process is gone (B-155: a
  presence file whose process no longer exists counts as stale, whatever its heartbeat). Only
  when another process now has the same pid, wait until the heartbeat in
  `<state-dir>\workers\<projectKey>.json` is 10 minutes old.
- While a worker runs, and while its queue is parked, client bridges leave that repository's
  waiting jobs to it. Jobs you enqueue through MCP still run in the client that enqueued them and
  end with it: put unattended work in the worker's file, or add it with `--add` while it runs.
- A stop does not wait for an auto-integration that only waits for a lock; the next worker (or a
  client after `--release`) finishes it.
- The global worker cap (`set_opencode_concurrency({ globalWorkerLimit })`) counts the worker's
  agents together with the clients'.
- A check that cannot read the queue (a busy or full disk) is one `queue_worker.tick_failed`
  warning per streak; the worker keeps its presence file fresh and still obeys `--stop` meanwhile.
- Exit codes: 0 clean stop, 1 refused to start, 2 stopped by an error. Details in
  [REFERENCE](REFERENCE.md#queue-worker-binqueue-workerjs).

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
- Many disjoint worktrees (for example one new file each) can be previewed and applied together with `integrate_opencode_worktrees`: one receipt, and either every item lands or none does. An item that changes a path you list in `serialOnly` (a lockfile, a migration) is not taken into a batch of two or more; integrate it alone.
- Failed, partial, unreviewed or not-yet-integrated worktrees are **kept**, so you never lose work.
- **Auto-integration (opt-in per job).** A queued writer enqueued with `autoIntegrate: true` (and a
  `validationCommand`) whose patch only **adds new files** is integrated by the bridge as soon as it
  finishes: the same dry run, receipt, validation in your checkout and rollback as above, then one
  commit of exactly those files as your configured Git user (`user.name` / `user.email`; the author
  of your last commit only when none is configured) (`Auto-integrate <job>: ...`),
  made from a temporary index after checking that the files are the reviewed content; your own
  staged and unstaged work stays as it was. An integration that was waiting when the bridge
  stopped is resumed after the restart. A patch that changes or deletes an existing file
  is left for the normal review (`autoIntegration=skipped_not_new_files` on the job). A worktree
  that changed after the job finished is not integrated (`autoIntegration=failed`). Set
  `CODEX_OPENCODE_AUTO_INTEGRATE=false` to refuse the option.
- If an agent needs a new package, it stops and returns `DEPENDENCY_REQUIRED {...}`. Codex then:
  1. adds the dependency itself, after your review;
  2. commits;
  3. retries the job.

---

## 10. Housekeeping and maintenance

Run all of these from `<bridge-dir>`, your clone of the bridge repository (placeholders as in [ONBOARDING.md](ONBOARDING.md)).

| Command | What it does | When |
| --- | --- | --- |
| `npm run setup` (`-- --yes`, `--dry-run`, `--skip-claude-code`) | Preview/apply the first-run runtime and client entries, pin the server, sync profiles and run doctor/health. Repeated completed setup is a no-op. See [flags](REFERENCE.md#one-command-setup). | After `npm ci` in a new clone |
| `npm run gc` | Dry run. Lists orphan worktrees, stale records, worktrees awaiting review, and dead project databases. Changes nothing. | Any time |
| `npm run gc:apply` | Removes orphans (source repository gone), repairs the registry, prunes dead databases. | **Weekly** |
| `npm run gc -- --include-retained --older-than 14 --apply` | Also removes reviewed-and-abandoned worktrees older than 14 days. Branches are kept. | Monthly, or when space is tight |
| `npm run doctor -- --cwd C:\path\to\project` | Fast integrity check with no model call. Covers the server hash, Git, databases and stuck jobs. | Start of day, or after a crash |
| `npm run smoke:live` | Starts the bridge exactly as Codex does and runs one tiny real agent job. | After any config or release change |
| `npm run smoke:live:health` | Same as above, without the model call. | Quick check |
| `npm run audit:state` | Read-only SQLite integrity report. | Investigating problems |
| `npm run tui` | Terminal dashboard of jobs, pipelines, locks and worktrees. | Watching work live |
| `npm run issues` (`-- --days 30`) | Prints the issue log lines (one per failure, below) rebuilt from the operations log. | After a batch |
| `npm run incidents` (`-- --days 30`) | Groups the operations log (below) by event and error type, newest problems first, with the latest `summary` of each group, and prints a draft `log.md` row for each recurring one. Also warns when OpenCode's own database has grown too large. | **Weekly**, and after a bad day |
| `npm run faults` (`-- --prompt`, `--json`, `--days 30`) | Lists the faults of the bridge itself (below), grouped, with the file and function of each. `--prompt` prints a ready task for your coding assistant. | When `doctor` reports faults, or after a crash |
| `npm run release:activate -- --prune` | Runs a normal release, then deletes old releases and config backups. It keeps the active release, the previous one, and the two newest backups. | When releases pile up |

**Operations log.** Every error you can hit is written, with credentials already redacted, to `<state-dir>\logs\bridge-YYYY-MM-DD.jsonl` (default state dir `%USERPROFILE%\.codex\codex-opencode-mcp`), one JSON line each with a readable `summary` (at most 400 characters):

- every warning and error the bridge raises itself (queue, locks, integration, recovery);
- every refused tool call (`tool.refused`, with the refusal's `errorType`, for example `unsafe_path`), every agent run that failed (`agent.run_failed`) and every queued job that failed (`queue.job_failed`);
- every MCP request the SDK rejected, such as an unknown tool or invalid arguments (`mcp.request_failed`, with the JSON-RPC `code` and `errorType: jsonrpc_<code>`), and MCP protocol errors (`mcp.protocol_error`); a client probing a method the bridge does not serve (`resources/list`, `server/discover`) is not logged;
- a tool handler that threw (`tool.handler_failed`) and a queue runner that threw (`queue.job_internal_failure`), both with the first stack lines;
- a bridge crash (`process.uncaught_exception` / `process.unhandled_rejection` with the first stack lines, then `process.exited`), including a failed integrity check at startup;
- failures of the `bin/` commands (`cli.<script>.failed` with `exitCode`): `npm run setup` (also a failed preflight and a refused write), `npm run doctor` (also "attention required"), `smoke:live`, `release:activate`, `test:release`, `gc`, `audit:state` and the runtime sync.

**Issue log.** Every job failure (rate limit, idle stop, timeout, failed validation, no output, a retry, a job that gave up, a failed auto-integration) is also one markdown line in `<state-dir>\logs\issues.md`, derived from the same record: `- 2026-10-02 08:12 UTC | queue.job_failed | agent_idle_timeout | job builder-... builder on opencode/muse-spark-1.3-contributor-free | ...`. `CODEX_OPENCODE_ISSUE_LOG` names another file (absolute path, existing folder) or `off`. A file inside your repository makes the checkout dirty; keep it outside, or use `CODEX_OPENCODE_SOURCE_DIRT_POLICY=unrelated_ok`.

**Fault log.** The issue log says what went wrong with a job. `<state-dir>\logs\faults.md` says what went wrong with the **bridge itself**: a crash, a tool handler or queue runner that threw, state it could not write or recover, a JavaScript error inside a job's failure text. Each fault is one entry (time, event, `errorType`, the first bridge file and function from the stack, the job or tool, the build it ran on, the summary and the stack), written the first time a bridge process sees it; a repeat is one line. The entries are meant for your coding assistant, not for you: run `npm run faults -- --prompt` and paste the output into Claude Code or Codex; it names the files to read and the rules a fix follows. When a fault is fixed, change its `status: open` line to `status: fixed <commit>`. `npm run doctor` warns when faults were logged in the last 7 days. `CODEX_OPENCODE_FAULT_LOG` names another file (absolute path, existing folder) or `off`. Every warn and error record of the operations log also carries `build` (the `server.js` hash and the pinned `lib/` digest, 12 characters each) and a readable `summary` of its error text, with credentials redacted.

Files older than 30 days are deleted, and a day's file stops at 20 MB per process. The writer never follows a link: if `logs` or a day's file is a junction or symlink, nothing is written or deleted through it. The client only shows the bridge's stderr, so this file is where a failure from the middle of a migration can be found afterwards. `npm run doctor` counts its recurring problems too. `CODEX_OPENCODE_OPS_LOG=off` turns it off (bridge and commands). To turn a recurring problem into a fix, check the draft row against the code, give it a real B-xxx id in `log.md`, and hand it to a fix session.

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

When something fails, the bridge returns an error type. Copy it and look it up here. If the bridge itself crashed or answered with a JavaScript error, run `npm run faults -- --prompt` (section 10) and hand the output to your coding assistant.

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
| `provider_rate_limited` | The agent's model kept answering "Rate limit exceeded" (or quota, or no funds) with no progress; the bridge stopped it and paused that provider/model for 30 min (then 60). `Paused providers` in `get_opencode_bridge_status` shows it. | Wait, use another model (`models` does this by itself), or `resume_opencode_provider` if you know the limit is gone. `CODEX_OPENCODE_RATE_LIMIT_HITS=0` turns the detection off. |
| `provider_paused` | You (or another client) paused that provider or model with `pause_opencode_provider`. | `resume_opencode_provider`, or wait for the time shown. |
| `outcome=gave_up` | A job with `models`/`maxAttempts` failed on every attempt; `attemptHistory` in `get_opencode_job` lists each attempt's model and error. | Read the attempts, fix the task or the models, then `requeue_opencode_job` (a manual requeue starts a fresh count). |
| `writer_no_changes` | A writer with a retry policy finished without changing any file; under a policy that counts as no output and is retried. | Nothing, unless every attempt does it: then the task is unclear. |
| `queue_only_option` | `models`, `maxAttempts` or `autoIntegrate` was given to `run_opencode_agent` or `run_opencode_parallel`, which cannot honour them. | Use `enqueue_opencode_job`. |
| `self_check_failed` | A self-check the bridge ran still failed after every fix pass (`Self-checks: failed ...` in the result). | Read its output in the result; fix the task or the check, or raise `selfCheckPasses` (at most 3). |
| `self_check_invalid` / `self_check_untrusted` / `self_check_script_editable` | A `selfCheckCommands` entry is not one plain allowlisted command, or it would run a script the job may edit. | Write the exact command (no wildcard, quotes or shell operators), and keep the validator out of `allowedEdits`. |
| `autoIntegration=failed` or `waiting_for_lock` on a job | The bridge could not land the new files itself (validation failed in your checkout, a conflict, the worktree changed after the job finished: `pipeline_source_identity_changed`, or an old record without the patch identity: `auto_integration_source_unattested`), or an in-place writer or another integration holds them. | `failed`: inspect the kept worktree and integrate it with `integrate_opencode_worktree`. `waiting_for_lock`: it retries every minute for an hour. |
| `lock_type_reserved` | A job asked for `lockType: serial_integration` (or `serial`, `integration`): that is the bridge's own integration lock. | Use `lockType: write` (or `write: true`) with `lockedPaths`, `allowedEdits` and a Scope Contract. |
| `validation_process_tree_unconfirmed` | The validation (or a self-check) command was stopped and the bridge could not confirm every process it started has ended. The job's lock stays quarantined, so the next writer of those paths waits. | Check that no leftover process (test runner, worker) is running; the quarantine is released once they are gone. |
| `external_runner_guard_unverifiable` | agy ran, but git could not read your checkout before or after the run, so the bridge cannot tell whether agy wrote outside its worktree. agy is not paused. | Fix the checkout (run `git status` there), check it for stray changes, then retry. |
| `serial_only_parallel_write` from `integrate_opencode_worktrees` | An item of a batch of two or more changes a path you listed in `serialOnly`. | Integrate that item alone with `integrate_opencode_worktree`, and the rest as a batch. |
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

The client entry runs either this checkout or a **release folder**, and in both cases the `server.js` hash and the digest of the `lib/` folder next to it are pinned in `~/.codex/config.toml` (`CODEX_OPENCODE_EXPECTED_SERVER_SHA256`, `CODEX_OPENCODE_EXPECTED_LIB_SHA256`; REFERENCE "lib/ pin"). A release is the stricter profile, and a release builds from any clone (log.md B-037; ONBOARDING step 15). A new install may still run the checkout, re-pinned with `npm run release:activate -- --sync-clients` after every change to `server.js` or a file under `lib/`; `npm run doctor` reports a stale pin as `Failure [server-pin]` or `Failure [lib-pin]`.

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
| | `set_opencode_concurrency` | Raise or lower the provider slot limit, the slots of single providers (`providerLimits: { codex: 5 }`, `null` clears one), the queue parallel limit and the global worker cap over all providers (`globalWorkerLimit`) without restarting (running jobs keep going). A provider with its own limit keeps it when you change `providerLimit`. `reset: true` returns to the environment values. |
| | `pause_opencode_provider` / `resume_opencode_provider` | Pause a provider or one model until a time or for some minutes, in every bridge process, and end a pause early (also an automatic one). |
| | (job options) `models`, `maxAttempts`, `autoIntegrate`, `scopeContract.selfCheckCommands`, `selfCheckPasses` | Fallback models and retries, auto-integration of new-file-only patches, and checks the bridge runs for a builder with fix passes; see [Long batches in the queue](#long-batches-in-the-queue). |
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
| `CODEX_OPENCODE_GLOBAL_WORKER_LIMIT` | as your machine allows, e.g. `10` | Maximum agents running at once on all providers together. The built-in default is `0` (no cap). |
| `CODEX_OPENCODE_MIN_FREE_MEMORY_MB` | default (`1024`) | The queue starts no new job below this much free memory. `0` turns it off. |
| `CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST` | `git,npm,node,pnpm,yarn,python,pytest` | Programs a job's `validationCommand` may start. The built-in default is `git` only. |
| `CODEX_OPENCODE_ATTESTATION_CACHE_TTL_MS` | default (30 min) | Reuses agent and plugin checks between jobs. Any change to an agent, skill, or config file resets it. `0` turns it off. |
| `CODEX_OPENCODE_EXPECTED_SERVER_SHA256` | release hash | Pins the exact bridge build. It must match the release. |
| `CODEX_OPENCODE_EXPECTED_LIB_SHA256` | written by the sync | Pins the `lib/` folder next to that `server.js` (the bridge's modules since the split). Required with the server pin unless a release manifest pin is set; never copied by hand. |
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
| `CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_MS` | 10 min (`0` turns it off). An agent that writes nothing to stdout or stderr for that long is stopped and the job fails as `agent_idle_timeout`; keep it at 10 minutes or more, because a long reasoning step or tool call is silent. `CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_BY_MODEL=opencode/space-bunny-free=1200000` gives one model a longer limit. |
| `CODEX_OPENCODE_RATE_LIMIT_PAUSE_MS` | 30 min, doubling to `CODEX_OPENCODE_RATE_LIMIT_PAUSE_MAX_MS` (60 min): the pause after a detected rate limit |

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
| `bin/queue-worker.js` | `npm run worker`: the unattended queue worker (section 8). |
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
