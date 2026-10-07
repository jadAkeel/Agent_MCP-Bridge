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
- OpenCode on `PATH`, signed in to at least one provider (`opencode auth list`). The default pure profile needs 1.18.32 or newer; 1.18.32 is the tested version, setup refuses an older one and accepts a newer one with a note (`npm run smoke:live` then proves it). The optional Gemini profile needs exactly 1.18.32, the version `opencode/plugin-integrity-manifest.json` pins (`openCodeVersion`).
- One MCP client: Codex CLI or Claude Code. Both work side by side, but one is enough; setup registers whichever is installed.

The default planner, builder, debugger, architect, reviewer and tester use `opencode/muse-spark-1.3-contributor-free`, which works with the pure profile. Signing in to Claude Code does not sign OpenCode in to a provider. Gemini is optional; it needs the Gemini setup profile and OpenCode provider sign-in.

Python is no longer needed: the bridge reads its TOML entry itself (log.md B-176).

The setup is tested on Windows 11 only; macOS and Linux are not verified yet.

## Install

```bash
git clone https://github.com/jadAkeel/Agent_MCP-Bridge.git && cd Agent_MCP-Bridge && npm ci && npm run setup
```

In Windows PowerShell 5.1, run those four commands on separate lines (`&&` requires PowerShell 7 or a POSIX shell).
Then restart the client setup registered (Codex, Claude Code, or both), and run `npm run smoke:live` once.

Setup checks prerequisites and sign-in, previews its changes for approval, creates the isolated
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

## Daily commands

Run these from `<bridge-dir>`.

| Command | Purpose |
| --- | --- |
| `npm run doctor -- --cwd <project>` | Fast health check, no model call |
| `npm run smoke:live:health` | Start the bridge like the client does, without a model call |
| `npm run smoke:live` | The same, plus one tiny real job |
| `npm run gc` / `npm run gc:apply` | List or remove leftover worktrees and dead databases |
| `npm run tui` | Terminal dashboard for pipelines and jobs |
| `npm run incidents` | Summarize recurring warnings and errors from the operations log |
| `npm run issues` | Print the issue log: one line per job failure, rebuilt from the operations log |
| `npm run faults -- --prompt` | List the bridge's own faults (crashes, handlers that threw) as a task for your coding assistant |
| `npm run worker -- --repo <project> --status` | Show the unattended queue worker of a repository and its queue counts |
| `npm run release:activate -- --sync-clients` | Re-pin the `server.js` and plugin-manifest hashes and copy the Codex entry to Claude Code |
| `npm run release:activate` | Run the release gate, build, activate, and verify a new release in one step |
| `npm test` | Full self-test suite |
| `npm run test:release` | Release gate: `npm test`, concurrency test, audit, health smoke; writes a receipt |

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
