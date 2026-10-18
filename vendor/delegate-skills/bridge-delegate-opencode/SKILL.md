---
name: bridge-delegate-opencode
description: Execute one bounded sequential Light task with managed OpenCode through Agent MCP Bridge. Use after bridge-plan selects OpenCode; preserves bridge locks, scope, isolation, cancellation and reviewed integration.
license: MIT
metadata:
  version: "1.0.0"
---

# Managed OpenCode Light delegate

Adapted from the reviewed delegate-skills brief/report workflow. Use the registered
`run_opencode_agent` MCP tool with `executionMode: "light"`; do not launch relay.mjs.
This path uses the tested native Windows OpenCode 1.18.32 lane, managed profiles and
permissions. Other major versions require compatibility evidence, not a silent fallback.

Provide one task: goal/observable acceptance, input/predecessor decisions, owned files,
forbidden paths, invariants/resources, actual check commands with executor, stop/report
conditions. No whole conversation or inherited-memory assumption. A writer uses builder
or debugger, `write:true`, locks, allowedEdits, write Scope Contract and isolated worktree.
Read-only jobs use a managed reader and read scope. Preserve configured model and variant;
an explicit requirement must be authorized/allowlisted. Never add `--auto` or bypass flags.

Follow [coordination](../references/coordination.md) and
[verification](../references/verification.md). One sequential task at a time. For related
follow-ups use `continueWorktree` with a delta brief: this preserves files, not session
memory. The bridge does not resume the last global agent session.

Keep the MCP request pending. Cancellation/disconnect uses the owned process supervisor;
confirm termination/quarantine before takeover. Fetch the exact Run id using
`get_opencode_job`, inspect preserved partial work and actual failure/permission/model
evidence; an exit zero alone is not success. Review source/tests and real check receipts.
Preview retained integration, inspect the patch and apply only with the exact reviewed
previewReceipt. Required combined checks remain pending until run. No automatic commits.
