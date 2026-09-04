import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { cleanupRunWorktrees } from "../../src/commands/cleanup-worktrees.js";
import { calculateCanonicalHash } from "../../src/contracts/round.js";
import { WorktreeManager } from "../../src/repo/git.js";
import {
  readWorktreeManifest,
  writeWorktreeManifest,
} from "../../src/repo/worktree-manifest.js";
import { createSlugRepository } from "../helpers/repository.js";

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function createManager(keepWorktrees: boolean) {
  const repositoryRoot = await createSlugRepository();
  return createManagerForRun({
    repositoryRoot,
    keepWorktrees,
    runId: "worktree-test-run",
  });
}

async function createManagerForRun(options: {
  repositoryRoot: string;
  keepWorktrees: boolean;
  runId: string;
}) {
  const { repositoryRoot, keepWorktrees, runId } = options;
  const baseCommit = (
    await execa("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
  ).stdout;
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "agent-arena-worktrees-"),
  );
  const artifactRoot = path.join(repositoryRoot, ".agent-arena", "runs");
  const manifestPath = path.join(
    artifactRoot,
    runId,
    "worktrees",
    "manifest.json",
  );
  const manager = new WorktreeManager(
    repositoryRoot,
    temporaryRoot,
    baseCommit,
    { keepWorktrees, manifestPath, runId },
  );
  await manager.initialize();
  return {
    repositoryRoot,
    temporaryRoot,
    artifactRoot,
    manifestPath,
    runId,
    manager,
  };
}

describe("WorktreeManager retention manifest", () => {
  it("retains successful worktrees and allocates unique retry paths", async () => {
    const fixture = await createManager(true);
    const first = await fixture.manager.create("validation", {
      purpose: "initial-validation-worktree:a",
      contestantId: "a",
    });
    await fixture.manager.remove(first);
    const second = await fixture.manager.create("validation", {
      purpose: "initial-validation-retry-worktree:a",
      contestantId: "a",
    });
    await fixture.manager.remove(second);
    await fixture.manager.finalize();

    expect(second).not.toBe(first);
    expect(path.basename(second)).toBe("validation-2");
    expect(await exists(first)).toBe(true);
    expect(await exists(second)).toBe(true);
    const manifest = await readWorktreeManifest(fixture.manifestPath);
    expect(manifest.executions).toHaveLength(1);
    expect(manifest.executions[0]?.finalizedAt).toBeTruthy();
    expect(manifest.worktrees).toEqual([
      expect.objectContaining({
        logicalName: "validation",
        purpose: "initial-validation-worktree:a",
        contestantId: "a",
        path: first,
        state: "retained",
      }),
      expect.objectContaining({
        logicalName: "validation",
        purpose: "initial-validation-retry-worktree:a",
        contestantId: "a",
        path: second,
        state: "retained",
      }),
    ]);
  });

  it("deletes worktrees by default and records only confirmed removals", async () => {
    const fixture = await createManager(false);
    const worktree = await fixture.manager.create("default-cleanup");
    await fixture.manager.remove(worktree);
    const retry = await fixture.manager.create("default-cleanup");
    await fixture.manager.remove(retry);
    await fixture.manager.finalize();

    expect(await exists(worktree)).toBe(false);
    expect(retry).not.toBe(worktree);
    expect(await exists(fixture.temporaryRoot)).toBe(false);
    const manifest = await readWorktreeManifest(fixture.manifestPath);
    expect(manifest.worktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: worktree, state: "removed" }),
        expect.objectContaining({ path: retry, state: "removed" }),
      ]),
    );
    expect(manifest.worktrees[0]?.retainedAt).toBeUndefined();
  });

  it("cleans retained worktrees idempotently from the run-owned manifest", async () => {
    const fixture = await createManager(true);
    const worktree = await fixture.manager.create("repair", {
      purpose: "repair-worktree:a",
      contestantId: "a",
    });
    await writeFile(path.join(worktree, "debug.txt"), "retained\n");
    await fixture.manager.finalize();

    const first = await cleanupRunWorktrees({
      runId: fixture.runId,
      repositoryRoot: fixture.repositoryRoot,
      artifactRoot: fixture.artifactRoot,
    });
    expect(first.failed).toEqual([]);
    expect(first.removed).toEqual([worktree]);
    expect(await exists(worktree)).toBe(false);
    expect(await exists(fixture.temporaryRoot)).toBe(false);

    const second = await cleanupRunWorktrees({
      runId: fixture.runId,
      repositoryRoot: fixture.repositoryRoot,
      artifactRoot: fixture.artifactRoot,
    });
    expect(second.failed).toEqual([]);
    expect(second.alreadyRemoved).toEqual([worktree]);
    expect(
      (await readWorktreeManifest(fixture.manifestPath)).worktrees[0],
    ).toEqual(expect.objectContaining({ state: "removed" }));
  });

  it("appends a resume execution and preserves earlier retained paths", async () => {
    const fixture = await createManager(true);
    const initial = await fixture.manager.create("implement-a");
    await fixture.manager.finalize();
    const resumeRoot = await mkdtemp(
      path.join(os.tmpdir(), "agent-arena-resume-worktrees-"),
    );
    const baseCommit = (
      await execa("git", ["rev-parse", "HEAD"], {
        cwd: fixture.repositoryRoot,
      })
    ).stdout;
    const resumed = new WorktreeManager(
      fixture.repositoryRoot,
      resumeRoot,
      baseCommit,
      {
        keepWorktrees: true,
        manifestPath: fixture.manifestPath,
        runId: fixture.runId,
        executionKind: "resume",
      },
    );
    await resumed.initialize();
    const continuation = await resumed.create("implement-a");
    await resumed.finalize();

    const manifest = await readWorktreeManifest(fixture.manifestPath);
    expect(manifest.executions.map((execution) => execution.kind)).toEqual([
      "initial",
      "resume",
    ]);
    expect(manifest.worktrees.map((entry) => entry.path)).toEqual([
      initial,
      continuation,
    ]);
    expect(initial).not.toBe(continuation);
    const cleanup = await cleanupRunWorktrees({
      runId: fixture.runId,
      repositoryRoot: fixture.repositoryRoot,
      artifactRoot: fixture.artifactRoot,
    });
    expect(cleanup.removed).toEqual([initial, continuation]);
  });

  it("cleans every retained manifest in a provider-recovery chain", async () => {
    const repositoryRoot = await createSlugRepository();
    const parent = await createManagerForRun({
      repositoryRoot,
      keepWorktrees: true,
      runId: "parent-run",
    });
    const parentWorktree = await parent.manager.create("implement-a");
    await parent.manager.finalize();

    const replacement = await createManagerForRun({
      repositoryRoot,
      keepWorktrees: true,
      runId: "replacement-run",
    });
    const replacementWorktree = await replacement.manager.create("repair-a");
    await replacement.manager.finalize();
    await writeFile(
      path.join(replacement.artifactRoot, replacement.runId, "result.json"),
      JSON.stringify({
        schemaVersion: 11,
        runId: replacement.runId,
        provenance: { parentRunId: parent.runId },
      }),
    );
    const recoveryPayload = {
      version: 1 as const,
      parentRunId: parent.runId,
      providers: ["codex"],
      createdAt: new Date().toISOString(),
      probeAttempts: [],
      disposition: "provider_recovered" as const,
      restartOrdinal: 1,
      replacementRunId: replacement.runId,
      runChain: [parent.runId, replacement.runId],
    };
    await writeFile(
      path.join(parent.artifactRoot, parent.runId, "transport-recovery.json"),
      JSON.stringify({
        ...recoveryPayload,
        recoveryHash: calculateCanonicalHash(recoveryPayload),
      }),
    );

    const cleanup = await cleanupRunWorktrees({
      runId: replacement.runId,
      repositoryRoot,
      artifactRoot: replacement.artifactRoot,
    });
    expect(cleanup.failed).toEqual([]);
    expect(cleanup.removed).toEqual([parentWorktree, replacementWorktree]);
    expect(cleanup.manifestPaths).toEqual([
      parent.manifestPath,
      replacement.manifestPath,
    ]);
    expect(await exists(parentWorktree)).toBe(false);
    expect(await exists(replacementWorktree)).toBe(false);

    const repeated = await cleanupRunWorktrees({
      runId: replacement.runId,
      repositoryRoot,
      artifactRoot: replacement.artifactRoot,
    });
    expect(repeated.failed).toEqual([]);
    expect(repeated.alreadyRemoved).toEqual([
      parentWorktree,
      replacementWorktree,
    ]);
  });

  it("rejects manifest paths outside their recorded execution root", async () => {
    const fixture = await createManager(true);
    const worktree = await fixture.manager.create("judge");
    await fixture.manager.finalize();
    const manifest = await readWorktreeManifest(fixture.manifestPath);
    manifest.worktrees[0]!.path = fixture.repositoryRoot;
    await writeWorktreeManifest(fixture.manifestPath, manifest);

    await expect(
      cleanupRunWorktrees({
        runId: fixture.runId,
        repositoryRoot: fixture.repositoryRoot,
        artifactRoot: fixture.artifactRoot,
      }),
    ).rejects.toThrow("escapes its execution root");
    expect(await exists(worktree)).toBe(true);

    // Restore the run-owned path and clean the test's retained worktree.
    manifest.worktrees[0]!.path = worktree;
    await writeWorktreeManifest(fixture.manifestPath, manifest);
    await cleanupRunWorktrees({
      runId: fixture.runId,
      repositoryRoot: fixture.repositoryRoot,
      artifactRoot: fixture.artifactRoot,
    });
    expect(
      JSON.parse(await readFile(fixture.manifestPath, "utf8")),
    ).toBeTruthy();
  });
});
