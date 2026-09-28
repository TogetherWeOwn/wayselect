# Wayselect deployment runbook (TOG-5738)

> **Runbook only — no production activation.** This document describes how to
> build the preview-server image, which environment variables it reads, and
> how to roll a bad deploy back. It does not deploy anything, and the preview
> server itself is fixture-only / dry-run-only: no live routing, no live model
> calls, no credentials, no backend writes (the purchase stub always refuses
> with 403 `preview_only` for real listings, 404 for unknown ones).

## 1. Build

Prerequisites: Docker (or a compatible builder) and network access to the
npm registry and `docker.io/library/node:20-slim`.

```sh
docker build -t wayselect:local .
```

What the `Dockerfile` pins:

- Base `node:20-slim` (matches `engines.node >= 20` in `package.json`).
- `npm ci --omit=dev` against the committed `package-lock.json` — reproducible
  production deps only (`ajv`, `ajv-formats`, `escape-html`).
- Non-root runtime: files are `chown`ed to `node:node` and the server runs as
  `USER node`.
- `HOST=0.0.0.0` is set in-image because the upstream server default is
  loopback (`127.0.0.1`), which is unreachable from outside the container.
- `HEALTHCHECK` hits an unknown path and expects the flag-independent
  `404 {"error":"not_found"}` JSON contract — it passes whether
  `WAYSELECT_PREVIEW` is on or off.

Expected result: the build exits 0. No CI `docker-build` job exists yet —
adding one needs `workflows` write scope, which this repo's GitHub-App
credential lacks (TOG-5728 precedent); a follow-up card adds the job once
that scope is granted. Until then, build verification is manual per §2.

## 2. Run (staging/preview only)

```sh
docker run --rm -p 3000:3000 \
  -e WAYSELECT_PREVIEW=1 \
  wayselect:local
```

Then verify with the repo's own health probe against the running container:

```sh
node bin/check-preview-health --base-url http://localhost:3000
```

Exit 0 = every check passed (skips allowed); exit 1 = failure; exit 2 =
usage error (bad flag). The probe asserts the listing index, one detail
page, the unknown-listing 404, the purchase-stub 403 guard (`H4`), and
catalog-index freshness (`F1`).

## 3. Environment contract

The server reads **three** variables. There are no secrets, no database URLs,
no credentials of any kind.

| Variable | Default | Effect (verified in `web/server.js`, `web/preview.js`) |
| --- | --- | --- |
| `PORT` | `3000` | Validated by `resolvePort()`: integer 1–65535, otherwise the process exits 1 with `Invalid PORT …`. |
| `HOST` | `127.0.0.1` | Bind address. The image overrides it to `0.0.0.0`; running `node web/server.js` directly keeps loopback. |
| `WAYSELECT_PREVIEW` | off (unset) | Truthy values `1`, `true`, `yes`, `on` (case-insensitive, trimmed) enable the `/listings` routes. Anything else — including unset — returns 404 `Preview unavailable` on gated routes. Read-only runtime flag; no writes. |

Explicitly **not** server config (do not set these on a deployment):

- `WAYSELECT_STAGING_ENDPOINT` — read only by local acceptance probes
  (`scripts/e2e-staging-acceptance.mjs`, `bin/accept-wayselect-buyer-listing`)
  to optionally POST a fixture entry at a staging URL. The server ignores it.
- `WAYSELECT_DETAIL_FRAGMENT_DELAY_MS` — test/dev slow-network knob read by
  `web/server.js` (delays the detail fragment only, unset/non-positive means
  no delay). Do not set it on a deployment.

## 4. How staging deploys (TOG-7131)

The trigger is host-mediated: Coolify rebuilds from the host mirror
(`git@<host>:/srv/git/wayselect.git`) via mirror autodeploy, with the panel
bearer held host-side under operator control (TOG-7094). GitHub holds no
panel credential and sends no bearer — the `deploy-staging` job
(`.github/workflows/ci.yml`, `runs-on: ubuntu-latest`) owns the Deployment
record, the fail-closed URL gate (`scripts/check-deploy-target.mjs`), the
mirror-settle delay, the `/healthz` settle poll, and the post-deploy smoke.
Green means "it is live". Host provisioning (mirror, Coolify app, staging
URL, autodeploy) is operator work on TOG-7094, not in this runbook.

## 5. Rollback

Deployments are immutable image tags; rollback is redeploying the previous tag.

1. Identify the last good tag (the deploy log records `<image>:<git-sha>` per
   deploy; `git log --oneline -3` on `main` cross-checks).
2. Redeploy the previous tag with the **same** env (`PORT`, `HOST`,
   `WAYSELECT_PREVIEW`) — never change code and env in one step.
3. Verify: `node bin/check-preview-health --base-url <staging-url>` must
   exit 0, and the purchase-stub guard (`H4 … 403 preview_only`) must pass —
   it proves the rolled-back build still cannot write.
4. If the bad deploy changed env rather than code, restore the previous env
   first and re-run the probe before touching the image tag.

No data migration exists (no database, no volumes), so rollback is
stateless: stop the bad container, start the previous tag, probe green.

## 6. What this runbook does NOT cover (explicit non-goals)

- No production activation: no prod host, DNS, TLS, secrets manager, or
  traffic cutover is defined here.
- No trusted-proxy change: the rate limiter keys on the direct TCP peer and
  deliberately ignores `X-Forwarded-For`. Re-evaluate trusted-proxy handling
  (see `web/rate-limit.js`) before putting this behind any proxy or public URL.
