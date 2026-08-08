import { describe, expect, it } from "vitest";
import { deriveDeliveryTarget } from "../../src/delivery/target.js";
import { RunSpecSchema } from "../../src/contracts/round.js";

function runSpec(sources: unknown[]) {
  return RunSpecSchema.parse({
    version: 1,
    runId: "run-1",
    task: {
      task: "task",
      acceptanceCriteria: ["criterion"],
      sources,
      createdAt: "2026-07-29T00:00:00.000Z",
    },
    baseCommit: "b".repeat(40),
    topology: {
      mode: "duel",
      contestants: [
        { id: "a", provider: "codex", role: "solver", startingPatch: "none" },
        { id: "b", provider: "claude", role: "solver", startingPatch: "none" },
      ],
    },
    commands: [
      {
        id: "required-test",
        kind: "required",
        command: "npm test",
        timeoutMs: 1_000,
        required: true,
      },
    ],
    budgets: {
      implementationMs: 1_000,
      reviewMs: 1_000,
      attackMs: 1_000,
      verifierMs: 1_000,
      repairMs: 1_000,
    },
    permissions: {
      mode: "confirm",
      reducedValidationAccepted: false,
      capabilities: [],
    },
    contentHash: "a".repeat(64),
  });
}

describe("delivery target derivation", () => {
  it("derives one stable GitHub issue target", () => {
    const result = deriveDeliveryTarget(
      runSpec([
        {
          id: "issue",
          kind: "issue",
          origin: "https://github.com/acme/repo/issues/1",
          retrievedAt: "2026-07-29T00:00:00.000Z",
          contentHash: "a".repeat(64),
          snapshotPath: "/tmp/issue",
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
      contentHash: "a".repeat(64),
      snapshotPath: `/tmp/${String(number)}`,
      github: {
        repository: "acme/repo",
        number,
        url: `https://github.com/acme/repo/issues/${String(number)}`,
      },
    }));
    const result = deriveDeliveryTarget(runSpec(sources));
    expect(result.ambiguous).toBe(true);
    expect(result.target).toBeUndefined();
  });
});
