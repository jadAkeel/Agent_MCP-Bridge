> **Historical record (archived 2026-09-24).** Line numbers, file names, release names, and procedures in this document may be out of date. Current docs: [USER_GUIDE.md](../USER_GUIDE.md) and [REFERENCE.md](../REFERENCE.md).

# Safe Publish Manifest

This repository stores the important, non-secret parts of the Codex -> MCP
Bridge -> OpenCode multi-agent system.

## Included

- MCP bridge source and package metadata.
- Main README and complete bridge guide.
- Global multi-agent architecture goal documents.
- Current Codex orchestrator and subagent configs.
- Current OpenCode agent configs and managed skills.
- Sanitized Codex MCP config example.
- Reviewed nonsecret OpenCode config and plugin security settings.

## Intentionally Excluded

- `~/.codex/auth.json` and OpenCode `auth.json`.
- `antigravity-accounts.json` and every provider credential/token file.
- Codex/OpenCode session, state, history, logs, sqlite, cache, sandbox, and
  attachment files.
- Raw `~/.codex/config.toml`, because it contains machine/runtime paths.
- Raw `~/.codex/rules/default.rules`, because it contains machine-local shell
  approvals and project-specific commands.
- `.env`, `.env.*`, generated worktrees, lock databases, runtime logs, and
  backup files.

The release builder and manifest never publish or hash excluded credential files.
Only reviewed nonsecret `opencode.jsonc` and `antigravity.json` inputs are
hash-pinned. At runtime, isolated-role discovery may read a bounded valid built-in
`auth.json` object and pass it only through `OPENCODE_AUTH_CONTENT` to a one-shot
child. The bridge never logs, returns, prompts with, or persists that content and
never reads `antigravity-accounts.json`.

## Restore Notes

Copy files back intentionally. Do not blindly overwrite local config directories.

- Codex agents: `codex/agents/` -> `~/.codex/agents/`
- Codex skills: `codex/skills/` -> `~/.codex/skills/`
- OpenCode agents: `opencode/agents/` -> `~/.config/opencode/agents/`
- OpenCode skills: `opencode/skills/` -> `~/.config/opencode/skills/`
- When the active MCP entry pins `CODEX_OPENCODE_AGENT_DIR`/`CODEX_OPENCODE_SKILL_DIR` to a dedicated runtime
  directory, use `npm run sync:runtime` (dry-run) and `npm run sync:runtime -- --apply --remove-stale`
  instead of copying by hand; it only touches `*.md` profiles and skill trees.
- `opencode/plugin-integrity-manifest.json` is machine-specific deployment
  evidence with canonical absolute paths and inspected hashes. Regenerate and
  re-review it when the source root, host, OpenCode version, or optional plugin
  package changes.
- Adapt `codex/config.example.toml`; never publish raw machine config.

## Runtime Release Workflow

A runnable release is self-contained for code and nonsecret policy inputs. It
includes exact `node_modules`, `bin/`, package files, `server.js`, reviewed
`opencode.jsonc`/`antigravity.json`, managed agents/skills, and the rewritten
plugin-integrity manifest. It never includes provider credentials.

Full immutable production uses OpenCode pure mode and the built-in Codex OAuth
transport. `CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS` must be `false`. The bridge
and fresh health reject external plugins when a release-manifest pin is active:
the reviewed Antigravity plugin stores its account under `XDG_CONFIG_HOME`, while
immutable production requires that config home to be the read-only release root.

The explicitly authorized Gemini hybrid profile keeps `server.js` in a published
read/execute-only release and pins its SHA-256, but points `XDG_CONFIG_HOME`, the
managed agent/skill directories, and plugin manifest at a dedicated writable OAuth
runtime. It enables only the exact allowlisted plugin and omits
`CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256`. This is weaker than the full
immutable profile: plugin/config/settings integrity remains pinned and effective
agent policy is attested, but same-user mutation of the writable runtime is outside
the release manifest boundary. Keep the previous immutable profile and config
backup for rollback.

The active config and active release remain unchanged through candidate build,
tests, health, and ACL verification.

### 1. Complete the mandatory source matrix

```powershell
npm test
npm run test:concurrency
npm run test:e2e
npm run test:e2e:contractor
npm audit --omit=dev
Push-Location opencode
npm audit --omit=dev
Pop-Location
npm audit --prefix 'C:\Users\10User\.cache\opencode\packages\@cortexkit\opencode-antigravity-auth@2.2.1' --omit=dev
git diff --check
```

Any failure or skipped gate stops publication.

### 2. Build a new non-overwriting release

```powershell
$releaseDirectory = 'C:\absolute\codex-opencode-mcp-releases\server-<new-id>'
npm run release:build -- $releaseDirectory
$serverSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $releaseDirectory 'server.js')).Hash.ToLowerInvariant()
$manifestSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $releaseDirectory 'release-manifest.json')).Hash.ToLowerInvariant()
$pluginManifestSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $releaseDirectory 'opencode\plugin-integrity-manifest.json')).Hash.ToLowerInvariant()
```

The builder rejects linked sources/ancestors, credential-bearing config keys,
noncanonical config provenance, and existing destinations. It stages on the
destination volume, rewrites only the staged config/settings paths, and publishes
by one directory rename with an exact file/digest manifest.

### 3. Test the pinned candidate before ACL hardening

```powershell
Push-Location $releaseDirectory
$env:CODEX_OPENCODE_EXPECTED_SERVER_SHA256 = $serverSha256
$env:CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 = $manifestSha256
$env:CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS = 'false'
$env:XDG_CONFIG_HOME = $releaseDirectory
$env:CODEX_OPENCODE_AGENT_DIR = Join-Path $releaseDirectory 'opencode\agents'
$env:CODEX_OPENCODE_SKILL_DIR = Join-Path $releaseDirectory 'opencode\skills'
$env:CODEX_OPENCODE_PLUGIN_MANIFEST_PATH = Join-Path $releaseDirectory 'opencode\plugin-integrity-manifest.json'
$env:CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256 = $pluginManifestSha256
npm test
Pop-Location
```

Remove those temporary environment overrides from the operator shell after the
candidate checks.

### 4. Prepare and validate a candidate Codex config

Create the candidate beside the active config so the final replacement is on the
same volume. Change only the MCP entry needed for this release:

- `command`: exact absolute Node executable used for verification.
- `args`: exactly one absolute candidate `server.js`.
- exact server, release-manifest, and plugin-manifest SHA-256 pins.
- `CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS=false`.
- `XDG_CONFIG_HOME=<release root>`.
- exact release-local agent, skill, and plugin-manifest paths.
- `CODEX_OPENCODE_WORKTREE_CLEANUP=never`.

Preserve reviewed queue/provider/policy settings. Do not copy or move any global
OpenCode tree or credential file.

```powershell
$configPath = 'C:\absolute\to\.codex\config.toml'
$candidateConfig = "$configPath.candidate"
Copy-Item -LiteralPath $configPath -Destination $candidateConfig
# Edit only $candidateConfig here.
python -I -c "import sys,tomllib; tomllib.load(open(sys.argv[1],'rb'))" $candidateConfig
node (Join-Path $releaseDirectory 'bin\fresh-healthcheck.js') $candidateConfig 'C:\absolute\healthy\git-checkout'
```

With `CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256` set, fresh health validates
the exact Node/server command, every release file/hash, release-local
XDG/config/agent/skill/plugin-manifest bindings, pure mode, MCP initialization,
tool discovery, and a healthy bridge status before spawning the candidate MCP.
For the Gemini hybrid profile, leave the release-manifest pin unset: fresh health
still verifies the exact server hash and fresh MCP health, while the bridge itself
attests the dedicated managed runtime and external-plugin manifest. The command
reports `immutable-release` or `server-pinned` so the assurance level is explicit.

### 5. Apply and prove read/execute-only release protection

The runtime identity needs read/execute/traverse only. Administrators and SYSTEM
retain recovery access. Remove inherited or wide write grants; setting read-only
attributes alone is insufficient. A release owned by the same non-elevated user
is protection from accidental mutation, not a malicious owner who rewrites its
DACL. Use an administrator-owned directory or separate OS identity for that
threat.

After applying the reviewed DACL:

- inspect it with `icacls`;
- prove ordinary create, write-handle, rename, delete, and attribute mutation are
  denied for the runtime identity;
- prove reading and executing the release still work;
- rerun pinned `npm test`, both live E2Es, and candidate fresh health.

On Windows, harden the release root first, then reset every existing child entry
so it inherits that root DACL. A recursive `/inheritance:r` plus `/grant` call
can leave pre-existing children with empty DACLs on some filesystems. Treat any
nonzero `icacls` result as a gate failure:

```powershell
$runtimeIdentity = "QSC-PC\10User"
icacls $releaseDirectory /inheritance:r /grant:r `
  "NT AUTHORITY\SYSTEM:(OI)(CI)(F)" `
  "BUILTIN\Administrators:(OI)(CI)(F)" `
  "${runtimeIdentity}:(OI)(CI)(RX)" /C
if ($LASTEXITCODE -ne 0) { throw "Root ACL hardening failed." }

foreach ($entry in Get-ChildItem -LiteralPath $releaseDirectory -Force -Recurse) {
  icacls $entry.FullName /reset /C *> $null
  if ($LASTEXITCODE -ne 0) { throw "Child ACL reset failed: $($entry.FullName)" }
}
```

Any failure stops activation. Do not weaken ACLs or skip tests to proceed.

### 6. Atomically activate only the Codex config

No OpenCode config, agent, or skill directory is replaced. Existing MCP
processes continue using the old immutable release; new processes use the new
config. Tell users to restart existing tasks before relying on the new release.

```powershell
$backupConfig = "$configPath.rollback-$(Get-Date -Format yyyyMMddHHmmss)"
Copy-Item -LiteralPath $configPath -Destination $backupConfig
$activationBackup = "$configPath.activation-backup-$(Get-Date -Format yyyyMMddHHmmss)"
[System.IO.File]::Replace($candidateConfig, $configPath, $activationBackup, $true)
```

Immediately run fresh health against the active config. Only a healthy result
authorizes completion. Keep the prior immutable release and byte-exact config
backups. On this Windows runtime, passing `$null` as the `File.Replace` backup
path fails; use an explicit same-volume backup path and verify its hash equals
the preactivation config hash.

### 7. Roll back atomically on any post-cutover failure

Create a same-volume rollback candidate from the byte-exact backup, atomically
replace the active config, and run the old release's fresh health check. Report
both candidate failure evidence and rollback health. Never modify or delete the
previous release during rollback.

A manifest SHA-256 is an integrity pin, not a public-key signature and not a
defense against an attacker who can also rewrite the operator config or DACLs.
