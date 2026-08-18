import { describe, expect, it, vi } from "vitest";
import type { FailureRecord } from "../../src/contracts/failure.js";
import { compareQualityWithRetry } from "../../src/quality/retry.js";
import type { PatchQualityVerifierInput } from "../../src/quality/verifier.js";

describe("quality verifier retry", () => {
  it("recreates its worktree and records recovery after a transient failure", async () => {
    const comparedWorktrees: string[] = [];
    const compare = vi.fn((value: PatchQualityVerifierInput) => {
      comparedWorktrees.push(value.worktree);
      if (comparedWorktrees.length === 1)
        return Promise.reject(new Error("transient verifier outage"));
      return Promise.resolve({
        version: 1 as const,
        verdict: "equivalent" as const,
        criteria: [],
        rationale: ["Equivalent"],
      });
    });
    const persisted: FailureRecord[] = [];
    const input = {
      promptPath: "/tmp/quality.prompt",
      transcriptPrefix: "/tmp/quality",
      worktree: "/tmp/quality-worktree-1",
    } as unknown as PatchQualityVerifierInput;

    const verdict = await compareQualityWithRetry({
      verifier: { id: "quality-test", compare },
      input,
      patchArtifactRefs: ["/tmp/a.diff", "/tmp/b.diff"],
      transcriptPrefix: (attempt) => `/tmp/quality-${String(attempt)}`,
      recreateWorktree: () => Promise.resolve("/tmp/quality-worktree-2"),
      persistFailureRecord: (record) => {
        persisted.push(structuredClone(record));
        return Promise.resolve();
      },
      now: () => new Date("2026-08-10T00:00:00.000Z"),
    });

    expect(verdict.verdict).toBe("equivalent");
    expect(compare).toHaveBeenCalledTimes(2);
    expect(comparedWorktrees).toEqual([
      "/tmp/quality-worktree-1",
      "/tmp/quality-worktree-2",
    ]);
    expect(persisted.at(-1)).toMatchObject({
      terminalDisposition: "recovered",
      attempts: [
        { attempt: 1, status: "failed" },
        { attempt: 2, status: "succeeded" },
      ],
    });
  });
});
