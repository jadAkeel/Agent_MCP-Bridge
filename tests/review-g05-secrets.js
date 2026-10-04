#!/usr/bin/env node

// G-05 (production review, second pass): the preview gate recognised credential shapes (AWS
// AKIA keys, npm tokens, Slack webhooks, scheme://user:password@host) that the log/storage
// redactor did not remove, and a flagged patch accepted with acceptFlaggedSecretLines was
// returned and stored unredacted. One sample of every LIKELY_SECRET_PATTERNS shape goes through
// each sink: direct stdout, the stored direct-run and queue results, the stored patch preview,
// a log event, diagnose output and the accepted (override) dry-run preview.
// Agent discovery and the OpenCode run are replaced by the self-test agentRuntimeTestHook, as in
// tests/review-l025.js; Git, locks, the worktree registry, the queue and SQLite state are real.
//   node tests/review-g05-secrets.js
import "./test-env.js"; // B-179: scratch XDG_CONFIG_HOME before the bridge reads it
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
// Error-level events reach stderr (the log sink under test); nothing below logs at that level on success.
process.env.CODEX_OPENCODE_LOG_LEVEL = "error";
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY;
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT;
const { __selfTest } = await import("../server.js");
const selfTestHooks = __selfTest.hooks;
const {
  CONFIG,
  LIKELY_SECRET_PATTERNS,
  QUEUE_JOBS,
  assert,
  cleanupWorktree,
  collectWorktreeDiff,
  createWorktreeForJob,
  listRetainedWorktreeArtifacts,
  logEvent,
  mkdir,
  mkdtemp,
  patchLikelySecretLines,
  path,
  redactLikelySecrets,
  redactSensitiveText,
  rm,
  runCommand,
  sanitizePersistedValue,
  server,
  tmpdir,
  writeFile,
} = __selfTest.internals;

const stateDir = await mkdtemp(path.join(tmpdir(), "review-g05-state-"));
const repo = await mkdtemp(path.join(tmpdir(), "review-g05-repo-"));
selfTestHooks.stateDirectoryOverride = stateDir;
selfTestHooks.queueModeOverride = "sqlite";

const gitIdentity = ["-c", "user.name=Review Test", "-c", "user.email=review@example.invalid"];
async function git(args, cwd = repo) {
  const result = await runCommand("git", args, cwd, 1000 * 60);
  assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}
await git(["init", "-q"]);
await git(["config", "core.autocrlf", "false"]);
await mkdir(path.join(repo, "src"), { recursive: true });
await writeFile(path.join(repo, "src", "a.txt"), "a\n", "utf8");
await git(["add", "."]);
await git([...gitIdentity, "commit", "-q", "-m", "init"]);

const textOf = (response) => (response?.content || []).map((item) => item.text || "").join("\n");
const callTool = (name, args) => server._registeredTools[name].handler(args, {});
const writeScope = (paths) => ({ mode: "write", read: paths, write: paths, allowedEdits: paths, forbidden: [], shared: [], serialOnly: [], validationCommand: "" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One line per LIKELY_SECRET_PATTERNS shape; `secret` is the part that must never survive.
const KEY_BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7G05KEYBODYx";
const SAMPLES = [
  { name: "private key", line: `-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n${KEY_BODY}\n-----END PRIVATE KEY-----`, secret: KEY_BODY },
  { name: "bearer", line: "curl -H 'X-Trace: Bearer G05bearerTokenValue1234567890abc'", secret: "G05bearerTokenValue1234567890abc" },
  { name: "basic", line: "sent Basic dXNlcjpHMDVwYXNzd29yZDE= to the proxy", secret: "dXNlcjpHMDVwYXNzd29yZDE" },
  { name: "google oauth", line: "oauth ya29.G05googleOauthAccessTokenValue123", secret: "G05googleOauthAccessTokenValue123" },
  { name: "jwt", line: "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJHMDUtdXNlciJ9.G05jwtSignatureValue12", secret: "G05jwtSignatureValue12" },
  { name: "sk dash", line: "openai sk-proj-G05openaiKeyValue1234567890", secret: "G05openaiKeyValue1234567890" },
  { name: "stripe", line: "stripe sk_live_G05stripeKeyValue123456", secret: "G05stripeKeyValue123456" },
  { name: "slack token", line: "slack xoxb-1234567890-G05slackBotToken", secret: "G05slackBotToken" },
  { name: "github", line: "github ghp_G05githubTokenValue1234567890ab", secret: "G05githubTokenValue1234567890ab" },
  { name: "npm", line: "npm npm_G05npmTokenValue00000000000000000000", secret: "G05npmTokenValue00000000000000000000" },
  { name: "google api key", line: "maps AIzaG05googleApiKeyValue12345678901234", secret: "G05googleApiKeyValue12345678901234" },
  { name: "aws", line: "aws AKIAG05AWSKEY7654321", secret: "AKIAG05AWSKEY7654321" },
  // B-117: token shapes the gate and both redactors missed.
  { name: "gitlab", line: "gitlab glpat-G05gitlabTokenValue12345", secret: "G05gitlabTokenValue12345" },
  { name: "hugging face", line: "hf hf_G05huggingFaceTokenValue1234567890ab", secret: "G05huggingFaceTokenValue1234567890ab" },
  { name: "google oauth client secret", line: "client GOCSPX-G05googleClientSecret12345", secret: "G05googleClientSecret12345" },
  { name: "slack app token", line: "slack app xapp-1-A0G05-1234567890-G05slackAppToken", secret: "G05slackAppToken" },
  { name: "sendgrid", line: "sendgrid SG.G05sendgridKeyIdAB.G05sendgridSecretValue12345", secret: "G05sendgridSecretValue12345" },
  { name: "pypi", line: "pypi pypi-AgEIcHlwaS5vcmcG05pypiTokenValue123456", secret: "G05pypiTokenValue123456" },
  { name: "azure account key", line: "DefaultEndpointsProtocol=https;AccountName=g05;AccountKey=G05azureAccountKeyValue0123456789abcdefABCDEFGHIJKLMNOPqrstuv==;EndpointSuffix=core.windows.net", secret: "G05azureAccountKeyValue0123456789abcdefABCDEFGHIJKLMNOPqrstuv" },
  { name: "slack webhook", line: "hook https://hooks.slack.com/services/TG05TEAM/BG05BOT/G05slackWebhookSecret1", secret: "G05slackWebhookSecret1" },
  { name: "credential url", line: "db postgres://g05user:G05dbPass99@db.example.invalid/app", secret: "G05dbPass99" },
  { name: "quoted credential key", line: "config = { apiKey: \"G05quotedApiKey42\" }", secret: "G05quotedApiKey42" },
  { name: "env value", line: "DB_PASSWORD=G05envPasswordValue7", secret: "G05envPasswordValue7" },
];
const SAMPLE_TEXT = SAMPLES.map((sample) => sample.line).join("\n");
const survivors = (text) => SAMPLES.filter((sample) => String(text).includes(sample.secret)).map((sample) => sample.name);
const assertNoSecrets = (text, sink) => assert.deepEqual(survivors(text), [], `${sink} kept credential text:\n${String(text).slice(0, 4000)}`);

function installRuntime({ onRun = async () => {}, stdout = "Done.", fail = "" } = {}) {
  selfTestHooks.agentRuntimeTestHook = {
    resolveAgent: async (requestedAgent, cwd, allowFallbackToBuild, subagentStrategy) => ({
      requestedAgent, actualAgent: requestedAgent, requestedAgentMode: "primary", actualAgentMode: "primary",
      fallbackUsed: false, proxyUsed: false, subagentStrategy, availableAgents: [requestedAgent], discoveryExitCode: 0,
    }),
    readAgentDebugMetadata: async (agent) => ({ ok: true, metadata: {
      name: agent, mode: "primary", provider: "fixture", model: "model-a", variant: "high",
      canEdit: agent === "builder", canDelegate: false, externalDirectoryDenied: true, webDenied: true,
      bashAutomaticAllowSafe: true, protectedEditsDenied: true, permissionProfileSha256: `profile-${agent}`,
    } }),
    runOpenCodeWithPolicy: async (agent, prompt, cwd, dryRun, lockPlan) => {
      if (fail) throw new Error(fail);
      const childStartedAtMs = Date.now();
      if (!dryRun) await onRun({ agent, cwd, lockPlan });
      return {
        exitCode: 0, stdout, stderr: "", errorType: null, durationMs: 1, dryRun,
        assistantFinalResponseDetected: true, childExecutionIntervals: [], configuredProvider: "fixture", configuredModel: "model-a",
        childStartedAtMs, childFinishedAtMs: Date.now() + 1,
      };
    },
  };
}

async function waitForQueueJob(jobId) {
  const deadline = Date.now() + 30000;
  while (!["completed", "failed", "cancelled"].includes(QUEUE_JOBS.get(jobId)?.status) && Date.now() < deadline) await sleep(50);
  assert.ok(["completed", "failed"].includes(QUEUE_JOBS.get(jobId)?.status), `queue job ${jobId} did not finish: ${QUEUE_JOBS.get(jobId)?.status}`);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("G-05: every gate pattern has a sample, and the gate flags every sample", async () => {
  for (const pattern of LIKELY_SECRET_PATTERNS) {
    assert.ok(SAMPLES.some((sample) => pattern.test(sample.line)), `no sample covers ${pattern}`);
  }
  for (const sample of SAMPLES) {
    const patch = ["diff --git a/src/a.txt b/src/a.txt", "--- a/src/a.txt", "+++ b/src/a.txt", "@@ -1 +1,5 @@", ...sample.line.split("\n").map((line) => `+${line}`)].join("\n");
    assert.ok(patchLikelySecretLines(patch).length > 0, `the gate does not flag the ${sample.name} sample`);
  }
});

test("G-05: both redactors remove every gate shape (direct stdout and the greedy log/storage redactor)", async () => {
  assertNoSecrets(redactLikelySecrets(SAMPLE_TEXT), "redactLikelySecrets (direct-run stdout)");
  assertNoSecrets(redactSensitiveText(SAMPLE_TEXT), "redactSensitiveText (logs, diagnostics, stored text)");
  assertNoSecrets(JSON.stringify(sanitizePersistedValue({ note: SAMPLE_TEXT, nested: [SAMPLE_TEXT] })), "sanitizePersistedValue");
  // The gate's false-positive protections still hold in the narrow redactor.
  const ordinary = "password = getpass.getpass()\n// Basic usage\ntoken_type = TokenType.INT64\nsk-spinner-plane";
  assert.equal(redactLikelySecrets(ordinary), ordinary);
});

test("G-05: a long run of blanks after an env value stays linear in every redactor", async () => {
  // The env-value pattern once ended in \s*;?\s*, which backtracked quadratically: 32,000
  // spaces took about 5 s in redactSensitiveText, and it runs on whole patches and logs.
  const input = `private_key=abcdefg1${" ".repeat(100_000)}x`;
  for (const [name, redact] of [["redactSensitiveText", redactSensitiveText], ["redactLikelySecrets", redactLikelySecrets]]) {
    const started = performance.now();
    redact(input);
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 1000, `${name} took ${Math.round(elapsedMs)} ms on 100,000 blanks`);
  }
  assert.equal(redactLikelySecrets("DB_PASSWORD=S3cr3tValue1 ; # note").includes("S3cr3tValue1"), false, "a trailing ; and comment still match");
});

test("G-05: a log event carries none of the shapes", async () => {
  assert.equal(CONFIG.logLevel, "error");
  const originalError = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  try {
    logEvent("error", "review.g05_sample", { summary: SAMPLE_TEXT, items: SAMPLES.map((sample) => sample.line) });
  } finally {
    console.error = originalError;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /review\.g05_sample/);
  assertNoSecrets(lines[0], "logEvent");
});

test("G-05: the stored direct-run result and its stored patch preview carry none of the shapes", async () => {
  installRuntime({
    onRun: async ({ cwd }) => writeFile(path.join(cwd, "src", "a.txt"), `${SAMPLE_TEXT}\n`, "utf8"),
    stdout: `Edited src/a.txt.\n${SAMPLE_TEXT}`,
  });
  const response = textOf(await callTool("run_opencode_agent", {
    agent: "builder", task: "Edit src/a.txt.", cwd: repo, write: true, lockMode: "simple",
    lockedPaths: ["src/a.txt"], allowedEdits: ["src/a.txt"], scopeContract: writeScope(["src/a.txt"]),
  }));
  const runId = /Direct run audit: (\S+); terminal metadata persisted/.exec(response)?.[1];
  assert.ok(runId, response);
  // The live response's patch preview comes from collectWorktreeDiff (the hook stands in for the
  // run itself, so its stdout reaches the response without the run's redactLikelySecrets pass).
  const preview = /Worktree patch preview:\n([\s\S]*?)(?:\n\n|$)/.exec(response)?.[1] || "";
  assert.match(preview, /diff --git/, response);
  assertNoSecrets(preview, "live response patch preview");
  const view = JSON.parse(textOf(await callTool("get_opencode_job", { jobId: runId, cwd: repo, detail: true })));
  assert.equal(view.kind, "direct_run");
  assert.match(view.resultDetailText, /diff --git/);
  assertNoSecrets(view.resultText, "stored direct-run result");
  assertNoSecrets(view.resultDetailText, "stored direct-run patch preview");
  for (const item of await listRetainedWorktreeArtifacts(repo, { jobId: runId })) await cleanupWorktree({ path: item.worktreePath, branch: item.branch, repoRoot: repo }, "always", true);
});

test("G-05: a queued job's stored result, error and diagnose output carry none of the shapes", async () => {
  installRuntime({ stdout: `Report.\n${SAMPLE_TEXT}` });
  const enqueued = textOf(await callTool("enqueue_opencode_job", { agent: "reviewer", task: "Review.", cwd: repo, write: false, lockMode: "off" }));
  const jobId = /Job ID: (\S+)/.exec(enqueued)?.[1];
  assert.ok(jobId, enqueued);
  await waitForQueueJob(jobId);
  const stored = textOf(await callTool("get_opencode_job", { jobId, cwd: repo, detail: true }));
  assert.match(stored, /Report\./, stored.slice(0, 2000));
  assertNoSecrets(stored, "stored queue result");

  installRuntime({ fail: `provider exploded while holding\n${SAMPLE_TEXT}` });
  const failing = textOf(await callTool("enqueue_opencode_job", { agent: "reviewer", task: "Review again.", cwd: repo, write: false, lockMode: "off" }));
  const failedId = /Job ID: (\S+)/.exec(failing)?.[1];
  assert.ok(failedId, failing);
  await waitForQueueJob(failedId);
  assert.equal(QUEUE_JOBS.get(failedId).status, "failed");
  assertNoSecrets(textOf(await callTool("get_opencode_job", { jobId: failedId, cwd: repo, detail: true })), "stored queue error");
  const diagnose = textOf(await callTool("diagnose_opencode_bridge", { cwd: repo }));
  assert.match(diagnose, new RegExp(failedId));
  assertNoSecrets(diagnose, "diagnose_opencode_bridge");
});

test("G-05: the stored patch preview and the accepted (override) dry-run preview carry none of the shapes", async () => {
  const worktree = await createWorktreeForJob({ cwd: repo, agent: "builder", jobId: "g05-override", lockedPaths: ["src"], allowedEdits: ["src"] });
  assert.equal(worktree.ok, true, JSON.stringify(worktree));
  try {
    await writeFile(path.join(worktree.path, "src", "a.txt"), `${SAMPLE_TEXT}\n`, "utf8");
    const diff = await collectWorktreeDiff(worktree);
    assert.match(diff.patchPreview, /diff --git/);
    assertNoSecrets(diff.patchPreview, "collectWorktreeDiff patchPreview");

    const args = { cwd: repo, worktreePath: worktree.path, allowedEdits: ["src"], dryRun: true };
    const flagged = textOf(await callTool("integrate_opencode_worktree", args));
    assert.match(flagged, /integration_preview_contains_sensitive_text/, flagged);
    assertNoSecrets(flagged, "rejected dry run");
    const accepted = textOf(await callTool("integrate_opencode_worktree", { ...args, acceptFlaggedSecretLines: true }));
    assert.match(accepted, /Serial integration accepted\./, accepted);
    assert.match(accepted, /Preview receipt: \{/);
    assert.match(accepted, /Patch preview masks the flagged values on patch lines \d+/);
    assert.match(accepted, /Patch preview:\ndiff --git/);
    assertNoSecrets(accepted, "accepted dry run (acceptFlaggedSecretLines)");
    const stat = textOf(await callTool("integrate_opencode_worktree", { ...args, acceptFlaggedSecretLines: true, previewMode: "stat" }));
    assert.match(stat, /Patch stat/);
    assertNoSecrets(stat, "accepted stat dry run");
  } finally {
    await cleanupWorktree(worktree, "always", true);
  }
});

let failed = 0;
try {
  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`ok   ${name}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`FAIL ${name}\n${error?.stack || error}\n`);
    } finally {
      selfTestHooks.agentRuntimeTestHook = null;
    }
  }
} finally {
  for (const directory of [repo, stateDir]) {
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
}
if (failed) {
  process.stdout.write(`${failed} of ${tests.length} G-05 secret-redaction tests failed.\n`);
  process.exit(1);
}
process.stdout.write(`All ${tests.length} G-05 secret-redaction tests passed.\n`);
process.exit(0);
