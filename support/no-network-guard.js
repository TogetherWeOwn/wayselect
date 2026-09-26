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
//
// Loopback carve-out: in-process server tests (e.g. the web preview server
// tests on origin/main) bind 127.0.0.1/::1 and fetch them over loopback. That
// traffic never leaves the host, so it passes through to the real
// implementation; every non-loopback destination still rejects before any
// socket is opened. Unix-domain socket paths likewise never leave the host.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const BYPASS = process.env.WAYSELECT_ALLOW_NETWORK === "1";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function guardError(callee) {
  return new Error(
    `[wayselect no-network guard] ${callee} is forbidden in tests; ` +
      "the only networked path is the opt-in `catalog import --fetch`",
  );
}

function forbidden(callee) {
  throw guardError(callee);
}

function isLoopbackHostname(hostname) {
  return typeof hostname === "string" && LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

// True when a fetch() target stays on this host. Accepts the string/URL/
// Request forms fetch() supports; anything unparseable fails closed.
function isLoopbackFetchTarget(target) {
  try {
    const url = target instanceof Request ? new URL(target.url) : new URL(target);
    return isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

// True when an http/https.request/get target stays on this host. Covers the
// (url) and (options) arities; options without a hostname default to
// localhost per the stdlib docs.
function isLoopbackHttpTarget(args) {
  const first = args[0];
  if (typeof first === "string" || first instanceof URL) {
    return isLoopbackFetchTarget(first);
  }
  if (first !== null && typeof first === "object" && !(first instanceof URL)) {
    if (typeof first.path === "string" && typeof first.hostname !== "string" && typeof first.host !== "string") {
      return true; // IPC path or hostname-less options (defaults to localhost)
    }
    const host = first.hostname ?? first.host ?? "localhost";
    return isLoopbackHostname(String(host).split(":")[0]);
  }
  return false;
}

// True when a net/tls.connect target stays on this host: a unix-socket path,
// an omitted host (stdlib defaults to localhost), or an explicit loopback.
function isLoopbackConnectTarget(args) {
  const [first, second] = args;
  if (typeof first === "string") {
    return true; // IPC path: net.connect treats a lone string as a pipe path
  }
  if (typeof first === "number") {
    return second === undefined || isLoopbackHostname(String(second));
  }
  if (first !== null && typeof first === "object") {
    if (typeof first.path === "string") {
      return true; // IPC path
    }
    return isLoopbackHostname(String(first.host ?? first.hostname ?? "localhost").split(":")[0]);
  }
  return false;
}

if (!BYPASS) {
  const realFetch = globalThis.fetch;
  const realRequest = { http: http.request, https: https.request };
  const realGet = { http: http.get, https: https.get };
  const realConnect = net.connect;
  const realCreateConnection = net.createConnection;
  const realTlsConnect = tls.connect;

  // fetch rejects (like a real failed request) rather than throwing, so
  // both sync and async callers observe the guard.
  globalThis.fetch = (target, ...rest) => {
    if (isLoopbackFetchTarget(target)) {
      return realFetch(target, ...rest);
    }
    return Promise.reject(guardError(`fetch(${target})`));
  };

  for (const transport of [http, https]) {
    const name = transport === http ? "http" : "https";
    transport.request = (...args) => {
      if (isLoopbackHttpTarget(args)) {
        return realRequest[name].apply(transport, args);
      }
      return forbidden(`${name}.request`);
    };
    transport.get = (...args) => {
      if (isLoopbackHttpTarget(args)) {
        return realGet[name].apply(transport, args);
      }
      return forbidden(`${name}.get`);
    };
  }

  net.connect = (...args) => {
    if (isLoopbackConnectTarget(args)) {
      return realConnect(...args);
    }
    return forbidden("net.connect");
  };
  net.createConnection = (...args) => {
    if (isLoopbackConnectTarget(args)) {
      return realCreateConnection(...args);
    }
    return forbidden("net.createConnection");
  };
  tls.connect = (...args) => {
    if (isLoopbackConnectTarget(args)) {
      return realTlsConnect(...args);
    }
    return forbidden("tls.connect");
  };
}
