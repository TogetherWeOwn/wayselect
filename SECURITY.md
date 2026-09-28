# Security Policy

> **Early development — fixture-only, dry-run only.** Wayselect has no live
> routing, no live model calls, no live provider credentials, and no endpoint
> discovery. There is no bug-bounty program. This policy describes what is
> supported, how to report a vulnerability, and what to expect back.
> Background: [`README.md`](README.md) ("What Wayselect is / is not").

## Supported versions

Only the latest commit on `main` is supported. There are no release
branches, backports, or LTS lines — this project is pre-release and moves
as a single line.

| Version | Supported |
| --- | --- |
| Latest `main` | Yes |
| Older commits, tags, forks | No — please reproduce on latest `main` first |

## How to report a vulnerability

**Do not open a public issue, PR, or discussion with vulnerability details.**

Report privately via GitHub Security Advisories on
`TogetherWeOwn/wayselect`: the repository **Security** tab → **Advisories**
→ **Report a vulnerability**. Only the reporter and maintainers can see it.

A good report includes:

- What you think is wrong and why it matters (confidentiality, integrity,
  or availability impact in the fixture-only slice).
- Steps to reproduce offline against a local checkout — fixture input,
  command, commit SHA. Offline repros are strongly preferred: the test
  suite is offline by policy ([`CONTRIBUTING.md`](CONTRIBUTING.md)).
- Affected files and the `main` commit you reproduced on.
- Whether you believe the issue also affects a dependency rather than
  Wayselect itself (see Scope below).

If private reporting is ever unavailable, contact a maintainer through a
private channel and share details only after they acknowledge — never in a
public thread.

If you find a secret committed to the repo (we hold none by design), treat
it as a vulnerability report: report privately, do not quote the secret
anywhere public, and maintainers will revoke/rotate and purge history.

## Response SLA

Maintainer commitments, measured from the private report timestamp:

- **Acknowledge within 72 hours** — confirm receipt and assign a handler.
- **Initial assessment within 7 days** — valid / needs-more-info / rejected
  with reasons, plus a severity call.
- **Fix or mitigation plan within 30 days** for confirmed issues, shipped
  as a normal reviewed PR (reviewer ≠ author, green CI on the exact head
  SHA that merges, per [`CONTRIBUTING.md`](CONTRIBUTING.md)). Timelines for
  complex issues are communicated in the advisory thread, not by silence.
- **Credit** in the advisory and CHANGELOG entry unless you ask to stay
  anonymous.

## Scope

In scope — the supported slice:

- `src/`, `web/`, `bin/`, `schema/` as run locally against synthetic
  fixtures: fail-closed eligibility bypasses, boundary-validation escapes
  (e.g. executable location fields smuggled past `src/catalog.js`),
  preview-server access-control or input-validation flaws. Known preview
  gaps already tracked in
  [`docs/wayselect-preview-security-checklist.md`](docs/wayselect-preview-security-checklist.md)
  do not need re-reporting — check there first.
- Supply-chain issues *in this repo's own pinning*: dependency confusion
  or pin drift covered by
  [`docs/dependency-update-policy.md`](docs/dependency-update-policy.md).
- Incident handling for a confirmed issue follows
  [`docs/incident-runbook.md`](docs/incident-runbook.md).

Out of scope (no bounty — there is none — and generally closed as
not-applicable):

- Anything requiring live services: there are no live model endpoints,
  credentials, paid inference, billing data, or production deployments to
  attack. The selection transport is an in-memory fake (`FakeTransport`,
  `networkUsed: false`); "SSRF/RCE against model endpoints" style reports
  do not apply.
- Upstream vulnerabilities in npm packages or in models.dev itself —
  report those to the upstream project; we will pick up fixed pins through
  the dependency-update policy.
- Third-party catalog redistribution, compatibility/cost/savings claims
  (the project makes none — see `README.md` claims discipline).
- Social engineering, physical attacks, or spam/phishing of maintainers.
- Reports generated solely by automated scanners with no demonstrated
  impact on this slice.

## Ground rules for testing

- Test only against local checkouts you control (`git clone … && npm ci`).
  Never probe anyone else's running preview server or infrastructure.
- Do not exfiltrate, publish, or retain any non-public data you
  accidentally encounter; report it and delete local copies.
- Keep tests offline and fixture-based, matching the project's own test
  policy — no live-network "proof of exploit" that touches third parties.

## No bounty

Wayselect currently offers no monetary bug bounty and no swag or credit
program beyond advisory/CHANGELOG attribution. By reporting you agree your
submission is voluntary; you retain your rights in your own report text,
and any fix landed by maintainers follows the repo's MIT license like any
other contribution.
