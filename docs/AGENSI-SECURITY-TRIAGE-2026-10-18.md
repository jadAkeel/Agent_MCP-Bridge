# Agensi RC: Targeted Command-Boundary Triage

Date: October 18, 2026.
Scope: GitHub CodeQL alerts 167, 168 and 169; local candidate command boundaries.
GitHub alert state at inspection: all three open, rule `js/command-line-injection`, severity critical.

## Summary

No shell-injection reproduction was found in the inspected boundaries and controlled native Windows checks. Two alerts identify intentional executable dispatch without a shell. The Windows stream-listing alert identifies a fixed `cmd.exe` command whose directory operands come from quoted environment references and existing filesystem enumeration.

These are bounded local triage findings, not an exhaustive caller audit or security release approval. The GitHub alerts remain open. Independent review of the dispositions and of executable/argument selection at callers remains part of G2.

## Candidate identity and environment

- Checkout: the existing combined candidate, detached at `2f66a10`, with substantial pre-existing changes.
- Native environment: Windows 11 `10.0.26200`, x64, Node `v24.11.1`.
- Main follow-up verification receipts record 401 publish-input files with stable before/after digest `46fc30a03d5b4e7e89f5e5310b19faafbec73413604347ecbf196d2192eec0b6`.
- The separate literal-argv receipt predates final smoke comments/onboarding edits. Its command-runtime, supervisor and boundary-test inputs are unchanged by those edits; retain that receipt's own source identity rather than relabeling it as a run on the later full digest.
- Fixture checks use disposable homes/config/state and remove ambient auth; provider execution is replaced by local peers/hooks where a model would otherwise run.

## Alert 167 — Process supervisor dispatch

**GitHub location:** `bin/process-supervisor.js:694` in the analyzed revision. The corresponding local sink is `spawn(message.command, message.args, ...)` in `launchPayload`.

**Reviewed flow:** the Bridge's `runSpawnCommand` starts a Node supervisor over owned stdio pipes, waits for readiness and any durable launch-authority gate, then writes a typed launch record. The supervisor validates the first record with `validLaunchMessage`; it rejects duplicate launches. The payload receives ignored stdin and piped output, not the supervisor's input/control channels.

**Controls observed:**

- `spawn` explicitly uses `shell: false` and separate string arguments.
- The launch-record validator rejects malformed command/argument/env values and embedded NULs; this is structural validation, not a command allowlist.
- Managed OpenCode execution uses `OPENCODE_EXE` and `openCodeRunArgs`. Agent/model/variant switches are single `--key=value` tokens; a prompt resembling a CLI option gets a fixed task prefix.
- Validation commands reach the supervisor after `prepareValidationCommand` resolves an operator-allowlisted executable, checks policy, and resolves Windows Node shims without invoking their batch shell.
- External runners have a separate opt-in/authorization boundary and intentionally execute reviewed native programs; this round does not certify every external runner or subcommand.

**Local disposition:** intentional executable dispatch; no demonstrated shell interpretation at this sink. Literal shell-shaped argv survived the actual supervisor and native child unchanged. Keep executable/option-selection review at callers separate from this result.

## Alert 168 — General command runner

**GitHub/local location:** `lib/run-command.js:43`, `execFileAsync(command, args, options)`.

**Reviewed flow:** callers supply an executable and argument vector; the runtime uses `shell: false`. Git calls additionally receive `trustedGitArgs` and `buildTrustedGitEnv` from `server.js`.

**Controls observed:**

- Command and arguments are not concatenated into a shell expression.
- Bridge Git enforces disabled hooks, fsmonitor, credential helpers, external diff and signing programs; it disables external diff/textconv on diff calls and uses literal pathspecs.
- Validation preparation rejects shells, inline evaluation/preloads and package-executor subcommands, resolves canonical executable paths against the operator allowlist, and supports exact executable hashes for strict project policy.
- The low-level runner itself intentionally does not decide whether an executable or subcommand is authorized. Native programs can interpret their own arguments, and authorized interpreters/package scripts can execute code.

**Local disposition:** no demonstrated shell injection at the wrapper. Direct native-child tests preserve metacharacters, quotes, variable syntax, Unicode, newlines and empty arguments exactly. This does not replace downstream option-injection or project-script trust review.

## Alert 169 — Windows alternate stream listing

**GitHub/local location:** `lib/writable-scope.js:58`, the fixed `cmd.exe /u /d /v:off /c dir /r /a` invocation.

**Reviewed flow:** `captureWritableScopeFilesystemState` enumerates existing directories with `lstat`/`opendir`; `listAlternateDataStreams` stores each directory in `CODEX_STREAM_DIR_<index>` and supplies a quoted reference for it to the fixed `dir` command. No task-provided shell command is accepted here.

**Controls observed:**

- The executable and command switches are fixed; `/d` disables AutoRun and `/v:off` disables delayed expansion.
- Operand references are quoted. Real Win32 directory names cannot contain the quote character needed to break those quotes.
- The command does not use `call` or another recursive evaluation step. Directory values with paired `%COMSPEC%` must remain literal paths rather than expanding recursively.
- Chunking bounds the expanded command size. Enumeration/listing failures produce `writable_scope_unverifiable`, preserving fail-closed scope handling.

**Local disposition:** no demonstrated injection through the reviewed filesystem-derived directory operands. The native NTFS regression covers both the original odd-name case and a paired `%COMSPEC%` case with `&`, `!`, parentheses and `^`; alternate streams are still found at the exact literal paths. The existing G-08 checks also cover stream-only changes, file-only scopes, parallel writers, links and retained output.

## Verification evidence

Each command below exited 0. These focused checks reported zero skips.

| Command | Result | Receipt |
| --- | --- | --- |
| `node bin/verify-isolated.js --node tests/command-boundary.test.js` | 2 native direct/supervised argv tests passed | `.test-logs/packaging-1792323691252-3076/report.json` |
| `node bin/verify-isolated.js --node tests/review-day5-validation.js` | 51 policy/parser/native argument checks passed | `.test-logs/packaging-1792323797029-16376/report.json` |
| `node bin/verify-isolated.js --node tests/review3-g08.js` | 15 writable-scope/NTFS/link checks passed | `.test-logs/packaging-1792323796898-22588/report.json` |
| `node bin/verify-isolated.js --node tests/review-split-lib-pin.js` | 11 digest/real Bridge startup checks passed | `.test-logs/packaging-1792323796875-25880/report.json` |
| `node bin/verify-isolated.js --node tests/live-smoke.test.js` | 8 MCP-peer smoke/control groups passed | `.test-logs/packaging-1792323796798-22592/report.json` |
| `node bin/verify-isolated.js --node tests/review-setup-cli.js` | 39 setup/reinstall/rollback/pinned-health checks passed | `.test-logs/packaging-1792323796893-26876/report.json` |

`test:command-boundary` is included in `npm test`; G-08 remains in the existing native suite. No production command-runner/supervisor/ADS behavior was changed to suppress an alert. The report records observed controls and new boundary coverage.

## Remaining acceptance

- Independent source-level review and final dispositions for these three alerts, plus broader production-alert triage where required by the advertised release path.
- Full-suite/release gates against the final candidate after any confirmed fixes.
- Explicit live route/account/variant and workload/time/cost authorization.
- Real-client read/write/review/receipt integration, then independent fresh-user and Agensi delivery acceptance.

The new `--read-file` smoke is a controlled SDK-client capability, not proof that a real provider or Claude Code/Codex completed the journey.
