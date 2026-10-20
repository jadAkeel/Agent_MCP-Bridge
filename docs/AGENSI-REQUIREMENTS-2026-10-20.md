# Agensi official requirements review — October 20, 2026

Public documentation was inspected read-only. No account was signed in, connector
changed, Skill uploaded, terms accepted or pricing selected. A browser redirect to
Google sign-in was a stop point; public pages were also available through read-only
fetches. No personal browser session was inspected.

## Sources and consequences

1. [Creator checklist](https://www.agensi.io/learn/skill-md-creator-checklist):
   one top-level folder containing SKILL.md, valid trigger-based name/description,
   actionable workflow/output, supporting files, no unexpected binaries/symlinks or
   secrets. It recommends testing in two agents and an independent tester.
   **Confirmed packaging issue repaired:** the previous exporter put SKILL.md at
   ZIP root. RC.2 wraps every payload file in `agent-mcp-bridge/`; local payload and
   manifest paths remain relative to that folder. A regression checks the actual ZIP.
2. [Supporting files guide](https://www.agensi.io/learn/how-to-write-skill-md-supporting-files):
   references/scripts/examples are packaged together, relative to the Skill. It
   describes local reference use, but does not prove that all 200 files in this
   package are retrievable by the current connector. That requires a delivery trial.
3. [Terms](https://www.agensi.io/terms), last updated October 18, 2026:
   sections 5.2/8.2/9 deliver Skills through a signed-in connector, without buyer file
   download/save/export. Section 2.1 permits one connected agent at a time; do not
   connect a test client to Jad's account without approval, as it disconnects the
   current one. Sections 6.2/6.3 require automated eight-point scan, manual review,
   redistribution rights and accurate listing claims. Section 6.3a allows source/docs
   links but prohibits off-platform paid upsells. No such upsell is proposed.
4. [Current MCP setup](https://www.agensi.io/docs/mcp-setup): sign-in/Allow is required;
   a new connection displaces the old app. The connector supplies instructions, not
   the local Bridge/Git/SQLite/CLI runtime.
5. [Seller guide](https://www.agensi.io/learn/how-to-sell-skills-on-agensi): ZIP upload,
   listing description/tags/price and scan/manual review. Its older Stripe-only/free
   setup guidance differs from the current terms: section 6.1 names enabled Stripe
   Connect **or Zoneless USDC** for paid publication. Do not assume Jad's eligibility
   or choose a payout route. Resolve free-listing account requirements in the actual
   owner-approved dashboard rather than claiming them verified here.

## Rights and delivery limits

ISC first-party material and MIT upstream material retain their original licenses
and notices. The original delegates are pinned at
`3aa72d681a79e2a9d09bd9a316353003ae1cb4a7`; installer/package checks verify their bytes.
They are independently obtainable through the companion runtime/source repository.
This is disclosed; the listing does not claim exclusive authorship.

**Unresolved:** platform buyer no-copy terms versus included ISC/MIT redistribution
rights require Agensi clarification before submission, especially for a paid offer.
An open-source license notice alone does not prove platform approval. Scripts in a
remotely delivered reference library do not become installed executables. Do not
export connector content to work around delivery restrictions.

Owner-review question draft (not sent):

> Our Skill includes ISC/MIT instructions and an attributed library of 18 MIT CLI
> delegate guides with support scripts. Runtime and the same open-source files are
> separately available from our GitHub package; the connector must not save files.
> Can your connector retrieve nested references and script text in this layout?
> How should existing open-source redistribution rights be disclosed alongside your
> buyer no-copy licence? Please confirm this package/category is acceptable before
> we submit or set a price.

## Pending owner actions

- Authorize runtime publication or another genuinely obtainable download location.
- Select client/provider/model/account and budget for the bounded real workflow;
  inference was explicitly deferred in this session.
- Arrange independent tester acceptance; do not relabel maintainer fixtures.
- Approve account/terms/upload and eventual publication, and finalize free/paid price
  and payout/support fields as applicable.
- Run actual Skill trigger/reference/tool-discovery/delivery acceptance after approval.

Local CI, ZIP validity and this document do not establish Marketplace readiness.
