import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/store.js";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("immutable operation ledger", () => {
  it("returns matching replays and rejects conflicting payloads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-operation-"));
    const store = new ArtifactStore(root, "run");
    await store.initialize();
    await store.writeImmutableJson("operations/key.json", { value: 1 });
    await expect(
      store.writeImmutableJson("operations/key.json", { value: 1 }),
    ).resolves.toContain("key.json");
    await expect(
      store.writeImmutableJson("operations/key.json", { value: 2 }),
    ).rejects.toThrow("Immutable artifact");
  });
});
