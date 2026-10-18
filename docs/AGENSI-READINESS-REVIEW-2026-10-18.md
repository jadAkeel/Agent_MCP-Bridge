# Agent MCP Bridge Readiness Review for Agensi

**Review date:** October 18, 2026
**Historical review window:** September 18–October 18, 2026
**Status:** Complete within the coverage limits stated below.

## 1. Review question and deliverable

Is the project actually ready to be offered on Agensi as a Skill paired with an MCP server, given the changes made over the last month, the Claude-related improvements, and the review rounds through Day 6?

This report records the plan, reviewed versions and locations, findings, verification, evidence limits, and remaining readiness work. Local code is not treated as a published release, and historical tests are not represented as having been rerun today.

## 2. Plan — written before the assessment

1. **Identify the version and time window:** record HEAD and Git status; inspect the month's history; distinguish published source from local changes.
2. **Reconstruct the change history:** review Claude, quality, and Day 1–Day 6 reports; connect fixes to current code and tests; record missing evidence.
3. **Trace the user journey:** installation, Skill discovery, MCP connection, delegation, Scope Contracts, locks, Git worktrees, review, integration, and recovery.
4. **Assess distribution readiness:** Skill metadata and references, packaging, installer, licenses, client and platform support.
5. **Compare Agensi's current requirements:** read its creator, format, MCP, and terms pages; do not assume that Agensi's support for 20+ agents proves that the Bridge works with all of them.
6. **Verify locally:** inspect test tooling first; run relevant checks in disposable environments without new provider inference; record commands, results, failures, and skips.
7. **Conclude:** produce a readiness matrix, prioritized launch blockers with closure criteria, and a list of unverified claims.

## 3. Starting point and version identity

- Workspace: `C:\Users\10User\bridge-combined-2026-10-17`.
- HEAD: `2f66a10593513f6930dea1a901f361bad5172f7f`, dated October 14, with subject `fix(bridge): integrate accepted cumulative Day3-Day6 repairs [skip ci]`.
- Initial status: **detached HEAD**, with 36 tracked files modified and many untracked files. Local additions include `skills/`, `skill-package-manifest.json`, `bin/install.js`, and packaging and quality-round reports.
- `package.json`: package name `codex-opencode-mcp`, version `1.0.0`, `private: true`, Node `>=22.13.0`.
- `gh repo view` confirmed that the GitHub repository is **PUBLIC**, its default branch is `main`, and its license is ISC. `private` in `package.json` concerns npm publication, not GitHub repository visibility.
- GitHub API confirmed public `main` is still at this HEAD; the latest observed push was October 14. Day 6 fixes are published, while the newer local additions are not part of this commit.
- `gh release list` returned no releases. `npm view codex-opencode-mcp name version dist.tarball --json` returned `E404`: no public package by this name was available at review time.

### Verified source digest

The current `bin/verify-isolated.js` measured the following before and after the checks:

```text
fileCount: 399
treeSha256: 08b45d4b79dfde3048666fdacf6a0792c4aae5c0be3e7bb949bbba7e81727387
```

This digest matches the successful release gate for the combined candidate on October 17. The release file set includes the server, package and lockfile, `bin/`, `lib/`, tests, Skills, vendor files, selected documentation, and runtime files. **It is not a digest of every repository file**; I do not use it to claim that README, CI, or all documents were unchanged.

The earlier round also records a broader 468-file freeze with SHA-256 `615a38f564d76505f8613685a860356aebdab1bbbec76c72a6465b0cbee78d9d`. I did not recompute that entire 468-file set today; the new independent comparison covers the 399-file set.

## 4. Executive verdict

**Yes, the project is a strong fit for Agensi's concept, and much of the required Skill layer already exists. However, it is not yet a public paid product ready for a promise such as “install it and it works immediately across all agents.”**

Recommendation: treat it as a **Release Candidate for a limited developer beta** and close the operational, distribution, and marketplace-acceptance gaps before a general launch. There is no need to rebuild the Bridge or redo accepted Day 6 fixes.

Reasons:

1. The project already has first-party Skills: `bridge-plan`, `bridge-execute`, and `bridge-learn`. Creating a `SKILL.md` from scratch is not the remaining task.
2. The combined candidate has strong evidence: full suites on Windows Node 22 and 24, a five-step release gate, and a source digest matching what I measured today.
3. The newest packaging and quality improvements remain local; people downloading current `main` will not receive everything assessed here.
4. The default model route needs requalification. The latest follow-up recorded `Model not found` for the Muse route used by the managed agents. The successful smoke used explicitly authorized GLM and performed only a literal text-response task.
5. Agensi's current terms say Skills are delivered through its agent connection and are not saved locally. Compatibility with local references and a Bridge MCP installed on the user's machine has not been demonstrated.
6. There is no second-developer fresh-machine trial, nor a complete real-client journey for the current candidate from installation through writing, review, and integration.
7. An open CodeQL backlog remains untriaged. A clean dependency audit does not close it; the alert count alone does not prove vulnerabilities.

## 5. Evidence sources and attribution limits

Path abbreviations used below:

| Label | Path |
| --- | --- |
| **R** | `C:/Users/10User/bridge-reports/review-roadmap` |
| **I** | `C:/Users/10User/bridge-reports/ai-review-2026-10-16/implementation` |
| **T** | `.test-logs/` in the current workspace |

Reports outside the repository are local historical files and may not be available to someone downloading the project. Recording their results here does not make them published evidence.

`R/ROADMAP.md:3–5` names Claude and Jad as integrators for the review plan. I also reviewed `claude/CLAUDE.md`, the history of Claude support, and fixes to Claude configuration sync. Git authors in the period are two user names; that does not identify which model authored each commit. Later reports attribute specific work to Codex, OpenCode, GLM, and Muse. **I do not attribute every improvement this month to Claude without evidence that establishes that attribution.**

## 6. What changed over the last month?

The available Git history in the requested window starts on September 22 and ends on October 14; later work is recorded in local changes and October 16–17 reports. `git shortlog` counted 331 commits, including merges, documentation, and tests; this is not a count of features or defects.

| Period | Verified developments | Evidence reviewed | Readiness impact |
| --- | --- | --- | --- |
| Sep 22–25 | Daily-use reliability; preserving dirty retained worktrees; lower delegation overhead; Claude Code client support; distinction between a delegate Skill and the Bridge | Commits `3d18923`, `38c87fa`, `5f82472`, `56cb89b`, `9881405`; README and Claude rules | Evolved from a launcher into a multi-client delegation system with integration controls. |
| Sep 28–30 | Long-run hardening and migration/review fixes; byte-oriented patches; rollback/recovery and Git control-surface safeguards; explicit pipeline verdict; receipts and batch integration | `fe43942`, `2099723`, `43c3608`, `994daa3`, `4dedea0`; review-round commits; current integration/finalizer samples | Stronger protection of files and evidence, with more behavior requiring verification. |
| Oct 1–5 | Unified setup; portable releases; logs/faults; flexible scheduling, pauses, and retries; unattended worker; external runners; server split into `lib/`; worktree continuation | `d9b7337`, `ac76420`, `6f3a15b`, `e46e655`, `64d8a8c`, `74516b5`, `f112386`, `977687a` | Better onboarding, operations, and recovery. |
| Oct 7–11 | Windows/setup/lease fixes; caching and attestation; compact MCP results and tools/list; more isolated/faster checks; credential protection in fixtures | `da1d1e7`, `413b0ae`, `4785ffa`, `fc6254b`; `log.md:116–181`; archived deep review | Less setup and context waste. Historical measurements are not new performance measurements from this review. |
| Day 1/2 and fix rounds, Oct 11–12 | Cancellation; reduced DB/hash/snapshot work; bounded, honest results; parallel path unified with the single-job executor; queue ownership/recovery; provider wait budgets | `R/LEDGER.md`; `log.md:17–123`; `1fefcb7`, `62bb119`, `91f68a4`, `0aa0e05`, `5b4f789`, `d7e0d72`, `bd5a655`, `8ccec86` | Substantive correctness/performance repairs; cumulative acceptance followed later in Day 6. |
| Day 3 | Git index batching; decoding quoted preview paths; avoiding persistence without changes; snapshot reuse; bounded diagnostics | `R/day-3/FINAL.md`; historical 31/31 targeted commands | Better fidelity and less repeated work; this was not a standalone full-gate pass. |
| Day 4 | Retry/backfill recovery; protection of late GC content; release-binding changes; stopping dispatch when containment is unconfirmed; named skip receipts | `R/day-4/FINAL.md`; six repairs and historical 39/39 targeted commands | Better recovery and more truthful verification/release receipts. |
| Day 5 | Serial bracket scopes; validation parser/trust; avoiding retention of capability tokens; finalizer quarantine; atomic key publication; worker ownership; retry intent | `R/day-5/FINDINGS.md`, superseded dispositions in `R/day-6/FINDINGS.md:90–98` | Cross-cutting concurrency, recovery, and security fixes. Some old progress labels were superseded by later acceptance. |
| Day 6 and Oct 14 | Duplication/dead-code review; week-wide consolidation; cleanup and Claude-sync fixes; publication of the accepted source | `R/day-6/{REPORT,FINDINGS}.md`, `publish-main-result.json`, commit `2f66a10` | Accepted basis for a limited private Windows alpha, not a general commercial-launch verdict. |
| Local work, Oct 14–17 | Skills, Light, installer and rollback transactions; optional Cursor/Pi; property/mutation testing; supervisor launch authority; Windows/POSIX ownership; combined quality rounds and dependency updates | Packaging/quality docs; AI review; `I/RESULTS.md` and receipts | The largest recent increase in packaging readiness; not published to current `main`. |

**Interpretation:** A large number of changes does not, by itself, prove instability. The evidence shows failures being found and repaired, with negative controls and broader gates added. It does make version identity, source digests, and evidence provenance essential; “the tests passed before” without identifying the source is insufficient.

## 7. What exactly happened in Day 6?

### Accepted fixes

- **D6-C3-001:** Pipeline cleanup did not pass the recorded branch tip to the shared guard. Current code passes `expectedBranchOid: source.sourceHead`; see `lib/pipelines/finalize.js:255–281`.
- **D6-C3-002:** An unescaped dot in executable-extension matching caused near-matches such as `gitxexe` to be treated like Git on the plain runner. Current code strips extensions with `/\.(exe|cmd|bat|ps1)$/i` and then compares the full executable name; see `lib/validation-command.js:416–419`. I ran these regressions today as part of 13/13 validation-tree checks.
- **WW-A2-001:** Auto-integration cleanup paths could bypass original source identity, continuation ownership, and reviewed-tip checks. Cumulative acceptance added guards; I reviewed the current path in `lib/integration-cleanup.js:37–175`.
- **WW-A3-001:** Claude sync could lose Claude-specific fields when building a desired entry without the current entry. Day 6 reports record acceptance; current setup tests check preservation of unrelated fields/settings.
- The round also corrected fixtures, evidence formatting, and test scheduling. Reports preserve earlier failures and then record a new complete run; they do not combine partial successes into a claimed full pass.

### What the gate established

I read the header of `R/day-6/verification/whole-week-npm-final-04/full-report.json`: **181/181 commands, 0 failed**, from 06:26 to 07:06 UTC on October 14, about 40.40 minutes. Skip accounting: 4 optional skips, 2 optional partial cases, 0 required skips.

The verdict in `R/day-6/REPORT.md` is **“limited, supervised private alpha with known Windows users.”** It did not establish a fresh user, sustained provider workload, POSIX behavior, or public-release readiness.

The report was written before publication and says `main` had not changed at that time. The later `publish-main-result.json` and current GitHub API establish publication as `2f66a10`, with 284 matching files; tests were not rerun at publication at the user's request. Therefore “Day 6 is unpublished” is no longer true.

### Remaining Day 6 boundaries

- `L-1-F2-8`: minor remaining duplication in usage/hash presentation; partially addressed polish, not a demonstrated blocker.
- `L-2-F7-4`: caller delay/slot-release behavior was fixed, but termination of a metadata/attestation subprocess midway through a read was not fully wired; real CLI behavior on that path remained unverified.
- Some Day 3 hypotheses remained deferred or unproven; they were not promoted to confirmed defects and did not receive speculative fixes.
- I found no accepted C4 workload result for the current source, nor a new benchmark establishing general financial savings or speedup.

## 8. Current end-to-end user journey

| Stage | Source/evidence reviewed | What is established and its limits |
| --- | --- | --- |
| Obtain the software | README, package metadata, GitHub/npm | GitHub is public; the newest installer/Skills are local; no public Release or npm package was found. |
| Install | `bin/install.js`, relevant `setup.js` and `setup-transaction.js` paths, setup regressions | Lockfile bootstrap without a shell; preview/approval; file ownership, backups, journal, and rollback. Passed 39/39 today in disposable environments, not on another developer's machine. |
| Discover Skills | Three Skills, renderer, references | Metadata and plan/execute/learn separation; renderer produces standalone folders. No native model discovery/adherence test. |
| Connect MCP | Tool modules, catalogue tests, generated Cursor handshake | Real SDK stdio connection; 28 tools; 31,252 bytes under the 33,000-byte cap. Does not establish desktop approvals/cancellation. |
| Select execution route | Skills, `lib/light-mode.js`, DELEGATE-AUDIT | Direct for tiny tasks; Light through the same executor; Parallel for independent work. Light refuses orchestration/fallback/auto-integration and some runners. |
| Admission and ownership | `execute-job.js:530–814`, `tools/parallel.js:28–193` | Locks/heartbeat, then a worktree or retained-worktree claim, then attestation and ownership before spawn; parallel uses the single executor. |
| Execute | Executor, supervisor changes, slot/validation reports | Provider authorization, wait limits, process supervision. The Bridge is a coordination boundary, not a complete OS sandbox. |
| Check results | `execute-job.js:920–1129`, validation trust/gate | Snapshots, HEAD, Git control, scope checks; validation mutations are rejected before a fix pass; unconfirmed containment retains protection. A whitespace check does not prove feature correctness. |
| Review | Skills and result caps | A worker's report is not acceptance; the coordinator reviews source, changes, and tests, with documented full/compact result limits. |
| Integrate | Integration contract/preview and apply paths | Receipt bound to patch/contract/source/target, HMAC-protected and durably single-use. It proves identity and declared review, not correctness. |
| Recover/clean up | Cleanup, pipeline verdict/cleanup, worker ownership | Durable state, retries/quarantine, and source checks. No promise to discover every descendant or tolerate every power-loss/full-disk failure. |
| Operate/diagnose | Logs, diagnostics, receipts | Faults distinguished from job failures; redaction and unknown-resolution status; current diagnostics test passed 1/1. |

The Skill's value is teaching an agent **when to delegate, how to bound the task, how to preserve evidence, and when to integrate**. The instruction file alone does not install Bridge MCP, Git, OpenCode, or provider access on a buyer's machine.

## 9. Skills, packaging, and licenses

### What already exists

- `skills/bridge-plan/SKILL.md`: choose Direct/Light/Parallel/Queue; dependencies; file/resource ownership; task and verification contracts.
- `skills/bridge-execute/SKILL.md`: execute an approved plan; monitor/recover; inspect source; receipt-bound integration; reuse valid checks.
- `skills/bridge-learn/SKILL.md`: evidence-based retrospective and reviewed proposed corrections, without automatic self-editing of personal Skills.
- `skills/references/{contracts,coordination,diagnostics,verification}.md`: shared source rendered into standalone folders. I read coordination and verification; links for other references were mechanically checked, but I did not read every line of every reference.
- Protected guides: `bridge-delegate-opencode`, `bridge-delegate-codex`, and `bridge-delegate-pi` under vendor.
- 18 original independent delegates and 2 optional helpers from pinned MIT upstream; these are not 18 new Bridge worker types and do not prove support for 18 MCP clients.
- `node bin/skill-package.js --check`: **26 Skills and 189 rendered files; integrity and managed links passed**.
- Manifest version 1.2.0, original Skills metadata version 1.0.0, package version 1.0.0. These are distinct version layers, but a public product needs a clear mapping and changelog.

### Why archiving a source folder is not enough

For example, `bridge-plan/SKILL.md:16` links to `../references/coordination.md`. The renderer in `bin/skill-package.js:62–86` rewrites this to `references/` inside the standalone folder and adds the required files. Zipping the source folder alone can omit references. The current CLI offers check/list/write-manifest, but no Agensi-ready ZIP export command. The needed artifact should come from rendered output and then be tested for reference loading on the platform.

### Ownership and licensing

- The ISC `LICENSE` permits use, modification, and distribution with or without fee, provided copyright/notice remain; it does not prohibit selling.
- Vendored delegates are MIT, with Ahmed Mohammed's copyright and pinned source. Tests check that LICENSE/NOTICE are preserved.
- Agensi's policy requires original work or distribution rights and says repackaged free Skills may be rejected. MIT licensing alone does not guarantee acceptance of a repackaged product.
- The listing should represent the Bridge's original orchestration workflow, with upstream material disclosed, rather than presenting 18 free delegates as original project work.
- Agensi's terms prohibit saving/copying/exporting purchased Skills, while the open-source licenses grant broader rights. How this applies to ISC/MIT components in a specific upload has not been resolved; clarify rights/exceptions with Agensi. Do not infer automatic cancellation of open-source licenses.

## 10. Agensi's current requirements

I used Agensi's official pages as read on October 18, 2026, especially Terms updated October 12. Google search was used for discovery; the findings below come from the original pages.

| Topic | Official-page statement | Implication |
| --- | --- | --- |
| Submission | ZIP containing a valid SKILL.md with `name`/`description`; supporting files are optional | Prepare a complete rendered artifact, not an arbitrary repository ZIP or folder with external references. |
| Review | 8-point scan and review; checks structure, commands, secrets, environment/network, obfuscation, prompt injection | Scanner/review acceptance is untested; passing npm tests does not imply marketplace acceptance. |
| Delivery | Terms 5.2: delivered through the Agensi agent connection, without saving Skill files locally | The local renderer does not prove references will arrive through `get_skill`; connector support-file behavior is unverified. |
| Runtime/MCP | Marketplace distributes Skills; our Bridge is local stdio and uses Git/SQLite/CLIs | Connecting Agensi MCP does not register or launch Bridge MCP. Disclose local requirements and provider setup. |
| 20+ agents | Platform/format compatibility | Does not prove Copilot or every client can run the Bridge tools and approval flow. |
| Listing/revenue | Free listing; 70% of net sale price excluding VAT/sales tax, 30% platform share; refunds reverse creator share | The email's central revenue claim matches the site; it is not an income guarantee, and tax is not part of the 70% calculation. |
| Exclusivity | Terms 8.1: non-exclusive distribution license; creator retains ownership | Consistent with the email. |
| Paid sales | Payout method enabled through Stripe Connect or Zoneless; verification/KYC applies | Seller eligibility and account/country availability were not checked. |

Sources: [Agensi home](https://agensi.io/), [Sell](https://agensi.io/sell), [Terms](https://agensi.io/terms), [MCP and advertised tools](https://agensi.io/mcp), [MCP setup](https://agensi.io/docs/mcp-setup), [Skill format](https://agensi.io/learn/skill-md-format-reference), [Creator guides](https://agensi.io/learn/for-creators).

I did not verify the claimed 65,000 monthly visitors, Joeri Brons's identity, or his authority, and did not use those claims as readiness evidence. GitHub stars are not a readiness criterion either.

## 11. Verification performed today

Environment: Windows 11 x64, build 26200, Node v24.11.1. I used `verify-isolated` with disposable homes/configs/state and no provider inference. The setup test ran real npm bootstrap in a temporary package with fake client/provider CLIs. I did not run setup against the user's actual configuration.

Each successful receipt below records `exitCode: 0` and `stableInputs: true` with the 399-file digest above. Case/check counts are counts within the files; they are not the full runner's canonical-command count.

| Command | New result | Receipt under T |
| --- | --- | --- |
| `node bin/skill-package.js --check` | 26 Skills, 189 rendered files; passed | Command stdout; read-only package check |
| `node bin/verify-isolated.js --node tests/skill-package.test.js` | 4/4, 0 skips | `packaging-1792317043067-10656/report.json` |
| `node bin/verify-isolated.js --node tests/review-setup-cli.js` | 39/39, 0 skips; completed in about 185.096s | `packaging-1792317401747-4080/report.json` |
| `node bin/verify-isolated.js --node tests/isolated-runner-checks.js tests/review-day5-worker-release.js tests/review-validation-tree.js tests/review-tools-list-budget.js` | 73/73 ownership, 13/13 validation, 13/13 catalogue; 0 skips | `packaging-1792317070406-24672/report.json` |
| `node bin/verify-isolated.js --node tests/platform-portability.test.js` | 3/3, 0 skips; native Windows with injected platform branches for other OSes | `packaging-1792317401737-2432/report.json` |
| `node bin/verify-isolated.js --node tests/orchestration-diagnostics.test.js` | 1/1, 0 skips | `packaging-1792317401742-8/report.json` |
| `node bin/verify-isolated.js --node tests/install-choices.test.js` | 4/4, 0 skips | `packaging-1792317401749-9132/report.json` |
| `npm audit --omit=dev --json` | exit 0; 0 reported vulnerabilities | JSON stdout; advisory database at check time |
| `npm view codex-opencode-mcp name version dist.tarball --json` | E404; intentional negative availability check, not a code-test failure | JSON stdout |

New successful total: **150 checks/cases across 8 files**. This does not include a new full suite, mutation rerun, or provider workload.

**Incomplete attempt preserved:** the first setup run printed 39 successful checks, but the shell-tool timeout ended after 180s before a final receipt: `T/packaging-1792317070397-17600/output.log`. I did not count it as a pass. A process check found no owned test processes remaining before retry. Earlier logs showed setup can take several minutes; I reran with a longer tool timeout, producing exit 0 and a final receipt. Test timeouts and code were not changed; no root cause is established that would make the first attempt a product defect.

I did not rerun full npm/release gates: matching completed receipts existed for this source identity, and I ran focused checks relevant to the question. This review's changes are docs-only, so the repository's TestSprite rule's docs-only exception applies.

## 12. Prior evidence reviewed, not rerun

| Evidence | Files read | Bounded conclusion |
| --- | --- | --- |
| Windows Node 22 full | `I/full22-resumed.receipt.json`, `T/packaging-1792222479230-17616/report.json`, reconciliation | 182/182, exit 0, matching digest; 4 optional whole skips, 2 partial, 0 required. |
| Windows Node 24 release | `I/full24-resumed.receipt.json`, `I/RELEASE-RECEIPT.resumed.json` | All 5 steps passed: deps, full npm, concurrency 32/32, audit, health smoke; matching source. |
| Full runner | Header of `T/report.json`, `I/RECONCILED-full22-resumed-full24-resumed.json` | Reports reconcile 364 command logs across Node 22/24; I did not re-analyze every raw log from scratch. |
| Linux Node 22 | `I/linux-full22.wrapper-report.json`, `I/RESULTS.md` | Earlier full 182/182 on native Linux binaries in WSL2, digest `17cb...` before final test-only stabilization. Reconciliation reports production bytes match; amended test passed later in isolation. Not a new final full run. |
| Linux Node 24 | `I/remaining/RESULTS.md` | Raw 181/182, exit 1 due to fixture without Git HEAD; B-037 passed 10/10 after correcting fixture history, and 182 logs were reconciled. Not a raw full green run. |
| Real GLM smoke | `I/remaining/glm-smoke-receipt.json` in full | Initialize/health then literal `LIVE_SMOKE_OK`; no repository tool use, write, or integration. `--server` removed pins from the child; runtime-observed model identity was absent. |
| Property/mutation | `docs/QUALITY-ROUND-RESULTS.md`, `I/RESULTS.md` | 73 property cases; retry: 194 mutants, 150 killed/42 survived/2 timeout; locks: 240, 168/71/1; leases: 132, 118/14/0. I did not recompute mutant identities; these measure test sensitivity, not product-bug counts. |

### Reconciling older documents with newer evidence

- `QUALITY-ROUND-RESULTS.md` mentions dependency advisories and pending Windows ownership review. The later AI review, combined-candidate acceptance, release receipt, and current audit are newer; I do not treat those old notes as continuing blockers solely because the text remains.
- `PLATFORM-VERIFICATION.md` records Windows 180/181 and incomplete Linux checks for an older packaging candidate; newer combined-candidate evidence is listed above.
- README says Linux/macOS were not tested. This omits later Linux evidence; macOS remains unverified.
- Day 5 progress labels were superseded by Day 6 acceptance of R01–R08, including R03/R06.
- `claude/CLAUDE.md:3` still says `Gemini-backed` despite current default profiles; its commit instruction for dependencies at line 28 also needs alignment with current delegation/approval rules before using the file as public guidance.

The practical need is one current evidence matrix, not to call every historical report wrong at the time it was written.

## 13. GitHub CI and CodeQL

- `gh run list` showed a successful CodeQL Setup on `2f66a10` and four older CI runs failing between October 7–10. Inspection of run `38051217109` established failure in `npm test`; I did not diagnose every old raw failure.
- Day 6 publication used `[skip ci]` at the user's request. CodeQL success is not CI test success, and no successful matrix run was observed for the unpublished local additions.
- The local workflow defines 9 combinations: three operating systems × three Node versions. A definition is not an executed successful run. It also sets `CODEX_TEST_ALLOW_REQUIRED_SKIPS=1`; even a green matrix needs its skip ledger inspected.
- GitHub API currently returns CodeQL default setup `state:not-configured` and `schedule:null`. I did not change this setting.
- A paginated query of open alerts returned **271 alerts**: 261 high, 7 critical, 3 medium under the rule severity classifications; 107 are under `tests/`.
- Critical alerts 172/171/170/162 are under tests; 169 is at `lib/writable-scope.js:58`, 168 at `lib/run-command.js:43`, and 167 at `bin/process-supervisor.js:694`, against GitHub source at `2f66a10`. **These alerts are not established vulnerabilities, and the 271 alerts are not 271 confirmed defects.** I did not perform a complete source-to-sink triage here.
- The clean `npm audit` result concerns dependency advisories in the current dependency graph; it does not establish the absence of product-code risks or close CodeQL.

Links: [CI run](https://github.com/jadAkeel/Agent_MCP-Bridge/actions/runs/38051217109), [CodeQL run](https://github.com/jadAkeel/Agent_MCP-Bridge/actions/runs/38594836489), [alert 167](https://github.com/jadAkeel/Agent_MCP-Bridge/security/code-scanning/167), [168](https://github.com/jadAkeel/Agent_MCP-Bridge/security/code-scanning/168), [169](https://github.com/jadAkeel/Agent_MCP-Bridge/security/code-scanning/169). Security pages may require repository-owner access.

## 14. Readiness matrix

| Area | Status | Rationale |
| --- | --- | --- |
| Product value | Strong fit | Bounded delegation and reviewed integration are useful; the Skill explains when to use them. |
| Core offline correctness | Strong local evidence | Full suites on Node 22/24, release/concurrency and race/recovery tests with fake agents; this does not prove absence of bugs. |
| Skills and packaging | Technically ready locally | Metadata, references, manifest, and new successful checks. |
| Installer transaction | Suitable for an RC | 39/39 today; both journal/rollback fixes exist and are tested. |
| Fresh-machine onboarding | Unverified | Disposable fixtures and fake CLIs are not another developer's machine. |
| Default model/provider | Needs requalification | Latest follow-up recorded Muse model-not-found; health does not prove availability. |
| Windows | Strongest beta path | Multiple evidence sources; a fresh-user and real-client write journey remain. |
| Linux | Partially established with substantial evidence | Native binaries on WSL2, earlier full Node 22 and reconciled Node 24; not every Linux distribution/desktop. |
| macOS | Unverified | No native acceptance for the current candidate. |
| Codex/Claude Code | Integration designed and historically used | Current candidate needs fresh real-client acceptance; setup/stdio/fakes do not cover that. |
| Cursor | Configuration/SDK established | Desktop behavior is unverified; release activation does not sync it automatically. |
| Copilot and other 20+ agents | Not established as Bridge clients | Platform-format compatibility and a `copilot-delegate` Skill are not MCP client acceptance. |
| Pi worker | Optional with explicit boundaries | Denied by default; explicit unsandboxed-worktree acceptance; builder/debugger file edits only; no Light; no native provider alpha here. |
| Agensi artifact/connector | Unverified | No upload, scan, loaded-reference, or dependency test. |
| Public release with newest improvements | Not available in inspected evidence | `main` is older; candidate is local; no Release found; npm E404. |
| Paid marketplace acceptance | Unverified | Component rights, payout, marketplace review, and compatibility claims need closure. |

## 15. Launch blockers and closure criteria

These are launch decision priorities; they are not all security bugs.

### P1 — Before promising a new user a working product

1. **Default provider:** choose an available route with owner approval, or make model configuration explicit. Prove file reading, a bounded writer, then review/integration from the target client with intended pins. Evidence: `opencode/agents/*.md` and `I/remaining/RESULTS.md:24–26`. The Muse failure is historical and external; I did not run new inference today and do not claim that route is unavailable for every account.
2. **Obtainable release:** preserve the accepted combined source in Git; define and publish a versioned tag/artifact with authorization. Verify that the downloaded artifact is the tested source and installs from a fresh directory. npm is not required if a clear GitHub Release/ZIP route is chosen; an `npx` promise under an unpublished name is incorrect.
3. **Agensi compatibility:** submit a rendered Skill artifact with Bridge requirements; resolve reference loading and how the local MCP is obtained; prove an Agensi connector session completes the advertised workflow. The local renderer alone does not close this item.
4. **Independent onboarding:** a second developer on a clean Windows machine follows the guide, installation, and provider/client flow, including reinstall and rollback in a test environment. Owner: Jad/volunteer to be selected; not performed here.
5. **CodeQL triage:** review source-to-sink paths for higher-risk production spawn/path/validation alerts; record false positives and fix supported issues before making broad security-focused commercial claims. Deleting alerts or assuming every spawn is safe because it uses `shell:false` is insufficient.

### P2 — Align the product surface and support claims

6. **Support matrix:** launch with paths that have actual acceptance evidence; label Cursor/macOS/Copilot experimental/unverified until tested. If they are promised at launch, their tests become launch requirements.
7. **Current documentation:** reconcile Linux status, superseded quality/advisory notes, Claude guidance, test-duration claims, and version requirements. The public installer requires exactly OpenCode 1.18.32 when `packageSkills` is enabled, while legacy pure setup accepts newer versions; document the distinction.
8. **Cursor update path:** `docs/CURSOR.md:125–136` says `release:activate/--sync-clients` does not update Cursor. Document and test a working update process, or implement it in a later task.
9. **Commercial bundle boundaries:** distinguish original work, MIT-vendored material, and independent routes; clarify open-source component rights with Agensi; enable payout before paid launch. Do not promise that 18 independent delegates inherit Bridge protection.

## 16. What I could not establish

| Open question | Review limit | Evidence needed |
| --- | --- | --- |
| Are all 331 commits defect-free? | Reviewed history, themes, dispositions, and samples; not a line-by-line audit of the month | Focused audit of a specified flow/version if needed. |
| Does the default model work today? | Last failure is historical; no new inference or credential inspection | Authorized smoke on the approved default route. |
| Does the GLM smoke prove pinned production startup? | Candidate override removed pins; literal reply did not read the repository | Start from a pinned artifact and exercise real file tasks. |
| Are Skills discovered and followed by models? | Source-reviewed scenario table and mechanical tests | Trigger/adherence tests on real Codex/Claude/Cursor clients, including tiny work and scope/refusal/review behavior. |
| Does Agensi deliver supporting files? | Public pages only; no upload/dashboard/authenticated session | Connector experiment and technical confirmation from Agensi. |
| Are CodeQL alerts exploitable? | Counted and located critical alerts; no full triage | Documented taint-path review without presuming all are true/false positives. |
| Is Linux final full raw exit 0? | Node 24 evidence includes a focused retry; Node 22 full predates test-only delta | Full run on the chosen release if that claim is required. |
| Are macOS/Copilot ready? | No native acceptance inspected | Native runner/device and actual client. |
| Are power loss/full disk/hostile filesystem covered? | Specific test cases exist; Bridge is not an OS sandbox | Bounded fault campaign if the product promise includes these conditions. |
| Is a large workload stable and inexpensive? | No measured C4 acceptance for current source | Realistic batch with jobs/failures/latency/cost measured. |
| Is paid listing/payout accepted and available? | No terms acceptance, account/payment setup, or email/traffic verification | Owner review with Agensi, listing acceptance, and payout eligibility. |

## 17. Review inventory: what and where

- **Git and metadata:** status, diff stat, log/first-parent, monthly shortlog; commit `2f66a10`; GitHub main/visibility/license/releases/runs; npm availability/audit; CodeQL setup/alerts.
- **Current docs:** README, `package.json`, `.gitignore`, CI; ONBOARDING prerequisites/runtime sections; CROSS-PLATFORM, CURSOR, PLATFORM-VERIFICATION, DELEGATE-AUDIT, SKILL-PACKAGING-LEDGER, SKILL-SCENARIOS, QUALITY-ROUND-RESULTS, RELIABILITY-COVERAGE; Claude rules; `log.md:1–186` and archived deep-review matches.
- **Focused source review:** `bin/install.js`, `bin/skill-package.js`, `bin/verify-isolated.js`, `bin/setup-transaction.js`; setup preflight/transaction sections; supervisor diff; `lib/light-mode.js`; worker-files helper/anchor and diff; executor admission/post-run; parallel executor/audit; integration contract/preview/cleanup; validation runner/gate; pipeline verdict/source cleanup.
- **Skills/licenses:** three SKILL.md files; coordination/verification; integrity manifest and renderer; vendor NOTICE and ISC. MIT preservation/upstream files were mechanically checked. I did not security-certify all 18 relays.
- **Tests:** packaging/platform/diagnostics test source, setup fault cases, Pi fake-harness header; ran 8 test files; reviewed selected receipts, full-report headers, and reconciliations, not every historical raw log.
- **Reports:** `R/ROADMAP.md`, `LEDGER.md`, Day 3/4 FINAL, Day 5 FINDINGS, Day 6 REPORT/FINDINGS, full report and publish receipt; original AI review; then `I/RESULTS.md`, `I/remaining/RESULTS.md`, and release/full/smoke receipts.
- **Web:** Agensi home/sell/terms/format/MCP/setup/creator index and GitHub API. Used the dedicated browser, not the personal browser.

## 18. Recommended next steps

1. Define a narrow product: **Bridge Orchestration Skill for developers that requires local Bridge MCP**, with an explicit support matrix.
2. Close the default route and highest-risk triage; select a release candidate from the evidenced combined source.
3. Prepare the rendered Agensi artifact and resolve delivery, references, and Bridge connection.
4. Run an independent install and read/write/review/integration trial on one named client, then a second if it will be advertised.
5. Update docs and version mapping; run affected gates when inputs change and reuse still-valid evidence.
6. After acceptance, the owner publishes the release/listing with evidence-backed support limits. Passing Agensi's scanner alone does not prove model adherence or core correctness.

## 19. Practical reply to the email

It would be accurate to tell Agensi that the project already has a Skill-based orchestration layer and installer, and that recent coordination, recovery, and integration changes have been tested extensively. The newest version is still a local Release Candidate and needs default-runtime qualification and an Agensi delivery-compatibility check before committing to a launch date.

**Recommendation:** continue the opportunity and prepare a limited, evidence-backed listing, while keeping a public paid launch conditional on the criteria in section 15. The evidence does not justify throwing the project away or starting over; it also does not justify promising “ready across 20+ clients” today.

---

This review was completed on October 18, 2026. The intended repository change is this report only; verification receipts are under `.test-logs/`. No product fixes, publication, or changes to real client settings were made during this review.
