# Reviewed delegation decision (2026-10-14)

Public upstream `amElnagdy/delegate-skills` pinned at
`3aa72d681a79e2a9d09bd9a316353003ae1cb4a7`. Inspected actual
`skills/{codex,opencode}-delegate/SKILL.md`, their complete `scripts/relay.mjs`,
Claude relay permission/Windows boundary, MIT LICENSE and relay test cases.
Compared the installed personal 0.4.2 relays separately from upstream 0.5.0.
No provider was called. Source review is not native execution evidence for upstream.
The initial protected-adapter decision below still applies to the bridge runtime. The
2026-10-15 independent packaging extension is recorded separately at the end.

## Findings and reuse decision

| Area | Actual source | Decision |
| --- | --- | --- |
| Ownership | Relays launch in supplied cwd; git porcelain is reporting, not bridge locks/scope ownership | Reuse existing bridge executor; no upstream launcher shipped |
| Codex permissions | `buildArgv` defaults workspace-write; also exposes danger-full-access/network overrides; ambient config by default | Existing bridge pins workspace-write/read-only, ephemeral, ignore-user-config/rules; no broader flags |
| OpenCode permissions | `buildArgv` adds --auto except plan; inherits environment/config and PWD override | Preserve attested managed profiles; never adopt --auto |
| Windows | Relays use cmd shell serialization to resolve npm shims; Codex quotes output path, filters WindowsApps; OpenCode agent/session are not token-validated before shell serialization | Reuse bridge no-shell npm-shim resolver and owned supervisor; do not transplant shell launcher |
| Cancellation | `killChild` uses taskkill /t /f on Windows and groups on POSIX; Windows SIGTERM/SIGHUP handlers cannot establish reliable relay cancellation; exceptions are swallowed | Bridge supervisor and quarantine semantics remain authoritative; test MCP cancel/disconnect with fake processes |
| Normal exit | 500ms pipe drain destroys inherited streams, does not establish all descendants stopped | Preserve bridge containment evidence; never infer termination from result.json |
| Results | Atomic result.json, raw event/brief/stderr files; final message, thread/session IDs, porcelain; exit zero can say completed despite absent report/provider error events | Existing result classification, sealed run receipts and scope/HEAD checks; add diagnostic session ID to stored result text |
| Sessions | Exact session and global resume-last; Codex flags must be reapplied on resume; OpenCode 2.x joins variant into model | No global resume; retained file continuation only. Codex remains ephemeral |
| Versions | OpenCode upstream now handles 1.x and 2.x; local 0.4.2 always sends --variant; local Codex adds profile/account routing absent upstream | Do not mix versions or import fleet/account routing. Installer gates tested 1.18.32 |
| Claude | Native Windows has no shell sandbox; preapproved PowerShell, inherited hooks, Git tripwire excludes ignored paths; executable native test pending upstream | Excluded from initial worker package; Claude remains a supported MCP client |
| Licensing | MIT copyright Ahmed Mohammed (amElnagdy), 2026 | Preserve full license and pinned notice for adapted guides |

The local relays are not identical snapshots: local Codex has `--profile`, home selection
and older argument handling; upstream adds ignore-user-config, web/network/subagent dials
and shell serialization. Local OpenCode is 719 lines versus upstream 781 and lacks the
2.x variant/version compatibility logic. Upstream tests cover synthetic argument/result,
version/timeout paths; they do not establish bridge ownership or installed-model adherence.

## Concrete API

`run_opencode_agent` accepts optional `executionMode: "light"`. It runs one supported role
through the same single-job executor/audit. Writers require managed worktree mode;
scope/lock validation remains unchanged. Light rejects contractor/proxy/fallback/automatic
integration and non-curated external runners, disables automatic builder rerouting and
read-only retry loops. Codex still needs explicit runner enablement AND model allowlist.
No new scheduler, coordination DB, MCP tool or raw relay. Parallel APIs are unchanged.

Light is a proportional one-worker workflow, not an exclusive repository-wide mutex:
normal scope/resource ownership still governs concurrency with other clients. Integration
uses the common reviewed preview receipt. Session IDs are diagnostic only, not resume
authority. Existing model attestation limits for external Codex remain visible; a required
runtime-model-evidence check may refuse it and is never disabled by this mode.

## Evidence boundary

Native Windows fake-runner tests exercise the adopted bridge boundary, not upstream
relays, real provider inference or real Codex sandbox enforcement. Required controls and
final verification results are recorded in SKILL-PACKAGING-LEDGER.md. Additional adapters
are excluded until their actual permission/Windows/containment path passes equivalent gates.

## Independent upstream package (2026-10-15)

The human explicitly requested nearly all original skills as independent skills instead
of additional protected bridge adapters. Bundle all 18 original `*-delegate` folders and
both original helper folders (`delegate-setup`, `codex-background`) at the SAME pinned
revision above. All 125 upstream files are byte-identical; full MIT license and attribution
are included in each selected installed folder. The integrity manifest pins all content.
No updater or job-time download is introduced.

`--standalone-delegates all|<keys>|none` is an opt-in file selection, default none. Existing
`--delegates` selects protected bridge guides exactly as before. Original names are preserved,
and existing user files retain the installer's unowned/user-modified conflict protection.
These are NOT new bridge runner IDs and are never implicitly selected as protected Light.

Source/package review covers the original catalogue and license, complete file/resource
inventory, sibling lane/bootstrap dependencies, Node built-in imports, permission/platform
documentation and install side effects. It is not a line-by-line security certification of
every upstream relay or real native/provider validation. Upstream skills differ in approval,
shell and read-only enforcement; the original caveats and scripts are retained, not masked
by a uniform bridge-sandbox claim. Some original defaults permit broad local actions.

The installer NEVER runs relays, discover/config/lane or codex-background bootstrap. Merely
copying the helper does not register a server or read auth/conversations. Any later helper
configuration/provider execution requires its original workflow and user authorization.
Codex background orchestration requires the separately configured original waiting helper;
it is not replaced by bridge polling. Installing original skills does not grant commit,
account-switch, expanded permissions or provider-cost authorization. Do not mix independent
writers with bridge-owned resources. Local checks establish packaging/install behavior only.
