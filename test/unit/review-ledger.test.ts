import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/store.js";
import {
  ReviewDecisionSchema,
  readCurrentReview,
} from "../../src/review/store.js";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("review ledger", () => {
  it("replays the latest append-only decision", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-review-"));
    const store = new ArtifactStore(root, "run");
    await store.initialize();
    for (const [index, status] of ["rejected", "accepted"].entries()) {
      const value = ReviewDecisionSchema.parse({
        version: 1,
        decisionId: `decision-${String(index)}`,
        ...(index > 0
          ? { parentDecisionId: `decision-${String(index - 1)}` }
          : {}),
        runId: "run",
        promptId: "prompt",
        status,
        ...(status === "accepted"
          ? {
              selectedContestantId: "a",
              selectionSource: "contestant",
              patchSha256: "a".repeat(64),
              baseCommit: "base",
            }
          : {}),
        channel: "api",
        attestationHash: "b".repeat(64),
        idempotencyKeyHash: String(index).repeat(64),
        decidedAt:
          index === 0 ? "2026-07-29T00:00:01.000Z" : "2026-07-29T00:00:00.000Z",
      });
      await store.writeImmutableJson(`reviews/${value.decisionId}.json`, value);
    }
    expect(await readCurrentReview(store)).toMatchObject({
      status: "accepted",
    });
  });

  it("fails closed when concurrent decisions create multiple heads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-review-fork-"));
    const store = new ArtifactStore(root, "run");
    await store.initialize();
    for (const decisionId of ["first", "second"]) {
      await store.writeImmutableJson(`reviews/${decisionId}.json`, {
        version: 1,
        decisionId,
        runId: "run",
        promptId: "prompt",
        status: "rejected",
        channel: "api",
        attestationHash: "b".repeat(64),
        idempotencyKeyHash: decisionId.padEnd(64, "0"),
        decidedAt: "2026-07-29T00:00:00.000Z",
      });
    }
    await expect(readCurrentReview(store)).rejects.toThrow("structural head");
  });
});
