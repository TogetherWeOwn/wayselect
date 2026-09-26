const EXECUTABLE_LOCATION_KEYS = new Set(["url", "endpoint", "baseUrl", "apiUrl"]);

function assertNoExecutableLocation(value, path = "route") {
  if (value === null || typeof value !== "object") {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (EXECUTABLE_LOCATION_KEYS.has(key)) {
      throw new TypeError(`${path} must not contain executable location field: ${key}`);
    }
    assertNoExecutableLocation(nestedValue, `${path}.${key}`);
  }
}

export class FakeTransport {
  #calls = [];

  get calls() {
    return structuredClone(this.#calls);
  }

  async send({ route, payload }) {
    if (!route || typeof route.routeId !== "string") {
      throw new TypeError("route.routeId is required");
    }
    assertNoExecutableLocation(route);

    const call = Object.freeze({
      routeId: route.routeId,
      payload: structuredClone(payload),
    });
    this.#calls.push(call);

    return Object.freeze({
      adapter: "fake",
      networkUsed: false,
      routeId: route.routeId,
      output: Object.freeze({
        text: `Synthetic response from ${route.routeId}`,
      }),
    });
  }
}
