# Beta security triage — October 20, 2026

## Identity and scope

Reviewed current code at `118e6d5c7b4097ad9bb3967d640ac12eb1389521` and the
October 18 [triage](AGENSI-SECURITY-TRIAGE-2026-10-18.md). GitHub still reports
271 open alerts from analysis `2f66a10593513f6930dea1a901f361bad5172f7f`, created
October 14. This is an old analysis, not a scan of the RC. No alerts were dismissed.

Published initial scope: local stdio MCP, public pure OpenCode installation,
bounded trusted-project file work, reviewed receipt-bound integration. The Bridge
does not promise an OS sandbox against a malicious process with the operator's
own filesystem privileges. Optional external runners are not exhaustively audited
by this review.

## Dispositions for each reviewed alert

| Alert | Disposition | Source-level reason / limit |
| --- | --- | --- |
| 167 `js/command-line-injection` | **False positive for shell injection in the reviewed managed path** | `bin/process-supervisor.js` validates typed launch messages (`validLaunchMessage`, lines 56–74), receives one launch on owned stdin, and calls `spawn(message.command, message.args)` with `shell:false` and payload stdin ignored (703–709). The sink moved from 694 in the old scan. Since that scan, launch-authority expiry is additionally checked before spawn. OpenCode arguments are separate `--agent=`, `--model=`, `--variant=` tokens and option-shaped prompts are guarded. The supervisor is intentionally an executable dispatcher, not an executable allowlist. |
| 168 `js/command-line-injection` | **False positive for shell injection in the reviewed managed path** | `lib/run-command.js:43–50` uses `execFile` with argv and explicit `shell:false`. The reported taint source is operator process environment choosing the executable, not a remote executable selector. Validation goes through `prepareValidationCommand`: canonical executable allowlist, lexical restrictions, optional strict hashes, Windows Node-shim resolution without batch-shell interpretation. Trusted Git configuration disables hooks, helpers, external diff/textconv and signing. Authorized scripts/interpreters still execute code by design; this disposition does not certify every caller or option combination. |
| 169 `js/command-line-injection` | **False positive for the filesystem-derived ADS operands** | `lib/writable-scope.js:45–67` uses fixed System32 cmd switches `/u /d /v:off /c dir /r /a`, quoted environment references for existing enumerated directories, no `call`/recursive expansion. Normal Win32 directory names cannot contain the closing quote. `%COMSPEC%`, ampersand, bang and caret literal-path NTFS cases are covered by G-08. The operator's SystemRoot remains a trusted environment setting. Enumeration errors fail closed. |
| 214 `js/remote-property-injection` | **False positive** | `bin/server-entry.js:14–18` clones the environment, enumerates its own keys, and deletes only two fixed retired variable names after uppercase comparison. It does not assign arbitrary remote properties or write the object prototype. |
| 271 `js/regex/missing-regexp-anchor` | **False positive** | `lib/redaction.js:85` is a credential-substring detector/redactor, not a URL hostname authorization rule. Finding a Slack webhook anywhere in a patch/log is intentional. Anchoring the expression to an entire input would miss embedded credentials. |
| 194 `js/file-system-race` | **Unresolved** | `lib/state/crypto.js:23–27` lstat-checks a key then reads by name. This is a real check/use interval under same-user adversarial replacement; no exploitation was demonstrated. The private operator-owned state root and linked-path checks are controls, not an atomic-open proof. Do not claim hostile same-user protection. |
| 195 `js/file-system-race` | **Unresolved** | The concurrent key-publication loser also checks then reads the winning key (`lib/state/crypto.js:68–74`). Complete-key publication uses private random temp, fsync and no-replace hard-link; these cover ordinary concurrent initialization, not malicious replacement between check and read. No production exploit was demonstrated. |

The five bounded false-positive decisions are not whole-product security clearance.
The two unresolved races do not establish a release-blocking defect in the advertised
trusted-local/same-user boundary; they block any stronger malicious-same-user isolation
claim. Broader path, state, external runner and resource-exhaustion alerts remain
unreviewed here. No claim of a clean CodeQL backlog or a new CodeQL scan is made.

## Verification and remaining coverage

Native literal-argv tests, validation policy checks, G-08 NTFS/links/scope checks,
state-key concurrency checks and release pinning are part of the final native suite.
Use that final release-gate receipt and matching CI cell artifacts for actual pass/skip
results. October 18 receipts are historical corroboration, not final-RC test results.

This round confirms a queue cancellation product defect separately (see
[stability investigation](BETA-STABILITY-2026-10-20.md)); it is repaired with a
red-before/green-after deterministic regression. No confirmed exploitable security
defect was found in these seven reviewed alert flows. Runtime/provider and fresh-user
acceptance remain separate pending gates.
