import test from "node:test";
import assert from "node:assert/strict";
import { createCache } from "../src/index.mjs";
test("basic operation", async () => {
  const cache = createCache({ load: async (k) => k.toUpperCase() });
  assert.equal(await cache.get("hi"), "HI");
});
