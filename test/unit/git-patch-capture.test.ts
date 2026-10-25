import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import {
  captureBinaryPatch,
  PatchCaptureIntegrityError,
  WorktreeManager,
} from "../../src/repo/git.js";
import { createSlugRepository } from "../helpers/repository.js";

async function commitAll(
  repositoryRoot: string,
  message: string,
): Promise<string> {
  await execa("git", ["add", "."], { cwd: repositoryRoot });
  await execa("git", ["commit", "-qm", message], { cwd: repositoryRoot });
  return (await execa("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }))
    .stdout;
}

async function rawDiff(
  worktree: string,
  args: string[] = ["diff", "--binary", "--full-index"],
): Promise<Buffer> {
  const result = await execa("git", args, {
    cwd: worktree,
    encoding: "buffer",
    stripFinalNewline: false,
  });
  return Buffer.from(result.stdout);
}

describe("Git patch capture integrity", () => {
  it("never writes accepted evidence through a candidate's directory symlink", async () => {
    const repositoryRoot = await createSlugRepository();
    const baseCommit = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
    ).stdout;
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "arena-evidence-link-"),
    );
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "arena-outside-canary-"),
    );
    const worktrees = new WorktreeManager(
      repositoryRoot,
      temporaryRoot,
      baseCommit,
    );
    await worktrees.initialize();
    try {
      await writeFile(path.join(outside, "evidence.txt"), "outside canary\n");
      const source = await worktrees.create("source");
      await writeFile(
        path.join(source, "test/evidence.txt"),
        "immutable evidence\n",
      );
      const patch = path.join(temporaryRoot, "evidence.diff");
      await worktrees.capturePatch(source, patch, undefined, true);
      const candidate = await worktrees.create("candidate");
      await rm(path.join(candidate, "test"), { recursive: true });
      await symlink(outside, path.join(candidate, "test"), "dir");
      // Git may replace the link or refuse it; it must never traverse it.
      await worktrees
        .applyEvidencePatch(candidate, patch)
        .catch(() => undefined);
      expect(await readFile(path.join(outside, "evidence.txt"), "utf8")).toBe(
        "outside canary\n",
      );
    } finally {
      await worktrees.cleanup();
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("replays immutable test postimages over conflicting repairs without altering production", async () => {
    const repositoryRoot = await createSlugRepository();
    await writeFile(
      path.join(repositoryRoot, "test/remove-me.txt"),
      "fixture\n",
    );
    const baseCommit = await commitAll(repositoryRoot, "Evidence fixture");
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "arena-evidence-"),
    );
    const worktrees = new WorktreeManager(
      repositoryRoot,
      temporaryRoot,
      baseCommit,
    );
    await worktrees.initialize();
    try {
      const source = await worktrees.create("evidence");
      const existingTest = "test/slug.test.mjs";
      const addedTest = "test/accepted.test.mjs";
      const immutable = 'throw new Error("original accepted assertion");\n';
      await writeFile(path.join(source, existingTest), immutable);
      await writeFile(path.join(source, addedTest), immutable);
      const binary = Buffer.from([0, 1, 255, 13, 10, 0, 17]);
      await writeFile(path.join(source, "test/binary.dat"), binary);
      await writeFile(path.join(source, "test/run.sh"), "#!/bin/sh\nexit 1\n");
      await chmod(path.join(source, "test/run.sh"), 0o755);
      await rm(path.join(source, "test/remove-me.txt"));
      const evidencePath = path.join(temporaryRoot, "evidence.diff");
      await worktrees.capturePatch(source, evidencePath, undefined, true);
      const evidenceBytes = await readFile(evidencePath);

      const candidate = await worktrees.create("candidate");
      const production = 'export function slug(value) { return "repaired"; }\n';
      await writeFile(path.join(candidate, "src/slug.mjs"), production);
      await writeFile(
        path.join(candidate, existingTest),
        "// weakened assertion\n",
      );
      await writeFile(
        path.join(candidate, addedTest),
        "// same-path regression\n",
      );
      await writeFile(path.join(candidate, "test/binary.dat"), "different\n");
      await writeFile(path.join(candidate, "test/remove-me.txt"), "changed\n");
      const candidatePath = path.join(temporaryRoot, "candidate.diff");
      await worktrees.capturePatch(candidate, candidatePath, undefined, true);
      const candidateBytes = await readFile(candidatePath);

      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt === 1)
          await writeFile(
            path.join(candidate, "test/remove-me.txt"),
            "untracked replacement\n",
          );
        await worktrees.applyEvidencePatch(candidate, evidencePath);
        expect(await readFile(path.join(candidate, existingTest), "utf8")).toBe(
          immutable,
        );
        expect(await readFile(path.join(candidate, addedTest), "utf8")).toBe(
          immutable,
        );
        expect(await readFile(path.join(candidate, "test/binary.dat"))).toEqual(
          binary,
        );
        expect(
          (await stat(path.join(candidate, "test/run.sh"))).mode & 0o111,
        ).toBe(0o111);
        await expect(
          stat(path.join(candidate, "test/remove-me.txt")),
        ).rejects.toThrow();
        expect(
          await readFile(path.join(candidate, "src/slug.mjs"), "utf8"),
        ).toBe(production);
      }
      expect(await readFile(evidencePath)).toEqual(evidenceBytes);
      expect(await readFile(candidatePath)).toEqual(candidateBytes);
    } finally {
      await worktrees.cleanup();
    }
  });

  it("keeps provider pathspec errors outside the integrity boundary with readable diagnostics", async () => {
    const repositoryRoot = await createSlugRepository();
    const baseCommit = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
    ).stdout;
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "agent-arena-invalid-patch-path-"),
    );
    const worktrees = new WorktreeManager(
      repositoryRoot,
      temporaryRoot,
      baseCommit,
    );
    await worktrees.initialize();

    try {
      const sourceTree = await worktrees.create("source");
      const snapshot = await worktrees.snapshot(sourceTree);
      const missingPath = "test/does-not-exist.test.mjs";
      const operations = [
        () =>
          worktrees.capturePatch(
            sourceTree,
            path.join(temporaryRoot, "scoped.diff"),
            [missingPath],
          ),
        () =>
          worktrees.capturePatchAgainstSnapshot(
            sourceTree,
            path.join(temporaryRoot, "snapshot.diff"),
            snapshot,
            [missingPath],
          ),
      ];

      for (const operation of operations) {
        const error = await operation().catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(PatchCaptureIntegrityError);
        expect((error as Error).message).toContain(
          `fatal: pathspec '${missingPath}' did not match any files`,
        );
        expect((error as Error).message).not.toMatch(/102,97,116,97,108/u);
      }
    } finally {
      await worktrees.cleanup();
    }
  });

  it("preserves a final hunk ending in a blank context line byte-for-byte", async () => {
    const repositoryRoot = await createSlugRepository();
    const sourcePath = path.join(repositoryRoot, "src", "slug.mjs");
    await writeFile(sourcePath, `${await readFile(sourcePath, "utf8")}\n`);
    const baseCommit = await commitAll(
      repositoryRoot,
      "add trailing blank line",
    );
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "agent-arena-patch-bytes-"),
    );
    const worktrees = new WorktreeManager(
      repositoryRoot,
      temporaryRoot,
      baseCommit,
    );
    await worktrees.initialize();

    try {
      const sourceTree = await worktrees.create("source");
      const changedPath = path.join(sourceTree, "src", "slug.mjs");
      await writeFile(
        changedPath,
        (await readFile(changedPath, "utf8")).replace(
          'replace(" ", "-")',
          'replace(/\\s+/g, "-")',
        ),
      );
      const expected = await rawDiff(sourceTree);
      expect(expected.subarray(-2)).toEqual(Buffer.from(" \n"));

      const patchPath = path.join(temporaryRoot, "blank-context.diff");
      const size = await worktrees.capturePatch(sourceTree, patchPath);
      const persisted = await readFile(patchPath);
      expect(persisted).toEqual(expected);
      expect(size).toBe(persisted.length);

      const replayTree = await worktrees.create("replay");
      await worktrees.applyPatch(replayTree, patchPath);
      expect(await readFile(path.join(replayTree, "src", "slug.mjs"))).toEqual(
        await readFile(changedPath),
      );
    } finally {
      await worktrees.cleanup();
    }
  });

  it("preserves Git's marker for a changed text file without a terminal newline", async () => {
    const repositoryRoot = await createSlugRepository();
    await writeFile(path.join(repositoryRoot, "note.txt"), "before");
    const baseCommit = await commitAll(repositoryRoot, "add unterminated text");
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "agent-arena-patch-no-newline-"),
    );
    const worktrees = new WorktreeManager(
      repositoryRoot,
      temporaryRoot,
      baseCommit,
    );
    await worktrees.initialize();

    try {
      const sourceTree = await worktrees.create("source");
      await writeFile(path.join(sourceTree, "note.txt"), "after");
      const expected = await rawDiff(sourceTree);
      const patchPath = path.join(temporaryRoot, "no-newline.diff");
      await worktrees.capturePatch(sourceTree, patchPath);
      expect(await readFile(patchPath)).toEqual(expected);
      expect(expected.toString("utf8")).toContain(
        "\\ No newline at end of file",
      );

      const replayTree = await worktrees.create("replay");
      await worktrees.applyPatch(replayTree, patchPath);
      expect(await readFile(path.join(replayTree, "note.txt"))).toEqual(
        Buffer.from("after"),
      );
    } finally {
      await worktrees.cleanup();
    }
  });

  it("preserves and replays a binary full-index patch", async () => {
    const repositoryRoot = await createSlugRepository();
    await writeFile(
      path.join(repositoryRoot, "asset.bin"),
      Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
    );
    const baseCommit = await commitAll(repositoryRoot, "add binary asset");
    await writeFile(
      path.join(repositoryRoot, "asset.bin"),
      Buffer.from(Array.from({ length: 256 }, (_, index) => 255 - index)),
    );
    const headCommit = await commitAll(repositoryRoot, "change binary asset");
    const expected = await rawDiff(repositoryRoot, [
      "diff",
      "--binary",
      "--full-index",
      baseCommit,
      headCommit,
    ]);

    const patch = await captureBinaryPatch(
      repositoryRoot,
      baseCommit,
      headCommit,
    );
    expect(patch).toEqual(expected);
    expect(patch.toString("utf8")).toContain("GIT binary patch");

    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "agent-arena-binary-replay-"),
    );
    const worktrees = new WorktreeManager(
      repositoryRoot,
      temporaryRoot,
      baseCommit,
    );
    await worktrees.initialize();
    try {
      const patchPath = path.join(temporaryRoot, "binary.diff");
      await writeFile(patchPath, patch);
      const replayTree = await worktrees.create("replay");
      await worktrees.applyPatch(replayTree, patchPath);
      expect(await readFile(path.join(replayTree, "asset.bin"))).toEqual(
        await readFile(path.join(repositoryRoot, "asset.bin")),
      );
    } finally {
      await worktrees.cleanup();
    }
  });

  it("ignores whitespace policy while verifying worktree and commit patches", async () => {
    const repositoryRoot = await createSlugRepository();
    const whitespacePath = path.join(repositoryRoot, "whitespace.txt");
    await writeFile(whitespacePath, "existing trailing whitespace   \n");
    const baseCommit = await commitAll(
      repositoryRoot,
      "add whitespace fixture",
    );
    await execa("git", ["config", "apply.whitespace", "error"], {
      cwd: repositoryRoot,
    });
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "agent-arena-whitespace-policy-"),
    );
    const worktrees = new WorktreeManager(
      repositoryRoot,
      temporaryRoot,
      baseCommit,
    );
    await worktrees.initialize();

    try {
      const sourceTree = await worktrees.create("source");
      await writeFile(
        path.join(sourceTree, "whitespace.txt"),
        "existing trailing whitespace\n",
      );
      const worktreePatchPath = path.join(temporaryRoot, "worktree.diff");
      const expectedWorktreePatch = await rawDiff(sourceTree);
      await expect(
        worktrees.capturePatch(sourceTree, worktreePatchPath),
      ).resolves.toBe(expectedWorktreePatch.length);
      expect(await readFile(worktreePatchPath)).toEqual(expectedWorktreePatch);

      await writeFile(whitespacePath, "existing trailing whitespace\n");
      const headCommit = await commitAll(repositoryRoot, "remove whitespace");
      const expectedCommitPatch = await rawDiff(repositoryRoot, [
        "diff",
        "--binary",
        "--full-index",
        baseCommit,
        headCommit,
      ]);
      await expect(
        captureBinaryPatch(repositoryRoot, baseCommit, headCommit),
      ).resolves.toEqual(expectedCommitPatch);
    } finally {
      await worktrees.cleanup();
    }
  });

  it("preserves a target-relative overlay against a frozen snapshot", async () => {
    const repositoryRoot = await createSlugRepository();
    const baseCommit = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
    ).stdout;
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "agent-arena-snapshot-bytes-"),
    );
    const worktrees = new WorktreeManager(
      repositoryRoot,
      temporaryRoot,
      baseCommit,
    );
    await worktrees.initialize();

    try {
      const sourceTree = await worktrees.create("source");
      const testPath = path.join(sourceTree, "test", "slug.test.mjs");
      await writeFile(testPath, `${await readFile(testPath, "utf8")}\n`);
      const snapshot = await worktrees.snapshot(sourceTree);
      await writeFile(
        testPath,
        (await readFile(testPath, "utf8")).replace(
          "creates a basic slug",
          "creates one basic slug",
        ),
      );
      const expected = await rawDiff(sourceTree, [
        "diff",
        "--binary",
        "--full-index",
        snapshot,
        "--",
        "test/slug.test.mjs",
      ]);
      const patchPath = path.join(temporaryRoot, "overlay.diff");
      const size = await worktrees.capturePatchAgainstSnapshot(
        sourceTree,
        patchPath,
        snapshot,
        ["test/slug.test.mjs"],
      );
      expect(await readFile(patchPath)).toEqual(expected);
      expect(size).toBe(expected.length);
    } finally {
      await worktrees.cleanup();
    }
  });
});
