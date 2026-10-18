# Agent MCP Bridge: Evidence-Driven Launch Plan

Date: October 18, 2026.
Status: Local hardening and English marketplace submission packaging completed with Jad's approval. Live route, final runtime artifact, marketplace acceptance and launch decisions remain pending.
Basis: [readiness review](AGENSI-READINESS-REVIEW-2026-10-18.md).

## 1. First priority

**Prove one independently reproducible first-user journey against an identifiable candidate.**

A new developer must be able to obtain the candidate, follow the guide, connect a real client, use an explicitly configured working provider, delegate a real file task, review the patch, and integrate it with the exact preview receipt. Successful health checks and a literal model reply are prerequisites, not that outcome.

The immediate technical dependency is the provider/default-route gap. The latest recorded Muse failure makes it premature to tell a buyer that default installation produces a working delegated task. Qualify the approved route first, then prove the whole journey; do not silently replace a user's model.

## 2. Feature card

- **Problem:** the strongest current evidence belongs to a local combined candidate, while public `main` is older. Current receipts do not prove a fresh real-client installation through reviewed integration. Agensi delivery is another unverified boundary.
- **Outcome:** a versioned release candidate with a documented, independently repeated workflow and an honest support matrix, followed by an Agensi listing that delivers that same workflow.
- **Evidence required:** candidate/artifact hashes; exact runtime/client/provider versions; requested/configured/runtime-observed model evidence distinguished; actual file changes; real test results; preview/apply receipt; installation/reinstall/rollback preservation; independent tester report; marketplace delivery result.
- **Blast radius:** initial release users and selected managed profiles/install paths. Existing installations require explicit compatibility and migration assessment before any default change. The number of affected installations is unknown; do not invent it or introduce telemetry to count it.
- **Boundary:** initial acceptance concerns one explicitly supported user journey. Additional clients, platforms, and advertised parallel/batch behavior receive their own acceptance evidence.

## 3. Decisions for Jad

All recommendations in this table are **assumed, pending Jad**, not settled decisions.

| ID | Decision | Recommendation | Why |
| --- | --- | --- | --- |
| D1 | Initial platform/client | Windows 11 + Claude Code as the first acceptance lane; verify Codex separately before claiming equal fresh-user coverage | Strongest platform evidence; narrow the first real-client investigation to one concrete path. |
| D2 | Worker provider/model/account/effort | One currently available, explicitly authorized OpenCode route; Jad supplies or confirms the exact route/account/variant | The old default's availability is uncertain; do not hardcode a replacement based on one historical GLM reply. |
| D3 | Live workload and budget | Start with one reader, one bounded writer, and one reviewer in a disposable project; confirm spend/time limits before running | This exercises tool use and integration while keeping the initial experiment bounded. |
| D4 | Distribution and commercial launch | Versioned GitHub release artifact plus an initially limited beta; choose free/paid Agensi pricing after delivery and acceptance evidence | Establish that people can obtain the exact tested version before selling a frictionless-install promise. |
| D5 | Private project-facts location | Use ignored `.test-logs/agensi-launch-project-facts.md` for the future private facts snapshot | `.claude/brief-facts.md` is missing and `.claude/` is not ignored. Confirm the location before creating private facts there. Public facts needed now are in Appendix A. |

No provider call, client-config modification, account selection, upload, publication, or agent dispatch is authorized merely by writing this plan.

## 4. Critical path and acceptance gates

```text
G0 Scope and candidate identity
  -> G1 Approved route + pinned real-client golden journey
  -> G2 Reviewed, reproducible RC artifact
  -> G3 Independent fresh-user acceptance
  -> G4 Agensi delivery acceptance
  -> G5 Limited beta and launch decision
```

Targeted security triage and an owner-led question to Agensi about support-file delivery can begin alongside G1 after authorization. Source-changing fixes must join the same final candidate and invalidate affected evidence. They do not create a second release stream.

### G0 — Fix the scope and record the candidate

**Outcome:** the operator can name exactly what is being qualified and which user claims it will support.

- Confirm D1–D4 and the private facts location.
- Record current HEAD, complete tracked/untracked inventory, publish-file digest, dependency lockfile, managed profiles, and required prerequisites.
- Prepare and verify an implementation checkout from the intended combined source before assigning implementation. Preserve the current checkout's existing work.
- Keep one acceptance ledger keyed by candidate identity and check inputs. A shared HEAD alone cannot distinguish these uncommitted candidates.

**Exit evidence:** baseline record, confirmed scope/route/budget, actual checkout path and state, check ownership.

### G1 — Qualify the route and prove a real golden journey

**Outcome:** a genuine user task completes through the Bridge with the intended startup pins and explicit provider selection.

1. Verify exact CLI/client/runtime prerequisites and the approved route. Normal sign-in stays with the operator.
2. Install into approved disposable configuration/state, then start the actual selected client using its supported isolation/configuration mechanism.
3. Confirm valid startup pins are enforced. Include a controlled mismatched-pin refusal; a `--server` candidate override that removes pins cannot serve as this proof.
4. Have a reader report a repository fact whose answer requires reading a known fixture file. A literal “OK” response does not qualify.
5. Have a writer make one small, observable behavior change in a Bridge worktree under an explicit Scope Contract.
6. Have the reviewer inspect the actual retained output. Run a genuine behavioral check; `git diff --check` is additional whitespace evidence only.
7. Preview, inspect the patch, and apply with the same contract and exact receipt. Verify final project behavior and preserved unrelated content.
8. Reuse matching controlled scope/cancellation/stale-receipt/rollback evidence; add focused controls only where the approved change creates a real coverage gap.

**Exit evidence:** real client/tool activity, exact provider request and available identity evidence, patch, checks, receipt, final status, lock/worktree outcome, and source/configuration identity.

**If it fails:** classify provider availability, configuration, client behavior, or product defect first. Keep partial evidence; repair the confirmed cause only. A model not emitting runtime identity remains an evidence limit, not a reason to fabricate identity or weaken policy.

### G2 — Produce a reviewed and reproducible RC artifact

**Outcome:** a person outside the working checkout can obtain and install the exact accepted bytes.

- Triage the highest-risk production CodeQL paths, initially alerts 167/168/169 and related trust boundaries. Follow reachable production flows rather than ranking work solely by the raw count of 271 alerts.
- For each investigated alert, record confirmed issue, false positive with a source-level reason, or unresolved evidence. Fix confirmed release-blocking issues in the advertised path before external distribution.
- Review any product/default changes independently. Review test edits and retained safety invariants separately from pass counts.
- Reconcile the quick-start, exact OpenCode requirements, client/platform matrix, model configuration, version mapping, and update/rollback instructions.
- Freeze the final candidate after fixes. Run required affected gates once at this stable boundary; inspect matching earlier receipts before scheduling redundant runs.
- Use the existing release/package builder in an isolated destination after verifying its invocation. Produce a versioned artifact and a file/hash manifest; do not activate the owner's live installation as a build step.
- Install the artifact from a fresh directory without depending on the original workspace or personal paths.

**Exit evidence:** reviewed source identity, security dispositions, actual gate receipts, artifact hash/manifest, extraction/install check, final documentation matching behavior.

### G3 — Have a second developer repeat the workflow

**Outcome:** onboarding works without the maintainer fixing undocumented assumptions during the trial.

- Jad selects an independent Windows tester with prerequisites or a clean environment they control.
- Give the tester only the versioned artifact, public instructions, prerequisites, and a disposable task project.
- Record installation interruptions and every undocumented manual intervention.
- Repeat the read/write/review/preview/apply journey from G1 using the tester's explicitly selected provider/client setup.
- Verify reinstall preserves unrelated settings and modifications, and validate the documented recovery/update/rollback path in a test environment.
- Resolve blocking onboarding findings. Source/artifact changes require affected checks and a new artifact identity; repeat the affected independent steps.

**Exit evidence:** tester environment, artifact hash, intervention log, observed results, and an explicit accepted/blocked verdict.

This is the strongest milestone for calling the initial product **beta-ready**. Passing the maintainer's local tests cannot substitute for it.

### G4 — Validate Agensi delivery and the listing promise

**Outcome:** the marketplace-delivered Skill can use the installed Bridge with all required instructions and references available.

- Confirm Agensi's current delivery of supporting references and dependencies, and the rights treatment of included ISC/MIT components.
- Build the submission from self-contained rendered first-party Skills; preserve necessary attribution and declare local Bridge/runtime/provider requirements.
- Jad approves any account, terms, upload, or submission action. Start with draft/test review where the platform supports it; do not assume a sandbox exists.
- Through the intended connector, verify Skill loading, required reference access, Bridge-tool discovery, route guidance, and the same reviewed integration workflow.
- Distinguish marketplace review/scan acceptance from actual workflow acceptance.
- Verify seller/payout eligibility if the listing will be paid, and keep compatibility claims limited to tested lanes.

**Exit evidence:** delivery test, listing contents/version, explicit platform review status, rights/prerequisite disclosures, and seller status as applicable.

The marketplace connector alone does not install or host the local Git/SQLite/CLI Bridge.

### G5 — Limited beta and release decision

**Outcome:** an honest supported offering, with measured real-user behavior and explicit remaining limits.

- Run a limited beta in the accepted platform/client lane, with consented tasks and observable reports.
- Record successful and failed tasks, retained work, cancellations, integration/recovery outcomes, elapsed time, and available usage/cost. Do not infer cost from missing counters.
- If parallel delegation is advertised, add a small approved real two-writer/disjoint-scope run and reviewed combined integration. Existing fake-agent concurrency coverage remains useful but is not a sustained provider-workload result.
- Expand client/platform promises only after each lane's actual acceptance. MacOS, Cursor desktop behavior, and Copilot are separately tracked items.
- Close confirmed blockers in advertised behavior; disclose unresolved limitations and assign owners.
- Jad authorizes publication/pricing only after reviewing the final artifact and listing evidence.

**Exit evidence:** release decision naming version/hash, supported scenarios, test receipts, known limits, support/update path, and publication owner.

## 5. Readiness labels

| Label | Required evidence |
| --- | --- |
| `LOCAL_RC_QUALIFIED` | G0–G2 accepted for one named platform/client/route; final source and artifact identities recorded. |
| `BETA_READY` | Independent G3 accepted for that artifact and support lane. |
| `AGENSI_READY` | G4 accepted, including actual delivery behavior and applicable seller requirements. |
| `LAUNCH_APPROVED` | G5 decision accepted by Jad with advertised scope and unresolved limits stated. |

These labels are distinct. An artifact can be beta-ready while marketplace delivery is still blocked.

## 6. Verification ownership and reuse

- One named executor owns each check/input state. One reviewer owns the associated source review.
- Existing receipts apply only to matching relevant source, tests, dependencies, runtime, configuration, and fixture inputs.
- A product change affecting release inputs invalidates applicable acceptance. A prose-only plan does not justify another full 182-command run.
- A fresh-machine trial deliberately tests a new environment and is not an unnecessary duplicate of local fixture tests.
- Keep raw failing/incomplete attempts and skips. Reconciled focused retries must not be called raw full-suite exit 0.
- Use native Node.js tests and relevant isolated integration/release checks for product-code work. TestSprite is optional and does not block local fixes; use it only when explicitly requested or suitable for a separate HTTP/web surface. Report real-client/provider and fresh-user acceptance separately from fixture results.

## 7. Local hardening update — October 18, 2026

Jad authorized starting fixes and explicitly removed mandatory TestSprite verification.

Completed in this round:

- Replaced the mandatory TestSprite block in `AGENTS.md` with native, isolated verification requirements. TestSprite setup/authentication/deployment no longer blocks Bridge fixes.
- Hardened `bin/live-smoke.js`: accept only explicit healthy status, reject MCP tool errors, and skip delegated work after failed health. A literal-response smoke must find the exact expected final answer, rather than a marker echoed in diagnostics. Reports now read the current `Actual model evidence` field.
- Corrected `bin/setup.js` prerequisite hints and README: the public Skill installer requires exactly OpenCode 1.18.32; legacy pure setup without `--skills` keeps its existing newer-version policy. No replacement provider/model was selected.
- Added isolated MCP-peer regression coverage in `tests/live-smoke.test.js`, wired it into `npm test` through `test:smoke`, and added version-policy cases to the platform suite.

Verification on Windows 11 / Node v24.11.1:

| Command | Observed result | Local evidence |
| --- | --- | --- |
| `node --test tests/live-smoke.test.js` | 3 test groups passed, 0 skips; fixtures isolate homes, state, Git configuration and credentials, with bounded child execution | Final direct CLI output; fake MCP peer only, no provider inference |
| `node bin/verify-isolated.js --node tests/platform-portability.test.js` | 4 tests passed, 0 skips | `.test-logs/packaging-1792322307696-26480/report.json` |
| `node bin/verify-isolated.js --node tests/review-setup-cli.js` | 39 checks passed, 0 skips | `.test-logs/packaging-1792322358884-20712/report.json` |
| `node bin/verify-isolated.js --node tests/skill-package.test.js` | 4 tests passed, 0 skips | `.test-logs/packaging-1792322358875-23816/report.json` |
| `node bin/verify-isolated.js --node bin/skill-package.js --check` | 26 Skills / 189 rendered files; integrity and managed links passed | `.test-logs/packaging-1792322358907-21088/report.json` |
| `git diff --check` | Passed | Local Git output |

Receipts describe their own recorded inputs; the final smoke test also includes subsequent test-only fixture isolation and timeout hardening. This round is focused local hardening, not full-suite/release acceptance. G0/G1 still require a selected, authorized live route and the real-client file/write/review/integration journey. Production CodeQL dispositions, independent fresh-user acceptance and marketplace delivery remain open.

### Follow-up: pinned file-reading smoke and command-boundary triage

- Added `--read-file` to `bin/live-smoke.js`. It requires an explicitly selected model, validates installed candidate pins using the existing shared validator, and rejects pin-dropping `--server` overrides. The file fact is random and absent from the task; the exact final answer and unchanged file/HEAD/Git status are required.
- Added `--require-pins` for health-only qualification. The actual Bridge accepts valid pins and refuses stale/missing pins in isolated startup controls.
- Preserved the explicitly unpinned legacy candidate override and literal-response mode, with distinct report labels. Neither is relabeled as file/writer/client acceptance.
- Inspected CodeQL alerts 167/168/169 and added real-child literal-argv coverage plus paired-percent NTFS path coverage. See [targeted security triage](AGENSI-SECURITY-TRIAGE-2026-10-18.md) for trust boundaries, evidence and unresolved dispositions.
- Follow-up checks passed with zero skips: 8 smoke groups, 11 pin/startup checks, 15 writable-scope/NTFS checks, 39 installer checks, 51 validation checks, plus the 2 native command-boundary tests. Exact commands and receipts are in the triage report.
- The main follow-up receipts name stable publish-input digest `46fc30a03d5b4e7e89f5e5310b19faafbec73413604347ecbf196d2192eec0b6` (401 files). These are focused Windows/Node24 results, not a new full-suite or release-gate result.

Jad selected local checks only for this round and deferred provider inference. Live inference and G0/G1 acceptance remain pending route/account/variant and workload authorization. The new reader harness is ready for that controlled experiment; the writer/reviewer/integration journey still requires execution from the selected real client.

## 8. English marketplace submission candidate

At Jad's request, prepared submission candidate `0.1.0-rc.1` with a root marketplace
SKILL.md, setup/mode/compatibility references, the full attributed delegate reference
library and reproducible ZIP tooling. The listing emphasizes flexible delegation modes.

The generated ZIP contains 200 files. Packaging tests passed 14/14 with no skips, and
Python independently validated the ZIP/CRC records. This is local packaging evidence;
G1/G3/G4 acceptance and final runtime release qualification remain separate.

See [submission results](AGENSI-SUBMISSION-RESULTS-2026-10-18.md),
[English listing copy](AGENSI-LISTING.md) and [packaging instructions](AGENSI-PACKAGING.md)
for exact paths, hashes, checks and remaining seller fields.

The later owner-authorized GitHub source update and its full-run/focused-repair evidence
are recorded in [publication verification](GITHUB-UPDATE-2026-10-18.md).

## Appendix A — Project facts snapshot for this plan

Checked October 18, 2026 from Git status, package scripts, README, CI, `.gitignore`, and the readiness report. Recheck before dispatch. No `.claude/brief-facts.md` was found; the dedicated private facts location awaits D5.

- Current checkout exists at `C:\Users\10User\bridge-combined-2026-10-17`, detached at `2f66a10`, with substantial pre-existing tracked/untracked changes. No implementation worktree has been prepared for this plan.
- Stack: Node ESM stdio MCP server, Zod validation, built-in SQLite, Git worktree isolation, managed OpenCode profiles. Execution/state/integration live in `lib/`; install/release/verification tools in `bin/`; first-party Skills in `skills/`.
- Node requirement is `>=22.13.0`; the current public Skill installer pins OpenCode 1.18.32. This round reconciled README and prerequisite hints with the distinct public-installer and legacy pure-profile policies.
- Personal/protected material: real `.env`/credential files, operator auth/account stores, real client configs, live Bridge SQLite state, and unrelated user work. Never open credential contents or copy profiles/auth into evidence. Normal CLI authentication is an operator action. No sealed evaluation dataset was identified in the inspected project metadata; follow any additional protection instructions found before opening data.
- Ignored local evidence/state: `.test-logs/`, `.release-gate/`, SQLite/DB files, `.env*`, generated output and mutation sandboxes. Keep private evidence there only after verifying ownership and any agreed location; keep documentation sanitized.
- Docs defining relevant boundaries: README; ONBOARDING; REFERENCE; DELEGATE-AUDIT; CROSS-PLATFORM; Skill coordination/verification references; readiness review.
- Initial live route/account/spend, tester, and implementation checkout are not selected. Do not claim they are available or configured.

| Purpose | Existing command | Conditions |
| --- | --- | --- |
| Package integrity | `node bin/skill-package.js --check` | Local source check. |
| Packaging suite | `npm run test:packaging` | Installed lockfile dependencies; isolated environment for fixture execution. |
| Installer fixture suite | `node bin/verify-isolated.js --node tests/review-setup-cli.js` | Disposable homes/state; can exceed three minutes. |
| Platform fixture suite | `node bin/verify-isolated.js --node tests/platform-portability.test.js` | Native current OS; injected branches are not proof of other native systems. |
| Focused validation/ownership/catalogue | `node bin/verify-isolated.js --node tests/isolated-runner-checks.js tests/review-day5-worker-release.js tests/review-validation-tree.js tests/review-tools-list-budget.js` | Choose relevant scopes after inspecting actual changes. |
| Isolated full suite | `node bin/verify-isolated.js --node tests/platform-suite.js` | Runs actual `npm test`; inspect every required skip. |
| Release acceptance | `node bin/release-gate.js --config <disposable-config> --receipt <evidence-receipt>` | Verify disposable paths first; includes full suite, concurrency, audit and health. |
| Dependency audit | `npm audit --omit=dev --json` | Read advisory output; not product-source security certification. |
| Whitespace | `git diff --check` | Does not prove functional behavior. |

No dedicated lint/typecheck script is configured in the inspected package. CI defines Windows/Linux/macOS × Node22.13/22.x/24.x and permits explicitly disclosed prerequisite skips. A configured matrix is not native passing evidence.

## Appendix B — First execution packet

The bounded G0/G1 handoff is [FIRST-USER-RC-BRIEF-2026-10-18.md](FIRST-USER-RC-BRIEF-2026-10-18.md). It is a draft, not dispatched. Confirm decisions, actual checkout state, route, budget, and check ownership before using it.
