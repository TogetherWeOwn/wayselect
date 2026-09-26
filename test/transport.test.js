import test from "node:test";
import assert from "node:assert/strict";
import { FakeTransport } from "../src/index.js";

test("fake transport executes without network access", async (context) => {
  context.mock.method(globalThis, "fetch", () => {
    throw new Error("network access is forbidden in fixture execution");
  });

  const transport = new FakeTransport();
  const result = await transport.send({
    route: { routeId: "northstar/alpha-chat" },
    payload: { prompt: "synthetic input" },
  });

  assert.equal(result.adapter, "fake");
  assert.equal(result.networkUsed, false);
  assert.equal(result.routeId, "northstar/alpha-chat");
  assert.deepEqual(transport.calls, [
    {
      routeId: "northstar/alpha-chat",
      payload: { prompt: "synthetic input" },
    },
  ]);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("transport rejects executable endpoint fields", async () => {
  const transport = new FakeTransport();

  await assert.rejects(
    () =>
      transport.send({
        route: {
          routeId: "northstar/alpha-chat",
          endpoint: "https://example.invalid/model",
        },
        payload: {},
      }),
    /must not contain executable location field: endpoint/,
  );
});
