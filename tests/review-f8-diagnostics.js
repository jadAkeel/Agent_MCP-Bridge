#!/usr/bin/env node

// F8: real isolated SQLite history; injected discovery, provider and health dependencies.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const scratchParent = path.resolve(tmpdir());
const scratch = await mkdtemp(path.join(scratchParent, "review-f8-diagnostics-"));
assert.ok(scratch.startsWith(`${scratchParent}${path.sep}`));
const savedEnvironment = { ...process.env };
const savedArgv = [...process.argv];
let hooks, savedStateDirectory, savedQueueMode;
let failed = 0;
try {
  // Establish all homes before imports; never copy operator profiles or credentials.
  for (const key of Object.keys(process.env)) {
    if (/^(?:CODEX_OPENCODE_|OPENCODE_|OPENAI_|ANTHROPIC_|GEMINI_|GOOGLE_|AWS_|AZURE_|CLAUDE_|GIT_CONFIG_)|(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET)$/.test(key)) delete process.env[key];
  }
  const homes = {
    HOME: "home", USERPROFILE: "home", APPDATA: "appdata", LOCALAPPDATA: "localappdata",
    XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "xdg-state",
    CODEX_HOME: "codex", CLAUDE_CONFIG_DIR: "claude", TEMP: "tmp", TMP: "tmp", TMPDIR: "tmp",
    CODEX_OPENCODE_STATE_DIR: "state", CODEX_OPENCODE_AGENT_DIR: "agents", CODEX_OPENCODE_SKILL_DIR: "skills",
  };
  for (const [key, directory] of Object.entries(homes)) {
    process.env[key] = path.join(scratch, directory);
    await mkdir(process.env[key], { recursive: true });
  }
  const gitConfig = path.join(scratch, "gitconfig");
  await writeFile(gitConfig, "");
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_SYSTEM = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.CODEX_OPENCODE_SYNC_MANAGED_RUNTIME = "false";
  process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
  process.env.CODEX_OPENCODE_OPS_LOG = "off";
  if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
  const { __selfTest } = await import("../server.js");
  const I = __selfTest.internals;
  hooks = __selfTest.hooks;
  savedStateDirectory = hooks.stateDirectoryOverride;
  savedQueueMode = hooks.queueModeOverride;
  hooks.stateDirectoryOverride = process.env.CODEX_OPENCODE_STATE_DIR;
  hooks.queueModeOverride = "sqlite";
  const { createPipelineStoreRuntime } = await import("../lib/pipelines/store.js");
  const { createStateSchema } = await import("../lib/state/schema.js");
  const { registerLockAndStatusTools } = await import("../lib/tools/locks-status.js");
  const { sanitizePersistedValue } = await import("../lib/redaction.js");
  const { finishSkips } = await import("./skip-gate.js");
  const tests = [], test = (name, fn) => tests.push({ name, fn });
  const terminal = new Set(["completed", "failed", "cancelled"]);
  const secret = "sk-proj-" + "a1".repeat(24);
  const text = response => response.content.map(item => item.text || "").join("\n");
  const newest = records => [...records].sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  let fixtureSequence = 0;
  async function fixture() {
    const cwd = path.join(scratch, `checkout-${++fixtureSequence}`);
    await mkdir(cwd);
    const db = await I.openLockDb(cwd);
    I.closeDb(db);
    return cwd;
  }
  function record(cwd, index, status, extra = {}) {
    return {
      pipelineId: `pipeline-${String(index).padStart(5, "0")}`, cwd, status,
      createdAt: new Date(Date.UTC(2099, 0, 1) + index * 1000).toISOString(),
      ownerInstanceId: "json-owner", ownerGeneration: "json-generation", revision: 999,
      integrationQueue: [{ status: "pending" }, { status: "integrated" }],
      errors: [`fixture failure ${secret}`], ...extra,
    };
  }
  function insert(db, value, { status = value.status, request = "fixture-encrypted-request", json = JSON.stringify(value), owner = I.BRIDGE_INSTANCE_ID, lease = "2099-02-01T00:00:00.000Z" } = {}) {
    db.prepare(`INSERT INTO opencode_pipelines
      (pipeline_id, cwd, status, created_at, updated_at, record_json, revision, request_encrypted, details_encrypted,
       owner_instance_id, owner_generation, owner_heartbeat_at, owner_lease_expires_at, expected_child_count, batch_state, cleanup_state, queue_mode)
      VALUES (?, ?, ?, ?, ?, ?, 7, ?, 'fixture-private-envelope', ?, 'sql-generation', ?, ?, 3, 'accepted', 'deferred', 'sqlite')`)
      .run(value.pipelineId, value.cwd, status, value.createdAt, value.createdAt, json, request, owner, value.createdAt, lease);
  }
  async function seed(cwd, values) {
    const db = await I.openLockDb(cwd);
    try {
      db.exec("BEGIN");
      for (const value of values) insert(db, value);
      db.exec("COMMIT");
    } finally { I.closeDb(db); }
  }
  function store({ mode = "sqlite", memoryRecords = new Map(), observe = () => {}, fault = () => {}, commands = [] } = {}) {
    return createPipelineStoreRuntime({
      ...I, PIPELINE_RUNS: memoryRecords, effectiveQueueMode: () => mode,
      decryptQueueRequest: () => assert.fail("diagnosis must not decrypt requests"),
      decryptIntegrationJournalBytes: () => assert.fail("diagnosis must not decrypt private details"),
      openLockDb: async cwd => {
        const db = await I.openLockDb(cwd);
        return {
          close: () => { commands.push("CLOSE"); db.close(); },
          exec: sql => { commands.push(sql); return db.exec(sql); },
          prepare: sql => {
            const statement = db.prepare(sql);
            const read = (method, args) => {
              fault(sql, method);
              const result = statement[method](...args);
              observe({ sql, method, args, result, db });
              return result;
            };
            return { get: (...args) => read("get", args), all: (...args) => read("all", args) };
          },
        };
      },
    });
  }
  const fresh = () => ({ stale: false, serverStale: false, libStale: false, error: "", libError: "", startedAt: "fixture-start", startupSha256: "same", onDiskSha256: "same", startupLibSha256: "same-lib", onDiskLibSha256: "same-lib" });
  function tools(runtime, { mode = "sqlite", freshness = fresh(), metadataError = false, nestedOk = true } = {}) {
    const handlers = new Map();
    const calls = { versions: [], metadata: [], nested: 0, cleared: 0, inference: 0, pipelineQueries: [] };
    const provider = { capacity: 3, keys: [{ providerKey: "fixture", leases: 0, capacity: 3 }], leases: [] };
    registerLockAndStatusTools({
      ...I, CONFIG: { ...I.CONFIG, modelOverrideAllowlist: [], requireRuntimeModelEvidence: false },
      server: { tool: (name, ...args) => handlers.set(name, args.at(-1)) },
      jobInputShape: {}, sanitizedWorkspaceSchema: I.z.object({}),
      OPENCODE_EXE: "fixture-opencode", OPENCODE_AGENT_DIR: process.env.CODEX_OPENCODE_AGENT_DIR,
      OPENCODE_SKILL_DIR: process.env.CODEX_OPENCODE_SKILL_DIR, GLOBAL_BRIDGE_STATE_DIR: process.env.CODEX_OPENCODE_STATE_DIR,
      GLOBALLY_REQUIRED_MANAGED_AGENTS: I.GLOBALLY_REQUIRED_MANAGED_AGENTS,
      queryPersistedPipelineRecords: async (...args) => { calls.pipelineQueries.push(args); return runtime.queryPersistedPipelineRecords(...args); },
      listPersistedPipelineRecords: () => assert.fail("diagnosis must use the bounded reader"),
      queryPersistedQueueRecords: async () => ({ records: [], total: 0, nonterminal: 0, failed: 0 }),
      listLocks: async () => [], listRetainedWorktreeArtifacts: async () => [],
      integrationJournalDiagnosis: async () => ({ unresolvedCount: 0 }),
      providerCapacitySnapshot: async () => provider,
      queueCapacityReport: () => ({ queueParallelLimit: 2, parallelCallLimit: 2, providerConcurrencyLimit: 3 }),
      queueMemoryGate: () => ({ floorMb: 0, freeMb: 1024, blocked: false }), queueMemoryWaitingJobs: new Map(),
      effectiveQueueMode: () => mode, effectiveQueueWriteConflictPolicy: () => "fixture-policy",
      resolveProjectStateRoot: I.resolveProjectStateRoot,
      pipelineOwnedByThisInstance: runtime.pipelineOwnedByThisInstance,
      bridgeSourceFreshness: async () => freshness, bridgeSourceFreshnessLines: I.bridgeSourceFreshnessLines,
      attestationCacheStatus: () => ({ source: "fixture", ageMs: 0 }),
      verifyExternalPluginPolicy: async () => ({ ok: true }),
      safeOpenCodeCommand: async args => {
        calls.versions.push(args); assert.deepEqual(args, ["--version"]);
        return { exitCode: 0, stdout: "fixture version" };
      },
      runCommand: async (exe, args) => { assert.equal(exe, "git"); assert.deepEqual(args, ["--version"]); return { exitCode: 0, stdout: "fixture git" }; },
      listAvailableAgents: async () => ({ result: { exitCode: 0 }, agents: new Map(I.GLOBALLY_REQUIRED_MANAGED_AGENTS.map(agent => [agent, "primary"])) }),
      availableAgentLabels: agents => [...agents.keys()],
      managedSkillSourceEvidence: async () => ({ ok: true, names: ["fixture"], fileCount: 1, sha256: "fixture" }),
      clearAttestationCache: () => { calls.cleared++; },
      readAgentDebugMetadata: async agent => {
        calls.metadata.push(agent);
        return { ok: true, metadata: { name: agent, canEdit: metadataError, canDelegate: agent === I.MCP_CONTRACTOR_ORCHESTRATOR_AGENT, bashDenied: true, skillDenied: true, taskDelegationAllowlistSafe: true } };
      },
      sanitizedAgentMetadataError: () => null,
      attestContractorNestedAgents: async () => { calls.nested++; return { ok: nestedOk, error: nestedOk ? "" : "fixture nested refusal" }; },
      effectiveContractorAuthorizationSha256: () => "",
      executeOpenCodeJob: () => { calls.inference++; assert.fail("health must never execute a model"); },
      prepareOpenCodeJob: () => { calls.inference++; assert.fail("health must never prepare model execution"); },
    });
    return { calls, call: (name, args) => handlers.get(name)(args, {}) };
  }
  function expectedDetails(records, runtime) {
    let finished = 0;
    return sanitizePersistedValue(newest(records).filter(value => !terminal.has(value.status) || ++finished <= 25).map(value => ({
      pipelineId: value.pipelineId, status: value.status, ownerInstanceId: value.ownerInstanceId || "",
      ownerLeaseExpiresAt: value.ownerLeaseExpiresAt || "",
      recoverableByThisInstance: runtime.pipelineOwnedByThisInstance(value) || Date.parse(value.ownerLeaseExpiresAt || "") <= Date.now(),
      pendingIntegrations: (value.integrationQueue || []).filter(item => item.status === "pending").length,
      errors: value.errors || [],
    })));
  }

  test("empty persisted history preserves diagnosis fields and complete zero counts", async () => {
    const cwd = await fixture(), runtime = store();
    assert.deepEqual(await I.queryPersistedPipelineRecords(cwd, { limit: 25 }), { records: [], total: 0, nonterminal: 0 });
    const diagnostic = tools(runtime);
    const report = JSON.parse(text(await diagnostic.call("diagnose_opencode_bridge", { cwd })));
    assert.deepEqual(Object.keys(report).sort(), ["generatedAt", "cwd", "bridgeProcess", "attestation", "summary", "directRuns", "diagnosticCoverage", "jobs", "retainedWorktrees", "pipelines", "locks", "integrationOperations", "provider"].sort());
    assert.equal(report.summary.pipelines, 0); assert.equal(report.summary.nonterminalPipelines, 0);
    assert.deepEqual(report.pipelines, []);
    assert.deepEqual(diagnostic.calls.pipelineQueries, [[cwd, { limit: 25 }]]);
  });

  test("small mixed history preserves persisted precedence, ownership, recovery and redaction", async () => {
    const cwd = await fixture(), runtime = store(), db = await I.openLockDb(cwd);
    try {
      insert(db, record(cwd, 1, "json-conflict"), { status: "completed", request: "", owner: "foreign", lease: "2099-02-01T00:00:00.000Z" });
      insert(db, record(cwd, 2, "json-conflict"), { status: "failed", request: null, owner: "foreign", lease: "2000-01-01T00:00:00.000Z" });
      insert(db, record(cwd, 3, "json-conflict"), { status: "cancelled" });
      insert(db, record(cwd, 0, "cleanup_deferred"), { owner: "foreign", lease: "" });
    } finally { I.closeDb(db); }
    const page = await runtime.queryPersistedPipelineRecords(cwd, { limit: 25 });
    const unrestricted = await runtime.listPersistedPipelineRecords(cwd);
    assert.equal(page.total, 4); assert.equal(page.nonterminal, 1);
    assert.deepEqual(newest(page.records), unrestricted);
    assert.deepEqual(await runtime.listPersistedPipelineRecords(cwd, "failed"), [unrestricted.find(value => value.status === "failed")]);
    const completed = page.records.find(value => value.status === "completed");
    assert.equal(completed.revision, 7); assert.equal(completed.ownerInstanceId, "foreign");
    assert.equal(completed.ownerGeneration, "sql-generation"); assert.equal(completed.expectedChildCount, 3);
    assert.equal(completed.batchState, "accepted"); assert.equal(completed.cleanupState, "deferred"); assert.equal(completed.queueMode, "sqlite");
    assert.equal(completed.replayRequestAvailable, false);
    assert.equal(page.records.find(value => value.status === "failed").replayRequestAvailable, false);
    assert.equal(page.records.find(value => value.status === "cancelled").replayRequestAvailable, true);
    const reportText = text(await tools(runtime).call("diagnose_opencode_bridge", { cwd }));
    const report = JSON.parse(reportText);
    assert.deepEqual(report.pipelines, expectedDetails(unrestricted, runtime));
    assert.deepEqual(report.pipelines.map(value => value.status), ["cancelled", "failed", "completed", "cleanup_deferred"]);
    assert.deepEqual(report.pipelines.map(value => value.recoverableByThisInstance), [true, true, false, false]);
    assert.ok(report.pipelines.every(value => value.pendingIntegrations === 1));
    assert.ok(!reportText.includes(secret)); assert.match(reportText, /redacted/);
    assert.ok(!reportText.includes("fixture-encrypted-request")); assert.ok(!reportText.includes("fixture-private-envelope"));
  });

  test("10,000 terminal rows materialize 25 terminal summaries and every older unfinished status using indexes", async () => {
    const cwd = await fixture();
    const unfinished = ["planned", "running", "awaiting_integration", "awaiting_finalization", "finalizing", "cleanup_deferred", "interrupted", "not_resumable", "quarantined", "", "unknown"];
    const values = unfinished.map((status, index) => record(cwd, index, status));
    for (let index = 100; index < 10100; index++) values.push(record(cwd, index, ["completed", "failed", "cancelled"][index % 3]));
    await seed(cwd, values);
    const reads = [], commands = [];
    const runtime = store({ commands, observe: read => reads.push(read) });
    const page = await runtime.queryPersistedPipelineRecords(cwd, { limit: 25 });
    assert.equal(page.total, 10000 + unfinished.length); assert.equal(page.nonterminal, unfinished.length);
    assert.equal(page.records.length, 25 + unfinished.length);
    assert.deepEqual(page.records.filter(value => !terminal.has(value.status)).map(value => value.status).sort(), [...unfinished].sort());
    assert.deepEqual(page.records.filter(value => terminal.has(value.status)).map(value => value.pipelineId), values.slice(-25).reverse().map(value => value.pipelineId));
    assert.deepEqual(commands, ["BEGIN", "COMMIT", "CLOSE"]);
    const details = reads.filter(read => read.method === "all");
    assert.equal(details.reduce((sum, read) => sum + read.result.length, 0), 25 + unfinished.length);
    for (const read of details) {
      assert.match(read.sql.split(/\bFROM\b/i)[0], /\(request_encrypted IS NOT NULL AND request_encrypted <> ''\) AS replay_request_available/);
      assert.ok(read.result.every(row => !Object.hasOwn(row, "request_encrypted") && !Object.hasOwn(row, "details_encrypted")));
      assert.ok(!JSON.stringify(read.result).includes("fixture-encrypted-request"));
    }
    const terminalRead = details.find(read => /LIMIT \?/.test(read.sql));
    assert.ok(terminalRead);
    const db = await I.openLockDb(cwd);
    try {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${terminalRead.sql}`).all(25).map(row => row.detail).join("\n");
      assert.match(plan, /USING INDEX opencode_pipelines_created_idx/);
      assert.doesNotMatch(plan, /TEMP B-TREE/i);
      const statusPlan = db.prepare("EXPLAIN QUERY PLAN SELECT status FROM opencode_pipelines WHERE status = ? ORDER BY created_at DESC LIMIT ?").all("completed", 25).map(row => row.detail).join("\n");
      assert.match(statusPlan, /opencode_pipelines_status_created_idx/); assert.doesNotMatch(statusPlan, /TEMP B-TREE/i);
    } finally { I.closeDb(db); }
    const unrestricted = await runtime.listPersistedPipelineRecords(cwd);
    assert.equal(unrestricted.length, 10000 + unfinished.length);
    const report = JSON.parse(text(await tools(runtime).call("diagnose_opencode_bridge", { cwd })));
    assert.equal(report.summary.pipelines, page.total); assert.equal(report.summary.nonterminalPipelines, page.nonterminal);
    assert.deepEqual(report.pipelines, expectedDetails(unrestricted, runtime));
  });

  test("checkout databases stay isolated and memory-mode diagnosis still reads persisted pipelines without a cwd filter", async () => {
    const first = await fixture(), second = await fixture();
    // A stored cwd discrepancy is not a new identity rule for this reader.
    await seed(first, [record(second, 1, "completed"), record(first, 2, "running")]);
    await seed(second, [record(second, 3, "failed")]);
    const runtime = store({ mode: "memory", memoryRecords: new Map([["memory-only", { pipelineId: "memory-only", cwd: first, status: "running" }]]) });
    assert.equal((await runtime.queryPersistedPipelineRecords(first, { limit: 25 })).total, 2);
    assert.equal((await runtime.queryPersistedPipelineRecords(second, { limit: 25 })).total, 1);
    assert.equal((await runtime.listPersistedPipelineRecords(first)).length, 2);
    const diagnostic = tools(runtime, { mode: "memory" });
    const report = JSON.parse(text(await diagnostic.call("diagnose_opencode_bridge", { cwd: first })));
    assert.equal(report.cwd, first); assert.equal(report.summary.pipelines, 2); assert.equal(report.summary.nonterminalPipelines, 1);
    assert.deepEqual(report.pipelines.map(value => value.pipelineId), ["pipeline-00002", "pipeline-00001"]);
    const previousMode = hooks.queueModeOverride;
    try {
      hooks.queueModeOverride = "memory";
      assert.equal((await I.queryPersistedPipelineRecords(first, { limit: 25 })).total, 2);
    } finally { hooks.queueModeOverride = previousMode; }
  });

  test("unselected malformed history is not parsed; selected corruption and database failures roll back and propagate", async () => {
    const cwd = await fixture();
    await seed(cwd, Array.from({ length: 26 }, (_, index) => record(cwd, index, "completed")));
    const db = await I.openLockDb(cwd);
    try { db.prepare("UPDATE opencode_pipelines SET record_json = ? WHERE pipeline_id = ?").run("{", "pipeline-00000"); }
    finally { I.closeDb(db); }
    const runtime = store();
    assert.equal((await runtime.queryPersistedPipelineRecords(cwd, { limit: 25 })).total, 26);
    await assert.rejects(runtime.listPersistedPipelineRecords(cwd), SyntaxError);
    const selectedDb = await I.openLockDb(cwd);
    try { selectedDb.prepare("UPDATE opencode_pipelines SET record_json = ? WHERE pipeline_id = ?").run("{", "pipeline-00025"); }
    finally { I.closeDb(selectedDb); }
    const commands = [];
    await assert.rejects(store({ commands }).queryPersistedPipelineRecords(cwd, { limit: 25 }), SyntaxError);
    assert.deepEqual(commands, ["BEGIN", "ROLLBACK", "CLOSE"]);
    await assert.rejects(tools(runtime).call("diagnose_opencode_bridge", { cwd }), SyntaxError);
    for (const method of ["get", "all"]) {
      const failure = new Error(`fixture database ${method} failure`), trace = [];
      const broken = store({ commands: trace, fault: (sql, actualMethod) => { if (actualMethod === method) throw failure; } });
      await assert.rejects(broken.queryPersistedPipelineRecords(cwd, { limit: 25 }), error => error === failure);
      assert.deepEqual(trace, ["BEGIN", "ROLLBACK", "CLOSE"]);
    }
    const failure = new Error("fixture open failure");
    const brokenOpen = createPipelineStoreRuntime({ ...I, openLockDb: async () => { throw failure; }, closeDb: () => assert.fail("unopened DB must not be closed") });
    await assert.rejects(brokenOpen.queryPersistedPipelineRecords(cwd, { limit: 25 }), error => error === failure);
  });

  test("counts and detail share one deferred WAL snapshot across a concurrent commit", async () => {
    const cwd = await fixture();
    await seed(cwd, [record(cwd, 1, "running"), record(cwd, 2, "completed")]);
    let wrote = false;
    const commands = [];
    const runtime = store({ commands, observe: ({ sql, db }) => {
      if (wrote || !/COUNT\(\*\)/.test(sql)) return;
      wrote = true;
      const databaseFile = db.prepare("PRAGMA database_list").all().find(row => row.name === "main").file;
      assert.ok(databaseFile.startsWith(`${scratch}${path.sep}`));
      const writer = new I.DatabaseSync(databaseFile);
      try {
        assert.equal(writer.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
        writer.exec("BEGIN IMMEDIATE");
        insert(writer, record(cwd, 3, "completed")); insert(writer, record(cwd, 4, "running"));
        writer.prepare("UPDATE opencode_pipelines SET status = 'failed' WHERE pipeline_id = ?").run("pipeline-00001");
        writer.exec("COMMIT");
      } finally { writer.close(); }
    } });
    const page = await runtime.queryPersistedPipelineRecords(cwd, { limit: 25 });
    assert.equal(wrote, true); assert.equal(page.total, 2); assert.equal(page.nonterminal, 1);
    assert.deepEqual(newest(page.records).map(value => [value.pipelineId, value.status]), [["pipeline-00002", "completed"], ["pipeline-00001", "running"]]);
    assert.deepEqual(commands, ["BEGIN", "COMMIT", "CLOSE"]);
    const after = await runtime.queryPersistedPipelineRecords(cwd, { limit: 25 });
    assert.equal(after.total, 4); assert.equal(after.nonterminal, 1); assert.equal(after.records.length, 4);
    assert.equal(after.records.find(value => value.pipelineId === "pipeline-00001").status, "failed");
  });

  test("fresh and legacy schema upgrades add compatible indexes and preserve safety and accepted pipeline data", async () => {
    const schema = createStateSchema();
    for (const legacy of [false, true]) {
      const db = new I.DatabaseSync(path.join(scratch, `schema-${legacy}.sqlite`));
      try {
        db.exec(`CREATE TABLE locks (normalized_path TEXT, run_id TEXT, token TEXT, lock_type TEXT);
          CREATE TABLE opencode_jobs (job_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
          CREATE TABLE opencode_pipelines (pipeline_id TEXT PRIMARY KEY, cwd TEXT, status TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, record_json TEXT NOT NULL);
          CREATE TABLE opencode_pipeline_children (pipeline_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
            job_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, PRIMARY KEY (pipeline_id, ordinal));`);
        if (!legacy) schema.ensurePipelineRevisionSchema(db);
        const token = `sha256:${createHash("sha256").update("fixture token").digest("hex")}`;
        db.prepare("INSERT INTO locks VALUES (?, ?, ?, ?)").run("a.txt", "fixture-run", token, "write");
        db.prepare("INSERT INTO locks VALUES (?, ?, ?, ?)").run(".", "quarantine-sentinel", token, "serial_integration");
        db.prepare("INSERT INTO opencode_jobs VALUES (?, ?)").run("child", '{"parentJobId":"accepted-f6"}');
        const summary = JSON.stringify({ pipelineId: "accepted-f6", status: "awaiting_finalization", ownerInstanceId: "accepted-owner", ownerGeneration: "accepted-generation", queueJobIds: ["child"], integrationQueue: [{ jobId: "child", status: "integrated", patchSha256: "accepted-patch" }], finalValidationCommand: "fixture validation", events: [{ type: "source_cleanup_authorized" }] });
        db.prepare("INSERT INTO opencode_pipelines (pipeline_id, cwd, status, created_at, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?)").run("accepted-f6", scratch, "awaiting_finalization", "2099", "2099", summary);
        db.prepare("INSERT INTO opencode_pipeline_children VALUES (?, ?, ?, ?)").run("accepted-f6", 0, "child", "2099");
        if (!legacy) {
          db.exec("UPDATE opencode_pipelines SET revision = 8, request_encrypted = 'accepted-request', details_encrypted = 'accepted-details', owner_instance_id = 'accepted-owner', owner_generation = 'accepted-generation', expected_child_count = 1, batch_state = 'accepted', cleanup_state = 'deferred'; DROP INDEX opencode_pipelines_created_idx; DROP INDEX opencode_pipelines_status_created_idx;");
        }
        const snapshots = ["locks", "opencode_jobs", "opencode_pipeline_children"].map(table => db.prepare(`SELECT * FROM ${table}`).all());
        const before = db.prepare("SELECT * FROM opencode_pipelines").get();
        schema.ensurePipelineRevisionSchema(db);
        schema.ensurePipelineRevisionSchema(db);
        assert.deepEqual(["locks", "opencode_jobs", "opencode_pipeline_children"].map(table => db.prepare(`SELECT * FROM ${table}`).all()), snapshots);
        const after = db.prepare("SELECT * FROM opencode_pipelines").get();
        for (const [key, value] of Object.entries(before)) assert.equal(after[key], value, key);
        assert.equal(after.owner_instance_id, "accepted-owner"); assert.equal(after.owner_generation, "accepted-generation");
        assert.equal(after.expected_child_count, 1);
        const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN ('opencode_pipelines_created_idx', 'opencode_pipelines_status_created_idx') ORDER BY name").all();
        assert.equal(indexes.length, 2);
        assert.match(indexes[0].sql, /\(created_at DESC\)/); assert.match(indexes[1].sql, /\(status, created_at DESC\)/);
      } finally { db.close(); }
    }
  });

  test("quick healthy and proven mismatched source keep existing headlines and warnings without inference", async () => {
    const cwd = await fixture();
    for (const mismatch of ["", "server", "lib"]) {
      const freshness = fresh();
      if (mismatch) Object.assign(freshness, { stale: true, serverStale: mismatch === "server", libStale: mismatch === "lib", onDiskSha256: mismatch === "server" ? "changed" : "same", onDiskLibSha256: mismatch === "lib" ? "changed-lib" : "same-lib" });
      const before = { ...freshness }, health = tools(store(), { freshness });
      const output = text(await health.call("get_opencode_bridge_status", { cwd }));
      assert.match(output, mismatch ? /^OpenCode MCP bridge status: attention required\./ : /^OpenCode MCP bridge status: healthy\./);
      if (mismatch) { assert.match(output, /differs from startup/); assert.match(output, /Restart the client/); }
      else assert.doesNotMatch(output, /differs from startup|Restart the client/);
      assert.match(output, /Provider readiness: not tested by health \(no model request sent\)/);
      assert.deepEqual(freshness, before); assert.deepEqual(health.calls.versions, [["--version"]]);
      assert.equal(health.calls.inference, 0); assert.equal(health.calls.nested, 0); assert.equal(health.calls.cleared, 0);
      assert.deepEqual(health.calls.metadata, []);
    }
  });

  test("unknown server or lib freshness requires attention without changing stale or manufacturing restart warnings", async () => {
    const cwd = await fixture();
    const missing = await I.bridgeSourceFreshness(path.join(scratch, "missing-server.js"), "startup", { runtimeDir: scratch, startupLibSha256: "" });
    assert.equal(missing.stale, false); assert.ok(missing.error);
    for (const freshness of [missing, { ...fresh(), stale: false, startupLibSha256: "", onDiskLibSha256: "", libError: "fixture unreadable lib" }]) {
      const before = { ...freshness }, health = tools(store(), { freshness });
      const output = text(await health.call("get_opencode_bridge_status", { cwd }));
      assert.match(output, /^OpenCode MCP bridge status: attention required\./); assert.match(output, /unreadable/);
      for (const line of I.bridgeSourceFreshnessLines(freshness)) assert.ok(output.includes(line));
      assert.doesNotMatch(output, /differs from startup|changed after|Restart the client/);
      assert.equal(freshness.stale, false); assert.deepEqual(freshness, before);
      assert.equal(health.calls.inference, 0); assert.equal(health.calls.nested, 0); assert.equal(health.calls.cleared, 0); assert.deepEqual(health.calls.metadata, []);
    }
  });

  test("deep health still clears attestation, checks all roles and rejects unsafe role or nested evidence", async () => {
    const cwd = await fixture();
    for (const options of [{}, { metadataError: true }, { nestedOk: false }]) {
      const health = tools(store(), options);
      const output = text(await health.call("get_opencode_bridge_status", { cwd, deep: true }));
      assert.match(output, Object.keys(options).length ? /^OpenCode MCP bridge status: attention required\./ : /^OpenCode MCP bridge status: healthy\./);
      assert.equal(health.calls.cleared, 1); assert.equal(health.calls.nested, 1);
      assert.deepEqual(health.calls.metadata.sort(), [I.MCP_ORCHESTRATOR_AGENT, I.MCP_CONTRACTOR_ORCHESTRATOR_AGENT, I.MCP_SANITIZED_READER_AGENT].sort());
      assert.equal(health.calls.inference, 0); assert.match(output, /Health depth: deep managed-role attestation/);
    }
  });

  for (const { name, fn } of tests) {
    try { await fn(); process.stdout.write(`ok   ${name}\n`); }
    catch (error) { failed++; process.stdout.write(`FAIL ${name}\n${String(error?.stack || error).split("\n").slice(0, 10).join("\n")}\n`); }
  }
  for (const key of ["TEMP", "TMP", "TMPDIR"]) {
    if (Object.hasOwn(savedEnvironment, key)) process.env[key] = savedEnvironment[key];
    else delete process.env[key];
  }
  if (finishSkips({ file: "tests/review-f8-diagnostics.js", total: tests.length, skips: [] })) failed++;
  process.stdout.write(failed ? `${failed} F8 regression test(s) failed.\n` : `All ${tests.length} F8 regression tests passed.\n`);
} finally {
  if (hooks) { hooks.stateDirectoryOverride = savedStateDirectory; hooks.queueModeOverride = savedQueueMode; }
  process.argv.splice(0, process.argv.length, ...savedArgv);
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(savedEnvironment, key)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnvironment)) process.env[key] = value;
  assert.ok(path.resolve(scratch).startsWith(`${scratchParent}${path.sep}`));
  await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
if (failed) process.exitCode = 1;
