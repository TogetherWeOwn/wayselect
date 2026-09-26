// No-network guard for the Wayselect test run (TOG-4800).
//
// Preloaded via `node --test --import ./support/no-network-guard.js` (see the
// `test` script in package.json). Any fetch or outbound socket attempt fails
// loudly instead of hanging or leaking traffic.
//
// The ONLY sanctioned networked path is the opt-in
// `wayselect catalog import --fetch` CLI flag, which no test exercises — every
// import test reads a local file. To run something that genuinely needs the
// network, set WAYSELECT_ALLOW_NETWORK=1 explicitly.
//
// Scope: global fetch plus the stdlib socket constructors tests could reach
// (http/https request helpers, net, tls). DNS-only lookups are out of scope;
// nothing under test performs them.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const BYPASS = process.env.WAYSELECT_ALLOW_NETWORK === "1";

function guardError(callee) {
  return new Error(
    `[wayselect no-network guard] ${callee} is forbidden in tests; ` +
      "the only networked path is the opt-in `catalog import --fetch`",
  );
}

function forbidden(callee) {
  throw guardError(callee);
}

if (!BYPASS) {
  // fetch rejects (like a real failed request) rather than throwing, so
  // both sync and async callers observe the guard.
  globalThis.fetch = (...args) => Promise.reject(guardError(`fetch(${args[0]})`));

  for (const transport of [http, https]) {
    transport.request = (...args) => forbidden(`${transport === http ? "http" : "https"}.request`);
    transport.get = (...args) => forbidden(`${transport === http ? "http" : "https"}.get`);
  }

  net.connect = (...args) => forbidden("net.connect");
  net.createConnection = (...args) => forbidden("net.createConnection");
  tls.connect = (...args) => forbidden("tls.connect");
}
