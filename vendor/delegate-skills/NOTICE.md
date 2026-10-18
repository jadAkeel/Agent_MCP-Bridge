# Curated bridge adaptation

Reviewed source: https://github.com/amElnagdy/delegate-skills
Pinned revision: `3aa72d681a79e2a9d09bd9a316353003ae1cb4a7` (2026-10-14 inspection).
Upstream codex-delegate/opencode-delegate skill version: 0.5.0.
Local installed personal copies examined separately: 0.4.2, with local modifications.

The bridge-delegate guides adapt the bounded brief/report/review workflow under MIT.
Names are distinct to preserve personal installations. Their execution uses the bridge's
existing managed executor and external Codex/optional Pi runners, NOT upstream relay.mjs or
codex-background/delegate-setup/fleet/account configuration. Separately selected original
skills in upstream/skills do ship their own relays and support utilities; see
UPSTREAM-NOTICE.md. They are independent routes, not bridge adapters, and setup does not
execute them. Nothing is fetched at job time. Preserve these notices and LICENSE.
Updates require a pinned source audit, reviewed diff, regenerated integrity and tests.
See docs/DELEGATE-AUDIT.md for the concrete launch/permissions/cancellation decision.
