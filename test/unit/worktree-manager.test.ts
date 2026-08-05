import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorktreeManager } from "../../src/repo/git.js";
import { createSlugRepository } from "../helpers/repository.js";

describe("WorktreeManager evidence overlays", () => {
  it("uses the accepted evidence file when a repair adds the same test path", async () => {
    const repositoryRoot = await createSlugRepository();
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "arena-evidence-overlay-"),
    );
    const manager = new WorktreeManager(repositoryRoot, temporaryRoot, "HEAD");
    await manager.initialize();

    try {
      const repairTree = await manager.create("repair");
      const conflictPath = path.join(repairTree, "test", "conflict.test.mjs");
      await writeFile(conflictPath, "repair-owned test\n");
      const repairPatch = path.join(temporaryRoot, "repair.diff");
      await manager.capturePatch(repairTree, repairPatch, undefined, true);
      await manager.remove(repairTree);

      const evidenceTree = await manager.create("evidence");
      await writeFile(
        path.join(evidenceTree, "test", "conflict.test.mjs"),
        "accepted evidence\n",
      );
      const evidencePatch = path.join(temporaryRoot, "evidence.diff");
      await manager.capturePatch(evidenceTree, evidencePatch, undefined, true);
      await manager.remove(evidenceTree);

      const validationTree = await manager.create("validation");
      await manager.applyPatch(validationTree, repairPatch);
      await manager.applyEvidencePatch(validationTree, evidencePatch);

      await expect(
        readFile(
          path.join(validationTree, "test", "conflict.test.mjs"),
          "utf8",
        ),
      ).resolves.toBe("accepted evidence\n");
    } finally {
      await manager.cleanup();
    }
  });
});
