// Process identity, descendant discovery, and containment evidence.
// Extracted from server.js in modularization round M-001.

import path from "node:path";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createProcessTableRuntime({
  runCommand,
  BRIDGE_RUNTIME_DIR,
  OPENCODE_EXE,
  CONFIG,
}) {
// One process-table read: pid, parent pid and creation time. The creation time tells a
// recorded process from a later one that reused its PID (Windows reuses PIDs quickly), which
// otherwise held a containment quarantine indefinitely or attributed a stranger's process.
async function processTable() {
  const listed = process.platform === "win32"
    ? await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { $c = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { '' }; \"$($_.ProcessId),$($_.ParentProcessId),$c\" }"], BRIDGE_RUNTIME_DIR, 1000 * 20)
    : await runCommand("ps", ["-A", "-o", "pid=,ppid=,lstart="], BRIDGE_RUNTIME_DIR, 1000 * 20, { ...process.env, LC_ALL: "C" })
      .then((result) => (result.exitCode === 0
        ? result
        // A ps without lstart (BusyBox) still yields PID-only evidence.
        : runCommand("ps", ["-A", "-o", "pid=,ppid="], BRIDGE_RUNTIME_DIR, 1000 * 20)));
  if (listed.exitCode !== 0) return { ok: false, at: Date.now(), rows: [] };
  const rows = [];
  for (const line of String(listed.stdout || "").split(/\r?\n/)) {
    const match = process.platform === "win32"
      ? /^\s*(\d+),(\d+),(\d*)\s*$/.exec(line)
      : /^\s*(\d+)\s+(\d+)(?:\s+(.+?))?\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || pid <= 0) continue;
    rows.push({ pid, ppid, createdAt: String(match[3] || "").trim() });
  }
  return { ok: true, at: Date.now(), rows };
}

async function processDescendants(rootPids) {
  const table = await processTable();
  if (!table.ok) return { ok: false, pids: [], processes: [] };
  const children = new Map();
  const createdAt = new Map();
  for (const { pid, ppid, createdAt: created } of table.rows) {
    createdAt.set(pid, created);
    if (pid === ppid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = new Set();
  const queue = [...rootPids];
  while (queue.length && found.size < 4096) {
    for (const child of children.get(queue.shift()) || []) {
      if (found.has(child) || rootPids.includes(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  const pids = [...found];
  return {
    ok: true,
    pids,
    processes: [...rootPids, ...pids].map((pid) => ({ pid, createdAt: createdAt.get(pid) || "" })),
  };
}

async function containmentRecord(result = {}) {
  const payloadPid = Number(result?.payloadProcessId || 0);
  const supervisorPid = Number(result?.supervisorProcessId || 0);
  const roots = [supervisorPid, payloadPid].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  const descendants = roots.length ? await processDescendants(roots).catch(() => ({ ok: false, pids: [], processes: [] })) : { ok: false, pids: [], processes: [] };
  const processes = (descendants.processes || []).filter((item) => item.createdAt);
  const pids = [...roots, ...descendants.pids];
  return JSON.stringify({
    pids,
    // Creation time per PID where the process table reported one. PIDs without one are
    // evidence by PID only, so reclaim stays as conservative as before for them.
    processes,
    pidOnly: processes.length < pids.length,
    complete: payloadPid > 0 && descendants.ok,
    recordedAt: Date.now(),
  });
}

// Process-table reads are cached briefly so a reclaim pass over several quarantines spawns
// the listing once. A cached table older than a record cannot prove anything about it.
let processTableProbe = null;

async function processTableNewerThan(recordedAt) {
  if (!processTableProbe || processTableProbe.at < recordedAt || Date.now() - processTableProbe.at > 1000 * 30) {
    processTableProbe = await processTable().catch(() => ({ ok: false, at: Date.now(), rows: [] }));
  }
  return processTableProbe;
}

async function recordedProcessStillRuns(pid, createdAt, recordedAt) {
  if (!containmentProcessExists(pid)) return false;
  if (!createdAt) return true;
  const table = await processTableNewerThan(recordedAt);
  if (!table.ok || table.at < recordedAt) return true;
  const row = table.rows.find((item) => item.pid === pid);
  // Absent from a listing taken after the record: that process is gone and the live PID
  // belongs to a process started later. A different creation time: the PID was reused.
  return Boolean(row) && row.createdAt === createdAt;
}

function containmentProcessExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error?.code === "EPERM";
  }
}

let openCodeProcessProbe = { at: 0, running: true };

async function openCodeProcessRunning() {
  if (Date.now() - openCodeProcessProbe.at < 1000 * 30) return openCodeProcessProbe.running;
  const base = path.basename(OPENCODE_EXE).replace(/\.(exe|cmd|bat|ps1)$/i, "") || "opencode";
  let running = true;
  if (process.platform === "win32") {
    const listed = await runCommand("tasklist", ["/FO", "CSV", "/NH"], BRIDGE_RUNTIME_DIR, 1000 * 15);
    if (listed.exitCode === 0) {
      const names = new Set(String(listed.stdout || "").split(/\r?\n/).map((line) => (line.match(/^"([^"]+)"/) || [])[1]?.toLowerCase()).filter(Boolean));
      running = names.has(`${base.toLowerCase()}.exe`) || names.has("opencode.exe");
    }
  } else {
    const probe = await runCommand("pgrep", ["-x", base], BRIDGE_RUNTIME_DIR, 1000 * 15);
    running = probe.exitCode !== 1;
  }
  openCodeProcessProbe = { at: Date.now(), running };
  return running;
}

async function containmentStillPossible(containmentJson, ownerPid = 0) {
  let info = {};
  try { info = JSON.parse(containmentJson || "{}") || {}; } catch { info = {}; }
  const pids = Array.isArray(info.pids) ? info.pids.map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0) : [];
  const recordedAt = Number(info.recordedAt || 0);
  const createdAtByPid = new Map((Array.isArray(info.processes) ? info.processes : [])
    .map((item) => [Number(item?.pid), String(item?.createdAt || "")])
    .filter(([pid, created]) => Number.isSafeInteger(pid) && pid > 0 && created));
  for (const pid of pids) {
    if (await recordedProcessStillRuns(pid, createdAtByPid.get(pid) || "", recordedAt)) return true;
  }
  if (recordedAt > 0 && Date.now() - recordedAt < CONFIG.containmentReleaseGraceMs) return true;
  if (info.complete === true && pids.length) return false;
  if (containmentProcessExists(Number(ownerPid))) return true;
  return await openCodeProcessRunning();
}

  return { processTable, processDescendants, containmentRecord, recordedProcessStillRuns, containmentProcessExists, openCodeProcessRunning, containmentStillPossible };
}
