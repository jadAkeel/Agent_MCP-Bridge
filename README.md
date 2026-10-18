# Codex OpenCode MCP Bridge

An MCP server that lets Codex and Claude Code hand bounded tasks to OpenCode agents, such as a reviewer, a builder, or a debugger, while the client stays the planner, reviewer, and only integrator. Both clients can use the same bridge on the same repository at the same time: locks and the provider limit are shared.

The client decides. The bridge enforces scope, isolation, and review. OpenCode agents execute.

## What it gives you

- **Delegation with limits.** Each write job carries a Scope Contract; any change outside it is rejected.
- **Isolation.** Writers work in their own Git worktree, never in your checkout.
- **Review before merge.** The client previews the exact patch, then integrates it with a single-use receipt.
- **Parallel work.** Independent jobs run at the same time, capped by a provider limit.
- **Durability.** Jobs, locks, and results survive crashes in per-project SQLite state.
- **Long batches.** Queued jobs can name fallback models and attempts, detect silent rate limits and pause that model, wait for free memory, stop stalled agents, run exact self-check commands, and land new-file-only patches with a commit by themselves; providers can be paused and all agents capped at runtime ([USER_GUIDE section 8](docs/USER_GUIDE.md#long-batches-in-the-queue)).

## Requirements

- Node.js 22.13 or newer
- Git
- OpenCode on `PATH`, signed in to at least one provider (`opencode auth list`). The public installer requires **exactly 1.18.32**, the version qualified for the packaged Skills. Lower-level setup without `--skills` accepts 1.18.32 or newer for the pure profile and notes untested versions; newer versions need separately authorized live verification. The optional Gemini profile also requires exactly 1.18.32, pinned by `opencode/plugin-integrity-manifest.json` (`openCodeVersion`).
- One MCP client: Codex CLI, Claude Code, or explicitly selected Cursor. Multiple clients can coexist; one is enough. Cursor desktop acceptance is tracked separately from configuration support.

The default planner, builder, debugger, architect, reviewer and tester are configured for `opencode/muse-spark-1.3-contributor-free` in the pure profile. Signing in to Claude Code does not sign OpenCode in to a provider. Gemini is optional; it needs the Gemini setup profile and OpenCode provider sign-in.

That default is a profile setting, not proof of current model availability for your account.
Confirm the route before live work; any alternative model must be explicitly selected and
authorized. Health checks and a literal-response smoke do not qualify file-tool or writer integration behavior.

Python is no longer needed: the bridge reads its TOML entry itself (log.md B-176).

The installer targets Windows 11, Linux and macOS. Native verification status and
remaining platform limits are recorded in [CROSS-PLATFORM](docs/CROSS-PLATFORM.md);
a CI matrix definition alone is not a passing native check.

## Install

The source is available on GitHub. After installing Node, Git, OpenCode **1.18.32**
and at least one supported client, obtain a source checkout and run the installer.
These commands work in PowerShell (Windows 11) or a terminal (Linux/macOS):

```powershell
git clone https://github.com/jadAkeel/Agent_MCP-Bridge.git
cd Agent_MCP-Bridge
node bin/install.js --yes
```

For a guided choice in a terminal, run `node bin/install.js` (or `--interactive`).
Choose orchestrator(s): Codex, Claude Code, Cursor, or a comma-separated combination;
then bridge workers/guides and any original independent delegate skills. Destinations
and changes are displayed before one installation approval. No login, model selection,
optional worker CLI installation or background-MCP bootstrap runs as an install side effect.
For unattended use, `--yes` uses explicit flags/defaults without questions:

```powershell
node bin/install.js --yes --client cursor --standalone-delegates claude,cursor,pi
node bin/install.js --yes --client codex,cursor --workers opencode,codex
```

OpenCode remains the required admission/runtime prerequisite. `--workers opencode,pi`
adds the Pi bridge guide and records the runner with safety `deny`. Enabling Pi requires
explicit acceptance with `--pi-safety unsandboxed-worktree` (or the chooser confirmation).
It has no OS sandbox, supports builder/debugger file edits only and needs its CLI/auth/exact
model allowlist separately. Pi is not supported in Light. [Pi worker](docs/pi-worker.md).
Cursor-only setup needs no Codex/Claude CLI. Actual desktop/model-driven use remains a
separate smoke check.

This prepares lockfile dependencies, managed bridge registration, `bridge-plan`,
`bridge-execute`, `bridge-learn` and the selected supported delegate guides. Default delegate:
OpenCode; choose `--delegates opencode,codex,pi` or `none`. Optional worker selection defaults
its matching guides unless explicitly overridden. Codex delegation still requires explicit
runner/model authorization. `--client codex|claude|both|cursor|all` or a client list selects clients. Use `--dry-run` for
a write-free preview. `--yes` authorizes only the displayed installation changes.

For the original independent delegate skills as well, select them explicitly:

```powershell
node bin/install.js --yes --standalone-delegates all
# Or select a subset (the client CLIs can be installed/authenticated later):
node bin/install.js --yes --standalone-delegates claude,cursor,kimi
node bin/skill-package.js --list
```

`all` adds 18 original CLI delegate skills plus `delegate-setup` and `codex-background`
support files, pinned under MIT. Their relays run independently: they do **not** inherit
bridge locks, scope enforcement, worktrees or integration receipts. Setup copies files;
it does not configure a fleet, bootstrap another MCP server, install/authenticate these
CLIs or run a provider task. Read the selected skill's own platform/permission caveats.
Codex background use needs separate authorized `codex-background` setup. Existing differing
personal skills are refused, never silently replaced. [Selection and boundaries](docs/ONBOARDING.md#independent-original-delegate-skills).

The installer checks versions and local doctor/health, never reads sign-in credentials or
launches inference. It reports sign-in as unknown/needs-auth and requests a client restart.
Sign in through the normal client/provider flow. Live inference smoke is a separate action.
Custom homes, ownership/conflicts, backups and safe rollback are in
[ONBOARDING](docs/ONBOARDING.md#package-installation-windows-linux-and-macos).

The lower-level `npm run setup` remains available after dependencies are installed. It
checks prerequisites and sign-in, previews its changes for approval, creates the isolated
runtime, registers the installed client (Codex, Claude Code, or both) with the real server hash, copies managed agents/skills, and runs
the doctor and health smoke. Re-running a completed setup changes nothing. Use
`npm run setup -- --yes` for non-interactive approval, `--dry-run` for a write-free preview, or
`--client codex|claude|both` to choose the clients instead of detecting them (`--skip-claude-code` still means Codex only).
The bridge's canonical MCP entry always lives in `~/.codex/config.toml`, even on a machine without Codex: the doctor, the smoke and `release:activate` read it, and the Claude Code entry is built from it. Defaults and the optional Gemini profile are in
[docs/REFERENCE.md](docs/REFERENCE.md#one-command-setup). The manual explanation of steps 3–8
remains in [docs/ONBOARDING.md](docs/ONBOARDING.md). Run `npm test` to verify the clone separately.
The `agent-mcp-bridge` bin entry is ready for a future `npx` release; this package is still private and unpublished.

## Quick start

1. Open Codex (or Claude Code) in your project, which must be a Git repository with at least one commit.
2. Nothing to copy: the bridge sends its delegation workflow to the client in the MCP handshake (log.md B-177). Optional, for more detail: the Codex agent `principal-engineer-orchestrator` (`codex/agents/`), or the owner's fuller Claude Code rules in [claude/CLAUDE.md](claude/CLAUDE.md), which you can add to `~/.claude/CLAUDE.md`.
3. Ask: *"Run get_opencode_bridge_status for this project, then ask an OpenCode reviewer for a short opinion on the code."*

The public skills choose **direct** work for tiny tasks, **Light** for one bounded sequential
managed delegate (`run_opencode_agent`, `executionMode: "light"`), or the existing protected
parallel path. Light retains normal locks, scopes, writer worktrees, cancellation, result
receipts and reviewed integration. It disables automatic rerouting/retry orchestration.
The [delegate audit](docs/DELEGATE-AUDIT.md) records the pinned upstream review and limits.
Skills guide model decisions; they do not prove model adherence or create an OS sandbox.

## Marketplace Skill package

The English marketplace entrypoint combines mode selection, setup guidance and the
attributed delegate reference library. Build a local submission ZIP with
`npm run package:agensi`. The ZIP contains a root `SKILL.md`, complete references/scripts,
and ISC/MIT notices; it does not include the separate Bridge Node runtime or provider access.

See [packaging instructions](docs/AGENSI-PACKAGING.md),
[listing draft](docs/AGENSI-LISTING.md) and
[submission verification](docs/AGENSI-SUBMISSION-RESULTS-2026-10-18.md).
Marketplace approval and fresh-user/provider acceptance are tracked separately from
local package integrity.

## Daily commands

Run these from `<bridge-dir>`.

| Command | Purpose |
| --- | --- |
| `npm run doctor -- --cwd <project>` | Fast health check, no model call |
| `npm run smoke:live:health` | Start the bridge like the client does, without a model call |
| `npm run smoke:live` | The same, plus one tiny real job |
| `npm run smoke:live -- --read-file --model provider/model@variant --config <absolute-config.toml>` | One explicitly selected read-only job must read a fresh file fact; requires installed server/lib/release pins and preserves the fixture |
| `npm run smoke:live:health -- --require-pins --config <absolute-config.toml>` | Health check with candidate pin validation, no model call |
| `npm run gc` / `npm run gc:apply` | List or remove leftover worktrees and dead databases |
| `npm run tui` | Terminal dashboard for pipelines and jobs |
| `npm run incidents` | Summarize recurring warnings and errors from the operations log |
| `npm run issues` | Print the issue log: one line per job failure, rebuilt from the operations log |
| `npm run faults -- --prompt` | List the bridge's own faults (crashes, handlers that threw) as a task for your coding assistant |
| `npm run worker -- --repo <project> --status` | Show the unattended queue worker of a repository and its queue counts |
| `npm run release:activate -- --sync-clients` | Re-pin the `server.js` and plugin-manifest hashes and copy the Codex entry to Claude Code |
| `npm run release:activate` | Run the release gate, build, activate, and verify a new release in one step |
| `npm test` | Full self-test suite |
| `npm run test:packaging` | Skill integrity, installer selections, diagnostics and marketplace ZIP regression checks |
| `npm run package:agensi` | Build the English marketplace submission in a new `dist/agensi/` directory |
| `npm run test:smoke` / `npm run test:command-boundary` | Isolated fake-MCP smoke controls and native literal-argv boundaries; no provider inference |
| `npm run test:property` | Generated queue scheduling, retry, lock/lease ownership, and provider-wait checks (fast-check; also in `npm test`) |
| `npm run test:mutation` | Check provider-wait and scheduler tests against temporary code mutations in those modules (Stryker) |
| `npm run test:mutation:retry` | Check retry properties against scoped retry-policy mutations (Stryker; [evidence and limits](docs/RETRY-PROPERTY-MUTATION.md)) |
| `npm run test:mutation:locks` | Check lock conflict, release, expiry, and heartbeat assertions against scoped mutations (Stryker; [quality plan](docs/QUALITY-ROUND-2026-10-16.md)) |
| `npm run test:mutation:leases` | Check durable queue renewal, reacquisition, and wait-probe assertions against scoped mutations ([coverage](docs/QUEUE-LEASE-PROPERTIES.md)) |
| `npm run test:release` | Release gate: `npm test`, concurrency test, audit, health smoke; writes a receipt |

`npm test` runs the commands retained in `test:commands`, with eight syntax workers
and three suite workers (at most two of the four longest suites at once, leaving
capacity for medium and short checks). Timing-sensitive suites run alone after the parallel
suites finish. Each command has a 15-minute timeout; failures do not stop the
remaining checks. Logs, durations, timeout diagnostics and `report.json` are in
`.test-logs/`. The report includes setup, profile preparation, cleanup and whole-run
time. Runtime profiles and shared test TEMP live in a private directory outside
Git; profile copying uses a bounded pool, refuses links and excludes auth/account
files and credential environment values. Metadata checks do not need operator
OAuth. Generated credential files are scrubbed on success or failure before any
non-credential fixture is retained. The existing skip summary
still reports required and optional skips. The robustness harness uses its own
empty XDG configuration regardless of the caller's shell.

Property and mutation tools require development dependencies (`npm ci`). They run
local fixtures without an LLM or provider credentials. Mutation testing is a separate,
slower command with two workers; its score applies only to the selected modules.
See [property/mutation testing](docs/PROPERTY-MUTATION-TESTING.md) for replay commands,
reports and coverage limits, and [reliability coverage](docs/RELIABILITY-COVERAGE.md)
for the existing crash/recovery and cross-process checks.

When the log destination is writable and below its daily cap, errors are recorded in `<state-dir>/logs/bridge-YYYY-MM-DD.jsonl` (default `~/.codex/codex-opencode-mcp/logs/`), one redacted JSON line each with a readable `summary`: refused tool calls, failed agent runs, MCP validation errors, bridge crashes, and failures of `npm run setup`, `doctor`, `smoke:live`, `release:activate` and `test:release`. `npm run incidents` groups them, and job failures also appear in `<state-dir>/logs/issues.md`. URL passwords are redacted. Logging is best effort: when a bridge runtime incident cannot be persisted, one redacted `ops_log_write_failed` diagnostic with the incident goes to stderr per continuous failure episode, even with `CODEX_OPENCODE_LOG_LEVEL=off`. `CODEX_OPENCODE_OPS_LOG=off` intentionally disables persistence and this fallback.

## Unattended runs

A bridge lives only as long as its MCP client, so a batch of hundreds of queued jobs used to need a client open for hours. `npm run worker -- --repo <project> --enqueue jobs.jsonl --env-from codex` runs the bridge's own queue for one repository without a client: write one `enqueue_opencode_job` input per line (each with an `idempotencyKey`), start the worker, add more jobs to it while it runs with `--add more-jobs.jsonl`, watch it with `list_opencode_jobs` or `--status`, and stop it with `--stop` (`--now` cancels the running jobs) or Ctrl+C; jobs a stopped worker leaves behind stay parked for the next worker until `--release` hands them to the clients; `--until-empty` exits when the queue is done. Retries, fallback models, pauses and auto-integration work as in a client ([USER_GUIDE section 8](docs/USER_GUIDE.md#unattended-runs-queue-worker), [REFERENCE](docs/REFERENCE.md#queue-worker-binqueue-workerjs)).

## Status

- Production-tested: the owner's daily use from Codex and Claude Code on Windows 11, and the release gate `npm run test:release`.
- Not tested: macOS and Linux, and a fresh-machine setup by a second developer. ONBOARDING was checked in a scratch setup on the owner's machine.
- A release builds from a fresh clone at any path (log.md B-037, covered by `tests/review-b037-portable-release.js`); a new install starts on the checkout, pinned by hash, and moves to a release as ONBOARDING step 15 describes.

## Documentation

- [docs/ONBOARDING.md](docs/ONBOARDING.md): a new operator's setup, from prerequisites to a first reviewed change, restarts and rollback.
- [docs/USER_GUIDE.md](docs/USER_GUIDE.md): how it works, daily use, troubleshooting, releases.
- [docs/REFERENCE.md](docs/REFERENCE.md): Scope Contract rules, tool behavior, and every configuration variable.
- [log.md](log.md): every problem found in real use, with its cause and fix.
- [docs/archive/](docs/archive/): historical audits and design notes. They are not current.

## Layout

| Path | Contents |
| --- | --- |
| `server.js` | The MCP bridge |
| `bin/` | Operator tools: doctor, gc, smoke, release, TUI, end-to-end tests |
| `tests/` | Self-test suite and pipeline tests |
| `opencode/` | Managed OpenCode agent profiles (`agents/`), skills (`skills/`), and reviewed config and plugin manifest |
| `codex/` | Codex agent profiles (`agents/`, including `principal-engineer-orchestrator`), rules, and the example MCP entry |
| `claude/` | A copy of the Claude Code delegation rules |
| `docs/` | Onboarding, user guide, reference, and the archive |
| `log.md` | Problem log |

The bridge is a coordination boundary, not an operating-system sandbox. Do not point it at untrusted repositories.

## License

ISC; see [LICENSE](LICENSE).
