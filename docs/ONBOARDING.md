# Onboarding: a new operator, from nothing to a first reviewed change

This guide sets up the bridge on a machine that is not the author's, in the order you will
need it. Every command below was run once in a scratch setup (all state, the Codex home, the
Claude config and the test project under one throwaway folder) unless it is marked
**Not run here**, with the reason. The [User Guide](USER_GUIDE.md) explains how the system works;
the [Reference](REFERENCE.md) lists every variable and tool.

Placeholders used throughout:

| Placeholder | Meaning |
| --- | --- |
| `<bridge-dir>` | Your clone of this repository |
| `<runtime-dir>` | A folder only the bridge's OpenCode uses (its `XDG_CONFIG_HOME`); not your personal `~/.config` |
| `<state-dir>` | Bridge state: SQLite databases, worktrees, releases (default `~/.codex/codex-opencode-mcp`) |
| `<project>` | The Git repository you want agents to work on |
| `<node>` | The absolute path of `node` (`(Get-Command node).Source` in PowerShell, `command -v node` in a POSIX shell) |

Commands are written for PowerShell 5.1 on Windows unless marked. Use `;` and `if ($?) { ... }`
instead of `&&` there.

## 1. Prerequisites and account checks

| Tool | Needed | Check |
| --- | --- | --- |
| Node.js | 22.13 or newer | `node --version` |
| Git | Any current version (the scratch run used 2.39) | `git --version` |
| OpenCode | 1.18.32 or newer for the default pure profile (1.18.32 is tested; a newer one gets a note and `npm run smoke:live` proves it); exactly 1.18.32 for the Gemini profile, whose plugin manifest pins it | `opencode --version` |
| Codex CLI **or** Claude Code | One MCP client is enough; setup registers whichever is installed (`--client` chooses) | `codex --version` / `claude --version` |

Python is not needed (log.md B-176).

Check that the client you use, and OpenCode, are signed in before you connect them to the bridge:

```powershell
codex login status
opencode auth list
claude auth status
```

**Checked:** the version commands and the sign-in checks of the installed tools.

`opencode auth list` shows the providers OpenCode has credentials for. The default planner,
builder, debugger, architect, reviewer and tester use `opencode/muse-spark-1.3-contributor-free`
and work with the pure profile. The sanitized reader uses `openai/gpt-5.6-terra`, which needs
OpenCode's OpenAI sign-in. Signing in to Claude Code does not sign OpenCode in to a provider.
Setup copies these reviewed profiles as they are; a pure health check proves discovery,
not current model availability. Add a provider with `opencode auth login`. The live smoke
in step 8 proves that its selected agent's model answers (the default agent is `planner`).
To select Gemini explicitly, use the Gemini setup profile, its provider sign-in and the
operator model allowlist described in REFERENCE's Model Selection section.

## 2. Get the code and install it

```powershell
git clone https://github.com/jadAkeel/Agent_MCP-Bridge.git <bridge-dir>
cd <bridge-dir>
npm ci
npm test
```

**Not run here:** the `git clone` (the scratch setup used an existing checkout). `npm ci` and
`npm test` were run. `npm test` takes 15 to 30 minutes and must end with `Self tests passed.`
and a `Total skipped:` line; a skip marked `REQUIRED` fails it (see "Skips" below).

Never create `node_modules` as a link (junction or symlink) to another checkout's
`node_modules`: removing a Git worktree on Windows recurses through such a link and empties the
other checkout (log.md B-030). Run `npm ci` in every checkout and worktree.

**Skips.** Some test cases need something your machine may lack. Optional ones (a symlink
privilege, an account that cannot be denied a directory) print `optional` and pass. Required
ones fail `npm test`: `tests/review-spawn.js` needs a C compiler (`gcc` on `PATH` or
`C:\MinGW\bin\gcc.exe`) to build its fake OpenCode on Windows, and `tests/review2-g.js` needs
`sh` (on `PATH`, or the one Git for Windows ships, which the test finds beside `git`, so PowerShell and cmd work too). Install them, or set `CODEX_TEST_ALLOW_REQUIRED_SKIPS=1`
knowingly for one run.

## 3. The OpenCode runtime folder

### Fast path (setup covers steps 3–8)

From the installed clone, run `npm run setup` (or `npm run setup -- --yes` to approve
non-interactively). It checks step 1, previews every change, creates the runtime, writes the
bridge's canonical entry (in `<CODEX_HOME>/config.toml`, even without Codex) and real server pin,
registers each installed client, syncs agents/skills,
and runs the doctor and **health-only** smoke. Restart the registered client, then run
`npm run smoke:live` once to prove provider readiness. Setup cannot sign in or restart clients
for you. It does not run the full `npm test` suite from step 2.

Defaults: `$CODEX_HOME` (or `~/.codex`), runtime `<CODEX_HOME>/opencode-bridge-runtime`,
state `<CODEX_HOME>/codex-opencode-mcp`. Use `--codex-home`, `--runtime-dir`, `--state-dir`
and `--claude-config` to isolate another setup, `--client codex|claude|both` to choose the clients instead of detecting them (`--skip-claude-code` means `--client codex`),
`--provider-limit N` (default 2), and `--dry-run` to preview without writing anything.
The default profile is `pure` (OpenCode 1.18.32 or newer); `--profile gemini` requires the reviewed plugin cache and
exactly OpenCode 1.18.32 (see [Reference](REFERENCE.md#managed-gemini-oauth-profile)).
Existing Codex configs are backed up as `config.toml.setup-backup-<time>`; only the
`opencode` tables are replaced. Other TOML bytes stay identical. A second completed run
is a no-op. The manual steps below explain what setup writes.

The bridge must not run agents from your personal OpenCode config: it attests the managed
profiles in `opencode/agents` and `opencode/skills` of this repository, copied into a folder of
their own.

```powershell
New-Item -ItemType Directory -Force <runtime-dir>\opencode | Out-Null
Copy-Item <bridge-dir>\opencode\opencode.jsonc <runtime-dir>\opencode\opencode.jsonc
```

The agents and skills are copied in step 7 by `sync-managed-runtime.js`, which reads the target
folders from the Codex entry you write in step 4. **Checked** with a scratch `<runtime-dir>`
(the same two steps, done from Git Bash with `mkdir -p` and `cp`). A bridge started from a
release copies them itself at startup; one started from a checkout does not (log.md,
2026-09-28), so re-run that copy after you change a profile.

## 4. The Codex MCP entry

Add this to `~/.codex/config.toml` (or `$env:CODEX_HOME\config.toml`). Paths in TOML strings
use `\\` or single quotes.

```toml
[mcp_servers.opencode]
command = '<node>'
args = ['<bridge-dir>\server.js']
startup_timeout_sec = 120
tool_timeout_sec = 3000

[mcp_servers.opencode.env]
XDG_CONFIG_HOME = '<runtime-dir>'
CODEX_OPENCODE_AGENT_DIR = '<runtime-dir>\opencode\agents'
CODEX_OPENCODE_SKILL_DIR = '<runtime-dir>\opencode\skills'
CODEX_OPENCODE_STATE_DIR = '<state-dir>'
CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS = "false"
CODEX_OPENCODE_WORKTREE_MODE = "write"
CODEX_OPENCODE_WORKTREE_ROOT = "global"
CODEX_OPENCODE_QUEUE_MODE = "sqlite"
CODEX_OPENCODE_QUEUE_RETENTION_DAYS = "30"
CODEX_OPENCODE_SOURCE_DIRT_POLICY = "unrelated_ok"
CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT = "2"
CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git"
CODEX_OPENCODE_REQUIRE_RUNTIME_MODEL_EVIDENCE = "false"
CODEX_OPENCODE_EXPECTED_SERVER_SHA256 = "set-by-sync-clients"
```

The last line is a placeholder: step 7 replaces it with the SHA-256 of `server.js`. It must
exist, because `--sync-clients` only rewrites a pin that is there, and until it holds the right
hash `npm run doctor` reports `Failure [server-pin]`.

This entry runs the bridge from your checkout, which is how you start (step 15 covers
releases). The command is the absolute Node path, not `node`, so a `PATH` change cannot swap
the interpreter.

**Not run here against the real `~/.codex/config.toml`** (the scratch setup must not change the
operator's clients). The same entry was written to a scratch `CODEX_HOME` and read back with:

```powershell
$env:CODEX_HOME = '<scratch>\codex-home'; codex mcp get opencode
```

The full annotated example, including every production pin, is
[codex/config.example.toml](../codex/config.example.toml).

## 5. The first-run environment, and why each value

| Variable | First-run value | Why |
| --- | --- | --- |
| `CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS` | `false` | The pure profile: OpenCode runs with `--pure`, no third-party plugin. The Gemini profile needs a plugin, a pinned manifest and more; see "Managed Gemini OAuth profile" in the Reference. |
| `CODEX_OPENCODE_WORKTREE_MODE` | `write` | Writers work in their own worktree, never in your checkout. `off` (the built-in default) lets a direct writer edit your checkout. |
| `CODEX_OPENCODE_WORKTREE_ROOT` | `global` | Worktrees live under `<state-dir>`, not inside `<project>`. |
| `CODEX_OPENCODE_QUEUE_MODE` | `sqlite` | A durable queue that survives a crash. |
| `CODEX_OPENCODE_SOURCE_DIRT_POLICY` | `unrelated_ok` | Your uncommitted files outside a job's scope do not block it. `strict` refuses any dirt. |
| `CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT` | `2` | Model calls at once, across all sessions. Raise it once you know your provider's rate limits. |
| `CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST` | `git` | Programs a `validationCommand` may start (step 12). |
| `CODEX_OPENCODE_REQUIRE_RUNTIME_MODEL_EVIDENCE` | `false` | OpenCode does not emit runtime model identity in every stream; `true` rejects real runs. |
| `CODEX_OPENCODE_MODEL_ALLOWLIST` | unset | Set it only when jobs should pick their own model (`provider/model@variant`, comma-separated). |

Leave every timeout at its built-in value for the first run. If you raise one, recompute step 6.

## 6. Choosing `tool_timeout_sec`

Codex gives up on a tool call after `tool_timeout_sec` seconds; a job still running then loses
its result. The value must cover the longest job the bridge allows:

```text
tool_timeout_sec >= provider slot wait (20 min) + longest agent timeout + validation timeout + 5 min
```

| Timeouts | Bound |
| --- | --- |
| All built-in (contractor 20 min is the longest agent, validation 5 min) | 20 + 20 + 5 + 5 = 50 min = **3000** |
| Builder raised to 45 min, validation to 15 min | 20 + 45 + 15 + 5 = 85 min = **5100** |

`npm run release:activate -- --sync-clients` (step 7) computes the bound from your entry and
warns when `tool_timeout_sec` is lower. A job that asks for its own `timeoutMs` is not counted:
keep long work on `enqueue_opencode_job`, whose result is stored and polled rather than
returned inside one tool call. The full formula is in the Reference under "Configuration".

## 7. Connect Claude Code and check both entries match

Skip the Claude registration if only Codex uses the bridge; the managed-runtime sync and
server pinning below are still required. `npm run setup -- --skip-claude-code` does all three safely.

Claude Code needs the same command, arguments and environment as the Codex entry. Register it
once, built from the Codex entry itself so nothing is retyped. `claude mcp add-json` takes the
entry as one JSON argument, and PowerShell 5.1 mangles quotes inside native arguments, so run
this from Git Bash:

```bash
codex mcp get opencode --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).transport;process.stdout.write(JSON.stringify({type:"stdio",command:t.command,args:t.args,env:t.env}))})' > opencode-entry.json
claude mcp add-json -s user opencode "$(cat opencode-entry.json)"
claude mcp get opencode
rm opencode-entry.json
```

Then copy the managed agents into the runtime folder and let the bridge's own tool pin the
server hash and bring both entries in line:

```powershell
cd <bridge-dir>
node bin/sync-managed-runtime.js --apply
npm run release:activate -- --sync-clients
```

`sync-managed-runtime.js` is a dry run without `--apply`; it reads the target folders from the
Codex entry (`--config <file>` for another one).
The manual tools default to `~/.codex/config.toml`; when using a different `$CODEX_HOME`,
pass `--config <CODEX_HOME>/config.toml` to sync, release sync, doctor and both smoke commands.
Setup passes that explicit path itself. Its Claude registration uses the shared entry helper
with atomic JSON file writes, so an arbitrary `--claude-config <file>` cannot accidentally
route `claude mcp add-json` to the real `.claude.json`.

`--sync-clients` re-pins `CODEX_OPENCODE_EXPECTED_SERVER_SHA256`, adds or re-pins
`CODEX_OPENCODE_EXPECTED_LIB_SHA256` (the digest of `lib/` next to `server.js`; without it a
server-pinned bridge refuses to start, log.md B-092), and the plugin manifest hash in the Gemini
profile, all from the files themselves, health-checks a fresh bridge process, and
re-registers Claude Code with exactly the Codex entry. It exits 1 when the two are left
different. Pass `--skip-claude-code` when Claude Code does not use the bridge.

Without Claude Code, run `npm run release:activate -- --sync-clients --skip-claude-code`: the
sync stops with an error when Claude Code has no `opencode` entry yet.

**Not run here against the real clients.** In the scratch setup the commands ran with
`CLAUDE_CONFIG_DIR=<scratch>\claude-config` (so `claude mcp add-json` wrote a scratch
`.claude.json`), `--config <scratch>\codex-home\config.toml`,
`--claude-config <scratch>\claude-config\.claude.json` and `--health-cwd <scratch>\project`, so
neither real client config changed. The sync printed `Integrity pins updated`,
`Client tool timeout covers the longest bridge job (3000 s >= 3000 s)` and
`Claude Code entry updated`, and `claude mcp get opencode` showed the entry as connected.

Claude's delegation rules are in `~/.claude/CLAUDE.md`; a copy is kept in
[claude/CLAUDE.md](../claude/CLAUDE.md).

## 8. Health checks, then a first read-only job

From `<bridge-dir>`, with a test repository that has at least one commit:

```powershell
npm run doctor -- --cwd <project>
npm run smoke:live:health
npm run smoke:live
```

`doctor` checks the server hash, Git, databases and stuck jobs without a model call.
`smoke:live:health` starts the bridge exactly as Codex does. `smoke:live` also runs one tiny
read-only job with a real model call (about a minute); it fails with the provider's error when
the sign-in from step 1 is missing.

Then open Codex **in `<project>`**, select the `principal-engineer-orchestrator` agent, and ask:

> Run `get_opencode_bridge_status` for this project, then ask an OpenCode reviewer for a short opinion on the code.

Expect `healthy` and a review within one to two minutes. If it takes longer, the job is usually
waiting for a provider slot: `get_opencode_job <Run id>` shows `stage=starting_agent` and
`providerWaitMs`. If it fails, copy the error type and look it up in the User Guide's
troubleshooting table, then run `npm run doctor -- --cwd <project>` and
`diagnose_opencode_bridge`.

**Not run here:** the Codex prompt (it needs an interactive Codex session). `doctor`,
`smoke:live:health` and `smoke:live` were run against the scratch entry, each with
`--config <scratch>\codex-home\config.toml` (`doctor` also with `--claude-config`): `doctor`
reported `healthy`, the health smoke `Missing required agents: none`, and the full smoke ran the
planner on `opencode/muse-spark-1.3-contributor-free` in 48 s.

## 9. A first writer, with a full Scope Contract

A write job names every path it may change. Ask Codex for a small change and let it build the
job; the call it makes looks like this:

```json
{
  "agent": "builder",
  "task": "Add a --verbose flag to src/cli/flags.ts. Read src/cli. Change only src/cli/flags.ts. Done when the flag parses and the existing tests still compile.",
  "cwd": "<project>",
  "write": true,
  "lockMode": "simple",
  "lockedPaths": ["src/cli"],
  "allowedEdits": ["src/cli/flags.ts"],
  "validationCommand": "git diff --check",
  "scopeContract": {
    "mode": "write",
    "read": ["src/cli"],
    "write": ["src/cli/flags.ts"],
    "allowedEdits": ["src/cli/flags.ts"],
    "forbidden": [".env", "package.json", "package-lock.json"],
    "shared": [],
    "serialOnly": [],
    "validationCommand": "git diff --check"
  }
}
```

- `allowedEdits` must sit inside `scopeContract.write`; anything the agent changes outside it
  fails the job and keeps its worktree.
- The writer runs in a worktree with no installed dependencies, so its `validationCommand` is
  `git diff --check`; the real tests run in your checkout after integration (step 11).
- Paths are relative to the repository, without `..`, `~`, drive-relative forms or `:` streams.
- Before running, `validate_delegation_plan` checks the same job without starting an agent.

**Checked:** this exact job (with `cwd` set to the scratch project) passes
`validate_delegation_plan` in the scratch bridge.

## 10. Before you integrate: the checklist

1. Read the agent's report and its `Files changed` list.
2. Every changed file is inside `allowedEdits`; nothing touches manifests, lockfiles, schemas,
   migrations or shared config unless the job was about them (those are serial-only).
3. No `Unsafe changed files`, no `DEPENDENCY_REQUIRED` line (if there is one: add the package
   yourself, commit, and re-run the writer).
4. Read the diff in the worktree (`Worktree path` in the result) or with the dry run below.
5. For anything non-trivial, have a reviewer (read-only) and a tester look at the worktree
   before you apply: ask Codex to run them with a read Scope Contract on the changed files.
6. Your checkout is not in the middle of a merge, rebase, cherry-pick, revert or bisect
   (the bridge refuses with `target_operation_in_progress`), and your own uncommitted edits do
   not touch the same files.

## 11. Dry run, receipt, apply

Integration is two calls of `integrate_opencode_worktree` with **the same arguments**:

1. Dry run: `dryRun: true`, the job's `worktreePath` (or `branch`), `allowedEdits`, and
   `validationCommand: "git diff --check"`. It returns the patch (or, with
   `previewMode: "stat"`, per-file line counts), its SHA-256, and a single-use, expiring
   `previewReceipt`.
2. Check that the patch is the one you reviewed: the changed-file list and diff stat match the
   job's result, and nothing else is in it.
3. Apply: the same arguments plus `reviewed: true` and the exact `previewReceipt`. Any argument
   that differs fails with `integration_preview_contract_mismatch` naming it; any change to the
   worktree or your checkout since the dry run fails with `integration_preview_stale` (dry-run
   again).
4. The apply runs the validation command and rolls back if it fails. With a passing validation
   the bridge removes the worktree and its branch.
5. Run your project's real tests in `<project>` and commit.

To land several disjoint worktrees at once (up to 25), `integrate_opencode_worktrees` takes
`items: [{ worktreePath, allowedEdits }, ...]` and the same shared arguments, and works the same
way: one dry run, one `previewReceipt` for the whole batch, one apply that lands every item or none.
A commit that another process lands on your checkout between the dry run and the apply does not
stale the receipt unless it touched one of the patched paths.

**Checked:** a dry run and an apply with a branch source ran through the scratch bridge's MCP
interface against the scratch project.

## 12. The validation allowlist

`validationCommand` runs without a shell. Its program must be listed in
`CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST`; `npx`, shells (`cmd`, `powershell`, `sh`,
`bash`) and inline eval (`node -e`) are refused before any agent starts
(`validation_command_untrusted`). On Windows `npm`, `pnpm` and `yarn` shims run as
`node <entry.js>`.

- Writers keep `git diff --check`: their worktree has no `node_modules`, so `npm test` there
  fails for the wrong reason (log.md B-007).
- For an integration apply you may use a real test command once its program is allowlisted,
  for example `CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,npm,node"` and
  `validationCommand: "npm test"`.
- Reading the result: `Validation gate: passed` ran and exited 0; `failed` ran and exited
  non-zero (`validation_command_failed`, output in the result); `skipped_due_to_prior_failure`
  never ran because the job had already failed; `skipped` means no command was given, and a
  skipped validation never cleans up a worktree.

## 13. Retained worktrees

A writer's worktree is kept until a reviewed integration passes, and whenever a job failed with
changes. To see them:

```powershell
npm run gc
```

and ask Codex to run `diagnose_opencode_bridge` for the project: `retainedWorktrees` lists each
one with its owner, `inFlight` (its job is still running: leave it alone) and a recovery action.
To keep work from a retained worktree, integrate it (step 11). To drop it:
`npm run gc -- --include-retained --older-than 14 --apply` removes reviewed-and-abandoned ones
older than 14 days; `npm run gc:apply` removes orphans whose repository is gone. Branches are
kept unless you pass `--delete-branches`; inspect one first with
`git log main..agent/<role>/<job>`.

**Checked:** `npm run gc -- --state-dir <scratch>\state` (dry run). **Not run here:** the
`--apply` forms and `git log main..agent/...`; the scratch state had no worktree to remove.
Without `--state-dir` the GC commands act on the default `<state-dir>`.

## 14. Which change needs which restart

A bridge process verifies `server.js` and the plugin manifest only when it starts, so most
changes need the client that runs it restarted. Codex keeps idle bridges alive; restart Codex
itself, not just the chat.

| You changed | Then run | Restart Codex | Restart Claude Code |
| --- | --- | --- | --- |
| `server.js` or anything under `bin/` in the checkout the entry runs | `npm run release:activate -- --sync-clients` | yes | yes |
| A new release (`npm run release:activate`) | nothing more (it syncs Claude Code) | yes | yes |
| An env value or `tool_timeout_sec` in the Codex entry | `npm run release:activate -- --sync-clients` (copies it to Claude Code) | yes | yes |
| A managed agent or skill in `opencode/` | from a checkout: `node bin/sync-managed-runtime.js --apply`; from a release: a new release | no (the next job re-attests) | no |
| A model in a profile (Gemini profile: the plugin manifest is regenerated) | `npm run release:activate -- --sync-clients` | yes | yes |
| An OpenCode upgrade | regenerate the plugin manifest (Gemini profile), then `--sync-clients` | yes | yes |
| `~/.claude/CLAUDE.md` | nothing | no | new session |
| A rollback (step 15) | `npm run release:activate -- --sync-clients` | yes | yes |

After a restart, `get_opencode_bridge_status` shows the SHA-256 of the `server.js` the bridge
started with; it must match the pinned `CODEX_OPENCODE_EXPECTED_SERVER_SHA256`.

## 15. Releases and rollback

Once the checkout entry works, run production from an immutable release instead:

```powershell
npm run release:activate
```

It runs the release gate (the same as `npm run test:release`), builds a new release folder under `<state-dir>\releases` (or next to the
active release), points the Codex entry at it with its hash, health-checks a fresh bridge,
backs the old config up as `config.toml.rollback-<time>` next to it, and restores that backup
itself if the health check fails. Then restart both clients.

To roll back by hand:

```powershell
Get-ChildItem $env:USERPROFILE\.codex\config.toml.rollback-* | Sort-Object LastWriteTime | Select-Object -Last 1
Copy-Item <that file> $env:USERPROFILE\.codex\config.toml
npm run release:activate -- --sync-clients
npm run smoke:live
```

The newest backup is the one written by the activation you are undoing. `--sync-clients`
re-registers Claude Code with the restored entry. Restart both clients before `smoke:live`
matters to them. `npm run release:activate -- --inspect` lists the active release, releases a
running bridge still loads, and what `--prune` would delete.

A release builds from any clone, at any path and on any account: the committed
`opencode/plugin-integrity-manifest.json` names `opencode/opencode.jsonc` and
`opencode/antigravity.json` relative to the repository (the folder that holds the manifest's
`opencode/` directory) and leaves the plugin's cache path to the bridge, which derives it from
the plugin name and your OpenCode cache folder. `.gitattributes` keeps those hash-pinned files
byte-for-byte whatever `core.autocrlf` says, and `opencode/.gitignore` is in the repository.
The release itself records the absolute paths of its own copies (log.md B-037). If you edit
`opencode/opencode.jsonc` or `opencode/antigravity.json`, update their `sha256` in the manifest,
or the build refuses them.

The checkout entry from step 4 (pinned by `--sync-clients`) remains a valid daily profile; it is
the one the author runs.

**Checked:** the rollback steps against the scratch Codex home (the newest
`config.toml.rollback-*` restored, then `--sync-clients` re-pinned it and found the Claude
entry in line) and `--inspect`. A release build from a checkout of the committed tree at
another path, with `core.autocrlf=true`, is covered by `tests/review-b037-portable-release.js`
(part of `npm test`), and `node bin/build-release.js <new-dir>` was run in a fresh `git clone`
of the fix branch. **Not run here:** a full `release:activate`, because it rewrites the real
client configs.
