# Attestation latency before the agent starts: trace, measurements, fixes

Read-only review of `C:\Users\10User\codex-opencode-mcp` at `b74fbc7` (bridge/housekeeping = main), 2026-10-10.
No tracked file was changed. All instrumentation ran on a scratch copy of the bridge
(`scratchpad\deep-review\bridge-copy`) with the client env from `~/.codex/config.toml`
`[mcp_servers.opencode.env]` and `CODEX_OPENCODE_STATE_DIR` pointed at scratch dirs. The live
attestation cache was only copied and read.

## 1. Headline

The large, variable cost is not OpenCode cold starts on a warm cache. It is the **attestation
cache fingerprint**, which B-193 (commit `413b0ae`, 2026-10-08) changed from a stat of about 15
small files to a **full content hash of the 180 MB `opencode.exe` plus all 1,403 files (12 MB)
of the antigravity plugin package tree plus the config/agent/skill dirs**. The bridge computes it
on **every** `cachedAttestation` call, including memory hits, and a direct read-only job makes
**4 such calls** before the agent starts (5 to 7 when a fresh read happens).

Measured cost of one fingerprint (memory hit, nothing else running in the call):

| host state | one fingerprint | 4 per warm job |
|---|---|---|
| quiet (CPU 17 to 30 %) | 0.66 to 1.8 s (typ. 1.3 s) | 3 to 7 s |
| loaded (CPU 75 to 93 %, MsMpEng at 105 %) | 2.6 to 5.2 s (typ. 3.5 to 4.5 s) | 13 to 20 s |
| 4 / 8 concurrent calls in one process | 4.4 s / 7.2 s each | |

Split of one fingerprint (quiet, `harness/fp-alt.mjs`): plugin tree 1.0 to 1.1 s (2.2 to 2.6 s
loaded), `opencode.exe` 0.3 to 0.7 s, PATH lookup of `opencode` 0.06 to 0.26 s, agents+skills 0.06 s.

On top of that, the **10-minute final-attestation window** produces a fresh pre-spawn read
(plugin-policy fingerprint + `opencode debug agent` + two more fingerprints) for the first job
whose cached entry is between 10 and 60 minutes old, even though discovery hit the same entry.

## 2. Trace of a direct `run_opencode_agent` explore job (no worktree, lockMode off)

Code path, with the cache calls marked [C] (each costs one fingerprint even on a hit):

Discovery phase (`lib/execute-job.js:323` to `:409`, and again to `:659`, because a job without a
worktree books its final read to `discovery` too, `lib/execute-job.js:659`):

1. `resolveAgent` (`lib/agent-resolution.js:48`) -> `listAvailableAgents` (`server.js:1857`) [C],
   key `agent-list\0<cwd>`. On a miss it spawns **`opencode agent list`** (`server.js:1867`)
   through `safeOpenCodeCommand`, which first runs `verifyExternalPluginPolicy` [C]
   (`server.js:2251`; on a miss: `hashExactTree` of the plugin tree, `lib/plugin-policy.js:415`,
   then `opencode --pure --version` and `opencode debug config` in parallel,
   `lib/plugin-policy.js:451`). If the agent is not in the list, `debugAgentExists` spawns
   `opencode debug agent <name>` [C] (`lib/agent-resolution.js:52`). Explore is in the list.
2. `readAgentDebugMetadata(actualAgent, discoveryCwd)` (`lib/execute-job.js:403`,
   `server.js:2149`) [C], key `agent-metadata\0explore\0<cwd>` (`server.js:2108`). On a miss:
   `verifyExternalPluginPolicy` [C], `opencode debug agent explore`, plus `opencode debug skill`
   only for managed agents whose skill permission is not denied (`server.js:2182`); explore made
   no `debug skill` call in any trace.
3. `readAgentDebugMetadata(actualAgent, executionCwd)` again (`lib/execute-job.js:650`) [C].
   Without a worktree `executionCwd === discoveryCwd`, so this is the same key and always a hit:
   it is a duplicate fingerprint.

openCodeRun pre-slot (`lib/opencode-run.js:19` to `:205`):

4. `attestForSpawn` -> `reattestAgentMetadata` (`lib/opencode-run.js:145`, `server.js:846`) [C]
   with `maxAgeMs = 600000`. `metadataResult.attestationKey` is always present (every
   `cachedAttestation` result is stamped, `lib/attestation-cache.js:85`), so the reuse branch is
   always taken. It hits only if the **original fresh read** behind the entry
   (`attested_at`, kept through memory and shared hits) is younger than 10 minutes. Otherwise it is
   a fresh read through the cache: fingerprint, `verifyExternalPluginPolicy` [C] (TTL 1 h, no age
   cap), `opencode debug agent explore`, fingerprint again before storing
   (`lib/attestation-cache.js:145`). The fresh result is stored, so the next jobs hit for 10 min.

Cache key composition (`lib/attestation-cache.js:77`, `:201`): `sha256(namespace, stateDir, key,
fingerprint)`, namespace = `sha256(server sha256, lib tree sha256 at startup, V8 version)`. Nothing
per call (no pid, time, or random part). The fingerprint context includes the whole
`buildOpenCodeEnv()` identity except `GIT_*` (`server.js:790`), i.e. PATH, TEMP, TMP and so on:
two bridge processes whose PATH/TEMP differ (likely Codex vs Claude Code) never share entries.
Any change to `server.js` or any `lib/` file changes the namespace and drops every shared entry
(seen in my own run B after a one-line edit of the scratch copy: full cold discovery, 78 s).
The worktree tree hash (`git ls-tree`, `server.js:2131`) only applies to worktree jobs; it did not
run here.

Git is not slow on this checkout: every git call in the traces took 25 to 310 ms (about 12 per
job, `rev-parse --show-toplevel` once per fingerprint via `openCodeProjectConfigDirectories`;
`git status` equivalents 120 to 210 ms).

### Instrumented traces (stubbed `opencode run`, `harness/trace-job.mjs`)

| run | condition | discovery | pre-slot | what happened |
|---|---|---|---|---|
| A1 | cold scratch state, loaded | 61.4 s | 3.9 s | agent-list miss 37.9 s (fp 5.0 + plugin-policy miss 20.0 [fp 4.4, `--version` 2.8 || `debug config` 7.0, fp-after 6.5] + `agent list` 9.2 + fp-after 3.6); metadata miss 19.7 s (fp 5.2 + policy hit 3.9 + `debug agent` 6.6 + fp-after 3.9); duplicate read 3.7 s; final reuse hit = 1 fp |
| A2 | warm, same process, loaded | 13.1 s | 4.3 s | 3 + 1 fingerprints only (4.6, 3.6, 4.9, 4.3 s) |
| C1 | warm shared entries older than the final window (FINAL_MAX_AGE=60 s to force it), loaded | 13.4 s | 17.5 s | discovery: 3 hits (5.2, 4.1, 4.1 s); pre-slot fresh: fp 3.9 + policy hit 4.1 + `debug agent` 6.1 + fp-after 3.4 |
| C2 | right after, loaded | 10.1 s | 2.7 s | 4 hits |
| D1 | default config (10 min), entries 10 to 60 min old, quieter | 2.4 s | 7.1 s | discovery 3 hits (0.7, 0.7, 1.0 s); pre-slot fresh: fp 1.5 + policy 1.3 + `debug agent` 2.6 + fp-after 1.7 |
| D2 | right after | 6.5 s | 2.7 s | 4 hits (1.7, 1.8, 3.0, 2.7 s; the fingerprint slows when repeated back to back) |

### Where the operator's 36 s (run 2) went

- discovery 7.9 s = three fingerprint-only cache hits (agent-list, agent-metadata, duplicate
  agent-metadata), about 2.6 s each. No OpenCode process was started in discovery.
- pre-slot 27.0 s = `reattestAgentMetadata` found the explore entry older than 10 minutes (it was
  still inside the 1 h TTL, so discovery had hit it) and did the fresh read: fingerprint +
  plugin-policy + `debug agent` + fingerprint. That is 7 s quiet and 17.5 s loaded in my traces;
  27 s fits a loaded host and/or a plugin-policy entry for that cwd older than 1 h (which adds
  `hashExactTree` + `debug config` + another fingerprint; 20 s loaded in trace A1).
- Run 1 is consistent with the same model: pre-slot 1.3 s is exactly one quiet-host fingerprint
  (a final-window hit, so the entry was 8 to 10 min old at run 1 and over 10 min at run 2);
  discovery 11.2 s is more than 3 quiet fingerprints, so one discovery read probably missed (an
  `agent list` miss is 3 fingerprints + one spawn).
- The live cache copy agrees: the only `explore` metadata row is stamped 11:16:41Z (14:16:41
  local), i.e. rewritten by a fresh final read; there are no agent-list rows after 10:57Z.

I could not see the operator's exact run timestamps or per-call cache sources, so the run-1
split is inferred. `runPhaseTimings.finalAttestationCached` is recorded (`lib/opencode-run.js:378`)
but `formatPhaseTimings` does not print it (`lib/opencode-command.js:381`); printing it (and the
per-call cache source) would make this visible in every report.

## 2b. Side observations

- Comment/code drift: `lib/opencode-run.js:136-140` and log.md B-171 say the non-reused final read
  "bypasses the cache ... including the plugin-policy probe", but `lib/opencode-run.js:155` calls
  the cached `verifyExternalPluginPolicy` (1 h TTL, no age cap; cached since `5f82472`,
  2026-09-24). It is still gated by the content fingerprint. Not a regression; the text is wrong.
- Waiter loop: a process waiting for another process's cold-read claim recomputes the full
  fingerprint on every ~100 ms poll (`lib/attestation-cache.js:149-150`). During a cold read in a
  parallel batch across processes this means continuous 180 MB + 1,403-file hashing per waiter,
  which loads CPU/Defender exactly while the cold read itself runs.
- A stale flight row (pid 22184, expired 07:39Z) sits in the live cache; harmless, reclaimed on the
  next claim of that key.
- Concurrency: 8 concurrent fingerprints in one process take 7.2 s each, so a parallel batch pays
  more per job, not less.

## 3. Cold start: user data home vs fresh

`harness/coldstart.mjs`, 5 interleaved repetitions per variant, cwd = the repo,
XDG_CONFIG_HOME = runtime dir, OPENCODE_DISABLE_PROJECT_CONFIG=1. Variant C/D use the exact
child env the bridge builds (`buildOpenCodeEnv()`), which already sets `OPENCODE_DB=:memory:`.
XDG_CACHE_HOME was kept at the user's `~/.cache` in every variant: a fresh cache has no plugin
package, so OpenCode would download `@cortexkit/opencode-antigravity-auth` from npm; I did not do
that download.

Quieter round (CPU 13 to 30 %), min / median / max in ms:

| command | A shell env, user data home (opens 1.2 GB opencode.db) | B shell env, fresh data home | C bridge env, user data home | D bridge env, fresh data home |
|---|---|---|---|---|
| `debug config` | 2470 / 2750 / 7032 | 2797 / 3969 / 5481 | 2513 / 3488 / 4069 | 2293 / 3132 / 3376 |
| `debug agent explore` | 2609 / 3066 / 4017 | 2541 / 3633 / 5829 | 2520 / 3345 / 5705 | 2596 / 2974 / 5921 |

Loaded round (CPU 74 to 93 %): every cell's median 5.2 to 6.5 s, again no ordering by data home
(`coldstart-summary.txt`).

Conclusion: the data home makes no measurable difference. The spread within one variant is larger
than any difference between variants.

Why: OpenCode 1.18.32 honours `OPENCODE_DB` (binary: `if(OPENCODE_DB===":memory:" ...) return
OPENCODE_DB`), and `buildOpenCodeEnv` sets `OPENCODE_DB=":memory:"` and
`OPENCODE_DISABLE_CHANNEL_DB=true` for every bridge child (`server.js:938-939`). So bridge children
do **not** open `~/.local/share/opencode/opencode.db`; variant D created no database file, variant
B created one. (The operator's quiet-shell numbers came from a plain shell, which does open it.)

What children still do inherit: `XDG_DATA_HOME` is not set by either client (`~/.codex/config.toml`
and `~/.claude.json` pass only XDG_CONFIG_HOME), so `buildOpenCodeEnv` sets
`XDG_DATA_HOME = ~/.local/share` (`server.js:918`, `lib/config.js:22`). Children read
`auth.json` there and write `log/`, `tool-output/` (which the agent policy whitelists by data home,
`lib/agent-policy.js:69`) and, for `opencode run`, snapshots. An isolated data home exists only for
pure/sanitized runs: `createIsolatedOpenCodeRuntime` (`server.js:975`) makes temp XDG dirs, writes a
fixed config, copies `auth.json` content (`server.js:956`), and is never cached. `bin/setup.js` does
not set XDG_DATA_HOME. B-192's "externally isolated XDG cache" was a self-test fixture issue, not a
runtime feature.

Auth implication of isolating the data home: `auth.json` would be missing. Free `opencode/*`
models still answer (operator verified today); `openai/*` (OAuth) and any provider whose
credentials live in `auth.json` would fail. The antigravity accounts live in the config dir
(`antigravity-accounts.json`), not the data home. An isolated data home would need a copied or
linked `auth.json`, which is a credential-handling change. Not worth it for speed.

## 4. Fixes ranked by safety, with expected savings

Per-job baselines from the traces: warm job = 4 fingerprints (3 to 7 s quiet, 13 to 20 s loaded);
first job after a 10 to 60 min gap adds a fresh final read (+7 s quiet, +17.5 s loaded, up to
about +27 s when the plugin-policy entry also expired).

### (a) Config only

1. `CODEX_OPENCODE_EXECUTABLE=C:\Users\10User\.opencode\bin\opencode.exe` in both client env
   blocks. `resolveAttestationExecutable` then checks one absolute path (1 ms) instead of walking
   PATH x PATHEXT (60 to 260 ms), per fingerprint. Saves 0.25 to 1 s per job. It also pins the
   spawned binary. The cache context uses the canonical path either way, so keys do not change.
   Needs a client config edit and restart (operator approval; `--sync-clients` is not affected,
   it pins server/lib hashes).
2. Nothing else config-only saves time without weakening a check. Not recommended for speed:
   isolating XDG_DATA_HOME (no measured gain, auth breakage).

### (b) Code that keeps every check

3. Make the content fingerprint cheaper, same inputs, still content-based
   (`lib/attestation-cache.js:14-38`): read the tree's files concurrently (e.g. 16 at a time) and
   combine per-file sha256 values in sorted order; read large files in 4 MB chunks. Measured:
   plugin tree 1.0 to 1.1 s -> 0.23 to 0.38 s, exe 0.3 to 0.7 s -> 0.14 to 0.17 s. One
   fingerprint about 1.3 s -> about 0.5 s quiet. Saves about 3 s per job quiet; loaded, assuming
   the same ratio, about 8 to 12 s per job. Digest format changes once (one cold read after deploy).
4. Stop computing duplicate fingerprints:
   - skip the second `readAgentDebugMetadata` when there is no worktree and
     `executionCwd === discoveryCwd` (`lib/execute-job.js:650`), reusing `agentMetadata`; the
     pre-spawn reattest still runs. Saves 1 fingerprint (0.7 to 1.8 s quiet, 3.5 to 5 s loaded).
   - compute the fingerprint once per discovery pass for agent-list and agent-metadata of the same
     cwd. Saves 1 more. The pre-spawn reattest keeps its own fresh fingerprint, so drift between
     discovery and spawn is still caught.
   Together: 2 of 4 fingerprints, 1.3 to 3.6 s quiet, 7 to 10 s loaded per job (less after fix 3).
5. Refresh the final attestation early instead of at spawn: when discovery hits an entry older than
   about half the final window, start the fresh read right away (in parallel with the rest of
   discovery and the snapshot), or keep recently used agent/cwd entries younger than 10 min with a
   background re-read while the bridge has jobs. The read is still fresh and inside 10 min at
   spawn. Saves most of the +7 s quiet / +17.5 to 27 s loaded on the first job after a gap, at the
   cost of background OpenCode cold starts.
6. Waiter loop: recompute the fingerprint only after the holder releases or every few seconds, not
   every ~100 ms poll (`lib/attestation-cache.js:149-150`). Reduces CPU/Defender contention during
   cold reads in parallel batches; saving not measured.
7. Observability: print `finalAttestationCached` and per-call cache sources in the timing line
   (`lib/opencode-command.js:381`). No time saved; makes these delays explainable per job.

### (c) Weakens a deliberate check: flagged, not recommended without an explicit decision

8. Raise `CODEX_OPENCODE_ATTESTATION_FINAL_MAX_AGE_MS` toward the 1 h TTL. Config only, removes
   the +7 to +27 s first-job cost, but undoes the B-171 bound on the "effective-permission drift"
   check (inputs outside the fingerprint, such as OpenCode's own cache under XDG_CACHE_HOME or
   runtime plugin state, would go unchecked for up to an hour instead of 10 minutes).
9. Reuse content hashes of the exe/plugin tree while size, mtime, ctime and inode are unchanged.
   Brings a fingerprint to about the metadata-walk floor (0.14 to 0.26 s). Gives up the explicit
   design goal in `lib/attestation-cache.js:13` (catch equal-size rewrites with restored mtime).
10. Run the plugin policy and `debug agent` concurrently in a fresh read. Saves 2.5 to 6 s per
    fresh read only, but `debug agent` loads the external plugin before its tree hash is verified.
11. Drop the plugin tree or the executable from the fingerprint (pre-B-193 behaviour). Cheapest,
    but a cached hit would no longer notice a tampered plugin or swapped binary within the TTL.
12. Antivirus exclusions for `opencode.exe`, the plugin cache or the state dir: MsMpEng was at
    105 % CPU during the loaded runs, but this is a security setting the operator would have to
    decide on and change; listed only as an observation.

Order to do: 7, 1, 4, 3, then 5 and 6. Fixes 3 + 4 together take a warm job from 4 full
fingerprints to 2 cheap ones: about 5 s -> 1 s quiet, about 15 s -> 3 to 4 s loaded (estimate for
the loaded case).

## 5. Could not verify

- The operator's exact run times and per-call cache sources, so the run-1 split is inferred.
- Whether the Codex and Claude Code bridge processes have the same PATH/TEMP and therefore share
  cache entries (their environments are not readable from here).
- Loaded-host savings for fixes 3 and 4 are proportional estimates from quiet microbenchmarks.
- A fresh XDG_CACHE_HOME cold start (would download the plugin from npm; not done).
- Any measurement was affected by host load that varied from 13 % to 93 % CPU during the session.

## 6. Side effects of this review

- Two real explore runs (free model `opencode/muse-spark-1.3-contributor-free`, read-only prompt
  "Read README.md first line") happened in trace A because my stub first matched `args[0]`
  instead of the `run` argument. They ran with scratch state; `opencode run` rewrote
  `~/.codex/opencode-gemini-runtime-v1/opencode/antigravity-accounts.json` (mtime 14:48:14
  local), as every bridge agent run does. All later runs used the stub.
- Variant A of the cold-start test (plain shell env) opened the user's `opencode.db` read-mostly,
  as the operator's own measurement did (mtime 14:59 local).

## Files

- Harness: `scratchpad\deep-review\harness\` (`env.mjs`, `fp.mjs`, `fp-parts.mjs`, `fp-alt.mjs`,
  `fp-parallel.mjs`, `trace-job.mjs`, `coldstart.mjs`, `instrument.mjs`)
- Raw output: `trace-run-A.txt`, `trace-run-B.txt`, `trace-run-C.txt`, `trace-run-D-quiet.txt`,
  `coldstart-summary.txt`, `coldstart-summary-2.txt`, `coldstart-detail*.txt`, `fp-alt.txt`,
  `fp-parallel.txt`
- Instrumented scratch copy: `scratchpad\deep-review\bridge-copy\`
