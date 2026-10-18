# Platform installation and verification

## Installation contract

The public installer targets Windows 11, Linux and macOS. It requires Node
**>=22.13.0** (the built-in SQLite API), npm, Git and OpenCode **1.18.32**.
CI covers the exact Node minimum, current Node 22.x and Node 24.x on all three
operating systems. Other Node majors satisfy the engine range but are outside
this maintained CI matrix. Native results, rather than simulated platform flags,
determine verification status.

From the package directory, in PowerShell or a POSIX terminal:

```sh
node bin/install.js --dry-run --client cursor
node bin/install.js --yes --client cursor
# Or choose codex, claude, both, all, or a comma-separated client list.
```

The installer does not install client/provider CLIs or sign in. npm bootstrap uses
`node <absolute npm-cli.js> ci --ignore-scripts --no-audit --no-fund` without a
shell. Discovery supports Windows Node/npm, official Unix/nvm installations,
distro `/usr/share/nodejs/npm`, and Homebrew's symlinked npm entry point. POSIX
prerequisites must be executable regular files (executable symlinks are accepted).

### Default paths

`<home>` is USERPROFILE (then HOME) on Windows and HOME on Linux/macOS, with the
OS home as fallback. `CODEX_HOME` and `CLAUDE_CONFIG_DIR` retain their overrides.
Paths with spaces are passed as argv, not shell-interpolated strings.

| Component | Default on each OS (native separators applied) |
| --- | --- |
| Canonical MCP entry | `<CODEX_HOME or home/.codex>/config.toml` |
| Worker runtime | `<codex-home>/opencode-bridge-runtime/opencode` |
| State, manifest, backups/journal | `<codex-home>/codex-opencode-mcp` (backups alongside changed files) |
| Claude MCP registration | `<CLAUDE_CONFIG_DIR or home>/.claude.json` |
| Claude skills | `<CLAUDE_CONFIG_DIR or home/.claude>/skills` |
| Codex skills; Codex + Cursor shared skills | `<host-home>/.agents/skills` |
| Cursor MCP registration | `<host-home>/.cursor/mcp.json` |
| Cursor-only skills | `<cursor-home>/skills` |

Each destination can be overridden with the existing installer flags. Unix XDG
variables do not move Codex/Claude/Cursor registration into an unrelated client
directory. The Bridge sets XDG_CONFIG_HOME for its isolated managed OpenCode
runtime. Desktop apps launched outside a shell may have a different PATH; ensure
the required worker executables are available to that client before use.

Link/junction destinations remain refused, including linked ancestors. On macOS,
use canonical `/private/...` paths when a chosen destination is under `/tmp` or
`/var`; `realpath` of an existing parent identifies that spelling. Do not bypass
the check with symlinked custom install roots. The verification wrapper creates
and canonicalizes its own disposable root; it does not relax production checks.

### Runtime safety and packaging

- Windows retains its taskkill/creation-time-verified descendant cleanup and
  best-effort containment classification. POSIX uses owned detached process
  groups with SIGTERM/SIGKILL and requires group absence **and** closed pipes to
  confirm termination; escaped/unconfirmed processes remain quarantined.
- Scope/lock matching probes filesystem case behavior; a macOS case-insensitive
  volume must not be treated as Linux merely because both use `/` paths. Git
  worktree/patch checks continue to preserve modes and symlink boundaries.
- Installation still uses the ownership manifest, concurrent-edit checks,
  bounded transaction, exact backups, rollback and pending recovery journal.
- Workers retain role, model, scope and executable restrictions. Pi still defaults
  to `deny`; it needs explicit `unsandboxed-worktree`, an exact authorized model,
  and a separate managed writer worktree. It has no OS sandbox and no Light mode.
- Release builds share the npm resolver with installation. Build on the target
  OS/architecture: copied `node_modules` or external CLI binaries are not a
  cross-OS binary distribution. No release is activated by these checks.
- Independent vendored delegate skills retain upstream caveats and do not inherit
  Bridge containment. Their installation is file copying, not platform certification.

## Reproduce offline verification

Use existing prerequisites; the suites create fake client/provider executables
and disposable homes/configs/Git repositories. No actual provider jobs are needed.
Windows fixture compilation needs gcc, and some shell fixtures need Git's sh.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run test:platform
node bin/verify-isolated.js --node tests/review-setup-cli.js
node bin/verify-isolated.js --node tests/platform-suite.js
```

The last command runs the actual `npm test` entry. Every isolated receipt includes
the exact Node argv, platform/release/architecture, Node version, exit code,
output path and before/after source digests. The normal 181-command runner also
records individual exits, durations and its skip ledger under `.test-logs/`.
CI retains those artifacts even on failure. Its existing
`CODEX_TEST_ALLOW_REQUIRED_SKIPS=1` policy permits unavailable prerequisites, with
every skip still reported by skip-gate; it does not certify those missing checks.

See [PLATFORM-VERIFICATION](PLATFORM-VERIFICATION.md) for the actual candidate run
record, including failures and unavailable native checks. A Windows execution of
an injected `darwin`/`linux` branch is not native macOS/Linux evidence.
