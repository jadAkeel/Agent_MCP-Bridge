# Candidate native verification

Candidate: `C:\Users\10User\bridge-skill-packaging-2026-10-14`

Branch: `bridge/skill-packaging-2026-10-14`

The verification commands were run from the candidate path unless explicitly
shown as WSL Linux commands. All installer tests used disposable homes/configs
and scratch Git repositories. No client/provider CLI was installed, credentials
were not read, and no real provider job was run. The full-suite runner uses a
disposable environment and records before/after source digests.

## Windows 11

Environment: Windows 11 build 26200, x64, Node v24.11.1, PowerShell 5.1.

| Exact command | Result | Evidence |
| --- | --- | --- |
| `node bin/verify-isolated.js --node tests/platform-portability.test.js` | exit 0; 3/3 pass | `.test-logs/packaging-1792066683506-21044/report.json` |
| Final `node bin/verify-isolated.js --node tests/platform-portability.test.js` | exit 0; 3/3 pass, including actual Windows npm CLI resolution | `.test-logs/packaging-1792072193821-11912/report.json` |
| `npm run test:platform` | exit 0; 3/3 pass | terminal output; same test source as the isolated receipt above |
| `node bin/verify-isolated.js --node tests/review-setup-cli.js` | exit 0; 37 setup checks pass | `.test-logs/packaging-1792066683539-24592/report.json` |
| `node bin/verify-isolated.js --node tests/platform-suite.js` (`npm test`) | exit 1; `npm test` packaging and Pi checks pass; runner 180/181 | `.test-logs/packaging-1792068833422-24300/report.json`; full run `.test-logs/2026-10-15T12-54-14-725Z-12904/` |
| `node bin/verify-isolated.js --node bin/process-supervisor.js --self-test` | exit 0; passes alone | `.test-logs/packaging-1792071200219-10756/report.json` |
| `git diff --exit-code -- bin/process-supervisor.js tests/review-batch-race.js` | exit 0; both known Windows test sources unchanged | terminal result |

The full suite's single failure was `bin/process-supervisor.js --self-test`,
with `snapshotOk:false` during the full run. It passed immediately when run
alone. This matches the supplied Windows candidate finding and is unrelated to
the installer/client/platform changes. The other supplied failure,
`tests/review-batch-race.js` B-153, **passed** in the full run (16/16, zero test
skips). The six skip-gate items were explicit Windows-only limitations: 4
skips (3 quoted/control-character Git paths, 1 symlink entry) and 2 partial
cases (two symlink-privilege-dependent checks). No required skips were recorded.

## Linux (Ubuntu WSL2, native Linux Node binaries)

Environment: Ubuntu on WSL2, Linux kernel `6.18.54.1-microsoft-standard-WSL2`,
x86_64; portable official Linux Node archives were verified against Node's
published SHA-256 sums and unpacked under a disposable test directory.

| Exact command | Result | Evidence |
| --- | --- | --- |
| `wsl -d Ubuntu --cd /home/jad/bridge-native-20261015/candidate --exec env PATH=/home/jad/bridge-native-20261015/node-v24.11.1-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin /home/jad/bridge-native-20261015/node-v24.11.1-linux-x64/bin/node bin/verify-isolated.js --node tests/platform-portability.test.js` | Node v24.11.1; exit 0; 3/3 pass | `/home/jad/bridge-native-20261015/candidate/.test-logs/packaging-1792067127186-4321/report.json` |
| Same native Node 24 invocation with `--node tests/review-setup-cli.js` | exit 0; 37 checks pass | `.test-logs/packaging-1792067149809-272/report.json` |
| Same native Node 24 invocation with `--node tests/isolated-runner-checks.js tests/review-day5-worker-release.js tests/review-integration-bytes.js tests/review-setup-cli.js tests/review-speedup.js tests/review-attestation-cache.js tests/review-prespawn.js tests/review-validation-tree.js` | exit 0; worker 68/68, integration bytes 25/25, setup 37, speedup 5/5, attestation 7/7, prespawn 9/9, validation tree 12/12; zero skips | `.test-logs/packaging-1792071769419-4329/report.json` |
| Native Node v24.11.1 `node bin/verify-isolated.js --node tests/platform-suite.js` (`npm test`) | exit 1; first post-change full run 172/181; no skips | `.test-logs/packaging-1792067334184-4333/report.json`; `.test-logs/2026-10-15T12-29-02-068Z-5220/` |
| Same native invocation after fixes, `npm test` on Node v22.13.0 | **incomplete**: the 40-minute command limit ended while command 179/181 (`tests/review-f9-startup.js`) was running; no final runner/wrapper receipt and no terminal exit code | `.test-logs/2026-10-15T13-35-00-840Z-5367/manifest.json`; partial `179-review-f9-startup.js.log`; wrapper directory `.test-logs/packaging-1792071291265-4343/` |
| Node v22.13.0 `node bin/verify-isolated.js --node tests/platform-portability.test.js` | exit 0; 3/3 pass | `.test-logs/packaging-1792072068771-4351/report.json` |
| Node v22.13.0 `node bin/verify-isolated.js --node tests/review-f9-startup.js` | exit 0; 8/8 pass, zero skips | `.test-logs/packaging-1792072069828-4470/report.json` |
| Native `resolveNpmCli()`/`existsSync()` probe on Linux Node v22.13.0 and v24.11.1 | exit 0 for both; resolves each portable runtime's actual `lib/node_modules/npm/bin/npm-cli.js` | WSL command output: `/home/jad/bridge-native-20261015/node-v22.13.0-linux-x64/lib/node_modules/npm/bin/npm-cli.js` and `/home/jad/bridge-native-20261015/node-v24.11.1-linux-x64/lib/node_modules/npm/bin/npm-cli.js` |

The first Linux full run exposed a POSIX SQLite locking defect: opening and
closing an extra descriptor for the worker-transition SQLite anchor while a
transaction held `BEGIN IMMEDIATE` released this process's POSIX `fcntl` locks.
The Unix side now verifies the anchor inode using `lstat` without opening it;
Windows retains its content/receipt check. The worker regression tests exercise
separate processes, crash recovery and the A/B/C recovery fence. The other first
run failures were native assumptions in test fixtures or a release fixture
inventory; those fixtures have been made explicit and rerun successfully in
the native Node 24 targeted command above.

The Node v22.13.0 full run did not finish within the 40-minute tool command
limit. The partial log shows command 179 began, but it does not establish its
result; do not count it as a pass or as a full-suite failure.

## macOS

Not run. No native macOS host or runner was available in this environment. The
CI matrix is configured to run macOS, but a configured workflow is not native
test evidence. Therefore macOS support and full cross-platform support remain
unverified until the corresponding native matrix jobs complete.

## CI matrix

`.github/workflows/ci.yml` now defines Windows, Ubuntu and macOS on Node 22.13.0,
latest 22.x and latest 24.x. It runs the focused portability test and isolated
full `npm test`, and retains `.test-logs/` artifacts. CI's required-prerequisite
skip policy remains explicit in the final skip summary; a green matrix job with
unavailable native prerequisites does not prove those individual checks.
