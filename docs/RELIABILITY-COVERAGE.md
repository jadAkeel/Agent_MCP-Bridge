# Reliability and security coverage

This inventory records existing tests inspected on 2026-10-14. It is a focused
map of the highest-impact failure modes, not an exhaustive code audit. No new
framework or duplicate regression suite was needed for these scenarios.

## Existing executable coverage

| Risk | Existing evidence | Remaining boundary |
| --- | --- | --- |
| Concurrent writers overwrite one another | `bin/e2e-concurrency.js`: 20 overlapping writer races with exactly one winner, 10 disjoint writer pairs, read/write conflicts and serial integration exclusion | Deterministic local processes, not sustained provider workloads |
| Crash leaves a job/lock stranded or loses output | Concurrency harness kills a real bridge process, waits for its lease expiry, checks takeover and retained output; `tests/review-batch-race.js` checks dead-owner hard-lock release | Does not simulate power loss or all disk failures |
| Retry creates duplicate work or loses durable intent | `tests/review-day5-retry-intent.js`: fresh-process recovery, two-process race, successor-mark rollback, generation and owner lease checks | Evidence is for the explicit crash/transaction boundaries tested |
| Integration overwrites concurrent user work | `tests/review-batch-race.js`: concurrent branch movement and conflicting committed content; `tests/review-integration-recovery.js`: affected-path drift and quarantine | Arbitrary concurrent manual worktree edits still require care |
| Unsafe lock/slot release while a child may live | `tests/review-day5-quarantine.js`: unknown evidence, PID reuse, failed lookups and live unrecorded validator controls | Does not prove every operating-system child tree is discoverable |
| Cancellation affects another job or leaves unsafe output | Concurrency harness: cross-process cancellation and sibling timeout isolation; `tests/review-spawn.js`: reader/writer abort and client disconnect | Local fake agents, not real provider/client combinations |
| Provider capacity exceeds resource limits | Concurrency harness: capacity across four processes and mixed-limit bridges; generated scheduler cases check queue capacity/holds; `tests/property-provider-wait.js` checks bounded budgets and isolated progress context | No throughput or long-duration latency claim |
| Protocol handling fails through the real MCP transport | `bin/mcp-robustness.js` and concurrency harness use SDK clients over stdio | Fresh user installations and additional clients remain smoke-test targets |

## Verification and economical use

- `npm run test:concurrency` was executed again on 2026-10-14: **32 passed,
  0 skipped, exit 0**. It uses local deterministic agents and temporary repos;
  no real provider jobs were run.
- The earlier complete `npm test` returned 176/182, with six ambient config
  refusals. Those files passed individually in clean-environment reruns. The
  subsequent isolated candidate gate returned **174/182, exit 1**, with eight
  failures. After a shorter unique spawn-fixture prefix and flat outer TEMP, the
  latest complete gate passed **182/182, exit 0**, in 31m20.156s. This is one
  complete-run pass, not a combination of focused controls. Skip accounting:
  four optional skipped cases, two optional partial cases, zero required skips.
  See `PROPERTY-MUTATION-TESTING.md` for exact counts and receipts.
- Concurrency is a separate command, not part of `npm test`. The release gate
  already includes it; do not call a plain `npm test` result concurrency coverage.
- Use the existing focused suite for the changed invariant first. Run the full
  gate at a stable integration boundary, rather than after every test assertion
  or documentation edit.
- Prioritize repairing test environment contamination before repeatedly paying
  for complete runs. Keep production policy enforcement and required assertions
  intact; use isolated synthetic configuration for local fixture verification.

No additional critical missing scenario was established in the inspected
categories. That does not establish that all possible failure modes are covered.
The practical remaining validation is a supervised Windows installation and
real-provider alpha smoke test; those were not performed here.

The subsequent fast-check/Stryker round did establish **test coverage gaps** in
queue-off/wake scheduling. Account3 added five generated properties, and an exact
265-mutant comparison killed 32 changes the first suite missed. This is evidence
of stronger regression detection, not a count of product bugs. See the expanded
scheduler section of `PROPERTY-MUTATION-TESTING.md` for the scoped results.

Retry follow-ups added generated durable-receipt/dispatch/history coverage and
then rate-limit output/final-response/changed-file boundaries plus infrastructure
backoff/model preservation. The current retry scope is **194 mutants: 120 killed,
72 survived, 2 known finalization timeouts, 0 errors; 62.89%**. The second round
added 41 assertion kills while preserving all 79 prior kills, with no product
source change. `RETRY-PROPERTY-MUTATION.md` distinguishes already-covered native
integration paths from new generated combinations and remaining fixture limits.

The complete gate did pass the expanded property command, retry-intent (31/31)
and test-runner inventory (26/26). The following Windows correction round passed
the entire real-runner gate, so **local testing-candidate acceptance is now
established**. A native Git destination-depth limitation remains reproducible;
the old supervisor snapshot failure remains unexplained, despite current parallel
and uninstrumented full-run passes. Only the test fixture name was shortened;
production behavior, PID checks, security, scheduling and timeouts were preserved.
The current report is `.test-logs/2026-10-15T20-41-41-703Z-2040/report.json`;
`RETRY-PROPERTY-MUTATION.md` records the path matrix, bounded snapshot diagnostics
and optional Windows limits. The separate 32-test concurrency receipt remains
historical evidence and was not rerun. This local gate does not establish
production readiness or real-provider behavior.

## CodeQL

**Stopped at the user's request:** on 2026-10-14 default setup was disabled again,
and GitHub confirmed `state: not-configured`, `schedule: null`. The initial scan
had completed and reported 271 open alerts, 107 in test files. Those are untriaged
alerts, not confirmed defects. Its receipts are retained under `.test-logs/security-review/`;
no alert was dismissed and no product fix was applied from that scan.

GitHub default setup was requested for JavaScript/TypeScript using the **extended**
query suite and **remote_and_local** threat model. The local sources matter for
this stdio/CLI bridge: stdin, filesystem, environment and CLI arguments must not
be treated as automatically trusted.

Configuration is managed in GitHub repository settings, not a second workflow
file. This avoids overlapping scans. No autofix, commit, push or production
deployment is part of enabling this scan. It analyzes committed GitHub source,
not the local uncommitted property/mutation testing additions.

Initial run: https://github.com/jadAkeel/Agent_MCP-Bridge/actions/runs/38594836489
Target commit: `2f66a10593513f6930dea1a901f361bad5172f7f`.
Setup receipts: `.test-logs/security-review/codeql-before.json`,
`codeql-request.json` and `codeql-enable.json`.

CodeQL alerts require source-level review. A successful analysis means the scan
ran; it does not mean there are no vulnerabilities. It also does not replace
dependency auditing or runtime fault-injection tests.
