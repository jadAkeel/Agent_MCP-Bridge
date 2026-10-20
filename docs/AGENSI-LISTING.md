# Agensi listing draft

Status: English copy for limited-beta submission candidate 0.1.0-rc.2. Pricing, runtime download URL,
publication and platform acceptance are pending. This is not a published listing.

## Title

Agent MCP Bridge Beta - Flexible Coding Delegation

## Short description

Choose the right delegation workflow: one bounded task, parallel coding work, durable
queues/pipelines, or an independent CLI delegate. Coordinate execution, review the diff,
and integrate managed work through Agent MCP Bridge.

## Full description

Different development tasks need different delegation strategies. Agent MCP Bridge helps
your coding agent choose a suitable route, give workers a focused brief, inspect the
actual result, and finish with reviewed changes.

Use sequential Light execution for a bounded task, validated parallel execution for
independent work, or durable queues/pipelines for scheduled and staged jobs. When you
prefer a specific independent CLI workflow, select its original delegate guide instead.

The package combines an original orchestration entrypoint, Bridge planning/execution/
learning guides, three managed worker guides, and an attributed library of 18 independent
delegate workflows with two optional support utilities. References, scripts and licenses
are included in the submission; local execution prerequisites remain explicit.

### What you can do

- Choose the execution mode based on task size, dependencies and available tools.
- Delegate one bounded managed task through OpenCode or explicitly enabled Codex.
- Coordinate managed parallel work with declared file/resource ownership.
- Use existing Bridge queue/pipeline tools for durable workflows.
- Follow original independent workflows for Claude, Cursor, Kimi, Aider and other
  packaged CLI delegates.
- Inspect real code/test evidence and integrate managed work using a reviewed preview
  receipt.

### Requirements

Managed execution requires a separate local Agent MCP Bridge runtime, Node.js >=22.13.0
with npm, Git, OpenCode 1.18.32, an MCP-capable client, and your own authorized
provider/model access. The installer has Claude Code, Codex and Cursor selections.
Windows has the strongest local evidence; Ubuntu/macOS CI exercises native fixtures,
not real client/provider acceptance. Cursor desktop acceptance is not established.
The final distributed candidate still needs a real client workflow and an independent
tester. This Beta does not promise a turnkey working default provider.

Independent delegates require their corresponding local CLI, authentication and any
documented helper configuration. They use their own permissions and review procedures.
Optional Pi execution requires explicit unsandboxed-worktree acceptance and supports
trusted file-editing tasks, not Light mode.

Provider usage or subscriptions are separate from the Skill price. Installing this Skill
does not authenticate accounts or select a paid model for you.

### Included materials and attribution

The submission has one top-level skill folder containing SKILL.md, setup/mode/compatibility references, an indexed
reference library, executable upstream support files, and ISC/MIT licenses and notices.
The original delegate library is by Ahmed Mohammed (amElnagdy), included under MIT at a
pinned revision. The Bridge integration and orchestration material build on that work;
the original delegates are also obtainable from their upstream project.

## Suggested first prompt

> Use Agent MCP Bridge to inspect this repository and recommend an appropriate delegation
> mode for one small task. Explain the required tools and selected model before execution.
> After I authorize the task, review the actual changes and checks before integration.

## FAQ

### Does this include an AI subscription or hosted execution?

The package supplies instructions and supporting files. Managed execution runs through
your local Bridge installation and authorized provider. Provider costs are separate.

### Can I obtain the independent delegate files through the companion package?

Yes. The Bridge installer can copy the included original Skill folders, scripts,
references and licenses. Visiting or cloning their upstream repository is not required
for those packaged files. The selected CLI binaries/authentication are still prerequisites.

### Are all delegates managed by Bridge?

Managed OpenCode, explicitly enabled Codex, and optional Pi use the supported Bridge
routes. The 18 original independent delegates retain their own CLI execution workflows.
The mode guide explains the applicable controls for each route.

### Does this guarantee cheaper or faster development?

Mode selection helps match work to the available tools. Actual time, quality and cost
depend on the task, provider and review requirements; no general savings are promised.

## Seller fields to finalize

- Price: owner decision; a free/limited beta is an available launch choice.
- Matching runtime download URL, version and SHA-256: supply the exact accepted artifact.
- Support contact: owner-supplied public contact or project issue tracker.
- Platform review status: record after submission, not before.
- Paid payout eligibility/setup: complete if the owner chooses paid distribution.

## Installation and bounded Beta example

Obtain runtime candidate **1.0.0-beta.1** with its `ARTIFACTS.json` and `SHA256SUMS`.
Verify the ZIP digest, extract to a new folder, and run the installer there:

```text
node bin/install.js --dry-run --client codex --workers opencode --delegates opencode
node bin/install.js --yes --client codex --workers opencode --delegates opencode
```

Review the preview before applying. Install Node/npm, Git, OpenCode 1.18.32 and your
selected client separately, and sign in through their normal supported flows. The
Marketplace Skill installs neither Runtime, CLIs nor model subscriptions.

Example after selecting and authorizing a provider/model and budget:

> In my disposable project, read the tax rule from policy.txt. Change only src/tax.js
> in a managed worktree to implement it. Run node --test tests/tax.test.js, have a
> read-only reviewer inspect the actual diff, and show the integration preview.
> Apply only the patch I approve using that exact preview receipt, then verify the
> final behavior and that my notes.txt is unchanged.

The example is an acceptance recipe, not a recorded successful provider run. Parallel
and durable modes have fixture coverage; sustained real-provider batch behavior and
universal delegate support are not claimed. Provider availability, account limits and
model output quality are external requirements. Pi is an optional explicitly accepted
unsandboxed-worktree route. Recovery of retained work requires review.

Runtime publication/download URL and the final hash mapping belong in the companion
candidate record before this draft can be submitted. Public support:
https://github.com/jadAkeel/Agent_MCP-Bridge/issues.
