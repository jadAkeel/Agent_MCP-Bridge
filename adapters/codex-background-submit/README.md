# OpenCode submission adapter for Codex

This optional adapter starts the registered `opencode-delegate` CLI relay through `codex-background`. `delegate_submit` returns a run ID after dispatch. `delegate_result` returns the current state or terminal outcome by ID on a later turn. The original blocking tools remain available.

Apply [the adapter patch](opencode-submit.patch) to a dedicated local copy of the pinned standalone skills. The [upstream guide](../../docs/DELEGATE-UPSTREAM.md) identifies the compatible revision and explains how to install those skills. Use PowerShell with absolute paths to the checkout and the local skills directory.

The patch includes portions of the upstream skills under their [MIT license](../../vendor/delegate-skills/LICENSE).

```powershell
$patch = Join-Path $bridgeCheckout 'adapters/codex-background-submit/opencode-submit.patch'
Push-Location $localSkillsDirectory
try {
    git apply --check $patch
    if ($LASTEXITCODE -ne 0) { throw 'The local skills do not match the adapter base.' }
    git apply $patch
    if ($LASTEXITCODE -ne 0) { throw 'Could not apply the adapter.' }
} finally {
    Pop-Location
}
```

Use the installed support skill's setup instructions for the existing registry. Keep the MCP helper disabled while idle. Start or temporarily enable it for authorized work and reload the MCP connection to discover the adapter tools. Keep the owning server available while any caller has a live job, pending request, or uncollected result. The final caller stops the idle instance and restores the disabled configuration after verifying shared ownership. Closing the owning connection can abort a live job.

Save the run ID after `delegate_submit`, return control to the caller, and use `delegate_result` once on a later turn. Review the terminal report and actual diff, rerun required checks, and integrate under the applicable repository policy. The adapter does not schedule a new Codex turn.

To verify the patched copy, run `node --test --test-concurrency=1 codex-background/scripts/server.test.mjs` from the skills directory. Once active work is collected and its helper is idle, rollback uses `git apply -R --check` and `git apply -R` from the same directory.
