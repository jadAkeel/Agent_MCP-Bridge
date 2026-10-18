# Compatibility and acceptance boundaries

This is marketplace submission candidate **0.1.0-rc.1**, assembled from the repository's
Skill bundle **1.2.0**. The application's package version is a separate version layer.
The generated package manifest records the exact submission files and their SHA-256
hashes. It does not identify or qualify an independently obtained runtime artifact.

| Surface | Current evidence and limit |
| --- | --- |
| Skill/reference packaging | The export command verifies source pins, local Markdown link targets, licenses and packaged bytes. Local archive extraction is separately verifiable. |
| Bridge runtime | Substantial local fixture coverage exists. Marketplace packaging does not rerun or replace runtime release gates. |
| Windows | Strongest local acceptance lane. Real-client/provider and independent fresh-user acceptance for the final distributed candidate remain separate checks. |
| Linux | Prior native-binary testing in WSL2 exists; it does not establish every Linux distribution or client setup. |
| macOS | An installer target; native acceptance is not established for this candidate. |
| Claude Code / Codex | Installer/client integrations exist. A real end-to-end task for the distributed candidate still needs acceptance. |
| Cursor | Registration and local setup paths exist; desktop discovery/approval behavior remains unverified. |
| Other client names | A matching original delegate name is not proof that the client can host Bridge or that a native workflow passed. |
| Independent delegates | All 18 original workflows and 2 helpers are included with their pinned scripts and references. Their own prerequisites and platform limits apply; all-provider/native execution is not established. |
| Agensi | Submission ZIP format is prepared locally. Marketplace scan/review, reference delivery and actual client execution still need platform acceptance. |

## Prerequisite failure is actionable information

If Bridge tools, the selected CLI, provider access, an authorized model or a helper
service are missing, identify the specific prerequisite. Do not silently install tools,
switch accounts/models, broaden permissions, or substitute a different execution route.

## Licensing and attribution

The project's original material is provided under the included [ISC license](../LICENSE).
Adapted Bridge delegate guides and unchanged independent delegate Skills include MIT
material by Ahmed Mohammed (amElnagdy). Their licenses and notices accompany each rendered
folder; see the aggregate [notice](../NOTICE.md). Open-source redistribution rights
remain those stated in the included licenses.

The marketplace offering combines route selection, Bridge integration, installation
guidance and the attributed reference library. It does not claim exclusive authorship of
the original delegates, universal client support, complete filesystem isolation, or
unmeasured cost/performance gains.
