#!/usr/bin/env node

// T-1: a skipped test is not a passed test. Every test file that can skip a case reports its
// skips through finishSkips(): a skipped case that is not marked optional fails the file, and a
// file whose every case skipped fails whatever the marks say (it proved nothing). Optional
// skips (a missing OS privilege, a platform that cannot express the case) stay allowed and are
// printed as "skipped: <n>".
//
// `npm test` starts with `node tests/skip-gate.js --reset` and ends with
// `node tests/skip-gate.js --summary`: in between, each file appends its skips to a ledger
// named after the shell that runs the chain (every command of the chain has it as parent), and
// the summary prints the total. A file run on its own finds no ledger and writes none.
//
// CODEX_TEST_ALLOW_REQUIRED_SKIPS=1 turns a required skip into a loud warning instead of a
// failure, for a machine that knowingly lacks a prerequisite; the summary says so.
import { appendFileSync, existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../bin/main-module.js";

export class SkipTest extends Error {
  // optional: the case may skip without failing the gate (say why in the reason).
  constructor(reason, { optional = false } = {}) {
    super(reason);
    this.optional = Boolean(optional);
  }
}

export const optionalSkip = (reason) => { throw new SkipTest(reason, { optional: true }); };
export const requiredSkip = (reason) => { throw new SkipTest(reason); };

const ledgerPath = (ppid = process.ppid, directory = tmpdir()) => path.join(directory, `codex-opencode-test-skips-${ppid}.jsonl`);
const allowRequired = () => process.env.CODEX_TEST_ALLOW_REQUIRED_SKIPS === "1";

export const SKIP_METADATA_PREFIX = "TEST_RUNNER_SKIP_METADATA: ";
export const MAX_SKIP_METADATA_BYTES = 1024 * 1024;

// One authoritative message carries the complete ledger, not a tail of suite output.
export function validateSkipMetadata(metadata) {
  const fail = message => { throw new Error(`Invalid test-runner skip metadata: ${message}`); };
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
  const count = value => Number.isSafeInteger(value) && value >= 0;
  if (!keys(metadata, ["version", "runnerPid", "allowRequiredSkips", "rows", "counts"]) || metadata.version !== 1
    || !Number.isSafeInteger(metadata.runnerPid) || metadata.runnerPid <= 0 || typeof metadata.allowRequiredSkips !== "boolean"
    || !Array.isArray(metadata.rows)) fail("invalid envelope");
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_SKIP_METADATA_BYTES) fail("message exceeds 1 MiB");
  const counts = { files: metadata.rows.length, skipped: 0, partial: 0, required: 0, total: 0 };
  for (const row of metadata.rows) {
    if (!keys(row, ["file", "total", "skipped", "partial", "required", "failed", "details"])
      || typeof row.file !== "string" || !row.file.trim() || ![row.total, row.skipped, row.partial, row.required].every(count)
      || typeof row.failed !== "boolean") fail("invalid ledger row");
    const details = Object.hasOwn(row, "details") ? row.details : [];
    if (!Array.isArray(details) || details.length !== row.skipped + row.partial) fail(`missing or inconsistent details for ${row.file}`);
    let skipped = 0, partial = 0, required = 0;
    for (const detail of details) {
      if (!keys(detail, ["name", "reason", "optional", "partial"]) || typeof detail.name !== "string" || !detail.name.trim()
        || typeof detail.reason !== "string" || !detail.reason.trim() || typeof detail.optional !== "boolean"
        || typeof detail.partial !== "boolean" || (detail.partial && !detail.optional)) fail(`invalid skip detail for ${row.file}`);
      if (detail.partial) partial++;
      else { skipped++; if (!detail.optional) required++; }
    }
    if (skipped !== row.skipped || partial !== row.partial || required !== row.required) fail(`classification counts differ for ${row.file}`);
    const failed = (row.total > 0 && row.skipped >= row.total) || (row.required > 0 && !metadata.allowRequiredSkips);
    if (row.failed !== failed) fail(`failure policy differs for ${row.file}`);
    counts.skipped += skipped; counts.partial += partial; counts.required += required;
  }
  counts.total = counts.skipped + counts.partial;
  if (!keys(metadata.counts, Object.keys(counts)) || !Object.entries(counts).every(([key, value]) => count(value) && metadata.counts[key] === value))
    fail("aggregate counts differ from ledger details");
  return metadata;
}

export function readSkipLedger(directory, parentPid, { allowRequiredSkips = allowRequired() } = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || !Number.isSafeInteger(parentPid) || parentPid <= 0)
    throw new Error("Skip ledger capture requires the final child's absolute temp directory and runner PID.");
  const ledger = ledgerPath(parentPid, directory), info = lstatSync(ledger);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SKIP_METADATA_BYTES) throw new Error(`Invalid skip ledger file: ${ledger}`);
  const text = readFileSync(ledger, "utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_SKIP_METADATA_BYTES) throw new Error("Skip ledger exceeds 1 MiB.");
  const rows = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const counts = { files: rows.length, skipped: 0, partial: 0, required: 0, total: 0 };
  for (const row of rows) { counts.skipped += row?.skipped; counts.partial += row?.partial; counts.required += row?.required; }
  counts.total = counts.skipped + counts.partial;
  return validateSkipMetadata({ version: 1, runnerPid: parentPid, allowRequiredSkips, rows, counts });
}

// skips: [{ name, reason, optional }]; partial: [{ name, reason }] for a passed case whose
// optional part could not run. Returns true when the gate fails.
export function finishSkips({ file, total, skips = [], partial = [] }) {
  const required = skips.filter((skip) => !skip.optional);
  const everySkipped = total > 0 && skips.length >= total;
  const count = skips.length + partial.length;
  const lines = [`skipped: ${count}${count ? ` (${skips.length} case(s), ${partial.length} partial; ${required.length} required)` : ""}`];
  for (const skip of skips) lines.push(`  - ${skip.optional ? "optional" : "REQUIRED"}: ${skip.name}: ${skip.reason}`);
  for (const skip of partial) lines.push(`  - optional part: ${skip.name}: ${skip.reason}`);
  let failed = false;
  if (everySkipped) {
    lines.push(`Every case of ${file} skipped: nothing was tested, so the file fails.`);
    failed = true;
  }
  if (required.length) {
    if (allowRequired()) {
      lines.push(`WARNING: ${required.length} required case(s) skipped; allowed only because CODEX_TEST_ALLOW_REQUIRED_SKIPS=1.`);
    } else {
      lines.push(`${required.length} required case(s) skipped: a required case must run, so the file fails. Install the missing prerequisite, or set CODEX_TEST_ALLOW_REQUIRED_SKIPS=1 knowingly.`);
      failed = true;
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  const ledger = ledgerPath();
  if (existsSync(ledger)) {
    const details = count ? [...skips.map(skip => ({ name: skip.name, reason: skip.reason, optional: Boolean(skip.optional), partial: false })),
      ...partial.map(skip => ({ name: skip.name, reason: skip.reason, optional: true, partial: true }))] : [];
    appendFileSync(ledger, `${JSON.stringify({ file, total, skipped: skips.length, partial: partial.length, required: required.length, failed,
      ...(count ? { details } : {}) })}\n`);
  }
  return failed;
}

function summary() {
  const ledger = ledgerPath();
  if (!existsSync(ledger)) {
    process.stdout.write("Skip summary: no ledger (run through npm test).\n");
    return;
  }
  const rows = readFileSync(ledger, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  rmSync(ledger, { force: true });
  const total = rows.reduce((sum, row) => sum + row.skipped + row.partial, 0);
  const required = rows.reduce((sum, row) => sum + row.required, 0);
  const detail = rows.filter((row) => row.skipped || row.partial).map((row) => `${row.file} ${row.skipped + row.partial}`);
  process.stdout.write(`Total skipped: ${total} across ${rows.length} reporting test file(s)${detail.length ? ` (${detail.join(", ")})` : ""}${required ? `; ${required} required skip(s) allowed by CODEX_TEST_ALLOW_REQUIRED_SKIPS=1` : ""}.\n`);
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--reset")) writeFileSync(ledgerPath(), "");
  else if (process.argv.includes("--summary")) summary();
  else if (process.argv.includes("--self-test")) {
    const quiet = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    // B-202: the required-skip cases pin the variable themselves, so the self-test gives the
    // same answer in CI (which sets CODEX_TEST_ALLOW_REQUIRED_SKIPS=1 for the whole run).
    const ambientAllow = process.env.CODEX_TEST_ALLOW_REQUIRED_SKIPS;
    const withAllow = (value, run) => {
      if (value === undefined) delete process.env.CODEX_TEST_ALLOW_REQUIRED_SKIPS;
      else process.env.CODEX_TEST_ALLOW_REQUIRED_SKIPS = value;
      try { return run(); } finally {
        if (ambientAllow === undefined) delete process.env.CODEX_TEST_ALLOW_REQUIRED_SKIPS;
        else process.env.CODEX_TEST_ALLOW_REQUIRED_SKIPS = ambientAllow;
      }
    };
    const results = [
      finishSkips({ file: "a", total: 3, skips: [] }) === false,
      finishSkips({ file: "b", total: 3, skips: [{ name: "x", reason: "r", optional: true }] }) === false,
      withAllow(undefined, () => finishSkips({ file: "c", total: 3, skips: [{ name: "x", reason: "r", optional: false }] })) === true,
      withAllow("1", () => finishSkips({ file: "c-allowed", total: 3, skips: [{ name: "x", reason: "r", optional: false }] })) === false,
      finishSkips({ file: "d", total: 2, skips: [{ name: "x", reason: "r", optional: true }, { name: "y", reason: "r", optional: true }] }) === true,
      finishSkips({ file: "e", total: 2, skips: [], partial: [{ name: "x", reason: "r" }] }) === false,
    ];
    process.stdout.write = quiet;
    if (results.every(Boolean)) process.stdout.write("skip-gate self-test passed.\n");
    else {
      process.stdout.write(`skip-gate self-test failed: ${JSON.stringify(results)}\n`);
      process.exitCode = 1;
    }
  }
}
