# Choose a delegation mode

Mode describes how work is arranged. Worker describes which CLI/provider executes it.
Choose these separately; a catalog of CLI Skills does not make every CLI a managed
Bridge worker.

| Mode | Good fit | Execution and review |
| --- | --- | --- |
| Direct | Small, obvious change with little delegation benefit | Current client does the work under project instructions. This is not a delegated job. |
| Managed Light | One bounded implementation or investigation | One sequential `run_opencode_agent` call with `executionMode: "light"`; managed OpenCode or explicitly enabled Codex. |
| Managed Parallel | Independent deliverables with compatible, disjoint file/resource ownership | Validate the delegation plan, then use `run_opencode_parallel`; inspect individual results and combined behavior. |
| Durable Queue / Pipeline | Jobs requiring scheduling, persisted state, dependencies or staged completion | Use the registered queue/pipeline schemas and their actual final gates. Queueing is distinct from simply launching more parallel calls. |
| Independent delegate | The user chooses an original CLI-specific workflow | Use its locally installed relay/helper and review procedure in an exclusive approved workspace. |

## Managed worker choices

- **OpenCode:** managed profiles and the common Bridge executor. Use
  [the OpenCode guide](../library/bridge-delegate-opencode/SKILL.md) for Light.
- **Codex:** optional external runner, explicitly enabled and model-allowlisted. Use
  [the Codex guide](../library/bridge-delegate-codex/SKILL.md) for Light requirements.
- **Pi:** optional, explicitly accepted unsandboxed-worktree file-editing route. Use
  [the Pi guide](../library/bridge-delegate-pi/SKILL.md); Pi is not a Light worker.

A Claude Code or Cursor MCP client can coordinate Bridge work without being an included
managed Claude/Cursor worker. Independent Claude/Cursor delegate Skills are separate routes.

## Independent worker choices

The bundle includes the original delegate workflows for agy, aider, claude, cline, codex,
commandcode, copilot, cursor, grok, kimi, muse, omp, opencode, pi, qoder, vibe, warp and
zcode, plus the delegate-setup and codex-background helpers. Load the selected entry from
[the catalog](catalog.md). These names identify packaged workflows, not proof that every
CLI/provider is available or verified on the user's platform.

## Continuation, permissions and integration

Related managed writer steps can use a retained worktree with an explicit delta brief.
`continueWorktree` preserves files, not prior model-session memory. Independent relays
have their own continuation semantics.

Bridge routes share ownership, scope validation, worktree handling, cancellation/recovery
and receipt-bound integration where applicable. These controls are not a complete OS
sandbox. Independent relays retain their own controls; keep them away from resources
owned by active Bridge writers.

The coordinator reviews actual code and check evidence in every mode. Never infer
correctness from a worker's report, or authorize commits/provider spending merely by
installing a Skill. Choose mode and worker based on the task and real capacity; make
speed/cost claims only from comparable measured results.
