# Pi worker delivery — 2026-10-14

## Checkout and design

- Base: local `main`, `2f66a10593513f6930dea1a901f361bad5172f7f`.
- Branch: `codex/pi-worker`.
- Worktree: `C:\Users\10User\bridge-pi-worker`.
- Original checkout: `C:\Users\10User\codex-opencode-mcp`; clean on entry and
  at final verification, still at `2f66a10593513f6930dea1a901f361bad5172f7f`.
- No new bridge dependencies; `package-lock.json` is unchanged.
- Existing test assertions and the canonical `test:commands` inventory are unchanged.
  Pi has its own `test:pi` command, so it can run without installing Pi or signing in.

The adapter uses the existing model-allowlist/external-runner seam. No new queue,
lock, worktree manager, process supervisor, retry/model-fallback system, or
integration path was introduced. See [installation and safety](pi-worker.md).

Official upstream and npm metadata were checked directly: original Pi is now
`@earendil-works/pi-coding-agent@1.2.0`, CLI `pi`, from
`https://github.com/earendil-works/pi` (the old `badlogic/pi-mono` URL redirects).
This is not Oh My Pi. The adapter requires the current 1.2.0 protocol floor.

## Changed files

| File | Change |
|---|---|
| `lib/pi-runner.js` | Pi flags/model parsing, isolated runtime, safety refusals, JSONL completion and usage parsing |
| `lib/external-runners.js` | Optional Pi dispatch, executable/version/hash checks, shared supervision/leases/guard, model and protocol errors, quota pauses, status |
| `lib/config.js` | Pi executable override and default-deny safety choice |
| `tests/review-pi-runner.js` | 16 isolated test cases; fake CLI with real bridge worktrees/scope checks/supervision |
| `tests/isolated-runner-checks.js` | Disposable profiles/state/Git configuration when running existing runner regressions |
| `tests/pi-offline-smoke.js` | Optional real Pi + loopback mock provider test and Windows metadata-startup sampler |
| `package.json` | `test:pi` script only |
| `README.md` | Optional worker entry point |
| `docs/pi-worker.md` | Installation, selection, roles, credentials, safety and protocol contract |
| `docs/pi-worker-delivery.md` | This verification/delivery record |

## Commands and results

All edits and validation ran in the new worktree. The initial worktree creation
command ran from the original checkout after inspecting its instructions,
`git status --short --branch`, `git worktree list --porcelain`, branch list, and
recent log:

```powershell
git worktree add -b codex/pi-worker "C:\Users\10User\bridge-pi-worker" main
```

Bridge dependencies were installed into the new worktree with lifecycle scripts
disabled and disposable npm user/global config and cache:

```powershell
npm ci --ignore-scripts --no-audit --no-fund --userconfig "C:\Users\10User\bridge-pi-worker\tmp\npm-user.npmrc" --globalconfig "C:\Users\10User\bridge-pi-worker\tmp\npm-global.npmrc" --cache "C:\Users\10User\bridge-pi-worker\tmp\npm-cache"
```

Result: 94 packages installed, exit 0. The npm user config specifies only the
public npm registry, `audit=false`, `fund=false`; global config is empty.

| Exact command (cwd = new worktree) | Actual final result |
|---|---|
| `node tests/review-pi-runner.js` | **16/16 passed**, zero skips |
| `node tests/isolated-runner-checks.js tests/review-flex-runners.js tests/review-provider-wait.js tests/review-spawn.js` | **23/23**, **22/22**, **43/43** cases passed; one existing optional symlink subcheck skipped because Windows symlink privilege was unavailable |
| `node tests/isolated-runner-checks.js tests/review-flex-defaults.js tests/review-production-startup.js tests/review-split-lib-pin.js tests/review-flex-self-check.js` | **6/6**, **2/2**, **11/11**, **8/8** passed, zero skips |
| `node --check lib/pi-runner.js` | Passed |
| `node --check lib/external-runners.js` | Passed |
| `node --check lib/config.js` | Passed |
| `node --check tests/isolated-runner-checks.js` | Passed |
| `node --check tests/review-pi-runner.js` | Passed |
| `node --check tests/pi-offline-smoke.js` | Passed |
| `git diff --check` | Passed |

The Pi fixture suite covers opt-in selection, exact argv/tool restrictions,
resource/preload environment stripping, final-result and usage parsing,
malformed/incomplete/retrying/aborted/length-limited output, model mismatch,
default-deny and unsupported role/mode refusals, version/executable/hash checks,
in-worktree success, out-of-scope/forbidden edits, unverifiable/modified target
checkout, provider quota pauses, pre-start cancellation, active cancellation,
timeout, descendant exit, lease release, and status reporting.

Fixture failures during development exposed an incorrectly cached rejected Pi
version; the cache now records only versions meeting the Pi floor. Fixture
assertions were also corrected to respect frozen configuration and the existing
Windows best-effort cleanup contract. The final results above are after these
corrections.

### Real Pi, without live provider access

The actual official npm CLI was installed under ignored `tmp/pi-real`, not
globally or into bridge dependencies:

```powershell
npm install --prefix "C:\Users\10User\bridge-pi-worker\tmp\pi-real" --ignore-scripts --no-audit --no-fund --save=false --package-lock=false --userconfig "C:\Users\10User\bridge-pi-worker\tmp\npm-user.npmrc" --globalconfig "C:\Users\10User\bridge-pi-worker\tmp\npm-global.npmrc" --cache "C:\Users\10User\bridge-pi-worker\tmp\npm-cache" @earendil-works/pi-coding-agent@1.2.0
node tests/pi-offline-smoke.js "tmp/pi-real/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
```

The first installation attempt exceeded a 120-second terminal budget. After
confirming that no installer process remained, the same command completed with
a longer budget. An initial standalone smoke harness left stdin open and timed
out; it was fixed to send EOF, matching the bridge supervisor's ignored stdin.

Final real-Pi result: **Pi 1.2.0, 26 JSONL events, two loopback HTTP requests,
actual `write` tool execution, final report recognized, usage 24 input / 16
output counted once across two turns**. Only a local synthetic model catalog and
fake credential were used. The fixture endpoint asserts that the real model
request exposes exactly `edit`, `read`, and `write`. A poisoned project extension
was not loaded. This is real Pi execution with a mock provider, not real model
inference and not a full bridge run with a live provider.

### Local metadata-startup measurement

```powershell
node tests/pi-offline-smoke.js "tmp/pi-real/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "C:\Users\10User\.opencode\bin\opencode.exe"
```

Environment: Windows, Node `v24.11.1`, Pi `1.2.0`, OpenCode `1.18.32`.
Both commands were **`--version` only**, each launched by the same PowerShell
process API with the same disposable HOME/config and cwd, one excluded warmup,
then five alternating measured pairs. Timers exclude PowerShell startup. Memory
is a 5-ms-sampled direct-process peak-working-set lower bound; it excludes bridge,
supervisor, descendants, and short-lived unsampled peaks.

| CLI | Raw elapsed ms | Median elapsed | Median sampled peak working set |
|---|---|---:|---:|
| Pi | 254.7139, 252.9388, 239.7894, 243.0851, 244.1703 | **244.2 ms** | **93.72 MiB** |
| OpenCode | 587.0927, 584.2222, 564.8969, 578.9167, 576.0878 | **578.9 ms** | **195.96 MiB** |

Raw sampled bytes: Pi `97890304, 98553856, 98271232, 98869248, 97247232`;
OpenCode `205168640, 205959168, 205979648, 205070336, 205475840`.
These are metadata-startup observations, **not** worker/coding-task latency,
end-to-end bridge cost, cold-disk performance, or a token-efficiency comparison.
The timed smoke run initially used a single mock-provider text turn; the final
smoke above additionally verifies a real tool turn without rerunning the timing
sample. No lower task latency or token use is claimed.

## Safety and remaining verification limits

- Pi execution defaults to refusal. Explicit `unsandboxed-worktree` mode is the
  only supported Pi safety mode; no read-only or sanitized guarantees are claimed.
- Only builder/debugger writers are supported. No nested subagents, shell,
  arbitrary extensions, MCP, automatic provider/model switching, or personal Pi
  configuration is enabled.
- Worktrees share Git metadata and do not restrict OS filesystem access. Scope
  validation and the target guard detect changes after execution; they do not
  prevent access, data disclosure, transient writes, or arbitrary host damage.
- Windows supervisor cleanup remains `windows_taskkill_best_effort`. Fixture
  checks observed both worker and descendant dead; this is not an OS sandbox or
  a guarantee against escaping/malicious descendants.
- All fixtures isolate HOME, config, bridge state and Git config. No personal
  authentication/configuration was inspected and no paid/live provider job ran.
- Live provider credentials/OAuth, upstream model routing, Linux/macOS operation,
  and adversarial OS sandbox containment were not verified. OAuth/personal
  profile loading and custom `models.json` providers are unsupported by design.
- The entire canonical test suite was not run; relevant existing runner,
  supervision, provider-wait, startup/default, self-check and integrity regressions
  are listed above. Existing assertions are preserved.
- No repo-local `.testsprite/config.json` or `TESTSPRITE_PROJECT_ID` was present.
  No TestSprite/cloud/deployed verification was run; no deployment was made.
- Nothing was committed, merged, pushed, activated, or deployed.

Branch: `codex/pi-worker`

Worktree: `C:\Users\10User\bridge-pi-worker`
