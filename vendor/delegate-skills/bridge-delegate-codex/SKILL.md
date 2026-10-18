---
name: bridge-delegate-codex
description: Execute one bounded sequential Light task with the explicitly enabled Codex external runner through Agent MCP Bridge. Use after bridge-plan selects an authorized Codex route; preserves common ownership and review controls.
license: MIT
metadata:
  version: "1.0.0"
---

# Managed Codex Light delegate

Adapted from the reviewed delegate-skills brief/report workflow. Invoke the existing
`run_opencode_agent` with `executionMode: "light"` and
`scopeContract.modelRequirement` naming the authorized `codex` provider/model/variant.
The bridge must already explicitly enable `codex` in external runners and allowlist the
exact model. Installing this skill does not enable a runner, choose a model or authorize
provider inference. Codex >=0.159.0 is the existing runner floor; event evidence uses
0.159.3. Do not broaden permissions or disable required model evidence to make it work.

Use one brief: goal/acceptance, input/predecessor decisions, owned/forbidden paths,
invariants/resources, actual commands and check executor, stop conditions and report.
Writer: builder/debugger, write Scope Contract, lockedPaths, allowedEdits and managed
isolated worktree. Follow [coordination](../references/coordination.md) and
[verification](../references/verification.md).

The bridge resolves native executables/npm shims without a shell, preserves model/effort,
uses workspace-write/read-only, ephemeral execution and ignores ambient user config/rules
to prevent nested MCP startup. It never requests danger-full-access. This is not complete
read containment or an OS boundary around every external tool. Do not launch the upstream
relay in the source checkout or run unmanaged writers beside managed jobs.

Keep the MCP request pending and retain the exact Run id/result. Thread id is diagnostic
evidence only: ephemeral jobs do not support provider session resume. Use `continueWorktree`
for related file continuity with an explicit delta brief, not `--resume-last`.
Cancellation/disconnect uses the same owned process supervisor as other bridge jobs;
confirm stopped descendants or quarantine before takeover. Inspect partial output on failure.
Review actual diff/tests and matching check receipts; do not accept a CLI report alone.
Integrate through the exact reviewed previewReceipt and required combined checks. No commit,
push, account rotation, permission bypass or implicit fallback is authorized.
