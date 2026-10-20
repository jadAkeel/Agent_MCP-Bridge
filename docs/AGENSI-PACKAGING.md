# Build the Agensi submission

This exporter prepares an English marketplace submission with one root entrypoint,
complete supporting files and preserved third-party attribution. It reuses the existing
Skill renderer and verified source manifest; it does not change installed client Skills.

## Commands

```text
node bin/package-agensi.js --check
node --test tests/agensi-package.test.js
node bin/package-agensi.js
```

The default output is a new directory at
`dist/agensi/agent-mcp-bridge-0.1.0-rc.2/`. To use a different new directory:

```text
node bin/package-agensi.js --output-dir "<new-output-directory>"
```

An existing output directory is refused. Builds do not overwrite previous evidence.
The exporter uses Node.js built-ins, with no archive dependency or provider calls.

## Output

- `agent-mcp-bridge-0.1.0-rc.2.zip`: the seller upload artifact, with one containing
  `agent-mcp-bridge/` folder and `SKILL.md` at that folder's root.
- `submission/`: the exact unarchived payload for local inspection.
- `SHA256SUMS`: archive digest.
- `BUILD-REPORT.json`: file inventory, hashes, component/source manifest identity and ZIP
  digest. It describes local packaging, not a runtime release or marketplace acceptance.

The ZIP has a single top-level `agent-mcp-bridge/` directory, as required by the
[official creator checklist](https://www.agensi.io/learn/skill-md-creator-checklist)
(checked October 20, 2026). Inside it are one marketplace Skill and `library/` containing the three existing
orchestration guides, three managed worker guides, 18 unchanged independent delegate
folders, and two unchanged helper folders. Managed references are rendered into their
own folders. Sibling helper paths in the original library remain intact.

The marketplace entrypoint is maintained in `skills/bridge-delegation/`. It is exported
explicitly and does not change the default three-Skill local installer selection.
`references/catalog.md`, the root LICENSE and aggregate MIT notices are assembled at
build time. `package-manifest.json` hashes every payload file except itself; the archive
digest covers it too. Fixed ZIP timestamps and sorted entries give repeatable bytes
for matching inputs and the same Node/zlib implementation.

## Delivery and installation boundary

The submission includes reference scripts, but their presence in an upload does not
install them on a buyer's disk. The root Skill directs execution to the separately
installed local Bridge/original scripts. Use the matching companion runtime package and
its installer; do not save remotely delivered Skill content to disk as a workaround for
marketplace delivery rules. Actual Agensi reference access still needs a delivery trial.

The seller description is maintained separately in [AGENSI-LISTING.md](AGENSI-LISTING.md).
It is not mixed into the agent's runtime instructions.

## Before submission/publication

Finalize pricing and the exact companion-runtime download/version/hash. Test installation
and one real-client file-read/write/review/integration journey on the selected authorized
provider route. Preserve local test failures and acceptance limits in the release record.
Upload/review/publication and account/terms changes are owner-authorized actions.

Local packaging tests are not a new full-suite pass, real provider acceptance, independent
fresh-user acceptance, or Agensi approval. Keep those outcomes separate in the final
release decision.
