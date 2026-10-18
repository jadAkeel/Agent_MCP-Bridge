# Optional original Pi worker

## Design and safety boundary

Pi uses the existing external-runner dispatch in `lib/opencode-run.js` and
`lib/external-runners.js`. The bridge still owns discovery, admission, locks,
provider leases, queues, worktree creation, process supervision, cancellation,
post-run scope/Git checks, validation, review, and integration. OpenCode remains
the default. OpenCode is still required for existing discovery/admission; Pi
replaces only worker execution, so end-to-end startup can still include OpenCode
probes. There is no new runtime dependency.

**Pi has no built-in security sandbox.** A worktree, tool allowlist, isolated
configuration directory, and post-run checks do not prevent access to other
files as the current OS user. In particular, Pi's `read`, `edit`, and `write`
tools accept paths outside its cwd, and Git worktrees share repository metadata.
The target-checkout guard detects some changes after the fact; it cannot prevent
them or reliably attribute concurrent edits. It does not scan the whole host.

The adapter therefore defaults to refusing Pi execution. The operator must
explicitly accept `unsandboxed-worktree` mode. Use only for trusted inputs in an
environment whose OS permissions/container/VM already provide the desired host
boundary. No sandbox wrapper or OS isolation is installed by this adapter.
Read-only, sanitized, orchestrator/contractor, and roles other than `builder`
and `debugger` are refused. No unsupported safety setting falls back to this mode.
OpenCode role attestation remains a bridge admission check; it is **not** Pi
permission attestation.

Pi receives only `read,edit,write`, with no shell, MCP, extensions, skills,
templates, themes, context-file discovery, or project trust. The bridge performs
validation/self-check commands. This is a file-editing worker, not an autonomous
test runner. Scope/forbidden-file enforcement remains the bridge's post-run
validation; it is not a pre-write filesystem restriction.

## Installation and selection

The combined `node bin/install.js` chooser offers Pi as an optional worker. Equivalent:
`node bin/install.js --yes --workers opencode,pi`. It adds bridge-delegate-pi and records
Pi with safety deny. CLI installation/auth and the exact provider/model allowlist below
remain separate. Explicit chooser acceptance or --pi-safety unsandboxed-worktree is required
to enable that mode. Original pi-delegate (--standalone-delegates pi) is independent of
this adapter; neither route silently substitutes for another. Light excludes Pi.

The original Mario Zechner Pi project now lives at
<https://github.com/earendil-works/pi> (the former `badlogic/pi-mono` redirects
there). It is **not Oh My Pi**. On 2026-10-14 the official npm registry reports
`@earendil-works/pi-coding-agent` version `1.2.0`, executable `pi`, requiring
Node >=22.19.0. The adapter requires Pi >=1.2.0 for the documented flags and
`agent_settled` protocol. Future releases are not automatically certified.

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.2.0
$env:CODEX_OPENCODE_EXTERNAL_RUNNERS = 'pi'
$env:CODEX_OPENCODE_PI_SAFETY = 'unsandboxed-worktree'
$env:CODEX_OPENCODE_WORKTREE_MODE = 'write'
$env:CODEX_OPENCODE_MODEL_ALLOWLIST = 'pi/openai/gpt-4.1@off'
# Optional absolute executable path, otherwise resolved on the bridge PATH:
# $env:CODEX_OPENCODE_PI_EXECUTABLE = 'C:\path\to\pi.cmd'
```

Preserve other runners by listing them too, e.g. `codex,agy,pi`. To select Pi for
a normal bridge write job, set:

```json
{
  "agent": "builder",
  "scopeContract": {
    "modelRequirement": {
      "provider": "pi",
      "model": "openai/gpt-4.1",
      "variant": "off"
    }
  }
}
```

This is a model-selection fragment: supply the usual task, cwd, write scope,
allowedEdits, locks, and validationCommand. Model syntax is
`pi/<Pi-provider>/<exact-model-id>[@thinking]`. Thinking accepts `off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, `max`; omitted means explicit `off`. Pi can clamp
thinking to model capabilities; this is not an attestation of reasoning effort.
No model/provider cycling, fallback, or nested agent is configured. Pi's CLI can
fuzzy-match model IDs; every completed assistant message must report the exact
requested provider/model or the bridge rejects the result.

Credentials must be supplied explicitly through the existing sensitive-env
passthrough policy: `CODEX_OPENCODE_PASSTHROUGH_ENV=OPENAI_API_KEY` and
`CODEX_OPENCODE_ALLOW_SENSITIVE_ENV=true` (provide
the value through your secure environment, never a tracked file). Pi gets a
fresh disposable agent directory and HOME for every invocation. Personal Pi
OAuth, settings, custom providers/models, and project-local resources are not
loaded. Custom providers requiring `models.json` are currently unsupported.

`CODEX_OPENCODE_PI_SAFETY` accepts only `deny` (default) and
`unsandboxed-worktree`. Existing executable SHA-256 pinning accepts `pi=<sha256>`;
provider slots/limits and quota groups accept `pi`. All Pi providers share the
`pi` runner slot key; configure quota groups explicitly when they share an
account with another runner. Idle timeout uses the existing
`CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_BY_MODEL=pi/openai/gpt-4.1=<ms>` setting.

## Protocol and lifecycle

Pi runs once using JSONL output and an in-memory session. Only completed
`message_end` assistant messages contribute text/usage (not deltas, `turn_end`,
or duplicated `agent_end.messages`). A successful result requires a final text
message with `stopReason=stop`, an `agent_end` without retry, and a subsequent
non-aborted `agent_settled`, followed by process exit 0. Malformed, incomplete,
truncated, failed, aborted, mismatched-model, or unfinished-tool streams fail.
Usage maps Pi input/output/cache counts and reported cost to bridge fields;
reasoning tokens are not separately reported. No inference is made about
upstream routing behind a provider.

The existing supervised process runner enforces cancellation, timeouts and
process-tree cleanup. Windows taskkill cleanup is explicitly best-effort, not
guaranteed containment. A reported unconfirmed termination quarantines the provider lease.
Successful runs remove their disposable runtime; failed runs retain a sidecar
for diagnostics. Sidecars may contain sensitive provider/runtime data; handle
them like other bridge state. Automatic Pi retries, compaction and cache warming
are disabled in generated settings, and offline mode disables automatic catalog
and update traffic (it does not disable the selected provider request).

## Official references

- [Package/installation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
- [CLI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md)
- [JSONL](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md)
- [Security](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md)
- [Environment](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/environment-variables.md)
- [Settings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md)

## Verification

`npm run test:pi` (or `node tests/review-pi-runner.js`) uses disposable fake CLI fixtures with real
bridge worktrees, scope checks, leases and process supervision. It does not use
personal credentials or call a provider. Fixture timing is not Pi startup time.
No latency or token-efficiency improvement is claimed. See the [delivery report](pi-worker-delivery.md)
for actual commands, results, and any real offline CLI measurements.

The optional `node tests/pi-offline-smoke.js <official-pi-cli.js> [opencode-exe]`
loads an explicitly supplied real Pi installation with a loopback-only mock
provider, a synthetic credential, and a disposable model catalog. That catalog
is test-only and is not loaded by the production adapter. On Windows, supplying
OpenCode also compares `--version` startup with five alternating measured pairs
after one warmup each, using the same launcher and working-set sampler. This
measures metadata startup, not worker-task latency or model token efficiency.
