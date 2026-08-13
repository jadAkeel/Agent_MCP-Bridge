# Codex–OpenCode MCP Bridge Hardening Report

Date: 2026-08-10

This report is the release record for the 2026-08-10 acceptance pass. The authoritative item-by-item checklist is [MCP_BRIDGE_HARDENING_CHECKLIST.md](MCP_BRIDGE_HARDENING_CHECKLIST.md). The active release was left unchanged until all source, focused, end-to-end, immutable-release, ACL, and health gates passed.

This pass found no new bridge-runtime defect. It did find and correct two operator-workflow defects: the previous Windows activation example passed a null `File.Replace` backup path, and the first recursive ACL hardening attempt left existing candidate children unreadable. It also corrected stale activation evidence after unrelated Codex config drift. The source server hash remained unchanged.

## Final disposition

The hardened immutable release is active:

`C:\Users\10User\codex-opencode-mcp-releases\server-b7a08c20-20260810`

The Codex config was atomically replaced only after its preactivation SHA-256 was rechecked. The preactivation config, an activation backup, and the prior immutable release remain available for rollback:

- Active config SHA-256: `9b0c6e7def9ab56826fd1e68b5936f7e8f30d975140e57ed6f369dd4fb71c1e3`
- Rollback config: `C:\Users\10User\.codex\config.toml.rollback-20260810-b7a08c20`
- Rollback config SHA-256: `0dcc58622ab5c29694e4518425b2006a2e3b107ac7f685b9bcb86c21706ce9af`
- Activation backup: `C:\Users\10User\.codex\config.toml.activation-backup-20260810-b7a08c20`
- Activation backup SHA-256: `0dcc58622ab5c29694e4518425b2006a2e3b107ac7f685b9bcb86c21706ce9af`
- Prior release: `C:\Users\10User\codex-opencode-mcp-releases\server-b7a08c20-20260809`
- Prior server SHA-256: `b7a08c205bde9630d03f2962410c61e4a84341ae1e8330d20bba2d6f51dfd367`

Already-running MCP processes keep their inherited configuration until restarted; fresh processes now resolve the active entry above.

## Immutable release identity

The release contains 7,899 manifest entries plus the manifest file itself (7,900 files on disk).

- `server.js`: `b7a08c205bde9630d03f2962410c61e4a84341ae1e8330d20bba2d6f51dfd367`
- `release-manifest.json`: `698a1ec4af594e4c5a242b62565912faadcdda106b110e3a437d83a3c1205b5f`
- `opencode/plugin-integrity-manifest.json`: `6b521d3e3ac5cd5297ab4c06a5764428332931865ff1eda21ff10f4f9676f376`
- `opencode/opencode.jsonc`: `bec3ce551a9fb11f02e4c4c666f99de9b9df6cb724940f4ed1815784ae232055`
- `opencode/antigravity.json`: `cff6726cb6a3e45713e0018401ddb094fcc07e5b6c4227fa0a0e35e85b0d810f`
- `opencode/.gitignore`: `2112e764c5bff9772492998e8ef894845f4208681f9a3a6d29fc6ff71ec2050e`

The runtime user's ACL is read/execute only. SYSTEM and Administrators retain full control. Create, write, rename, and delete probes were denied; existing server and bootstrap hashes remained unchanged. The bootstrap `.gitignore` is shipped and manifest-pinned because real OpenCode 1.17.13 creates it on first use.

The first candidate ACL attempt was rejected because existing child DACLs became empty and `server.js` was unreadable. The corrected procedure protected the root, reset all 8,685 existing child entries to inherit the root DACL, checked all reset exit codes, and then passed readability, mutation, hash, package, concurrency, ordinary E2E, Contractor E2E, and fresh-health gates.

## Confirmed and fixed issue clusters

### Acceptance findings closed on 2026-08-10

- **D1.1 — Windows activation/ACL procedure friction.** Reproduction: the prior guide's `[IO.File]::Replace($candidateConfig, $configPath, $null)` failed with `The path is not of a legal form`; the first recursive `/inheritance:r` ACL command left existing candidate children unreadable. User impact was a blocked activation or a false-ready release. Root cause was Windows `File.Replace` requiring an explicit backup path in this runtime and existing child DACLs not being reset from the protected root. The minimal fix was documentation in `docs/SAFE_PUBLISH_MANIFEST.md` for an explicit same-volume activation backup plus root-then-child ACL reset and strict exit checks. The corrected procedure was tested by the successful activation, rollback health, 8,685 child resets, denied mutation probes, and all post-ACL gates. Residual risk: a malicious same-user owner can still rewrite ACLs; use an administrator-owned parent or separate OS identity.
- **D2.1 — report/config snapshot drift.** Reproduction: unrelated Codex config changes after the 2026-08-09 activation made the report's recorded config hash stale even though bridge pins remained valid. Impact was inaccurate audit identity, not bridge execution failure. Root cause was an external config writer and the absence of a bridge-owned config watcher. The minimal fix was to preserve the exact preactivation config, re-record current active pins, atomically activate the tested candidate, and verify both active and rollback health. Residual risk: future unrelated config edits can stale a static report; regenerate activation evidence after such edits.

- Worktree lifecycle and dirty-source safety: successful unintegrated worktrees are retained, dirty writer sources are rejected with structured overlap evidence, cleanup is validation/final-gate bound, and source/target/HEAD/tree/ignored-file identity is rechecked across preview, apply, validation, and cleanup.
- Integration safety: receipts are single-use and contract-bound; dry-run cannot mark integration complete; exact patch/file/mode/symlink evidence is required; post-apply and post-validation mutations are rejected; rollback never writes through a replaced symlink; pipeline cleanup waits for durable authorization and terminal state.
- Queue and concurrency: durable owner generations, leases, heartbeats, child identity, cancellation-wins terminal CAS, revision/owner/status persistence, pre-run conflict terminalization, crash recovery, non-replayable records, bounded result evidence, provider leases, and direct-parallel all-settled behavior are covered.
- Provider/retry behavior: structured SDK/API/session error shapes, auth/quota/billing/model terminal classes, transient backoff and Retry-After forms, elapsed budgets, no unsafe write retries, and cross-process capacity leases are enforced.
- Plugin/config and credential boundary: production is pure mode with external plugins disabled; release startup rejects immutable pinning with external plugins; effective agent/skill/config origins and trees are pinned; ambient `OPENCODE_*` secrets and logs are filtered; task/result/lock data is redacted or hashed. Builder and manifest tooling never publish/hash credential files. Runtime isolated discovery may read a bounded valid built-in `auth.json` and pass it child-only through `OPENCODE_AUTH_CONTENT`; it is not logged, returned, prompted, or persisted, and bridge code never reads `antigravity-accounts.json`.
- Validation policy: operator-only root/path/policy/executable pins, exact safe Git vectors, canonical executable/hash checks, policy provenance, revocation, mutation, restart, and pre-execution reauthorization are required. Repository package-manager execution remains an explicit operator authorization, not a sandbox.
- Sanitized workspaces and agent authorization: every effective runnable role is source/model/prompt/permission/skill-attested; sanitized runs use isolated HOME, XDG data/config/cache/state, temp, memory DB, no project control config/MCP/LSP/skills, exact-root execution, and no worktree substitution. Contractor parent and nested roles are isolated and re-attested.
- Release workflow: deterministic staging refuses links/ancestors/credential-bearing config and overwrite, publishes an exact manifest, uses release-local nonsecret configuration/agents/skills, performs read-only ACL hardening, and atomically replaces only the Codex config with a preserved rollback copy. No global OpenCode tree is staged or replaced.

## Mandatory verification matrix

All commands below passed against the final source or the final ACL-protected candidate as noted.

| Gate | Result |
|---|---|
| `npm test` (source, prior hardening baseline) | Passed, 179.0s |
| Focused source self-test | Passed, 149.9s |
| `npm run test:concurrency` (source) | Passed, 19.7s |
| `npm run test:e2e` (source) | Passed, 221.9s |
| `npm run test:e2e:contractor` (source) | Passed, 134.6s |
| Root, `opencode/`, installed pinned plugin `npm audit --omit=dev` | 0 vulnerabilities in each scope |
| `git diff --check` | Exit 0; only existing LF-to-CRLF warnings |
| Immutable candidate build | Passed; 7,899 manifest entries, 19.8s |
| Post-ACL candidate fresh health | Passed; 20 tools advertised, 14.1s |
| `npm test` from ACL-protected candidate | Passed, 170.0s |
| `npm run test:concurrency` from ACL-protected candidate | Passed, 20.5s |
| `npm run test:e2e` from ACL-protected candidate | Passed, 231.4s |
| `npm run test:e2e:contractor` from ACL-protected candidate | Passed, 146.1s |
| Active-config fresh health after atomic activation | Passed; 20 tools advertised, 11.1s |
| Rollback-config fresh health | Passed; 20 tools advertised, 16.5s |

Focused builder, fresh-health, TUI, server self-tests, release manifest, plugin integrity, provider, queue, pipeline, integration, sanitized-workspace, and rollback regressions are recorded in the checklist and passed before activation.

## Deferred boundaries and rejected findings

The implementation does not claim to make an untrusted repository a sandbox. A separate VM/container is required when raw data, credentials, ignored files, or hostile native tools must be physically unavailable. Same-user filesystem races outside the protected release ACL, operating-system compromise, and semantic row/column access control remain deployment boundaries. The unofficial Antigravity plugin is intentionally inactive in the immutable production profile; its provider-owned credential/account storage is outside the bridge release boundary. Findings without a reproducible failure mode, duplicate findings superseded by a later fix, and probes corrected by ordered OpenCode permission semantics are explicitly marked rejected in the checklist.

## Rollback procedure

If active health or a subsequent acceptance gate fails, atomically replace the active Codex config with `config.toml.rollback-20260810-b7a08c20` (or the byte-identical activation backup), point the MCP entry at the preserved prior release, and rerun fresh health before accepting work. Do not delete either release or the rollback copies during incident response.
