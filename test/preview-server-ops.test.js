// Tests for the TOG-5726 preview server operability slice: GET /healthz,
// PORT env handling (resolvePort), and graceful shutdown wiring.
//
// node:test, zero dependencies.

import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import {
  createApp,
  installShutdownHandlers,
  resolvePort,
  SERVER_VERSION,
} from "../web/server.js";

const JSON_CT = "application/json; charset=utf-8";

describe("preview server ops (TOG-5726)", () => {
  const servers = [];
  const listeners = [];
  async function start(env, options) {
    const server = createApp(env, options);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  after(async () => {
    for (const remove of listeners.splice(0)) {
      remove();
    }
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  });

  async function get(base, path, init) {
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      text,
    };
  }

  it("GET /healthz returns {status: ok, version} as JSON when preview is on", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const probe = await get(base, "/healthz");
    strictEqual(probe.status, 200);
    strictEqual(probe.contentType, JSON_CT);
    deepStrictEqual(JSON.parse(probe.text), { status: "ok", version: SERVER_VERSION });
    ok(SERVER_VERSION !== "", "version must be non-empty");
  });

  it("GET /healthz version pins the package manifest version (TOG-6378)", async () => {
    // Gap B5: SERVER_VERSION is read from the manifest at module load; the
    // existing assertions compare /healthz against the imported constant
    // itself, so a drifted or hardcoded source would still pass. Read
    // package.json independently so drift fails loudly.
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    ok(
      typeof manifest.version === "string" && manifest.version !== "",
      "package.json must carry a non-empty version",
    );
    strictEqual(SERVER_VERSION, manifest.version, "SERVER_VERSION must equal package.json version");
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const probe = await get(base, "/healthz");
    strictEqual(probe.status, 200);
    deepStrictEqual(JSON.parse(probe.text), { status: "ok", version: manifest.version });
  });

  it("GET /healthz answers when preview is off (health is not content)", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "0" });
    const probe = await get(base, "/healthz");
    strictEqual(probe.status, 200);
    deepStrictEqual(JSON.parse(probe.text), { status: "ok", version: SERVER_VERSION });
  });

  it("GET /healthz is exempt from rate limiting", async () => {
    // Budget of 1 per window: the first listing request passes, the second
    // is refused — but health probes must still answer 200.
    const base = await start({ WAYSELECT_PREVIEW: "1" }, { rateLimit: { windowMs: 60_000, max: 1 } });
    strictEqual((await get(base, "/listings")).status, 200);
    const limited = await get(base, "/listings");
    strictEqual(limited.status, 429, "precondition: limiter must be saturated");
    const probe = await get(base, "/healthz");
    strictEqual(probe.status, 200);
    deepStrictEqual(JSON.parse(probe.text), { status: "ok", version: SERVER_VERSION });
  });

  it("non-GET /healthz is 405 JSON; trailing slash keeps the 404 contract", async () => {
    const base = await start({ WAYSELECT_PREVIEW: "1" });
    const post = await get(base, "/healthz", { method: "POST" });
    strictEqual(post.status, 405);
    strictEqual(post.contentType, JSON_CT);
    // TOG-6717 rides alongside the error code: this pin owns the probe
    // routing, not the envelope shape.
    const { requestId: _postRequestId, ...postBody } = JSON.parse(post.text);
    deepStrictEqual(postBody, { error: "method_not_allowed" });
    // A query string does not change the probe path (URL pathname match),
    // so harmless probe parameters still answer 200.
    const queried = await get(base, "/healthz?x=1");
    strictEqual(queried.status, 200);
    // A trailing slash is a different path: it falls through to the
    // unknown-path JSON 404, never a false-positive 200.
    const miss = await get(base, "/healthz/");
    strictEqual(miss.status, 404);
    // TOG-6717 rides alongside the error code (see above).
    const { requestId: _missRequestId, ...missBody } = JSON.parse(miss.text);
    deepStrictEqual(missBody, { error: "not_found" });
  });

  describe("resolvePort", () => {
    it("accepts valid ports, the env, and defaults to 3000", () => {
      strictEqual(resolvePort("3000"), 3000);
      strictEqual(resolvePort(" 9001 "), 9001);
      strictEqual(resolvePort("1"), 1);
      strictEqual(resolvePort("65535"), 65535);
      // The no-arg form reads process.env.PORT; control the env so the
      // test is hermetic regardless of the ambient shell.
      const saved = process.env.PORT;
      try {
        delete process.env.PORT;
        strictEqual(resolvePort(), 3000);
        process.env.PORT = "9001";
        strictEqual(resolvePort(), 9001);
      } finally {
        if (saved === undefined) {
          delete process.env.PORT;
        } else {
          process.env.PORT = saved;
        }
      }
    });

    it("rejects out-of-range and non-numeric PORT values", () => {
      for (const bad of ["0", "65536", "-1", "abc", "", "3.5", "3000x"]) {
        throws(() => resolvePort(bad), RangeError, `PORT=${JSON.stringify(bad)}`);
      }
    });
  });

  describe("installShutdownHandlers", () => {
    it("closes the server and exits 0 on SIGTERM after drain", async () => {
      const server = createApp({ WAYSELECT_PREVIEW: "1" });
      servers.push(server);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      let exitCode = null;
      const fakeTimers = {
        setTimeout: (fn) => ({ __fake: true, fn }),
        clearTimeout: () => {},
      };
      const remove = installShutdownHandlers(server, {
        exit: (code) => {
          exitCode = code;
        },
        timers: fakeTimers,
      });
      listeners.push(remove);
      process.emit("SIGTERM");
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      strictEqual(exitCode, 0, "expected exit(0) after drain");
      ok(server.listening === false, "server must stop accepting connections");
    });

    it("ignores a second signal while a shutdown is already in flight", async () => {
      const server = createApp({ WAYSELECT_PREVIEW: "1" });
      servers.push(server);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const exits = [];
      const fakeTimers = {
        setTimeout: (fn) => ({ __fake: true, fn }),
        clearTimeout: () => {},
      };
      const remove = installShutdownHandlers(server, {
        exit: (code) => exits.push(code),
        timers: fakeTimers,
      });
      listeners.push(remove);
      process.emit("SIGTERM");
      process.emit("SIGINT");
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      deepStrictEqual(exits, [0], "exactly one exit, from the first signal");
    });
  });
});
