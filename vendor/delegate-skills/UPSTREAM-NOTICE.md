# Independent upstream delegate skills

Source: https://github.com/amElnagdy/delegate-skills
Pinned revision: 3aa72d681a79e2a9d09bd9a316353003ae1cb4a7
Copyright (c) 2026 Ahmed Mohammed (amElnagdy). Distributed under the included MIT LICENSE.

The files in upstream/skills/ are unchanged copies of the 18 original delegate skills
and the delegate-setup/codex-background support utilities at this revision. The installer
adds this notice and LICENSE to each selected installed folder. Source package integrity
is pinned in skill-package-manifest.json. Updating upstream requires review and new pins.

These original skills invoke their own CLI relays, independently of Agent MCP Bridge.
They do not inherit its locks, scope enforcement, worktrees or integration receipts.
Each skill owns its permissions, platform limits, prerequisites and failure semantics.
Do not run independent writers against paths/resources already owned by a bridge job.
Installing files does not install/authenticate their CLIs, approve provider/model costs,
write a fleet map, bootstrap codex-background or register another MCP server. Any such
subsequent setup/execution must follow the user's authorization and the selected skill.

For Codex background orchestration, upstream requires a separately configured
codex-background utility. Selection "all" explicitly includes both helper skill folders,
but still does not execute their setup. Individual selections do not imply helper setup.
Upstream commit/land examples do not override the user's actual Git authorization.
Native Windows/provider behavior has not been verified for all these CLIs by this bridge.
