// B-179: the bridge refuses to start agents when the OpenCode config directory it would hand
// them (XDG_CONFIG_HOME/opencode) enables MCP servers. A developer's personal OpenCode config
// often does, and the tests import server.js in the developer's environment, so every test that
// loads the bridge imports this module FIRST: it points XDG_CONFIG_HOME at an empty scratch
// directory unless the caller already set one. lib/config.js reads the variable at import time,
// which is why this must be the first import, not a call.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (!process.env.XDG_CONFIG_HOME) {
  process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), "bridge-test-xdg-config-"));
}
