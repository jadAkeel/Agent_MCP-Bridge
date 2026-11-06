# Retry, ADS and attestation fixes: PR verification follow-up

This candidate includes the bounded BR-001/002/003 fixes documented in
[the original verification report](BR-001-003-VERIFICATION-2026-10-23.md), plus
isolation of the native process-supervisor self-test from parallel test load.
The PR branch starts at main `e1d1db86f2fb1c609ef91f0258bbe722b58eafb7`.
The preceding local branch had the same source tree as that main commit.

## Windows process-supervisor failure

The October 23 full runner executed the supervisor self-test in its `parallel`
lane. Its native descendant snapshot returned `snapshotOk:false`; the same
unchanged self-test subsequently passed alone. The underlying Windows command's
error was not recorded, so a specific OS error or timeout is not established.

`bin/test-runner.js` now schedules `process-supervisor.js` in the existing
`exclusive` lane, after parallel children have closed. Syntax checks still use
the syntax lane. This prevents contention from the runner's own parallel
fixtures; it does not guarantee snapshots succeed under arbitrary external load.
The production supervisor, process identity checks, containment assertions,
five-second native command budgets and 15-minute per-file timeout are unchanged.

The added regression in `tests/review-test-runner.js` derives the command from
the canonical package script, runs two parallel fixture processes followed by
the **real supervisor self-test**, checks all child close/start timestamps, and
requires the supervisor's success output. A following exclusive fixture must
also wait for the supervisor to close.

## New verification on Windows / Node 24.11.1

Command: `node bin/verify-isolated.js --node tests/review-test-runner.js`.
The wrapper uses disposable homes/state and removes ambient authentication.

| Candidate | Result | Local evidence under `.test-logs/` |
|---|---|---|
| New regression, before runner fix | 26/27 passed; exit 1; expected `exclusive`, observed `parallel`; stable inputs | `packaging-1792793452810-13976/report.json` |
| Initial attempt after runner fix | Native supervisor case passed, but execution stopped before a final receipt; outcome incomplete, not counted as green | `packaging-1792793501002-25300/output.log` |
| Completed attempt after runner fix | **27/27 passed; zero skips; exit 0; stable inputs** | `packaging-1792793548448-5572/report.json` |

The completed run also retains the existing tests for timed-out process trees,
unrelated-process protection, aborted dispatch when containment is unconfirmed,
skip accounting, credential scrubbing and exclusive scheduling.

Its recorded source digest (the wrapper's 409-file input scope, not a release
archive hash) was unchanged before/after:
`a9683f418c7ab31ada318598c173863b7cb7f0c167c4ee52c7a2ad133de8463a`.

An OpenCode CLI static review using `openai/gpt-6.1-sol`, variant `high`, found
no material defect in the five production BR-001/002/003 diffs and their added
regressions. The initial review process ended without a report; its same-session
continuation completed successfully. This assistant did not run tests and did
not review the runner scheduling change. Its supplied test counts were not
independent test execution. The coordinator inspected the diff and actual local
receipts separately. `git diff --check` also passed.

## Existing evidence and limits

The production BR-001/002/003 changes and their tests were not changed in this
follow-up. Their earlier results remain: queue **37/37**, native Windows ADS
**19/19**, shared attestation **35/35**. See the original report for before-fix
failures and exact receipts. Its full run remains **181/182 commands, exit 1**;
the new focused run does not retroactively make that full run green.

No existing assertions were removed, tests skipped, timeouts increased,
dependencies changed or provider/policy permissions broadened. The old runtime
packages were not rebuilt or replaced. This document does not establish a new
green CI matrix, native Linux/macOS acceptance, provider/client acceptance or
Marketplace publication. A new PR CI result must be evaluated separately.
