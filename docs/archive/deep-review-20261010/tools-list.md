# tools/list size review (codex-opencode-mcp, branch bridge/housekeeping at b74fbc7)

Date: 2026-10-10. This was a read-only review and no tracked file was changed. The temporary measuring script was
`.measure-tools.mjs` in the checkout. It was deleted afterwards; a copy is `measure-tools.mjs` next to this file.

## 0. Method and units

- `measure-tools.mjs` starts the bridge with the `mcp_servers.opencode` entry of `~/.codex/config.toml`
  (command, args, env), with two changes: `CODEX_OPENCODE_STATE_DIR` points at a scratch directory and
  `CODEX_OPENCODE_SYNC_MANAGED_RUNTIME=false` is set. The measurement therefore touched neither the live state nor
  the managed runtime dirs. `tools/list` does not depend on state, and HEAD gives the same 63,740 B as the lead's
  measurement against the live state.
- Sizes are the `JSON.stringify` bytes of the `tools/list` result (compact, as sent on the wire).
  **63,740 B = 62.2 KiB.** The 2026-09-24 baseline is **36,576 B = 35.7 KiB = "36.6 KB" in decimal units**
  (commit 5f82472, measured the same way). The two figures in the brief mix units: the growth is +27,164 B (+74 %).
- History: 70 first-parent commits since 5f82472 changed `server.js`, `lib/tools/` or `lib/scope-contract.js`. Each
  one was extracted with `git archive` into scratch, linked to the checkout's `node_modules` by a junction (both
  lockfiles pin SDK 1.30.0 and zod 4.4.3), started with the server/lib SHA pins removed, and measured. Raw dumps
  are in `revs/<sha>.json`, the series in `series.txt` and the table in `table-series.md`. One commit (413b0ae)
  did not start: it crashed in `attestationCacheTtlMs`. Its neighbours have identical sizes, so no schema change
  is missing from the series.

## 1. Breakdown of the 62.2 KiB

Totals: tool descriptions 5,947 B; inputSchemas 54,777 B (86 %); names, `execution` and JSON keys about 3,016 B.
Descriptions set with `.describe()` inside the schemas come to about 24,165 B, which is 44 % of the schema bytes.

| tool | total B | description B | inputSchema B | 2026-09-24 (5f82472) B |
|---|---:|---:|---:|---:|
| run_opencode_parallel | 8402 | 313 | 7985 | 4806 |
| enqueue_opencode_job | 8035 | 100 | 7832 | 4928 |
| validate_delegation_plan | 7945 | 107 | 7731 | 4838 |
| run_opencode_agent | 7785 | 51 | 7633 | 4678 |
| create_multi_agent_pipeline | 6486 | 114 | 6262 | 5729 |
| integrate_opencode_worktrees | 5207 | 1003 | 4093 | (new) |
| integrate_opencode_worktree | 4236 | 444 | 3682 | 2938 |
| set_opencode_concurrency | 1921 | 561 | 1253 | (new) |
| requeue_opencode_job | 1279 | 531 | 645 | (new) |
| resolve_integration_quarantine | 1230 | 447 | 670 | (new) |
| pause_opencode_provider | 1092 | 371 | 611 | (new) |
| acquire_agent_lock | 925 | 80 | 744 | 915 |
| get_opencode_job | 843 | 186 | 558 | 413 |
| verify_sanitized_workspace | 834 | 151 | 574 | 834 |
| list_opencode_jobs | 804 | 50 | 653 | 540 |
| finalize_multi_agent_pipeline | 707 | 128 | 467 | 676 |
| get_opencode_bridge_status | 688 | 186 | 393 | 688 |
| list_multi_agent_pipelines | 668 | 59 | 500 | 507 |
| abandon_multi_agent_pipeline | 618 | 123 | 384 | 618 |
| inspect_opencode_queue_recovery | 590 | 119 | 357 | 590 |
| resume_opencode_provider | 561 | 259 | 195 | (new) |
| release_agent_lock | 550 | 37 | 412 | 550 |
| cancel_opencode_job | 494 | 138 | 254 | 494 |
| diagnose_opencode_bridge | 409 | 130 | 172 | 409 |
| run_multi_agent_pipeline | 393 | 101 | 185 | 393 |
| get_multi_agent_pipeline | 371 | 79 | 185 | 371 |
| list_agent_locks | 339 | 34 | 206 | 339 |
| list_opencode_agents | 289 | 45 | 141 | 289 |
| **sum** | **63740** | **5947** | **54777** | **36576** |

### Repeated fragments (byte-identical subtrees across tools)

| fragment | bytes per copy | copies | bytes beyond the first copy |
|---|---:|---:|---:|
| whole job shape (`jobInputShape`, server.js:692-727) as `properties` | 7,516 | 3 identical + 1 superset (enqueue adds `idempotencyKey`, `parentJobId`) | about 22,500 |
| of which `scopeContract` (lib/scope-contract.js:123-143) | 2,719 (properties 2,597) | 4, plus 1 in create_multi_agent_pipeline | 10,388 |
| of which `scopeContract.selfCheckCommands` (one 560-char description) | 619 | 5 | 2,476 |
| of which `scopeContract.modelRequirement` (scope-contract.js:116) | 571 | 5 | 2,284 |
| of which `scopeContract.timeoutPolicy` (legacy) | 287 | 5 | 1,148 |
| `models` (its description says "enqueue_opencode_job only") | 466 | 4 | 1,398 |
| `autoIntegrate` ("enqueue_opencode_job only") | 410 | 4 | 1,230 |
| `validationFixPasses` ("Not available in run_opencode_parallel") | 389 | 4 | 1,167 |
| `sanitizedWorkspace` (server.js:677) | 383 | 6 (including verify_sanitized_workspace.contract) | 1,915 |
| `continueWorktree` | 273 | 4 | 819 |
| `selfCheckPasses` | 254 | 4 | 762 |
| `maxWaitMs` | 226 | 4 | 678 |
| `maxAttempts` ("enqueue_opencode_job only") | 211 | 4 | 633 |
| legacy `scope` / `validation` objects | 217 / 214 | 6 / 6 | 1,085 / 1,070 |
| `previewReceipt.properties` | 610 | 2 | 610 |
| `$schema: "http://json-schema.org/draft-07/schema#"` | 52 | 28 | 1,456 |
| `execution: {"taskSupport":"forbidden"}` (SDK default; not sent to the model) | 40 | 28 | 1,120 |

The lead's reading is correct, but the repeated unit is larger than `scopeContract`: it is the **whole job
shape**. `run_opencode_agent`, `enqueue_opencode_job`, and the `jobs.items` of `run_opencode_parallel` and
`validate_delegation_plan` each carry it (lib/tools/locks-status.js:567, :818-821, :933-938; lib/tools/parallel.js:18).
Four copies of about 7.5 KB come to about 30 KB, which is 47 % of the response. The copies after the first cost
about 22.5 KB.

Some options are advertised on tools that refuse them:
- `models`, `maxAttempts` and `autoIntegrate` on run_opencode_agent, run_opencode_parallel and validate_delegation_plan:
  1,087 B x 3 = 3,261 B. The handlers refuse them with `queue_only_option` (lib/lock-plan.js:696-705,
  lib/tools/locks-status.js:900).
- `continueWorktree`, `validationFixPasses`, `selfCheckPasses` and `scopeContract.selfCheckCommands` on
  run_opencode_parallel: 1,535 B. They are refused at lib/lock-plan.js:413-428 and by `continueWorktreeJobError`.

## 2. Registration and the zod -> JSON Schema conversion

- All 28 tools use the deprecated positional overload `server.tool(name, description, rawShape, handler)` (SDK
  `McpServer.tool`, node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:657-695). server.js:668-675 wraps
  `server.tool`, but only to wrap the handlers. The tools are registered in lib/tools/locks-status.js (11 tools,
  :167-:998), lib/tools/jobs.js (7), lib/tools/pipelines.js (7), lib/tools/integration.js (2, at :12 and :339) and
  lib/tools/parallel.js (1, at :14).
- A raw shape becomes `z4mini.object(shape)` (sdk zod-compat.js:79-100, `normalizeObjectSchema` -> `objectFromShape`).
  That object uses the default **strip** mode: unknown top-level keys are silently dropped before the handler runs.
  The nested `scopeContract`, `sanitizedWorkspace`, `modelRequirement` and `previewReceipt` are `.strict()` and
  refuse unknown keys.
- For `tools/list`, mcp.js:67-97 calls `toJsonSchemaCompat(obj, {strictUnions, pipeStrategy:"input"})`.
  sdk server/zod-json-schema-compat.js:18-25 sends zod v4 schemas to
  `z4mini.toJSONSchema(schema, {target:"draft-7", io:"input"})`; `zod-to-json-schema` is used only for zod v3.
  The SDK passes no `reused` option, so zod's default `reused: "inline"` applies (zod v4/core/to-json-schema.js:27).
  zod moves a schema into `definitions` only when it carries `.meta({ id })` (to-json-schema.js:193-197) or is
  cyclic. The bridge sets no id anywhere, so **no `$ref`, `$defs` or `definitions` is emitted** (0 occurrences in
  the dump). The draft-7 target is also why each of the 28 tools carries a `$schema` key, although the SDK's own
  `ToolSchema` documents inputSchema as 2020-12 (types.js:1236-1246).
- Descriptions are not duplicated between `.describe()` and the tool descriptions. The cost comes from long
  `.describe()` texts on shared fields, which are repeated 4 or 5 times: `selfCheckCommands` 560 chars,
  `autoIntegrate` about 360, `models` about 340, `validationFixPasses` about 330.

**$defs cannot remove the repetition across tools.** Each `Tool.inputSchema` is a standalone JSON Schema, and MCP
`ListToolsResult` has no shared definitions section (sdk types.js:1229-1285). A `$ref` can only point inside the
same tool's schema. Repetition within one tool is small: create_multi_agent_pipeline repeats
`sanitizedWorkspace.properties`, `scope` and `validation`, and `reviewerJob` matches `testerJob`. Every other tool
carries the job shape at most once. The best possible `$ref` saving over all 28 tools is about **0.7 KB**.

## 3. What the two clients accept (verified vs assumed)

Verified:
- **Claude Code 2.1.228** (string search in the installed claude.exe): MCP tools get
  `inputJSONSchema: ndi(P.inputSchema, overrides)`. `ndi` only replaces property descriptions where an
  official-plugin override exists. The API request then sends `input_schema: m` with `m = inputJSONSchema`; `L6b`
  only deletes properties for a fixed per-tool list. The bridge's schema therefore reaches the Anthropic API
  unchanged, `$schema` key included. `execution` is not sent.
- **Claude Code defers these tools.** In this very session all 28 `mcp__opencode__*` tools are listed as deferred
  (names only), and a schema is loaded and paid for only when ToolSearch selects that tool. So in Claude Code the
  upfront cost per session is about 28 names plus the 1.5 KB of server instructions (server.js:523-537). The size
  of each tool is paid when that tool is loaded (run_opencode_agent: 7.8 KB, about 2k tokens). Tool search is
  controlled by `ENABLE_TOOL_SEARCH` (`auto`, `auto:N` or `true`) and is turned off when `ANTHROPIC_BASE_URL`
  is not a first-party host (strings in claude.exe). In this configuration the premise "paid by every Claude Code
  session before any work" does not hold.
- **Codex CLI 0.159.3** (strings in codex.exe): the MCP tool schema is parsed into a serde
  `struct JsonSchema with 15 elements` with the fields `$ref, type, description, encrypted, enum, items, minItems,
  properties, required, additionalProperties, anyOf, oneOf, allOf, $defs, definitions`, plus a separate `const`
  struct. This Codex version therefore models `$ref`, `$defs` and `definitions` and drops every other keyword
  (`pattern`, `minLength`, `maxLength`, `minimum`, `maximum`, `exclusiveMinimum`, `maxItems`, `$schema`).
  Applying the same filter to the dump gives 48.5 KB of schema instead of 54.8 KB: about 6.2 KB of constraints
  never reach a Codex model. The strings `defer_loading` and `namespace` also appear in codex.exe.

Assumed or not verified:
- Whether the Anthropic Messages API accepts `$ref`/`$defs` in a non-strict `input_schema`. The bundled claude-api
  reference does not say, and testing it needs a paid call. The question does not matter much, given section 2
  (at most 0.7 KB to gain).
- Whether Codex actually resolves `$ref` end to end, as opposed to only carrying it. This is inferred from the
  struct fields, not tested.
- Whether Codex 0.159.3 defers MCP tools by default, i.e. whether it pays the 62 KB upfront. Not verified, and
  `~/.codex/config.toml` has no tool-search or defer setting. The lead's "every Codex session" claim holds only if
  Codex sends all MCP tools eagerly.
- log.md has **no** entry about the 2026-09-24 cleanup or about flattening schemas (searched for "tools/list",
  "36", "KB", "inputSchema" and "advertis"). The phrase "scopeContract is .strict() and callers send its nested
  fields" comes from the user's auto-memory file `project-bridge-review-findings-20260923.md`. The cleanup itself
  is commit 5f82472 ("One shared job schema for the four job tools ... tools/list 59.6 KB -> 36.6 KB").

## 4. Reduction plan

Design point: do **not** shrink the zod shapes. The SDK strips unknown top-level keys, so removing a field from a
shape turns an explicit refusal into a silent ignore. The code deliberately avoids that (Q-007 comment at
lib/lock-plan.js:694-695, Q-018 comment at lib/tools/pipelines.js:33). Instead, add one **advertisement
transformer** for `tools/list`:
- After all the `register*Tools` calls, wrap the ListTools handler. The low-level `Protocol.setRequestHandler`
  simply overwrites the existing handler (sdk shared/protocol.js:886-893).
- Post-process each tool's JSON from a per-tool table: fields to hide, descriptions to shorten, objects to show as
  opaque.

Validation stays the current zod schema, so every caller that works today keeps working and every refusal keeps
its errorType. Three tests read `server._registeredTools[...].inputSchema` (review-integration-batch.js:469,
review-integration-recovery.js:398, review-provider-wait.js:272); the transformer does not affect them. Also add a
size guard next to tests/review-split-lib-pin.js:76, which already calls listTools: fail when the list exceeds a
total and a per-tool budget. No test guards the size today, which is why the regression went unnoticed.

Projected sizes, applied cumulatively to the HEAD dump (`project.mjs`; results in `projection.txt`):

| step | change | must callers send something different? | after step |
|---|---|---|---:|
| 0 | HEAD | | 63,740 B (62.2 KiB) |
| 1 | drop `$schema` and the default `execution` (per the spec, an absent taskSupport means forbidden: sdk types.js:1215-1222) | no | 61,164 B (59.7 KiB) |
| 2 | hide the options a tool refuses (queue-only options on run/parallel/validate; options parallel does not support) | no; the refusals stay because validation is unchanged | 56,159 B (54.8 KiB) |
| 3 | hide the legacy `scopeContract` aliases (`agent, role, scope, actions, validation, timeoutMs, timeoutPolicy, shared, serialOnly`) and the mode spellings `read-only`/`readonly` | no; still accepted. No documented caller sends them (claude/CLAUDE.md:16-19, codex/agents/principal-engineer-orchestrator.toml:36-40, the job shapes in ~/.claude/CLAUDE.md) | 50,385 B (49.2 KiB) |
| 4 | hide rare top-level job fields (`orchestratorMode`, `userAuthorizedOrchestrator`, `contractorAuthorizationToken`, `allowFallbackToBuild`, `subagentStrategy`, `proxyAgent`, `lockType`, `sharedFiles`, `serialOnly`) | no; still accepted. The orchestrator is used only when the user names it. Keep the fields documented in REFERENCE.md | 47,809 B (46.7 KiB) |
| 5 | limit descriptions to about 120 chars per field and about 240 per tool; move the detail to docs/REFERENCE.md (most of it is already there, e.g. REFERENCE.md:101 and :103) | no | 41,389 B (40.4 KiB) |
| 6 | show `jobs.items` of run_opencode_parallel and validate_delegation_plan as an object "with the fields of run_opencode_agent" | nothing changes on the wire, but there is an ergonomics risk: a model that loads only run_opencode_parallel (Claude Code loads tools one by one) no longer sees the field names. Mitigate with the description and the job shapes in CLAUDE.md/AGENTS.md | 34,502 B (33.7 KiB) |
| 8 | show `previewReceipt` as an opaque object ("pass back the dry run's receipt unchanged") | no; callers echo it back unchanged and it is still validated strictly | 32,798 B (32.0 KiB), applied after 1-6 without 7 |
| 7 | fold the operator tools (set_opencode_concurrency, pause/resume_opencode_provider, requeue_opencode_job, resolve_integration_quarantine, inspect_opencode_queue_recovery, verify_sanitized_workspace, abandon_multi_agent_pipeline, list_agent_locks) into one `opencode_admin {action, cwd, args}`, and stop advertising acquire/release_agent_lock (CLAUDE.md and the server instructions already say never to call them) | **yes**: callers and docs that name those tools must change, and tests that call them through `_registeredTools` must follow | 27,353 B (26.7 KiB), after 1-6 |
| 9 | advertise the 6 pipeline tools only when an env flag such as `CODEX_OPENCODE_ENABLE_PIPELINES=1` is set | **yes**, for pipeline users (memory notes 1 pipeline ever, cancelled) | 19,394 B (18.9 KiB), after 1-8 |

Summary: the behaviour-preserving steps (1-6 and 8) reach **about 32.8 KB (32.0 KiB, -49 %)**. The original
**<20 KB** target needs the caller-visible steps 7 and 9 as well (**about 19.4 KB**). After all steps the largest
tools are enqueue_opencode_job 4.9 KB, run_opencode_agent 4.0 KB, integrate_opencode_worktrees 3.1 KB and
integrate_opencode_worktree 2.8 KB. The step-5 projection uses plain truncation; short descriptions written by hand
should land within a few hundred bytes of it.

Not recommended:
- shared `$defs`: they cannot reach across tools, and save at most 0.7 KB;
- moving the advertised `scopeContract` into a separate tool: callers would have to send something different.

Order of work:
- Steps 1-4 and 8 are mechanical and low-risk: one transformer, one table and one size test.
- Step 5 is editorial work.
- Step 6 needs a decision on model ergonomics.
- Steps 7 and 9 need the owner's decision, plus doc and CLAUDE.md/AGENTS.md updates for both clients.

## 5. Why it grew from 36.6 KB to 62.2 KiB

Per-commit series (first-parent commits that changed the size):

| first-parent commit | date | subject | tools | tools/list B | delta B |
|---|---|---|---:|---:|---:|
| 5f82472 | 2026-09-24 | refactor: make the bridge lean and fast (baseline) | 22 | 36576 | |
| fe43942 | 2026-09-28 | fix: harden the bridge for long multi-day delegated runs | 22 | 36888 | 312 |
| 2099723 | 2026-09-29 | fix: findings from the charGPT migration phase 1 | 22 | 37152 | 264 |
| 43c3608 | 2026-09-29 | fix: findings from the charGPT migration phase 2 | 22 | 37415 | 263 |
| 994daa3 | 2026-09-29 | fix: findings from the charGPT migration phase 3 | 22 | 37600 | 185 |
| 4dedea0 | 2026-09-29 | feat: pipeline finalization gates require an explicit GATE_VERDICT | 22 | 37631 | 31 |
| a299993 | 2026-09-29 | Merge branch 'review/spawn' into bridge/migration-fixes | 22 | 38103 | 472 |
| dcb86de | 2026-09-29 | Merge branch 'review/integration2' into bridge/migration-fixes | 22 | 38113 | 10 |
| 707dbce | 2026-09-29 | fix: wire the .git control-surface check into write jobs | 22 | 38096 | -17 |
| c14aa7d | 2026-09-29 | fix: make parallel runs, usage, provider retries and phase timing visible | 22 | 38192 | 96 |
| 5fd4ee2 | 2026-09-30 | fix(results): compact parallel blocks, stored run results (B-031, B-032) | 22 | 38830 | 638 |
| 7ca02e7 | 2026-09-30 | Merge bridge/long-run-hardening (review2, B-030) | 22 | 38991 | 161 |
| ccdc656 | 2026-09-30 | Merge branch 'bridge/g01-quarantine-resolve' (resolve_integration_quarantine) | 23 | 40448 | 1457 |
| f981277 | 2026-09-30 | fix: review fixes after merging G-04, G-10, G-05, G-01 | 23 | 40222 | -226 |
| 43aaa18 | 2026-10-01 | Merge branch 'bridge/queue-features' (requeue_opencode_job, set_opencode_concurrency) | 25 | 44180 | 3958 |
| ca088bb | 2026-10-01 | Merge branch 'bridge/batch-integration' (integrate_opencode_worktrees) | 26 | 49669 | 5489 |
| 6f3a15b | 2026-10-02 | Merge branch bridge/flex-scheduling (B-060..B-073, Q-005..) | 28 | 60443 | 10774 |
| 5afb903 | 2026-10-03 | Merge branch bridge/prod-ratefix | 28 | 61024 | 581 |
| 29bd881 | 2026-10-03 | Merge branch bridge/prod-review-fixes | 28 | 61459 | 435 |
| 977687a | 2026-10-05 | feat(mcp): expose worktree continuation with queue lineage and refusals | 28 | 62784 | 1325 |
| 868fb49 | 2026-10-08 | feat(jobs): expose provider holders and caller slot-wait budgets | 28 | 63740 | 956 |

The flex-scheduling merge 6f3a15b (+10,774 B) breaks down as +2,042 B on each of the four job tools (`models`,
`maxAttempts`, `autoIntegrate`, `selfCheckCommands`, `selfCheckPasses`), the new pause/resume tools (+1,653 B),
+640 B on the pipeline tool and +311 B on set_opencode_concurrency.

By cause (HEAD vs 5f82472, `node cmp.mjs revs/5f82472.json tools-list.json`):

| cause | bytes | commits |
|---|---:|---|
| 6 new tools: integrate_opencode_worktrees 5,207; set_opencode_concurrency 1,921; requeue_opencode_job 1,279; resolve_integration_quarantine 1,230; pause_opencode_provider 1,092; resume_opencode_provider 561 | 11,290 | I-002 51c2da4 (via ca088bb); Q-002 841be09 and Q-001 a9f418d (via 43aaa18); G-01 5eb55d0 (via ccdc656); B-062 7e744ff (via 6f3a15b); per-provider limits B-130..135 65eebfe |
| growth of the shared job shape, x4 copies (3,107 B per copy) | 12,428 | per copy: `models` 466 + `maxAttempts` 211 (B-064 d603b70); `autoIntegrate` 410 (B-067 941ad00); `scopeContract.selfCheckCommands` 619 + `selfCheckPasses` 254 (B-066 c43bf04, B-068 3729695); `validationFixPasses` 389 (Q-004 bffc938); `continueWorktree` 273 (Q-018 977687a); `maxWaitMs` 226 (868fb49); longer `lockType`/`timeoutMs`/`modelRequirement` descriptions about 160 |
| run_opencode_parallel: description and `detail` | 489 | B-031/B-032 5fd4ee2 |
| integrate_opencode_worktree: `acceptFlaggedSecretLines`, `acceptBinaryHunks`, `previewMode`, longer description | 1,298 | G-05, b2a52a1, 5fd4ee2, I-001 |
| create_multi_agent_pipeline: scopeContract growth + `continueWorktree` | 757 | |
| get_opencode_job, list_opencode_jobs, list_multi_agent_pipelines, finalize, acquire_agent_lock | 896 | |
| **total** | **27,164** | |

Root cause: the 2026-09-24 cleanup created one shared `jobInputShape` and spread it into four tools. Every job
option added since then is paid four times. Seven such options were added between 2026-10-01 and 2026-10-08, several
with descriptions of 250-560 chars. That includes options three of the four tools explicitly refuse, which take
4.8 KB of the current list. Add six new operator/integration tools (11.3 KB) and the absence of any size budget in
the tests, and the list grew by 74 %.

## Files (all in this directory)

- `tools-list.json`: HEAD dump. `revs/*.json`: one dump per measured commit. `series.txt`, `table-series.md`:
  the history series.
- `analyze.mjs`: fragment analysis. `cmp.mjs`: per-tool diff of two dumps. `project.mjs` / `project-a.mjs`: plan
  projection. `projection.txt`, `projected-final.json`: its output.
- `measure-tools.mjs`: copy of the deleted `.measure-tools.mjs`. `measure-rev.sh`: per-commit runner. The `revs/src-*`
  trees are kept; their `node_modules` junctions were removed.
