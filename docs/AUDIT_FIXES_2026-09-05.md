# MCP / OpenCode audit remediation — 2026-09-05

This note records the fixes applied after the Arabic audit in
`chesEngineWithData/docs/mcp-orchestrator-audit/README.md`. It describes the
development tree and the release published from it. The previous immutable
release was preserved for rollback.

## Implemented

- Secret redaction now recognizes underscore-based GitHub token prefixes such
  as `ghp_` and `github_pat_`, with synthetic canaries across raw, JSON, URL,
  log, and persisted-output paths.
- OpenCode event parsing now reconstructs multipart final responses, rejects
  malformed streams, keeps all authoritative runtime model identities, and
  reports ambiguous or conflicting model evidence instead of silently using
  the first event.
- A caller can declare `scopeContract.modelRequirement` with provider, model,
  optional variant, and optional mandatory runtime evidence. Configuration
  mismatches fail before a paid agent process starts; runtime conflicts fail
  after execution. The bridge still does not accept arbitrary per-job model
  overrides.
- Git and `HEAD` readiness checks are shared by preflight and execution. Invalid
  non-Git or unborn-HEAD workspaces are rejected before OpenCode is spawned,
  while documented dry-run and sanitized-workspace flows remain available.
- Direct `run_opencode_agent` calls now have a bounded SQLite audit index that
  stores operational metadata only. Prompts, responses, stdout, stderr, and
  error text are excluded. Queue diagnostics expose direct-run coverage and
  keep it clearly separate from queued jobs.
- The orchestrator profile asks for exact commands and requires a final text
  response even when a permitted command is denied. Permissions were not
  loosened.
- SQLite queue status transitions now distinguish a heartbeat-only revision
  advance from a competing state mutation. This fixes a reproduced race that
  could leave an owned job indefinitely pending. The concurrency fixture also
  waits for supervised payload output rather than assuming it exists as soon as
  the supervisor PID is published.
- Vulnerable transitive `fast-uri` and `qs` versions were updated through the
  existing dependency graph; no new dependency was introduced.

## Intentionally not changed

- External plugins remain disabled for the immutable managed release. Enabling
  a personal OAuth plugin would mix mutable credentials/configuration into the
  pinned trust boundary. Gemini therefore requires a separately pinned provider
  profile and credential design before it can become the managed default.
- Read-only jobs still observe the checkout as it changes. Attribution is
  reported conservatively; the bridge does not roll back or overwrite user
  changes.
- Windows process-tree containment remains best effort when the operating
  system cannot confirm termination. Such runs are quarantined rather than
  reported as clean.

## Verification state

Passed locally in the development tree:

- `npm test`
- `npm run test:concurrency`
- `npm run test:e2e`
- `npm run test:e2e:contractor`
- `node server.js --self-test-events`
- `node --test bin/direct-run-audit.test.js`
- `npm audit --omit=dev` after the dependency update
- `npm audit --omit=dev` under `opencode/`
- the pinned optional plugin-cache audit after rebuilding version `2.0.0`
- `git diff --check`

The hardened candidate also passed pinned `npm test`, both live E2Es (the
contractor test was rerun alone after a parallel run observed unrelated global
OpenCode log activity), ACL denial probes, and fresh health with 21 advertised
tools. The rebuilt optional cache emitted an engine warning because transitive
`ini@7.0.0` requests Node `24.15.0` while this host uses `24.11.1`; the plugin is
disabled in the managed release, but this remains a prerequisite to review
before enabling it.

TestSprite authentication was not available on this machine, and no local
TestSprite project link was found, so no TestSprite result is claimed.

## Published release

- Release: `C:\Users\10User\codex-opencode-mcp-releases\server-f1603ba7-20260905-audit-fixes`
- Server SHA-256: `f1603ba7447bc38fd5d6ed6bdec70303d16c14783bbcbfe1c54e94e8606097e0`
- Release-manifest SHA-256: `b13bfa30461ee5da3e73754e54fd7a6bba8ad50db8d52459ec95ccc57c0c565a`
- Plugin-manifest SHA-256: `f0cbc94c468a69145517b7cbae679a40eb8a8fa3f01eb773cd54d2c4beddfc08`
- Activation fresh health: passed, 21 tools advertised
- Previous config backup: `C:\Users\10User\.codex\config.toml.rollback-20260905232833`
- Atomic replacement backup: `C:\Users\10User\.codex\config.toml.activation-backup-20260905232833`

Existing MCP processes continue on the old release until their task/app process
is restarted. New processes use the published release.

## Publication rule

Follow `docs/SAFE_PUBLISH_MANIFEST.md`: build a new non-overwriting candidate,
test it while pinned, verify ACLs and hashes, then atomically switch the MCP
configuration. If any gate fails, keep the existing active release.

## Gemini 3.8 Flash hybrid activation — 2026-09-06

The earlier decision to keep external plugins disabled was superseded by explicit
operator authorization to make Gemini the managed default while accepting the
reduced isolation. Every non-sanitized managed agent now uses
`google/antigravity-gemini-3.8-flash` with variant `high`. The
`mcp-sanitized-reader` intentionally remains on `openai/gpt-5.6-terra` because
its isolated execution requires pure mode.

The activated deployment uses a hybrid boundary:

- Bridge code is published under
  `C:\Users\10User\codex-opencode-mcp-releases\server-gemini38-20260906`,
  protected read/execute-only for the runtime user, and pinned by server SHA-256
  `663e25ac40e9d1957a473e9a1856ef01964dd98da7b0f767ebf3dc3b9fefb78c`.
- The release manifest remains available as build evidence with SHA-256
  `885d0f95de918bdaba05fb1acd0108284bb0d053a366b336c01c64773cabf740`,
  but the active external-plugin profile intentionally does not set the release
  manifest pin.
- The dedicated writable OAuth runtime is
  `C:\Users\10User\.codex\opencode-gemini-runtime-v1`. Plugin version `2.2.1`
  is exact-allowlisted and the runtime plugin manifest is pinned to
  `4f359d77866e2d3f5cf336c313a758d371c899084a4c7ec53351451dac9d5d48`.
- Plugin tree verification covers 1,403 files and 1,473 entries. Its tree
  SHA-256 is
  `088438f043b94dc1d81d59c1271c6c36c703c7be9f2b898468a4fdfb288d5a54`.
- The bridge health policy now derives edit and nested-task capability through
  the same normalized effective-agent metadata used by policy attestation. This
  supports OpenCode/plugin metadata that reports `edit`/`write` instead of the
  legacy `apply_patch` key without loosening either permission.

Verification passed in the source tree and again where applicable from the
read-only release: `npm test`, ordinary MCP E2E, contractor MCP E2E, cross-process
concurrency, root and OpenCode dependency audits, plugin-cache audit, plugin
integrity verification, ACL read/write probes, and live MCP Gemini profile smoke.
The smoke returned `MCP_GEMINI_OK` while reporting configured provider `google`,
model `antigravity-gemini-3.8-flash`, variant `high`, no fallback, and no changed
files. OpenCode did not emit authoritative runtime model identity in its JSON
stream, so the evidence proves the explicit command/profile and successful
provider response rather than cryptographic runtime-model attestation.

The active config was replaced atomically. Rollback copies are:

- `C:\Users\10User\.codex\config.toml.rollback-20260906105510`
- `C:\Users\10User\.codex\config.toml.activation-backup-20260906105510`

This hybrid mode is weaker than the prior immutable pure profile. OAuth refresh
requires a writable config runtime, and managed agent/skill content there is not
covered by the release manifest. Plugin/config/settings hashes and effective
permission attestation remain fail-closed, but a same-user compromise can still
rewrite writable runtime inputs. The plugin is unofficial and may carry Google
account-policy risk; use a dedicated low-privilege account. Keep the previous
pure release and backups for rollback.
