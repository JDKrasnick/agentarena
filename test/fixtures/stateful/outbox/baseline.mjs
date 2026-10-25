import test from "node:test";
import assert from "node:assert/strict";
import { createOutbox } from "../src/index.mjs";
import { createStore } from "../src/store.mjs";
test("basic operation", async () => {
  const box = createOutbox({ store: createStore(), send: async () => {} });
  assert.equal(await box.enqueue("x", { x: 1 }), true);
  assert.equal(await box.runOne(), true);
  assert.deepEqual(await box.stats(), { pending: 0, sending: 0, done: 1 });
});
