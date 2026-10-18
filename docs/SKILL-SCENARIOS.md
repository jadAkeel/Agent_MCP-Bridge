# Skill scenario review

Coordinator source review of the packaged guidance; this is NOT model-adherence evaluation.
The mechanical gate checks integrity, format and standalone links independently.

| Scenario | Expected decision / source-reviewed rule |
| --- | --- |
| Tiny direct edit | bridge-plan chooses direct, normal checks |
| One bounded task | Light, one managed single-job executor |
| Independent modules | Validate plan, protected parallel and compatible resources |
| Disjoint files, shared DB/port/cache | Assign resource owner; serialize conflicting checks |
| Schema/migration | One serial owner |
| Real predecessor | Start from reviewed actual files, supported calls, no invented dependsOn |
| Continued worktree | Files continue; explicitly transfer decisions, no inherited session memory |
| Running check | Wait for existing executor |
| Matching passing check | Inspect receipt and reuse, still inspect source |
| Changed fixture/dependency | Invalidate affected receipt |
| Required independent execution | Execute that distinct gate |
| Integrated candidate | Required combined checks still pending |
| Timeout with useful artifacts | Diagnose unfinished concern, delta recovery |
| Failed model route | Block unchanged route, no fan-out/fallback |
| Quota wait | Authorized cadence, no account rotation |
| Takeover live writer | Cancel owned writer, confirm descendants stopped, preserve artifacts |
| Long task | Meaningful updates, compact waits, no poll required for each update |
| Green tests, incomplete review | Acceptance remains pending |
| Learning incident | Evidence/impact/recurrence/disposition; reviewed canonical correction |

These expected decisions were traced to the three entrypoints and shared references.
An independent behavioral worker evaluation requires a separately permitted bounded model
environment. No live provider evaluation was performed during this implementation.
