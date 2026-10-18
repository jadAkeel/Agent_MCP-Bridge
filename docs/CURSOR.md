# Cursor as the orchestrator

Cursor Agent plans bounded work, calls the existing MCP bridge, monitors OpenCode workers,
reviews their output, and performs receipt-bound integration. The same bridge enforces
Scope Contracts, worktree isolation, locks, provider limits, validation and rollback.
Cursor support adds configuration, not a second worker system or a Cursor worker runner.

## Install and connect

Requirements: Cursor desktop, Node >=22.13, Git, and OpenCode >=1.18.32 for the default
pure profile. Codex and Claude Code are **not required**. OpenCode provider readiness is
separate from Cursor sign-in; setup does not sign in for you.

From the combined package, run `node bin/install.js` and choose Cursor, workers and skills,
or `node bin/install.js --yes --client cursor`. Public installation uses one transaction
for canonical registration, Cursor JSON, runtime, skills and manifest. Codex + Cursor share
the user .agents/skills root; Cursor alone uses .cursor/skills. --cursor-home/--cursor-config
select custom destinations. No Codex/Claude CLI is needed for Cursor-only mode. Authentication
and native UI verification remain separate. --client codex,cursor or all selects multiple
clients; auto/both retain their earlier meaning.

Lower-level setup remains available after installing dependencies. Run separately (PowerShell 5.1):

```powershell
npm ci
npm run setup -- --client cursor --dry-run
npm run setup -- --client cursor
```

Review the preview and approve it, or add `--yes` for non-interactive approval. Setup:

- Writes the bridge's canonical entry to `~/.codex/config.toml` even without Codex. This
  is the existing operator-tool format, not a Codex installation or authentication step.
- Creates the managed runtime/state under `~/.codex` by default. Use `--codex-home`,
  `--runtime-dir`, and `--state-dir` for other destinations.
- Merges `mcpServers.opencode` into `~/.cursor/mcp.json`. Other servers/top-level settings
  survive. Changed existing files get exact `.setup-backup-<time>` backups; guarded writes
  reject invalid JSON/TOML, symlinks/junctions and concurrent edits. A completed rerun is
  byte-identical. `--dry-run` writes nothing and skips authentication checks.
- Uses the absolute Node executable and bridge `server.js` path, a `type: "stdio"` entry,
  the same safety environment as the other clients, and server **and** library hashes.
- Syncs managed agents/skills and runs doctor plus a health-only MCP smoke with no model call.
  It skips Codex/Claude CLI and auth probes and leaves Claude's config alone.

For project-local Cursor configuration, use an absolute project path instead:

```powershell
npm run setup -- --client cursor --cursor-config "C:\work\my-project\.cursor\mcp.json"
```

Use one scope for `opencode`; avoid conflicting global/project entries with the same name.
Generated config contains machine-specific absolute paths; review it before sharing it.
For side-by-side clients, run Cursor setup with the **same** runtime/state/provider options
used by your existing setup. `auto` still detects only Codex/Claude CLIs, and `both` still
means those two. Explicit Cursor mode works even if those CLIs are installed.

Restart Cursor, open your target Git project (with at least one commit), and enable
`opencode` under Cursor's MCP settings / **Customize**. In **Agent**, ask for
`get_opencode_bridge_status` with `cwd` set to the project's absolute path. Approve the
tool call and confirm the result describes your project and healthy bridge state.
If it fails, open **Output → MCP Logs** and inspect launch/path/pin errors.

From the bridge clone, independently check the runtime:

```powershell
npm run doctor -- --skip-claude-code --cwd "C:\work\my-project"
npm run smoke:live:health
npm run smoke:live
```

Doctor's skip flag is for a Cursor-only install; omit it if you also want to compare an
existing Claude registration. For a custom `--codex-home`, pass
`--config "<codex-home>\config.toml"` to these commands. Full live smoke makes a real
OpenCode model call; the health-only smoke does not. None of these prove the Cursor UI
connection; the Agent status call does.

## First delegated task: read-only, queued and monitored

Paste this into Cursor Agent, replacing the placeholders with an absolute repository path
and one existing source file:

> You are the planner, reviewer and only integrator. Use the opencode MCP bridge for
> bounded OpenCode tasks. Run get_opencode_bridge_status for `<project>`. Enqueue one
> reviewer job for `<source-file>` with write:false, lockMode:"off", allowedEdits:[],
> and scopeContract:{mode:"read",read:["<source-file>"],write:[],allowedEdits:[]}.
> Ask for at most three concrete review findings; do not edit files. Use a unique
> idempotencyKey. Keep the returned jobId and poll list_opencode_jobs / get_opencode_job
> with this cwd until terminal. Read the actual result and distinguish completed,
> failed, cancelled or interrupted. Summarize evidence and limitations; make no changes.

Use `get_opencode_job` with `detail:true` for retained full detail, or
`cancel_opencode_job` if you want to stop a queued job. Do not infer success from an
enqueue acknowledgement or the worker's own claim. Long work should be queued and
polled, rather than held inside one long synchronous tool request.

The bridge sends client-independent workflow instructions in the MCP handshake. Actual
Cursor consumption of those instructions is unverified, so this explicit prompt makes
the orchestrator role clear without installing personal rules or authentication files.

## First reviewed write

Ask Cursor for one small change to an existing file, using the [ONBOARDING write-job
example](ONBOARDING.md#9-a-first-writer-with-a-full-scope-contract). Have Cursor:

1. Define acceptance criteria, explicit read/write/allowedEdits/forbidden paths and
   `validationCommand:"git diff --check"`. Writers need `write:true`, `lockMode:"simple"`
   (or strict) and bounded `lockedPaths`. Validate with `validate_delegation_plan`.
2. Enqueue a `builder` job with that contract, a unique idempotency key, and no
   `autoIntegrate`. Monitor it to completion. Writers run in retained bridge worktrees;
   never ask workers to merge into your checkout or manage locks directly.
3. Read the result, changed-file/scope/unsafe verdicts and actual diff. For non-trivial
   work, request a read-only reviewer/tester on the retained worktree. Resolve failures
   and dependency requests before integrating. Manifests/shared config stay serial.
4. Call `integrate_opencode_worktree` with `dryRun:true`, the returned `worktreePath`,
   target `cwd`, allowed/forbidden paths and validation command. Review/show the patch.
5. Apply only after review and approval: the **same arguments**, with `dryRun:false`,
   `reviewed:true` and the **exact** `previewReceipt`. A stale/mismatched receipt needs a
   new preview/review. Do not bypass the bridge with manual cherry-picks or patch copies.
6. Run the project's real checks and report their actual output before claiming success.
   Commit/merge only when the user requests it. The bridge validates and rolls back a
   failed apply; it cleans a successfully validated bridge worktree by default.

## Maintenance and limitations

- Setup targets the checkout from which it runs. Keep that clone available; changing
  pinned server/library bytes requires tested, approved re-pinning and a client restart.
- `release:activate` and `--sync-clients` currently update Codex/Claude, **not Cursor**.
  After a release activation, rollback, or canonical environment/pin change, back up
  Cursor's JSON and update only `mcpServers.opencode` to match the canonical TOML's
  `command`, `args` and `env`, with `type:"stdio"`, preserving other entries/settings.
  Restart Cursor and check status. For a checkout-based install, re-running Cursor
  setup safely re-pins that checkout, but also restores setup's defaults; it does not
  import custom release paths, model allowlists or timeouts from an active release.
- Cursor's documented stdio fields do not include Codex's `tool_timeout_sec`; setup
  does not invent an equivalent. Queue and poll long jobs. Cursor desktop disconnect,
  cancellation, approvals and instruction consumption still need interactive testing.
- Closing Cursor ends its bridge process. Cancel jobs explicitly to stop work; existing
  recovery/retry rules apply, and other clients sharing state may recover eligible jobs.
- Tested here: isolated setup using fake provider/client CLIs, and a real SDK stdio
  handshake/tool discovery/status call from the generated Cursor JSON. **Not tested:**
  an actual Cursor desktop session, a live model-backed task from Cursor, macOS/Linux,
  or a second developer's fresh machine. No real user config or auth was changed.

Official Cursor MCP documentation inspected for this implementation:
[Model Context Protocol](https://cursor.com/docs/context/mcp) (stdio fields, JSON format,
global/project locations, tool approval and MCP logs). Implementation commands and actual
results are recorded in [the work report](../reports/cursor-orchestrator.md).
