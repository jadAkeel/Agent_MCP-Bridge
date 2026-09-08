import { spawn } from "node:child_process";

const mode = process.argv[2] || "";
const payload = process.argv[3]
  ? JSON.parse(Buffer.from(process.argv[3], "base64url").toString("utf8"))
  : {};

function delay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
}

async function writeEvents(events) {
  for (const event of events || []) {
    const stream = event.stream === "stderr" ? process.stderr : process.stdout;
    const chunk = event.base64 === undefined
      ? String(event.text || "")
      : Buffer.from(event.base64, "base64");
    stream.write(chunk);
    await delay(event.delayAfterMs || 0);
  }
}

switch (mode) {
  case "report":
    process.stdout.write(JSON.stringify({
      cwd: process.cwd(),
      envValue: process.env[payload.envName] ?? null,
    }));
    break;
  case "events":
    await writeEvents(payload.events);
    if (payload.holdMs) {
      await delay(payload.holdMs);
    }
    process.exitCode = payload.exitCode || 0;
    break;
  case "tree": {
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    process.stdout.write(`${JSON.stringify({ grandchildPid: grandchild.pid })}\n`);
    setInterval(() => {}, 1000);
    break;
  }
  case "sleep":
    setInterval(() => {}, 1000);
    break;
  default:
    process.stderr.write(`unknown fixture mode: ${mode}`);
    process.exitCode = 2;
}
