import { realpath, rmdir } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { ArtifactStore } from "../artifacts/store.js";
import { resolveRepositoryRoot } from "../repo/git.js";
import {
  readWorktreeManifest,
  writeWorktreeManifest,
  type WorktreeManifest,
  type WorktreeManifestEntry,
} from "../repo/worktree-manifest.js";

export interface CleanupWorktreesResult {
  manifestPath: string;
  removed: string[];
  alreadyRemoved: string[];
  failed: Array<{ path: string; error: string }>;
}

async function git(
  repositoryRoot: string,
  args: string[],
): Promise<{ exitCode: number; output: string }> {
  const result = await execa("git", args, {
    cwd: repositoryRoot,
    reject: false,
  });
  return {
    exitCode: result.exitCode ?? 1,
    output: result.stderr || result.stdout,
  };
}

async function registeredWorktrees(
  repositoryRoot: string,
): Promise<Set<string>> {
  const result = await git(repositoryRoot, ["worktree", "list", "--porcelain"]);
  if (result.exitCode !== 0)
    throw new Error("Unable to list repository worktrees: " + result.output);
  return new Set(
    await Promise.all(
      result.output
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => canonicalPath(line.slice("worktree ".length))),
    ),
  );
}

async function canonicalPath(candidate: string): Promise<string> {
  let current = path.resolve(candidate);
  const suffix: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(current), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(candidate);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function validateEntryContainment(
  manifest: WorktreeManifest,
  entry: WorktreeManifestEntry,
): Promise<void> {
  const execution = manifest.executions.find(
    (candidate) => candidate.id === entry.executionSessionId,
  );
  if (!execution)
    throw new Error("Worktree references an unknown execution session");
  const root = path.resolve(execution.temporaryRoot);
  const candidate = path.resolve(entry.path);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Registered worktree path escapes its execution root");
  const canonicalRoot = await canonicalPath(root);
  const canonicalCandidate = await canonicalPath(candidate);
  const canonicalRelative = path.relative(canonicalRoot, canonicalCandidate);
  if (
    !canonicalRelative ||
    canonicalRelative.startsWith("..") ||
    path.isAbsolute(canonicalRelative)
  )
    throw new Error("Registered worktree path escapes its execution root");
}

export async function cleanupRunWorktrees(options: {
  runId: string;
  repositoryRoot?: string;
  artifactRoot?: string;
  now?: () => Date;
}): Promise<CleanupWorktreesResult> {
  const repositoryRoot = await resolveRepositoryRoot(
    options.repositoryRoot ?? process.cwd(),
  );
  const artifactRoot = path.resolve(
    options.artifactRoot ?? path.join(repositoryRoot, ".agent-arena", "runs"),
  );
  const store = new ArtifactStore(artifactRoot, options.runId);
  const manifestPath = store.resolve("worktrees/manifest.json");
  const manifest = await readWorktreeManifest(manifestPath);
  if (manifest.runId !== options.runId)
    throw new Error(
      "Worktree manifest run ID does not match the requested run",
    );
  const currentRoot = await realpath(repositoryRoot);
  const commonResult = await git(repositoryRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (commonResult.exitCode !== 0)
    throw new Error(
      "Unable to resolve repository identity: " + commonResult.output,
    );
  const currentCommon = await realpath(commonResult.output.trim());
  if (
    manifest.repository.root !== currentRoot ||
    manifest.repository.gitCommonDirectory !== currentCommon
  )
    throw new Error(
      "Worktree manifest belongs to a different repository checkout",
    );

  for (const entry of manifest.worktrees)
    await validateEntryContainment(manifest, entry);

  const now = options.now ?? (() => new Date());
  const removed: string[] = [];
  const alreadyRemoved: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];

  for (const entry of manifest.worktrees) {
    const registeredPath = await canonicalPath(entry.path);
    let registrations = await registeredWorktrees(repositoryRoot);
    if (!registrations.has(registeredPath)) {
      entry.state = "removed";
      entry.removedAt ??= now().toISOString();
      delete entry.retainedAt;
      delete entry.cleanupFailedAt;
      delete entry.cleanupError;
      alreadyRemoved.push(entry.path);
      manifest.updatedAt = now().toISOString();
      await writeWorktreeManifest(manifestPath, manifest);
      continue;
    }
    const removal = await git(repositoryRoot, [
      "worktree",
      "remove",
      "--force",
      entry.path,
    ]);
    registrations = await registeredWorktrees(repositoryRoot);
    if (removal.exitCode === 0 && !registrations.has(registeredPath)) {
      entry.state = "removed";
      entry.removedAt = now().toISOString();
      delete entry.retainedAt;
      delete entry.cleanupFailedAt;
      delete entry.cleanupError;
      removed.push(entry.path);
    } else {
      entry.state = "cleanup_failure";
      entry.cleanupFailedAt = now().toISOString();
      entry.cleanupError =
        removal.output ||
        "Git continued to register the worktree after removal";
      failed.push({ path: entry.path, error: entry.cleanupError });
    }
    manifest.updatedAt = now().toISOString();
    await writeWorktreeManifest(manifestPath, manifest);
  }

  const prune = await git(repositoryRoot, ["worktree", "prune"]);
  if (prune.exitCode !== 0)
    failed.push({
      path: manifest.repository.root,
      error: "git worktree prune failed: " + prune.output,
    });
  for (const execution of manifest.executions) {
    if (
      manifest.worktrees.some(
        (entry) =>
          entry.executionSessionId === execution.id &&
          entry.state !== "removed",
      )
    )
      continue;
    try {
      await rmdir(execution.temporaryRoot);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
    }
  }
  manifest.updatedAt = now().toISOString();
  await writeWorktreeManifest(manifestPath, manifest);
  return { manifestPath, removed, alreadyRemoved, failed };
}
