# Orchestrator DAGs with Beads

[Beads](https://github.com/gastownhall/beads) stores task status and blocking dependencies across sessions. The approved Superpowers plan defines requirements and acceptance criteria. The orchestrator chooses how to run eligible work and owns integration and verification.

Install the Beads CLI and its Codex skill from the [official distribution](https://github.com/gastownhall/beads/blob/v1.3.4/docs/getting-started/installation.md). Use an approved embedded store for the project. To keep an external store outside the checkout, point `BEADS_DIR` to that store, initialize it from a directory outside Git with `bd --sandbox init --stealth --skip-agents --skip-hooks --non-interactive --prefix bridge`, and set `dolt.local-only` to `true`. Set `BD_DISABLE_METRICS=1` and `DOLT_DISABLE_EVENT_FLUSH=1` in the shell before running `bd`. Check the selected store with `bd --sandbox where --json`.

1. Create an epic for the approved DAG, one bead per task, and a join bead for any stage that requires combined verification. Link each bead to its plan step and acceptance evidence.
2. Add blocking edges with `bd --sandbox dep add <dependent> <prerequisite>`. Find eligible work with `bd --sandbox ready --parent <epic-id> --json`.
3. As the sole writer to the embedded store, claim the chosen bead with `bd --sandbox update <id> --claim`. When delegating, record the run or job ID, workspace, and next review step on the bead. Resume an in-progress run from its receipt before dispatching more work for that bead.
4. Close a task after accepting its result. Close a join after integrating its predecessors and passing the combined checks. Dependent work starts from that verified candidate.

For standalone OpenCode Light, use the [optional submission adapter](../adapters/codex-background-submit/README.md). For a managed Bridge task that needs a nonblocking dispatch, use `enqueue_opencode_job` when its contract fits. Either route leaves the result review with the orchestrator.
