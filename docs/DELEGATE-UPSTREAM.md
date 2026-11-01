# Preserve the author's delegate workflows

The original skills come from
[amElnagdy/delegate-skills](https://github.com/amElnagdy/delegate-skills), pinned at
[`3aa72d681a79e2a9d09bd9a316353003ae1cb4a7`](https://github.com/amElnagdy/delegate-skills/tree/3aa72d681a79e2a9d09bd9a316353003ae1cb4a7/skills).
All 125 files under `vendor/delegate-skills/upstream/skills/` preserve that revision's
file paths and bytes. The installer adds attribution and license files separately.

Selecting an original skill such as `opencode-delegate` selects the author's workflow:
prepare a bounded brief, invoke its relay or required support tool, interpret its result,
and review the actual changes. Its selected workspace and permissions govern execution.
Agent MCP Bridge does not add a mandatory worktree, locks or integration receipts to it.
For Codex background orchestration, the author's `codex-background` utility remains the
required waiting mechanism; short foreground runs follow its documented exception.

The `bridge-delegate-*` guides are separately named adaptations. Their managed Light
and parallel execution keep Bridge's existing worktrees, locks and reviewed integration.
Installing Bridge must not rewrite original skill names to prefer those adaptations.
Keep independent jobs away from files and resources owned by active Bridge jobs.

## Installation and updates

Select originals using `--standalone-delegates all` or explicit keys; the selection
retains the original scripts, references and helper relationships. `--delegates` selects
managed Bridge guides and is a separate option. Existing local modifications must be
backed up and reviewed before replacing a personal installation. Installation does not
itself start a provider job, configure accounts, bootstrap a service or authorize commits.

Keep compatibility changes and local routing preferences out of the vendored originals.
If a new runtime needs a change, review an upstream update or maintain a distinctly named
adapter with its own documented compatibility; do not silently patch the original skill.
An upstream update must review the new revision, compare the complete file inventory and
contents, preserve MIT notices, and regenerate `skill-package-manifest.json`.

Verify local packaging with:

```powershell
node bin/skill-package.js --check
node --test tests/skill-package.test.js
```

These checks establish packaging fidelity and integrity, not successful inference or
provider authentication. Follow each original skill's platform and provider requirements.
