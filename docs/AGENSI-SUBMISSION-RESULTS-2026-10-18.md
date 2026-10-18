# Agensi submission candidate results

Date: October 18, 2026.
Status: **Local English submission package prepared and verified.** Marketplace review,
real-client/provider execution and independent fresh-user acceptance are separate pending
outcomes.

## Deliverables

- Marketplace entrypoint: `skills/bridge-delegation/SKILL.md`.
- Supporting setup, mode and compatibility guidance in its `references/` directory.
- English listing copy: [AGENSI-LISTING.md](AGENSI-LISTING.md).
- Reproducible exporter: `bin/package-agensi.js`, also available as `npm run package:agensi`.
- Build/use instructions: [AGENSI-PACKAGING.md](AGENSI-PACKAGING.md).
- Regression coverage: `tests/agensi-package.test.js`, included in `test:packaging`.

The listing's central value is flexible route selection and reviewed execution: managed
Light, managed Parallel, durable Queue/Pipeline, and explicitly selected independent CLI
delegation. Direct work is documented as the appropriate option for tiny tasks.

## Generated artifact

Relative to the workspace:

```text
dist/agensi/agent-mcp-bridge-0.1.0-rc.1/
  agent-mcp-bridge-0.1.0-rc.1.zip
  SHA256SUMS
  BUILD-REPORT.json
  submission/
```

ZIP SHA-256:

```text
fb63d777348a5a246c75f10e1b15d826ded5d736e6c356b4250e09b9e5cb9d76
```

The archive contains **200 files**, with one root marketplace SKILL.md and a complete
reference library of 26 existing guides: three orchestration guides, three managed worker
guides, 18 independent delegates, and two helpers. Original upstream files remain unchanged;
rendered managed links resolve inside their folders. Root/third-party licenses and notices
are included. There are 27 SKILL.md files in total, including the marketplace entrypoint.
Nested Skills are reference material, not automatically installed marketplace sub-Skills.

The source Skill bundle remains version 1.2.0; this marketplace assembly is candidate
0.1.0-rc.1. The generated source manifest SHA-256 is
`c09417e8429a043ed99b62f1b7ba10787ccce399e8c24ec6b53126a50927a98b`.
These identities distinguish this candidate from earlier local bundles with the same
application package version.

## Verification actually run

Environment: Windows 11 x64, Node.js v24.11.1, Python 3.12.4 for the independent ZIP check.

| Command | Observed result |
| --- | --- |
| `node bin/package-agensi.js --check` | 200 files; root metadata, source pins, attribution and local Markdown link targets passed. |
| `npm run test:packaging` | 14 tests passed, 0 failed, 0 skipped; includes all 5 new exporter tests and the existing renderer/diagnostics/installer-selection tests. |
| `node bin/verify-isolated.js --node bin/package-agensi.js` | Built the final ZIP, exit 0, stable publish inputs; disposable home/config/state, no provider inference. |
| `python -m zipfile -t dist/agensi/agent-mcp-bridge-0.1.0-rc.1/agent-mcp-bridge-0.1.0-rc.1.zip` | Exit 0; independent standard-library ZIP/CRC validation passed. |
| `git diff --check` | Passed. |

The exporter tests verify root layout, all original script/reference bytes and licenses,
sibling helpers, ZIP round-trip contents and manifest hashes, deterministic entry order,
broken/escaping links, unsafe archive paths, refusal to overwrite existing output, and
check-only behavior. Original relay help checks are local fixtures, not provider work.

Build receipt: `.test-logs/packaging-1792340335739-4536/report.json`.
Its release-publish input digest is
`882022d7e1c6525304387a4c85206e85e394544dc2f19f9f2c9eac55778e8c76`
for 408 files, identical before and after the build. That digest uses the existing
release-publish input set; the submission's own manifest separately identifies every ZIP
payload file. Seller-only documentation is outside that release-publish digest.

## Remaining release work

1. Supply an obtainable matching companion runtime artifact and its download/version/hash
   in the final seller fields. The Skill ZIP does not contain the Bridge Node runtime or
   third-party CLI binaries.
2. Complete a selected, authorized real-client/provider read/write/review/integration task,
   then independent first-user acceptance using the distributed artifact.
3. Reconcile the two failures in the earlier 180/182 full-suite run before treating the
   final runtime release gate as green. This packaging round did not rerun that full suite
   or repair those unrelated test paths.
4. Finalize price/support/payout fields as applicable, then perform owner-authorized upload
   and Agensi scan/review/delivery acceptance.

No marketplace upload, publication, terms acceptance, provider call, live-client setup,
commit or push was performed in this preparation round.

## Later GitHub-update verification

The owner subsequently authorized a GitHub source update. Both earlier failing tests
were repaired. A new full run finished 181/182, exposing a separate concurrency-test
clock issue; its test-only correction passed 29/29. See
[the publication verification record](GITHUB-UPDATE-2026-10-18.md) for exact outcomes,
skip accounting and source identities. This follow-up does not change the ZIP bytes or
replace the pending marketplace/real-user acceptance steps above.
