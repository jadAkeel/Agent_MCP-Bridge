# GitHub source update verification

Date: October 18, 2026.
Scope: publish the combined local Bridge improvements and English Agensi submission
tooling to GitHub. The owner explicitly authorized the source update. Marketplace
publication, runtime activation, provider inference and a tagged release are separate
actions.

## Included changes

- Transactional source-package installer with explicit client/worker/Skill selections,
  ownership preservation, backups, interrupted-setup refusal and rollback.
- Original Bridge planning/execution/learning Skills, managed Light delegation, optional
  Pi worker integration, Cursor configuration support and attributed independent
  delegate workflows.
- An English marketplace entrypoint, indexed reference library, reproducible ZIP export,
  listing copy and packaging regressions.
- Supervisor launch-deadline enforcement, worker-file identity/locking portability,
  clearer diagnostics and stronger pinned file-reading smoke controls.
- Property/mutation tooling and isolated Windows/Linux/macOS CI configuration. A configured
  CI matrix is not a claim that every native job has already passed.
- Public source-checkout installation instructions and current prerequisite descriptions.

Local browser captures are explicitly ignored. Runtime state, credentials, generated
archives, test logs and mutation reports are excluded from the source publication.

## Repaired test failures

1. `review-test-runner`: updated exact command-inventory expectations for the added smoke,
   command-boundary and Agensi packaging checks; preserved the canonical 182-command
   inventory and historical argv/hash assertions.
2. `review-day5-quarantine`: observe stdin errors through child close, tolerate the expected
   shutdown EPIPE only, retain unexpected-error/exit assertions, and keep the deliberately
   live validator alive until explicit shutdown or parent pipe closure. The old ten-second
   self-expiry could race synchronous fixture work.
3. `review-f6-finalize-snapshots`: the full run exposed a concurrency deadline starting
   before Git preparation finished. Preparation now has its own bound; the original
   three-second overlap deadline starts when the first held gate enters. Serial gate
   execution still fails. Production finalizer code was not changed.

## Actual local verification

Environment: Windows 11 x64, Node.js v24.11.1. Native/fixture checks used disposable
homes, state and Git repositories; no authorized live-provider route was selected.

| Check | Actual result |
| --- | --- |
| Focused test runner | 26/26 passed, no skips. |
| Focused quarantine | 13/13 passed, no skips. |
| `npm run test:platform` | 4/4 passed, no skips; injected OS branches do not establish native acceptance on another OS. |
| Actual isolated `npm test` | Packaging 14/14, smoke 8/8, command boundary 2/2, Pi fixtures 16/16 passed. Canonical full run: **181/182**, exit 1, solely the concurrency-test deadline above. |
| Full-run skip ledger | 4 optional whole skips, 2 optional partial cases, **0 required skips**, no required-skip override. |
| Corrected finalization snapshot test | 29/29 passed, no skips, on the final test-only correction. |
| Production dependency audit | 0 reported vulnerabilities from `npm audit --omit=dev --json`. |
| Upstream provenance | All 125 staged original files match GitHub blobs at pinned delegate-skills revision `3aa72d681a79e2a9d09bd9a316353003ae1cb4a7`. |
| Staged-content review | Candidate secret-pattern findings were inspected: explicit synthetic redaction/loopback fixtures only; no unresolved finding. No browser captures, credentials or runtime state selected. |
| Whitespace | `git diff --cached --check` passed after normalizing three documentation lines. |

The 51.33-minute full run is retained as a failure, not relabeled as a raw green run.
After it completed, the only source-code delta was the concurrency-test fixture above;
the affected test was rerun successfully. Remaining post-run changes are publication
documentation. Runtime behavior did not change after the full run. GitHub CI is the next
complete run on the published final revision; its status must be checked separately.

## Local evidence identities

- Full wrapper: `.test-logs/packaging-1792341546148-5596/report.json`.
- Full canonical report: `.test-logs/2026-10-18T16-39-57-598Z-15732/report.json`.
- Full publish-input digest, 408 files:
  `968da91cebe12df84500a2d349780579430ae3ee0bf3f03a002e2764347b0058`.
- Corrected-test wrapper: `.test-logs/packaging-1792344941308-34016/report.json`.
- Final publish-input digest, 408 files:
  `4a33ff52a31fec2dcae16db343c8edae3480f7363076ca38c357acc1e0838e27`.
- Reconciliation: `.test-logs/publication-verification-summary.json`.

These digests use the release tool's existing publish-input set, not every repository
document. Raw local evidence is intentionally not committed. The marketplace ZIP and its
separate file/archive hashes are recorded in
[the submission results](AGENSI-SUBMISSION-RESULTS-2026-10-18.md).

Source publication does not establish Agensi approval, independent fresh-user acceptance,
or a real-client/provider read/write/review/integration journey. Those release outcomes
remain as documented in the launch plan.
