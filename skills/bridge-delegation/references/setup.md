# Local setup and first task

## What the user needs

The marketplace provides the delegation instructions and reference library. Managed
execution runs on the user's machine through a separately installed Agent MCP Bridge.
Independent delegates also need their own local CLI/script installation.

Prerequisites for the current Bridge public Skill installer:

- Windows 11, Linux or macOS as installer targets; see the evidence limits below.
- Node.js >=22.13.0 with npm, Git, and exactly OpenCode 1.18.32.
- A selected MCP client. The installer has Claude Code, Codex and Cursor selections.
- A user-selected, available provider/model and normal CLI/provider authentication.
- Any additional CLI required by the chosen delegate. Installing a Skill does not install
  a provider subscription, third-party CLI binary or authenticated account.

## Obtain the matching companion runtime

Use the versioned Agent MCP Bridge runtime package supplied by the publisher for this
release. It must contain `bin/install.js`, `server.js`, `package.json`, the lockfile,
`skills/`, `vendor/delegate-skills/`, and `skill-package-manifest.json` along with the
runtime files. Check its publisher-supplied version/hash before setup.

The project home is https://github.com/jadAkeel/Agent_MCP-Bridge. A branch checkout is
not automatically the same candidate as this Skill package. If a matching runtime
artifact or download location has not been supplied, request it before installation.
There is no published npm installation command claimed by this submission candidate.

## Preview and install

Run commands from the obtained runtime package directory. For a Claude Code client
with managed OpenCode and selected independent Claude, Cursor and Kimi guides:

```text
node bin/install.js --dry-run --client claude --workers opencode --delegates opencode --standalone-delegates claude,cursor,kimi
```

After the user reviews the planned installation, the same selection can be applied:

```text
node bin/install.js --yes --client claude --workers opencode --delegates opencode --standalone-delegates claude,cursor,kimi
```

These are example selections, not required defaults. `--client codex` and
`--client cursor` choose other supported installer targets. Use
`node bin/install.js --interactive` for guided choices. Select `--standalone-delegates
all` to install all 18 original delegates and both helpers; `none` selects no independent
Skills. List the available selections with `node bin/skill-package.js --list`.

The installer verifies the Skill manifest and uses lockfile dependencies. It prepares
the selected client registration, host Skills and managed runtime/state, preserving
unrelated configuration through its transaction workflow. It does not authenticate
providers, select a replacement model, or start delegated provider work. `--yes` accepts
the displayed installation changes; it is not permission for later inference or Git work.

Restart/reload the selected client as needed, verify the Bridge tools are visible, and
use normal provider sign-in. Agensi and Bridge can be separate MCP connections in the
same client: one supplies instructions; the other performs local managed execution.

## Enable only the chosen worker

OpenCode is the required admission/runtime prerequisite. A managed Codex worker requires
explicit external-runner configuration and an exact authorized model allowlist. The
optional Pi worker needs explicit `unsandboxed-worktree` acceptance and supports trusted
file-editing builder/debugger tasks through normal Bridge jobs, not Light mode.
Use the [catalog](catalog.md) for the selected guide and its exact requirements.

For independent delegates, the installer copies the original scripts and references into
local Skill folders. The user can obtain those files through the companion package
without cloning the upstream delegate repository. Each selected CLI still has its own
installation, authentication and permissions. `delegate-setup` and `codex-background`
require their own authorized configuration; copying their files does not start services.

## First useful task

Start in a disposable Git project with a committed baseline:

1. Confirm the selected client can discover the Skill and Bridge tools.
2. Select an authorized provider/model and ask a reader to report a fact from a file.
3. Delegate one small behavior change with explicit file ownership and a genuine check.
4. Inspect the resulting source and test output, preview integration, then apply the
   reviewed Bridge patch using its exact receipt.
5. Verify the final behavior and that unrelated content remains intact.

This is a task recipe, not a claim that the current submission has passed real-client,
provider, fresh-machine or Agensi delivery acceptance. See
[compatibility](compatibility.md). Stop at the actual missing prerequisite if a step fails.
