# Continue the testing quality round — next-agent execution prompt

> Historical dispatch brief. Later work completed native bounded diagnosis,
> the deferred-drain correction, final mutation measurements, source acceptance
> and the full Node24 gate. Consult the current
> `.test-logs/quality-round-2026-10-16/STATUS.md`, actual receipts and final report
> before executing; do not repeat this original TODO list blindly.

Continue the existing work; implement and verify the unfinished acceptance steps.
Do not merely propose a plan. No new features, broad cleanup, or score chasing.
Resolve routine choices autonomously. Keep the user informed before long operations
and about every minute while tests or delegation are active.

## Workspace and safety

- Candidate: `C:\Users\10User\bridge-testing-tools-2026-10-14`.
- Expected branch: `codex/testing-tools-2026-10-14`.
- Expected HEAD: `2f66a10593513f6930dea1a901f361bad5172f7f`.
- Preserve all inherited uncommitted and untracked work. Verify current reality first.
- Do not modify `C:\Users\10User\codex-opencode-mcp` or
  `C:\Users\10User\bridge-skill-packaging-2026-10-14`.
- No commit, merge, push, publication, deployment, real user configuration changes,
  credentials/private configuration/live bridge state reads, or real provider jobs.
- No dependency changes, runtime-floor changes, sandbox broadening, test weakening,
  skipped required checks, identity/containment relaxation, or blanket timeout increases.
- Use actual isolated runtimes, disposable profiles/repos and local fake payloads.
  Never kill processes or delete directories without verifying test ownership.
- Apply applicable repository instructions and existing progress-updates,
  bug-investigator, test-and-verification and safe-implementation skills.
  Use multi-agent-balanced/codex-delegate only if delegating.

## Verify current state before acting

Read `docs/QUALITY-ROUND-2026-10-16.md`, the actual diff, and relevant current
receipts under `.test-logs/quality-round-2026-10-16/` (abbreviated E below).
Inspect narrow relevant process/result metadata before dispatching or writing.
Do not duplicate an active writer or test executor.

`E/STATUS.md` and `E/HANDOFF.md` are STALE: their last updates precede completed
lease work, the supervisor repair and the latest Node22 failure. Treat this prompt
as continuation context, but actual source and receipts remain authoritative.
Refresh those existing two files after reconciling them; do not create another
competing coordination system. `E/baseline.json` holds preservation evidence.

## Verified work to preserve

1. Retry properties: 15 cases; native retry-intent 31/31 passed.
   Actual retry Stryker: 194 mutants, 150 Killed, 42 Survived, 2 Timeout,
   78.35%; 30 additional kills against the same prior mutant identities.
   See `E/root/retry-comparison.json`, `retry-final.json`, and
   `retry-mutation.receipt.json`. Do not rerun this unchanged mutation scope.
2. Lock properties currently 17 cases; latest focused receipt passed17/17.
   First mutation measured an EARLIER14-case input: 240 mutants,141 Killed,
   99 Survived,0 Timeout,58.75%. Exact measured inputs/report archived in
   `E/root/locks-measured/`. Latest tests are not measured by that score.
3. Queue lease properties currently17 cases; latest focused receipt passed17/17.
   First mutation measured an EARLIER15-case input:132 mutants,115 Killed,
   17 Survived,0 Timeout,87.12%. Root subsequently added probe-open-failure
   cleanup/recovery and default renewal-failure deadline/reason cases.
   Archive `reports/mutation/queue-leases.json` before overwriting it.
4. The combined property command currently contains73 cases across five files.
   Node22 recorded71/71 BEFORE the last two lease cases. Do not report73/73
   until a real current run establishes it. The complete runner still has182
   commands; new properties extend one existing grouped command.
5. Independent review ACCEPTED current test/config/wiring deltas, not overall
   acceptance: `E/account3/final-test-delta-review-run/final.txt` and result.json.
   One nonblocking test gap: the lock stop/drain case awaits pending work before
   stop, so does not prove stop stays pending while a DB open is held. Strengthen
   this with a deferred open, assert stop remains unsettled, then release the
   open and verify completion; do not introduce arbitrary timing sleeps.
6. Confirmed product defect Q-20261016-01 was reproduced and repaired:
   receiver could launch a payload with an already-expired positive launch
   deadline. The only approved product edit is `bin/process-supervisor.js`:
   fail closed immediately before spawn while preserving future and omitted
   deadline behavior and all existing containment/identity contracts.
   Current repaired file SHA256:
   `34da823d3dbd77690510fdb2825b4dc113c9a50dc155c93df48a62b3df0e9830`.
   Native before/after marker evidence exists in `E/root/authority-before.json`,
   `authority-after.json`, `authority-after-node22.json` and matching receipts.
   Both Node22 and24 prevent expired execution after repair; valid control starts.
   Node24 supervisor self-test and runner-wiring checks passed. Parent error
   reporting does not preserve the specific child errorType; this is a known
   diagnostic limitation, not evidence the payload was launched.

## Priority 1 — diagnose the actual Node22 native failure

Read `E/root/supervisor-node22.receipt.json` and
`E/root/supervisor-node22/080-process-supervisor.js.log`.
Actual Node22.13.0 self-test exit1 at approximately line1212:
`descendantExit.descendants.found >= 1` failed with
`{"snapshotOk":true,"found":0,"killed":0,"gone":0,"failed":0}`.
This is the Windows orphaned-descendant cleanup assertion. Do not conflate it
with the historical snapshotOk:false failure or the new launch-deadline test.

Inspect descendant creation, breakaway/job behavior, ancestry snapshots, PID
identity and cleanup. Establish whether this is a fixture race, runtime/Windows
behavior, an existing product failure, or a regression. Compare the focused case
on repaired and predecessor product bytes using separate disposable candidates
and the same Node22 environment; preserve the current candidate. Reuse baseline
evidence and source where appropriate; do not rerun broad discovery or full suites
to answer this narrow question. Collect evidence before repeating failures.

For a confirmed defect, record repro/impact and a minimal concrete correction
plan before editing. Remain within this supervisor/containment verification scope.
If another product file is demonstrably necessary, record exact file/contract
ownership and why the change is required before implementation. Never turn off
the descendant assertion, assume an absent snapshot means successful cleanup,
or weaken Windows safety to accommodate Node22. Independently inspect the fix
and rerun focused positive/negative controls on22 and24 before full gates.

## Priority 2 — freeze meaningful final test deltas

Close the deferred-drain test gap. Review changed tests against real behavior.
Run affected properties, then rerun lock and lease Stryker scopes sequentially
on stable relevant inputs. There are concrete unmeasured test additions, so these
runs are justified. First lock run took about21min; lease about2min. Preserve
old reports, compare identical source/mutant IDs, and classify meaningful survivors.
Mutants are synthetic edits, not a count of confirmed product bugs. Do not seek100%
through mirrored assertions, trivial tests, excluded live behavior or wider scope.

## Priority 3 — complete final gates on ONE stable candidate

Inspect `package.json`, the real runner and `E/root/check.mjs` before execution.
That wrapper prepares empty synthetic homes, isolated Git configuration and flat
external TEMP, hashes inputs and writes non-overwriting command/log/skip receipts.
Use fresh result names. Keep one check executor; no competing Stryker/full suites.

- Node24 full gate, from the candidate cwd:
  `node .test-logs/quality-round-2026-10-16/root/check.mjs final-node24 npm test`
- Node22 official portable binary is at `E/root/node22/node.exe`, verified SHA256
  `364dbc8442f8d5c04fd4226bcfcf8e60d3268627eb1d7be214a91bb7d74cdbb9`.
  Prepend its absolute directory to PATH, then invoke that node with:
  `.test-logs/quality-round-2026-10-16/root/check.mjs final-node22 node "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" test`
  Ensure npm and descendant node processes really use22.13.0.
- Execute the actual isolated `npm run test:concurrency` gate on the final
  candidate, preferably on Node22, through the same safe environment wrapper.
- Complete-suite setup/portable/release SELF-TESTS cover their existing inventory;
  do not rerun unchanged identical checks just to accumulate green receipts.
  Do not invoke the default live/config-reading release gate.

Previous complete npm test was182/182,4 optional skips,2 optional partials,0
required, taking about31min. Its238 inputs matched at this round's start, but
that is predecessor evidence, not acceptance of new executable bytes. Give real
full gates enough time with progress updates. Record actual command counts,
exits, skips/reasons, runtime, candidate hashes and all failures. If product or
test inputs change after freezing, invalidate affected evidence and rerun the
relevant final gates. Do not describe focused passes as full testing.

## Delegation, if useful

The authorized external worker is existing Codex CLI profile account3,
`gpt-6.1-sol`, high reasoning, clean environment, bounded sandbox. Existing
transport: `C:\Users\10User\bridge-reports\review-roadmap\day-3\codex-dispatch.mjs`.
Read supported options before use. No other accounts/models/workers/schedules.
Use coherent ownership, concise context and independent review; root is sole
native/full-gate executor. Worker native fs.link EPERM/IPC EACCES boundaries were
already observed: do not repeat identical refused controls or broaden permissions.
If running this prompt inside account3 itself, do not dispatch recursively to
the same account. Finish useful work directly and explicitly mark any genuinely
independent review still pending; self-review is not independent acceptance.

## Final source review and report

Inspect actual diffs/callers as well as tests. Reconcile lock/queue ownership,
generation/cancellation/recovery, integration safety, supervisor cleanup and
logging boundaries, using prior review rather than restarting discovery.
Update `E/root/source-review.md`, existing STATUS/HANDOFF and relevant docs.
Verify protected main and packaging HEAD/status/file hashes against baseline.
Distinguish inherited changes from this round's product/test edits.

Existing production npm audit exit1 lists SDK and proxy-addr advisories. Scoped
source review found stdio use, not the affected HTTP paths; this is not permission
to call the audit green, upgrade dependencies silently or claim all routes safe.
Native Windows long Git destination limits remain an operating limitation.
No actual providers, real user configuration, Linux/macOS or sustained live load
were tested here. State these limits without inventing additional blockers.

Definition of done: diagnosed and appropriately resolved native failure; meaningful
final property/mutation evidence; complete available local gates on the frozen
candidate; source/delta review and required independent acceptance; preserved
protected trees; concise evidence-backed readiness assessment and next steps.
If an external blocker prevents completion, leave exact pending work and real
evidence. Do not announce success prematurely. Report measured elapsed/token
usage where available, not an invented three-hour claim. Never pad time or repeat
unchanged tests merely to fill the original substantial-work budget.
