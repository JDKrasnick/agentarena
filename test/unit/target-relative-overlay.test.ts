import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { WorktreeManager } from "../../src/repo/git.js";
import { createSlugRepository } from "../helpers/repository.js";

describe("target-relative test overlays", () => {
  it("captures and replays a regression edit relative to the frozen target patch", async () => {
    const repositoryRoot = await createSlugRepository();
    const baseCommit = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
    ).stdout;
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "agent-arena-overlay-"),
    );
    const worktrees = new WorktreeManager(
      repositoryRoot,
      temporaryRoot,
      baseCommit,
    );
    await worktrees.initialize();

    try {
      const implementationTree = await worktrees.create("implementation");
      const testPath = path.join(implementationTree, "test", "slug.test.mjs");
      await writeFile(
        testPath,
        `${await readFile(testPath, "utf8")}test("target-owned case", () => assert.equal(slug("Target Case"), "target-case"));\n`,
      );
      const implementationPatch = path.join(
        temporaryRoot,
        "implementation.diff",
      );
      await worktrees.capturePatch(
        implementationTree,
        implementationPatch,
        undefined,
        true,
      );

      const generationTree = await worktrees.create("generation");
      await worktrees.applyPatch(generationTree, implementationPatch);
      const targetSnapshot = await worktrees.snapshot(generationTree);
      const generationTestPath = path.join(
        generationTree,
        "test",
        "slug.test.mjs",
      );
      await writeFile(
        generationTestPath,
        `${await readFile(generationTestPath, "utf8")}test("arena regression", () => assert.equal(slug("Arena Case"), "arena-case"));\n`,
      );
      const overlayPatch = path.join(temporaryRoot, "regression-overlay.diff");
      await worktrees.capturePatchAgainstSnapshot(
        generationTree,
        overlayPatch,
        targetSnapshot,
        ["test/slug.test.mjs"],
      );

      const verifierTree = await worktrees.create("verifier");
      await worktrees.applyPatch(verifierTree, implementationPatch);
      await worktrees.applyPatch(verifierTree, overlayPatch);
      const replayed = await readFile(
        path.join(verifierTree, "test", "slug.test.mjs"),
        "utf8",
      );
      expect(replayed).toContain("target-owned case");
      expect(replayed).toContain("arena regression");
      expect(await readFile(overlayPatch, "utf8")).not.toContain(
        '+test("target-owned case"',
      );
    } finally {
      await worktrees.cleanup();
    }
  });
});
