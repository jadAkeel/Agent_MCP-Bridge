# Worker profile inheritance and run tracking

## Outcome

Codex Desktop coordinates OpenCode CLI, Codex CLI, and Antigravity CLI workers across Light, Parallel Light, Bridge, and Queue. An operator selects a named profile for each job. Workers inherit the operator's installed, compatible workflows and tools while keeping each account's login and quota identity independent. A desktop operator can look up every dispatched worker after returning to the chat.

## Approaches

1. Reuse a live CLI home directly. This loads familiar tools, but a shared home couples sessions and authentication, allows concurrent settings changes, and can recursively load the orchestrator's Bridge.
2. Copy a complete CLI home for each account. This duplicates customization and risks copying credentials and mutable state. Updates drift across copies.
3. Resolve shared user customizations and CLI-specific settings into each worker launch while keeping named account state separate. The operator chose inheritance from the primary user profile. Use this approach across transports.

## Profile resolution

Resolve a job's configuration in this order: installed user workflow sources, the primary profile of the selected CLI, permitted overrides for the named account, and the runner's execution constraints. Resolve sources at dispatch and record the selected profile ID and the configuration revision or digest. A queued or retried job keeps its account binding. If its binding or required tool changes before execution, report the mismatch and allow explicit resubmission.

Use the host's configured user directories and paths. Keep public defaults portable and operator mappings local. Never copy login stores, cookies, session databases, or credential values from the customization source. Use the selected account's native credential store or an operator-configured credential reference. Do not silently switch accounts or equate different credentials with independent quota. Share concurrency and rate-limit state for aliases known to use the same quota group.

Expose compatible installed workflows, including Superpowers, Spec Kit, Open Kit, and EGM, as native skills where supported and installed. Preserve their relative references and report a missing or incompatible requested workflow. Load harness-native plugins and MCP tools through that CLI's supported mechanism. Preserve user enablement settings and authentication references. A required tool is ready only when the worker can discover and use it in the selected profile. Keep the orchestrator's own dispatch endpoints out of the worker's effective configuration. Apply existing permissions, worktree ownership, and process cleanup rules even when tools are inherited. User-enabled compatible tools carry over when the worker scope permits them. Report an inherited tool that cannot be admitted under that scope. Reject dispatch if the brief requires it.

## Runner support

| Worker | Account selection | Customizations |
| --- | --- | --- |
| Codex CLI | Extend the existing per-job Codex profile mapping and preserve isolated CODEX_HOME authentication. | Load effective worker configuration with the recursive Bridge entry excluded. Verify which user and project settings Codex actually loads. |
| OpenCode CLI | Named provider accounts use separate native data or credential contexts. Primary customization comes from the operator's OpenCode profile. | Verify native plugins, skills, and enabled MCP tools, including CortexKit, GitHub, and Context7 where installed and authorized. Keep signed or pinned release files separate from mutable user inputs. |
| Antigravity CLI | Prove account selection with an installed CLI and two independently authenticated contexts before advertising concurrent personal sign-in. Google documents OS-keyring sign-in and supports Gemini API key or ADC modes. | Load supported skills, plugin and MCP configuration from the primary agy profile. Verify headless skill activation and permissions. Report the account mode actually used. |

If the installed agy CLI has no supported same-Windows-user OAuth selector, use separately authenticated OS contexts only if the operator chooses and verifies them. API key or ADC profiles can be offered as explicitly selected modes with their own quota semantics. Neither implies that personal Google subscriptions can run concurrently under one Windows login.

## Orchestration and tracking

Codex Desktop selects the existing Superpowers workflow for its own implementation. For delegation, it applies installed balanced coordination guidance and the matching CLI-specific guidance before selecting the transport. A worker brief records its scope, owned paths, required tools, acceptance checks, predecessor results, and return format. The orchestrator owns shared foundations, the review of worker results, and joins. Expose a clear diagnostic if a named workflow is absent on the host.

Each accepted dispatch returns a stable run ID before waiting for execution. Save the ID, mode, worker, selected account profile, workspace, state, and a recoverable result reference. Parallel jobs return one ID per worker and a group ID. The status view resolves both active and persisted terminal results from Codex Desktop and distinguishes queued, running, completed, failed, cancelled, and interrupted work. Persist receipts and terminal outcomes locally across chat or process restart. If a worker's state is uncertain, report interruption or recovery required without silently redispatching. Reuse Bridge SQLite and existing relay receipts where possible. Keep live process ownership and cancellation with the transport. Desktop exit may interrupt work when no independently owned on-demand worker remains. Preserve the last known status and recovery details.

## Acceptance

- Register two real Codex accounts, run tasks concurrently, and verify the observed account binding without logging credentials. A quota failure stays attributed to its original account.
- Verify the supported agy account modes with actual jobs. If personal concurrent OAuth is unavailable, record that limitation separately from fixture and API/ADC coverage.
- From the primary OpenCode profile, run a delegated job that invokes an enabled MCP tool and a harmless skill. Repeat through Light, Parallel Light, Bridge, and Queue. Confirm disabled tools stay disabled and per-account login remains distinct.
- Verify a shared skill and a harness-specific plugin from each supported CLI where available. A missing required skill or tool yields an actionable preflight result.
- From Codex Desktop, submit work in every mode, query while it runs, then retrieve the terminal result by the same ID. Repeat after a chat restart. Exercise failed, cancelled, and interrupted workers and verify cleanup of owned processes.
- Run the repository's regression and packaging gates. Verify the Windows installation with the intended release and separately test a fresh-user installation. Publish only portable code, fixtures, and documentation. Keep machine paths and credentials local.\n