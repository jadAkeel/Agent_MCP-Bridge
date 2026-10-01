# Codex OpenCode MCP Bridge

An MCP server that lets Codex and Claude Code hand bounded tasks to OpenCode agents, such as a reviewer, a builder, or a debugger, while the client stays the planner, reviewer, and only integrator. Both clients can use the same bridge on the same repository at the same time: locks and the provider limit are shared.

The client decides. The bridge enforces scope, isolation, and review. OpenCode agents execute.

## What it gives you

- **Delegation with limits.** Each write job carries a Scope Contract; any change outside it is rejected.
- **Isolation.** Writers work in their own Git worktree, never in your checkout.
- **Review before merge.** The client previews the exact patch, then integrates it with a single-use receipt.
- **Parallel work.** Independent jobs run at the same time, capped by a provider limit.
- **Durability.** Jobs, locks, and results survive crashes in per-project SQLite state.

## Requirements

- Node.js 22.12 or newer
- Git
- OpenCode 1.18.32 on `PATH`: the version `opencode/plugin-integrity-manifest.json` pins (`openCodeVersion`). The Gemini profile refuses any other version; the default pure profile does not check it, but 1.18.32 is the tested version.
- Codex CLI, with an MCP entry in `~/.codex/config.toml`; see [codex/config.example.toml](codex/config.example.toml)
- Claude Code (optional), registered with the same entry; see [docs/ONBOARDING.md](docs/ONBOARDING.md) step 7

The setup is tested on Windows 11 only; macOS and Linux are not verified yet.

## Install

```powershell
git clone https://github.com/jadAkeel/Agent_MCP-Bridge.git <bridge-dir>
cd <bridge-dir>
npm ci
```

Then follow [docs/ONBOARDING.md](docs/ONBOARDING.md) steps 1 to 8: prerequisites and sign-in checks, the test suite, the OpenCode runtime folder, the Codex entry, the Claude Code entry and hash pinning, and the health checks.

## Quick start

1. Open Codex (or Claude Code) in your project, which must be a Git repository with at least one commit.
2. In Codex, select the `principal-engineer-orchestrator` agent. Claude Code follows the delegation rules in `~/.claude/CLAUDE.md` (a copy is in [claude/CLAUDE.md](claude/CLAUDE.md)).
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
| `npm run release:activate -- --sync-clients` | Re-pin the `server.js` and plugin-manifest hashes and copy the Codex entry to Claude Code |
| `npm run release:activate` | Run the release gate, build, activate, and verify a new release in one step |
| `npm test` | Full self-test suite |
| `npm run test:release` | Release gate: `npm test`, concurrency test, audit, health smoke; writes a receipt |

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
