import { describe, expect, it, vi } from "vitest";
import type { FailureRecord } from "../../src/contracts/failure.js";
import type { WorktreeManager } from "../../src/repo/git.js";
import { prepareWorktreeWithRetry } from "../../src/repo/retry.js";

describe("worktree preparation retry", () => {
  it("persists the first failure and rebuilds a clean worktree before retrying", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce("/tmp/arena-worktree-1")
      .mockResolvedValueOnce("/tmp/arena-worktree-2");
    const applyPatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient git failure"))
      .mockResolvedValueOnce(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const persisted: FailureRecord[] = [];
    const worktree = await prepareWorktreeWithRetry({
      worktrees: { create, applyPatch, remove } as unknown as WorktreeManager,
      name: "validation",
      subject: "validation-worktree:a",
      patches: ["/tmp/candidate.diff"],
      contestantId: "a",
      persistFailureRecord: (record) => {
        persisted.push(structuredClone(record));
        return Promise.resolve();
      },
      now: () => new Date("2026-08-10T00:00:00.000Z"),
    });

    expect(worktree).toBe("/tmp/arena-worktree-2");
    expect(remove).toHaveBeenCalledWith("/tmp/arena-worktree-1");
    expect(applyPatch).toHaveBeenNthCalledWith(
      2,
      "/tmp/arena-worktree-2",
      "/tmp/candidate.diff",
    );
    expect(persisted).toEqual([
      expect.objectContaining({
        attempts: [expect.objectContaining({ status: "failed" })],
      }),
      expect.objectContaining({
        terminalDisposition: "recovered",
        attempts: [
          expect.objectContaining({ attempt: 1, status: "failed" }),
          expect.objectContaining({ attempt: 2, status: "succeeded" }),
        ],
      }),
    ]);
  });
});
