import { describe, expect, it } from "vitest";
import { deriveDeliveryTarget } from "../../src/delivery/target.js";
import { TaskContractSchema } from "../../src/core/types.js";

function contract(sources: unknown[]) {
  return TaskContractSchema.parse({
    version: 1,
    task: "task",
    acceptanceCriteria: ["criterion"],
    sources,
    createdAt: "2026-07-29T00:00:00.000Z",
    contractHash: "hash",
  });
}

describe("delivery target derivation", () => {
  it("derives one stable GitHub issue target", () => {
    const result = deriveDeliveryTarget(
      contract([
        {
          id: "issue",
          kind: "issue",
          origin: "https://github.com/acme/repo/issues/1",
          retrievedAt: "2026-07-29T00:00:00.000Z",
          contentHash: "hash",
          snapshotPath: "/tmp/issue",
          visibility: "shared",
          github: {
            repository: "acme/repo",
            number: 1,
            url: "https://github.com/acme/repo/issues/1",
          },
        },
      ]),
    );
    expect(result).toMatchObject({
      ambiguous: false,
      target: { kind: "github_issue", repository: "acme/repo", number: 1 },
    });
  });

  it("blocks delivery, not the task, when multiple targets are plausible", () => {
    const sources = [1, 2].map((number) => ({
      id: `issue-${String(number)}`,
      kind: "issue",
      origin: `https://github.com/acme/repo/issues/${String(number)}`,
      retrievedAt: "2026-07-29T00:00:00.000Z",
      contentHash: "hash",
      snapshotPath: `/tmp/${String(number)}`,
      visibility: "shared",
      github: {
        repository: "acme/repo",
        number,
        url: `https://github.com/acme/repo/issues/${String(number)}`,
      },
    }));
    const result = deriveDeliveryTarget(contract(sources));
    expect(result.ambiguous).toBe(true);
    expect(result.target).toBeUndefined();
  });
});
