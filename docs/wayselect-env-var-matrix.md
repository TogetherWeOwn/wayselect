# `WAYSELECT_*` env-var matrix (operator doc, TOG-7321)

One ops table for the four `WAYSELECT_*` runtime knobs. Each row names the
default, the scope, and who sets it, with the exact source line a reviewer
can check it against. No secrets, no credentials, no production activation:
every knob below is local preview, test, or dev tooling.

## Ops table

| Variable | Default | Scope | Who sets |
| --- | --- | --- | --- |
| `WAYSELECT_PREVIEW` | Unset → **off** (content routes 404) | Preview web server: gates `GET /listings`, `GET /listings/:provider/:model` (shell + JSON fragment), `POST /sellers/submissions`, `GET`/`POST /sellers/submissions/:provider/:model/confirm`. `/healthz` and `/favicon.ico` stay ungated | Operator running `npm run preview` (`node web/server.js`) |
| `WAYSELECT_TRUSTED_PROXY_IP` | Unset (or blank) → **direct-remote only**, `X-Forwarded-For` ignored | `createApp` rate-limit identity (`web/server.js`, `resolveClientIp` in `web/rate-limit.js`): only when the direct TCP peer normalizes to this IP is the leftmost XFF entry used as the client key | Operator whose preview sits behind exactly one reverse proxy; otherwise leave unset |
| `WAYSELECT_DETAIL_FRAGMENT_DELAY_MS` | Unset → `"0"` → **no delay** | `GET /listings/:provider/:model` with `Accept: application/json` and preview on — the `{ html }` fragment only; shell first paint, flag-off path, index, purchase stub, and `/healthz` never delayed | Developer exercising the skeleton loading state; never set in shared, staging, or production |
| `WAYSELECT_ALLOW_NETWORK` | Unset → **no-network guard active** | Test runs preloading `support/no-network-guard.js` (`npm test`, `bin/accept-fixture-refresh`): non-loopback `fetch`/socket calls reject; loopback (`localhost`, `127.0.0.1`, `::1`) and unix-socket paths still pass | Developer running something that genuinely needs the network; never set in CI |

## Row-by-row verification notes

### `WAYSELECT_PREVIEW` — `web/preview.js:8-14`, gates at `web/server.js:422,498,559,642`

`isPreviewEnabled` returns false for unset/null and true only for the
trimmed, case-insensitive truthy set `1`, `true`, `yes`, `on`. Flag-off
content routes answer 404: HTML `Preview unavailable` pages for browsers,
`{error: "preview_disabled"}` JSON where the client negotiates
`application/json` (the detail shell's fragment fetch). Four gate sites in
`web/server.js`: listing index (422), seller intake (498), seller confirm
(559), listing detail (642). Ungated by design: `GET /healthz` (liveness
must not look dead) and `GET /favicon.ico` (204, keeps page loads out of
the 404 logs).

### `WAYSELECT_TRUSTED_PROXY_IP` — `web/server.js:326-327`, `web/rate-limit.js:100-125`

`options.trustedProxyIp ?? env.WAYSELECT_TRUSTED_PROXY_IP ?? null`; a null
or whitespace-only value collapses to unset. Unset means `resolveClientIp`
returns the direct TCP peer and never consults `X-Forwarded-For`, so
spoofed headers cannot rotate rate-limit identities. Set means single-hop
opt-in: only when the direct peer normalizes to the trusted IP is the
leftmost XFF entry used, and garbage/hostname entries fall back to the
direct peer. Both sides normalize IPv4-mapped IPv6 (`::ffff:127.0.0.1` ≡
`127.0.0.1`). Header comment: `web/rate-limit.js:12-19`.

### `WAYSELECT_DETAIL_FRAGMENT_DELAY_MS` — `web/server.js:704-708`

Parsed as `Number.parseInt(String(value ?? "0"), 10)`; only finite values
`> 0` delay via `setTimeout`, everything else serves immediately
(fail-open to fast, never a hang). Full parse table, units, and operator
recipes live in `docs/wayselect-slow-network-knob.md` — this matrix defers
to it and does not duplicate the contract.

### `WAYSELECT_ALLOW_NETWORK` — `support/no-network-guard.js:27,94`

Strict `=== "1"` check; any other value (including `"true"`) keeps the
guard on. Loaded via `node --test --import ./support/no-network-guard.js`
(`package.json` `test` script) and by `bin/accept-fixture-refresh:187`.
The only sanctioned networked path is the opt-in
`wayselect catalog import --fetch` CLI flag, which no test exercises.

## Out of scope

- `WAYSELECT_STAGING_ENDPOINT` also exists (`scripts/e2e-staging-acceptance.mjs:135`):
  an opt-in staging catalog POST target for the e2e script, undeclared by
  default (the publish step then runs as a local validator gate). It is
  script-local, not server/test runtime, so it is outside this matrix.
- Plain `PORT` (default `"3000"`, strict integer 1–65535,
  `web/server.js` port resolution) is not `WAYSELECT_*`-namespaced and is
  likewise outside this matrix.
