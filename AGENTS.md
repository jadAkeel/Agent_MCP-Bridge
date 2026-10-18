# Project Verification

Agent MCP Bridge is a local Node.js stdio MCP server with Git worktrees and SQLite state.
Use the repository's native tests and relevant local integration checks to verify changes.

- Run focused regression tests for affected behavior; use isolated fixtures for configuration,
  state, worktrees and process tests.
- Run the appropriate packaging, full-suite or release gates when the change requires them.
- Real-client/provider acceptance requires an explicitly selected route and authorized inference.
  Report fixture coverage separately from real-client and fresh-user acceptance.
- Inspect failures and report actual outcomes, required skips and remaining verification gaps.
- TestSprite is optional. Its installation, authentication, project linking, deployment and
  results are not prerequisites for local development or completion of Bridge fixes.
  Use it only when explicitly requested or appropriate for a separately tested HTTP/web surface.
