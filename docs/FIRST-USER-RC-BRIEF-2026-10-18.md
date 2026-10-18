# First-User RC Qualification — Draft Execution Brief

Status: Awaiting Jad's decisions; not dispatched. Scope: launch-plan G0/G1 only.

<context>
Project: Agent MCP Bridge, Node ESM stdio MCP server with SQLite and Git worktrees.
Existing source: C:\Users\10User\bridge-combined-2026-10-17, detached HEAD 2f66a10.
The checkout contains substantial pre-existing combined-candidate changes; it is not clean.
No separate implementation checkout or live-client fixture has been prepared for this packet.
Read AGENSI-READINESS-REVIEW-2026-10-18.md and AGENSI-LAUNCH-PLAN-2026-10-18.md, including Appendix A.
Read relevant README/ONBOARDING/REFERENCE and Skill coordination/verification rules.
Verify source ownership and prepare an approved candidate checkout before editing.
Other user work exists; its process ownership and branches have not been established.
</context>

<outcome>
Prove an approved provider route can complete a real file-based Bridge workflow from a named
client, with enforced startup pins, protected writer isolation, reviewed receipt-bound apply,
and actual behavioral checks. Repair only confirmed blockers to that outcome under approval.
Windows 11 + Claude Code first lane: assumed, pending Jad.
Managed OpenCode route/account/variant and live spend/time limit: unselected, pending Jad.
Initial live jobs: one reader, one bounded writer, one reviewer; assumed, pending Jad.
Implementation checkout, check owners and private facts location: unselected, pending Jad.
</outcome>

<invariants>
- Preserve existing work and explicit user authorization on every execution route.
- Keep provider/model/effort selection explicit; no silent fallback, account rotation or policy broadening.
- Installation acceptance must not imply provider readiness or authorize inference implicitly.
- Retain managed profile attestation, locks, writer worktrees and scope enforcement.
- Use the normal pin-enforcing startup path; do not use an override that removes expected pins.
- Integration requires the exact reviewed patch/contract receipt; preserve unrelated changes.
- Cancellation/containment uncertainty retains quarantine and recovery evidence.
- Worker reports, health and whitespace checks are not functional acceptance.
</invariants>

<acceptance>
1. Record the actual candidate source/config/artifact inputs and approved client/runtime versions.
2. Missing prerequisites/auth/route produce actionable outcomes, preserving unrelated configuration.
3. Valid installed pins allow startup; a controlled wrong-pin case refuses before delegated work.
4. A real reader extracts a known fact from a fixture file; no literal-response-only substitute.
5. A bounded writer changes behavior only within the contracted managed worktree; target stays unchanged.
6. Review inspects actual output; a meaningful behavioral test passes, separately from whitespace checks.
7. Preview then exact-receipt apply integrates only the reviewed change and passes final behavior checks.
8. Stale receipt/scope/cancellation controls retain their guarantees; reuse exact existing evidence where valid.
</acceptance>

<measure>
Record exact source and configuration identities, commands/exits/skips, client and CLI versions,
route/variant, available runtime identity evidence, jobs/changes, elapsed time and available usage/cost.
State unsupported model evidence explicitly; do not infer observed identity from configured arguments.
Inventory any default-profile or install behavior changes and their effect on existing installations.
</measure>

<hard_rules>
Dispatch only after Jad confirms the pending decisions and actual implementation state is verified.
Do not commit, stage, push, publish, reset, stash, switch user branches or activate the live release.
Never open/copy real credentials, .env contents, operator auth/account files or personal profiles.
Keep real client configs and live SQLite state outside the experiment; use approved disposable state.
Do not open any sealed/held-out data encountered; stop and report its protection instructions.
Use normal authorized sign-in; no permission bypass or manual credential export.
Keep product changes scoped; a new runtime/chooser/transport requires its own justified scope.
</hard_rules>

<verification>
Inspect existing receipts before launching duplicate checks; preserve required-skip accounting.
Use relevant exact commands from launch-plan Appendix A after inspecting the actual delta.
Installer changes: node bin/verify-isolated.js --node tests/review-setup-cli.js
Skill changes: npm run test:packaging
Relevant native portability: node bin/verify-isolated.js --node tests/platform-portability.test.js
Run the approved real-client read/write/review/receipt integration journey against disposable fixtures.
Run git diff --check; record the complete tracked/untracked change scope and preserved baseline.
Required final broad gates belong to G2 after source freezes; do not claim this packet approves release.
</verification>

<report>
Write sanitized evidence to the agreed ignored evidence directory after verifying its parent.
Report findings/limits first, then identities/measurements, changed files and reasons, actual
checks and raw outcomes, golden-journey results, and remaining decisions. Mark failed or
unavailable live steps blocked, not passed. Return G0/G1 accepted/blocked with evidence links.
</report>
