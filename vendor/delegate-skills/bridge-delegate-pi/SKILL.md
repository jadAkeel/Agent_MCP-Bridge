---
name: bridge-delegate-pi
description: Use the optional Pi bridge worker for an explicitly authorized file-editing builder/debugger task. Requires enabled Pi runner, explicit unsandboxed-worktree acceptance and exact model allowlist; not a Light, reader or independent pi-delegate route.
license: MIT
metadata:
  version: "1.0.0"
---

# Pi file-editing bridge worker

This guide uses the existing bridge job executor, not the original pi-delegate relay.
Pi is optional and defaults to denial. Confirm runner `pi` is explicitly enabled,
`CODEX_OPENCODE_PI_SAFETY=unsandboxed-worktree` is authorized, Pi >=1.2.0 is available,
and the exact `pi/<provider>/<model>[@thinking]` is allowlisted. Installation alone
does not establish authentication, model availability or acceptance of that safety mode.

Use normal `run_opencode_agent` or queue APIs WITHOUT `executionMode:"light"`.
Only builder/debugger write jobs are supported. Set write:true, bounded lockedPaths,
allowedEdits, and a write Scope Contract with modelRequirement provider:"pi",
model:"<Pi-provider>/<exact-model-id>", variant:"<authorized thinking level>".
Keep managed worktree mode write/all. Do not request reader/sanitized/contractor roles,
broaden permissions or silently switch to another runner. Direct pi-delegate is a
different independent route; never mix its writer with bridge-owned resources.

Pi receives read/edit/write only; shell, MCP, extensions, skills and automatic project
context are disabled. Assign real checks to the coordinator/test executor. The bridge
owns locks, provider slots, process supervision, post-run scope/target checks, validation
and reviewed integration. A worktree/tool list is NOT an OS security sandbox: same-user
filesystem access is not prevented. Use trusted inputs within the user's accepted host
boundary; never describe the mode as sandboxed or as supporting read-only containment.

Follow [coordination](../references/coordination.md) and
[verification](../references/verification.md). Preserve actual run ID, partial edits,
terminal/cleanup/quarantine evidence and check receipts. Inspect source/diff, then preview
and apply through the exact reviewed integration receipt under existing authorization.
No automatic commits, live smoke, account switching or model fallback.
