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
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const ledgerPath = (ppid = process.ppid) => path.join(tmpdir(), `codex-opencode-test-skips-${ppid}.jsonl`);
const allowRequired = () => process.env.CODEX_TEST_ALLOW_REQUIRED_SKIPS === "1";

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
    appendFileSync(ledger, `${JSON.stringify({ file, total, skipped: skips.length, partial: partial.length, required: required.length, failed })}\n`);
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
    const results = [
      finishSkips({ file: "a", total: 3, skips: [] }) === false,
      finishSkips({ file: "b", total: 3, skips: [{ name: "x", reason: "r", optional: true }] }) === false,
      finishSkips({ file: "c", total: 3, skips: [{ name: "x", reason: "r", optional: false }] }) === true,
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
