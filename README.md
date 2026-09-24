# Codex OpenCode MCP Bridge

An MCP server that lets Codex hand bounded tasks to OpenCode agents, such as a reviewer, a builder, or a debugger, while Codex stays the planner, reviewer, and only integrator.

Codex decides. The bridge enforces scope, isolation, and review. OpenCode agents execute.

## What it gives you

- **Delegation with limits.** Each write job carries a Scope Contract; any change outside it is rejected.
- **Isolation.** Writers work in their own Git worktree, never in your checkout.
- **Review before merge.** Codex previews the exact patch, then integrates it with a single-use receipt.
- **Parallel work.** Independent jobs run at the same time, capped by a provider limit.
- **Durability.** Jobs, locks, and results survive crashes in per-project SQLite state.

## Quick start

1. Open Codex in your project, which must be a Git repository with at least one commit.
2. Select the `principal-engineer-orchestrator` agent.
3. Ask: *"Run get_opencode_bridge_status for this project, then ask an OpenCode reviewer for a short opinion on the code."*

## Daily commands

Run these from this repository.

| Command | Purpose |
| --- | --- |
| `npm run doctor -- --cwd <project>` | Fast health check, no model call |
| `npm run smoke:live` | Start the bridge like Codex does and run one tiny real job |
| `npm run gc` / `npm run gc:apply` | List or remove leftover worktrees and dead databases |
| `npm run tui` | Terminal dashboard for pipelines and jobs |
| `npm run release:activate` | Test, build, activate, and verify a new release in one step |
| `npm test` | Full self-test gate |

## Requirements

- Node.js 22.12 or newer
- OpenCode 1.17.13 on `PATH`
- Git
- A Codex MCP entry in `~/.codex/config.toml`; see [codex/config.example.toml](codex/config.example.toml)

## Documentation

- [docs/USER_GUIDE.md](docs/USER_GUIDE.md): how it works, daily use, troubleshooting, releases.
- [docs/REFERENCE.md](docs/REFERENCE.md): Scope Contract rules, tool behavior, and every configuration variable.
- [docs/archive/](docs/archive/): historical audits and design notes. They are not current.

## Layout

| Path | Contents |
| --- | --- |
| `server.js` | The MCP bridge |
| `bin/` | Operator tools: doctor, gc, smoke, release, TUI, end-to-end tests |
| `tests/` | Self-test suite and pipeline tests |
| `opencode/agents/`, `opencode/skills/` | Managed OpenCode agent profiles and skills |
| `codex/agents/` | The Codex orchestrator profile |

The bridge is a coordination boundary, not an operating-system sandbox. Do not point it at untrusted repositories.
