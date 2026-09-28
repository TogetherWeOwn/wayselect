// TOG-5749: fuzz tests over malicious transport/catalog shapes.
//
// Deterministic seeded fuzzer (mulberry32, fixed seed): randomized route
// objects with forbidden executable-location keys injected at random
// depths/containers must always be rejected by FakeTransport with TypeError,
// and must never record a call. Malformed routes fail closed with TypeError.
// Catalog-entry schema rejects injected url/endpoint extras (ok:false), and
// normalizeCatalog rejects unknown location fields instead of normalizing.
// Seller/purchase intake rejects forbidden fields at every fuzzed position.
//
// Fixture-only, no network. Bypass count for this run: zero exploitable
// bypasses (see report at the bottom). If this fuzzer ever passes a
// forbidden exact key through send(), that is a bypass: file it as its own
// bug card, do not relax the test.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  computeCatalogSnapshotHash,
  FakeTransport,
  normalizeCatalog,
  PurchaseSubmissionError,
  SellerSubmissionError,
  validatePurchaseSubmission,
  validateSellerSubmission,
} from "../src/index.js";
import { validateCatalogEntry } from "../src/validate-catalog-entry.js";

// Fixed seed: the same suite must generate the same cases on every run.
const SEED = 0x5749;
const ITERATIONS = 200;

const FORBIDDEN_KEYS = ["url", "endpoint", "baseUrl", "apiUrl"];
const BENIGN_KEYS = ["docs", "notes", "meta", "info", "label", "extra", "nested", "items"];

// Protocol variants for the injected values. The guard is key-based, so the
// value must never matter; every variant below must still be rejected.
const EVIL_VALUES = [
  "https://example.invalid/model",
  "http://example.invalid/model",
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "file:///etc/passwd",
  "ftp://example.invalid/x",
  "//example.invalid/protocol-relative",
  "https://example.invalid/ｕrl-unicode",
  "%68%74%74%70%73%3a%2f%2fexample.invalid/pct-encoded",
];

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, pool) {
  return pool[Math.floor(rng() * pool.length)];
}

// Build a random benign nested structure of objects/arrays/scalars.
function randomBenign(rng, depth) {
  const roll = rng();
  if (depth <= 0 || roll < 0.3) {
    return pick(rng, ["text", 42, true, null, "https://example.invalid/value-only"]);
  }
  if (roll < 0.65) {
    const obj = {};
    const count = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < count; i += 1) {
      obj[pick(rng, BENIGN_KEYS)] = randomBenign(rng, depth - 1);
    }
    return obj;
  }
  const arr = [];
  const count = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < count; i += 1) {
    arr.push(randomBenign(rng, depth - 1));
  }
  return arr;
}

// Inject a forbidden key at a random depth inside a cloned benign structure.
// Returns the mutated route and the injected key.
function injectForbidden(rng, route) {
  const key = pick(rng, FORBIDDEN_KEYS);
  const value = pick(rng, EVIL_VALUES);
  let target = route;
  const depth = Math.floor(rng() * 4);
  for (let i = 0; i < depth; i += 1) {
    if (Array.isArray(target)) {
      let next = target.find((item) => item !== null && typeof item === "object");
      if (next === undefined) {
        target.push({});
        next = target[target.length - 1];
      }
      target = next;
    } else {
      const childKey = pick(rng, BENIGN_KEYS);
      let child = target[childKey];
      if (child === null || typeof child !== "object") {
        child = rng() < 0.5 ? {} : [{}];
        target[childKey] = child;
      }
      if (Array.isArray(child)) {
        let next = child.find((item) => item !== null && typeof item === "object");
        if (next === undefined) {
          next = {};
          child.push(next);
        }
        target = next;
      } else {
        target = child;
      }
    }
  }
  if (Array.isArray(target)) {
    target.push({ [key]: value });
  } else {
    target[key] = value;
  }
  return key;
}

function randomRoute(rng) {
  const route = { routeId: "northstar/fuzz-chat", ...randomBenign(rng, 3) };
  if (typeof route !== "object" || route === null || Array.isArray(route)) {
    return { routeId: "northstar/fuzz-chat" };
  }
  return route;
}

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

test("fuzzer is deterministic for the fixed seed", () => {
  const first = randomRoute(mulberry32(SEED));
  const second = randomRoute(mulberry32(SEED));
  assert.deepEqual(second, first);
  const third = randomRoute(mulberry32(SEED + 1));
  assert.notDeepEqual(third, first, "different seeds must diverge");
});

test(`property: ${ITERATIONS} randomized malicious routes are rejected, never recorded`, async () => {
  const rng = mulberry32(SEED);
  for (let i = 0; i < ITERATIONS; i += 1) {
    const transport = new FakeTransport();
    const route = randomRoute(rng);
    const key = injectForbidden(rng, route);
    const callsBefore = transport.calls.length;
    await assert.rejects(
      () => transport.send({ route, payload: { prompt: "synthetic" } }),
      (error) =>
        error instanceof TypeError &&
        error.message.includes("must not contain executable location field") &&
        error.message.includes(key),
      `case ${i}: forbidden key ${key} passed the guard`,
    );
    assert.equal(
      transport.calls.length,
      callsBefore,
      `case ${i}: rejected send must not record a call`,
    );
  }
});

test("transport rejects every forbidden key at every fixed adversarial shape", async () => {
  const shapes = [
    (key, value) => ({ routeId: "northstar/alpha-chat", [key]: value }),
    (key, value) => ({ routeId: "northstar/alpha-chat", nested: { deep: { [key]: value } } }),
    (key, value) => ({ routeId: "northstar/alpha-chat", items: [{ [key]: value }] }),
    (key, value) => ({ routeId: "northstar/alpha-chat", items: [[[{ [key]: value }]]] }),
    (key, value) => ({ routeId: "northstar/alpha-chat", [key]: [value, { [key]: value }] }),
  ];
  for (const key of FORBIDDEN_KEYS) {
    for (const value of EVIL_VALUES) {
      for (const [shapeIndex, shape] of shapes.entries()) {
        const transport = new FakeTransport();
        await assert.rejects(
          () => transport.send({ route: shape(key, value), payload: {} }),
          new RegExp(`must not contain executable location field: ${key}`),
          `key=${key} shape=${shapeIndex} value=${JSON.stringify(value)}`,
        );
        assert.equal(transport.calls.length, 0);
      }
    }
  }
});

test("transport rejects hostile object wrappings fail-closed", async () => {
  const transport = new FakeTransport();
  // __proto__ smuggled through JSON parsing.
  await assert.rejects(
    () =>
      transport.send({
        route: JSON.parse('{"routeId":"northstar/alpha-chat","__proto__":{"url":"https://example.invalid/x"}}'),
        payload: {},
      }),
    /must not contain executable location field: url/,
  );
  // Frozen and null-prototype routes are still scanned.
  await assert.rejects(
    () =>
      transport.send({
        route: Object.freeze({ routeId: "northstar/alpha-chat", url: "https://example.invalid/x" }),
        payload: {},
      }),
    /must not contain executable location field: url/,
  );
  await assert.rejects(
    () =>
      transport.send({
        route: Object.assign(Object.create(null), {
          routeId: "northstar/alpha-chat",
          baseUrl: "https://example.invalid/x",
        }),
        payload: {},
      }),
    /must not contain executable location field: baseUrl/,
  );
  assert.equal(transport.calls.length, 0);
});

test("transport rejects malformed routes fail-closed with TypeError", async () => {
  const transport = new FakeTransport();
  for (const bad of [null, "northstar/alpha-chat", 42, [], {}, { routeId: 42 }, { routeId: null }]) {
    await assert.rejects(
      () => transport.send({ route: bad, payload: {} }),
      (error) => error instanceof TypeError,
      `expected TypeError, route passed: ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(transport.calls.length, 0);
});

test("transport accepts clean routes; the guard is key-based, not value-based", async (context) => {
  context.mock.method(globalThis, "fetch", () => {
    throw new Error("network access is forbidden in fixture execution");
  });
  const transport = new FakeTransport();
  const result = await transport.send({
    route: {
      routeId: "northstar/alpha-chat",
      docs: "https://example.invalid/value-only-is-not-a-location-field",
      nested: { notes: ["javascript:alert(1) is only a string here"] },
    },
    payload: { prompt: "synthetic input" },
  });
  assert.equal(result.adapter, "fake");
  assert.equal(result.networkUsed, false);
  assert.equal(transport.calls.length, 1);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("property: catalog-entry schema rejects injected location fields", async () => {
  const fixture = await readJson("./fixtures/valid.json");
  const rng = mulberry32(SEED);
  for (let i = 0; i < 50; i += 1) {
    const entry = structuredClone(fixture);
    const key = pick(rng, FORBIDDEN_KEYS);
    const value = pick(rng, EVIL_VALUES);
    const at = Math.floor(rng() * 4);
    if (at === 0) {
      entry.entry[key] = value;
    } else if (at === 1) {
      entry.entry.modalities[key] = value;
    } else if (at === 2) {
      entry.entry.cost[key] = value;
    } else {
      entry.provenance[key] = value;
    }
    const result = validateCatalogEntry(entry);
    assert.equal(result.ok, false, `case ${i}: injected ${key} at ${at} accepted`);
    assert.match(result.error, /Catalog entry rejected/);
  }
});

test("property: normalizeCatalog rejects unknown location fields, never normalizes", async () => {
  const fixture = await readJson("../fixtures/catalog.synthetic.json");
  const rng = mulberry32(SEED);
  for (let i = 0; i < 50; i += 1) {
    const catalog = structuredClone(fixture.catalog);
    const providerKey = pick(rng, Object.keys(catalog));
    const modelKey = pick(rng, Object.keys(catalog[providerKey].models));
    const key = pick(rng, FORBIDDEN_KEYS);
    catalog[providerKey].models[modelKey][key] = pick(rng, EVIL_VALUES);
    assert.throws(
      () =>
        normalizeCatalog(catalog, {
          ...fixture.provenance,
          snapshotHash: computeCatalogSnapshotHash(catalog),
        }),
      /unknown field/,
      `case ${i}: injected ${key} into ${providerKey}/${modelKey} normalized`,
    );
  }
});

test("property: seller/purchase intake rejects forbidden fields at every fuzzed position", async () => {
  const sellerFixtures = await readJson("../fixtures/seller-submission.synthetic.json");
  const purchaseFixtures = await readJson("../fixtures/purchase.synthetic.json");
  const rng = mulberry32(SEED);
  const positions = ["top", "entry", "modalities", "provenance"];
  for (let i = 0; i < 60; i += 1) {
    const key = pick(rng, FORBIDDEN_KEYS);
    const value = pick(rng, EVIL_VALUES);
    const at = pick(rng, positions);

    const seller = structuredClone(sellerFixtures.valid);
    if (at === "top") seller[key] = value;
    else if (at === "entry") seller.entry[key] = value;
    else if (at === "modalities") seller.entry.modalities[key] = value;
    else seller.provenance[key] = value;
    assert.throws(
      () => validateSellerSubmission(seller),
      (error) =>
        error instanceof SellerSubmissionError &&
        error.code === "forbidden-field" &&
        error.key.endsWith(key),
      `case ${i}: seller accepted ${key} at ${at}`,
    );

    const purchase = structuredClone(purchaseFixtures.valid);
    if (at === "entry" || at === "modalities") {
      purchase.provenance[key] = value; // purchase has no entry; fold into provenance
    } else if (at === "top") purchase[key] = value;
    else purchase.provenance[key] = value;
    assert.throws(
      () => validatePurchaseSubmission(purchase),
      (error) =>
        error instanceof PurchaseSubmissionError &&
        error.code === "forbidden-field" &&
        error.key.endsWith(key),
      `case ${i}: purchase accepted ${key} at ${at}`,
    );
  }
});

// Bypass report (TOG-5749, this run): zero exploitable bypasses.
// Evidence: 200 seeded malicious routes + 4 keys x 9 values x 5 shapes +
// hostile wrappings all rejected with TypeError and zero recorded calls;
// catalog-entry, normalizeCatalog, seller and purchase intake reject every
// injected location field. Known non-bypass observations (pinned nowhere,
// left for hardening judgment): case/unicode/whitespace key variants,
// symbol keys, Map contents, non-enumerable keys and payload URLs pass the
// exact-key guard; circular/deep inputs throw RangeError (still fail-closed,
// no call recorded). Each would become its own bug card only if a bypass
// through the fake (never-network, routeId-only records, synthetic output)
// threat model is demonstrated.
