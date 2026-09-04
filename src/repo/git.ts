import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { randomUUID } from "node:crypto";
import type { ContestantId } from "../core/types.js";
import {
  readWorktreeManifest,
  writeWorktreeManifest,
  type WorktreeManifest,
  type WorktreeManifestEntry,
} from "./worktree-manifest.js";

async function gitRaw(
  repositoryRoot: string,
  args: string[],
  cwd = repositoryRoot,
): Promise<Buffer> {
  const result = await execa("git", args, {
    cwd,
    reject: false,
    encoding: "buffer",
    stripFinalNewline: false,
  });
  if (result.exitCode !== 0) {
    const stderr = Buffer.from(result.stderr).toString("utf8");
    const stdout = Buffer.from(result.stdout).toString("utf8");
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return Buffer.from(result.stdout);
}

async function gitScalar(
  repositoryRoot: string,
  args: string[],
  cwd = repositoryRoot,
): Promise<string> {
  return (await gitRaw(repositoryRoot, args, cwd)).toString("utf8").trim();
}

export class PatchCaptureIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PatchCaptureIntegrityError";
  }
}

function patchCaptureIntegrityError(
  message: string,
  cause: unknown,
): PatchCaptureIntegrityError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new PatchCaptureIntegrityError(`${message}: ${detail}`, { cause });
}

async function verifyReversePatch(
  repositoryRoot: string,
  worktree: string,
  patchPath: string,
): Promise<void> {
  await gitRaw(
    repositoryRoot,
    ["apply", "--check", "--reverse", "--whitespace=nowarn", patchPath],
    worktree,
  );
}

export async function resolveRepositoryRoot(cwd: string): Promise<string> {
  return gitScalar(cwd, ["rev-parse", "--show-toplevel"]);
}

export async function resolveCommit(
  repositoryRoot: string,
  ref = "HEAD",
): Promise<string> {
  return gitScalar(repositoryRoot, ["rev-parse", `${ref}^{commit}`]);
}

export async function fetchRemoteCommit(
  repositoryRoot: string,
  repository: string,
  commit: string,
): Promise<string> {
  await gitScalar(repositoryRoot, [
    "fetch",
    "--no-tags",
    `https://github.com/${repository}.git`,
    commit,
  ]);
  const fetched = await resolveCommit(repositoryRoot, "FETCH_HEAD");
  if (fetched !== commit)
    throw new Error(
      `Fetched commit ${fetched} does not match frozen pull request head ${commit}`,
    );
  return fetched;
}

/** Capture a Git patch without text decoding so binary hunks and mode changes survive intact. */
export async function captureBinaryPatch(
  repositoryRoot: string,
  baseCommit: string,
  headCommit: string,
): Promise<Buffer> {
  try {
    const patch = await gitRaw(repositoryRoot, [
      "diff",
      "--binary",
      "--full-index",
      baseCommit,
      headCommit,
    ]);
    if (patch.length === 0) return patch;

    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "agent-arena-patch-check-"),
    );
    const indexPath = path.join(temporaryRoot, "index");
    try {
      await execa("git", ["read-tree", headCommit], {
        cwd: repositoryRoot,
        env: { GIT_INDEX_FILE: indexPath },
      });
      await execa(
        "git",
        ["apply", "--cached", "--check", "--reverse", "--whitespace=nowarn"],
        {
          cwd: repositoryRoot,
          env: { GIT_INDEX_FILE: indexPath },
          input: patch,
          encoding: "buffer",
          stripFinalNewline: false,
        },
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
    return patch;
  } catch (error) {
    throw patchCaptureIntegrityError(
      `Failed to capture or verify Git patch ${baseCommit}..${headCommit}`,
      error,
    );
  }
}

export async function resolveGitHubRepositoryIdentity(
  repositoryRoot: string,
): Promise<{ repository: string; baseBranch?: string } | undefined> {
  let remote: string;
  try {
    remote = await gitScalar(repositoryRoot, ["remote", "get-url", "origin"]);
  } catch {
    return undefined;
  }
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/u.exec(
      remote,
    );
  const repository = match?.[1];
  if (!repository) return undefined;
  let baseBranch: string | undefined;
  try {
    const symbolic = await gitScalar(repositoryRoot, [
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    baseBranch = symbolic.replace(/^origin\//u, "");
  } catch {
    try {
      baseBranch = await gitScalar(repositoryRoot, [
        "branch",
        "--show-current",
      ]);
    } catch {
      // A detached repository still has a stable repository identity.
    }
  }
  return {
    repository,
    ...(baseBranch ? { baseBranch } : {}),
  };
}

export async function readTextAtCommit(
  repositoryRoot: string,
  commit: string,
  filePath: string,
): Promise<string | undefined> {
  const result = await execa("git", ["show", `${commit}:${filePath}`], {
    cwd: repositoryRoot,
    reject: false,
  });
  return result.exitCode === 0 ? result.stdout : undefined;
}

export async function assertCleanRepository(
  repositoryRoot: string,
): Promise<void> {
  const status = await gitScalar(repositoryRoot, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  const material = status
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.slice(3).startsWith(".agent-arena/"));
  if (material.length > 0) {
    throw new Error(
      `Repository must be clean before a fight:\n${material.join("\n")}`,
    );
  }
}

export class WorktreeManager {
  private readonly worktrees = new Set<string>();
  private readonly allocatedPaths = new Set<string>();
  private manifest?: WorktreeManifest;
  private executionSessionId?: string;
  private initialized = false;
  private finalized = false;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    readonly repositoryRoot: string,
    readonly temporaryRoot: string,
    readonly baseCommit: string,
    private readonly options: {
      keepWorktrees?: boolean;
      manifestPath?: string;
      runId?: string;
      executionKind?: "initial" | "resume" | "provider_recovery";
      now?: () => Date;
    } = {},
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.temporaryRoot, { recursive: true });
    if (!this.options.manifestPath) {
      this.initialized = true;
      return;
    }
    if (!this.options.runId)
      throw new Error("A run ID is required for a worktree manifest");
    const now = this.timestamp();
    const repository = await this.repositoryIdentity();
    let manifest: WorktreeManifest;
    try {
      manifest = await readWorktreeManifest(this.options.manifestPath);
      if (
        manifest.runId !== this.options.runId ||
        manifest.repository.root !== repository.root ||
        manifest.repository.gitCommonDirectory !== repository.gitCommonDirectory
      )
        throw new Error(
          "Existing worktree manifest repository identity does not match",
        );
      if (manifest.retentionEnabled !== (this.options.keepWorktrees ?? false))
        throw new Error(
          "Existing worktree manifest retention policy does not match",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      manifest = {
        version: 1,
        runId: this.options.runId,
        repository,
        retentionEnabled: this.options.keepWorktrees ?? false,
        createdAt: now,
        updatedAt: now,
        executions: [],
        worktrees: [],
      };
    }
    this.executionSessionId = `execution-${String(manifest.executions.length + 1)}-${randomUUID().slice(0, 8)}`;
    manifest.executions.push({
      id: this.executionSessionId,
      kind: this.options.executionKind ?? "initial",
      temporaryRoot: path.resolve(this.temporaryRoot),
      startedAt: now,
    });
    this.manifest = manifest;
    await this.persistManifest();
    this.initialized = true;
  }

  async create(
    name: string,
    metadata: { purpose?: string; contestantId?: ContestantId } = {},
  ): Promise<string> {
    return this.exclusive(() => this.createUnlocked(name, metadata));
  }

  private async createUnlocked(
    name: string,
    metadata: { purpose?: string; contestantId?: ContestantId } = {},
  ): Promise<string> {
    if (!this.initialized)
      throw new Error("WorktreeManager is not initialized");
    const logicalName = this.safeLogicalName(name);
    let ordinal = 1;
    let target: string;
    do {
      target = path.join(
        this.temporaryRoot,
        ordinal === 1 ? logicalName : `${logicalName}-${String(ordinal)}`,
      );
      ordinal += 1;
    } while (
      this.allocatedPaths.has(target) ||
      this.manifest?.worktrees.some((entry) => entry.path === target) ||
      (await this.pathExists(target))
    );
    await gitScalar(this.repositoryRoot, [
      "worktree",
      "add",
      "--detach",
      target,
      this.baseCommit,
    ]);
    this.worktrees.add(target);
    this.allocatedPaths.add(target);
    if (this.manifest && this.executionSessionId) {
      const entry: WorktreeManifestEntry = {
        id: `worktree-${String(this.manifest.worktrees.length + 1)}-${randomUUID().slice(0, 8)}`,
        executionSessionId: this.executionSessionId,
        logicalName,
        purpose: metadata.purpose ?? logicalName,
        ...(metadata.contestantId
          ? { contestantId: metadata.contestantId }
          : {}),
        path: target,
        state: "active",
        createdAt: this.timestamp(),
      };
      this.manifest.worktrees.push(entry);
      try {
        await this.persistManifest();
      } catch (error) {
        await gitScalar(this.repositoryRoot, [
          "worktree",
          "remove",
          "--force",
          target,
        ]).catch(() => undefined);
        this.worktrees.delete(target);
        this.manifest.worktrees.pop();
        throw error;
      }
    }
    return target;
  }

  async applyPatch(worktree: string, patchPath: string): Promise<void> {
    const content = await readFile(patchPath);
    if (content.length === 0)
      throw new Error(`Cannot apply empty patch: ${patchPath}`);
    await gitScalar(
      this.repositoryRoot,
      ["apply", "--index", "--3way", patchPath],
      worktree,
    );
  }

  /**
   * Freeze the worktree's current tracked state as a Git tree. Unlike HEAD or
   * the mutable index, this remains a stable target-relative baseline even if
   * an agent stages files while building an attack.
   */
  async snapshot(worktree: string): Promise<string> {
    await gitScalar(this.repositoryRoot, ["add", "-A"], worktree);
    return gitScalar(this.repositoryRoot, ["write-tree"], worktree);
  }

  async changedPathsSinceSnapshot(
    worktree: string,
    snapshot: string,
  ): Promise<string[]> {
    const tracked = await gitScalar(
      this.repositoryRoot,
      ["diff", "--name-only", snapshot, "--"],
      worktree,
    );
    const untracked = await gitScalar(
      this.repositoryRoot,
      ["ls-files", "--others", "--exclude-standard"],
      worktree,
    );
    return [
      ...new Set(
        [...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean),
      ),
    ];
  }

  async capturePatch(
    worktree: string,
    targetPath: string,
    paths?: readonly string[],
    againstHead = false,
  ): Promise<number> {
    if (paths && paths.length > 0) {
      // Provider-declared paths are participant input. Keep a missing or
      // otherwise invalid pathspec outside the harness-integrity boundary so
      // the caller can isolate that entry without aborting the round.
      await gitScalar(
        this.repositoryRoot,
        ["add", "-N", "--", ...paths],
        worktree,
      );
    }
    try {
      if (!paths || paths.length === 0) {
        await gitScalar(this.repositoryRoot, ["add", "-N", "."], worktree);
      }
      const args = ["diff", "--binary", "--full-index"];
      if (againstHead) args.push("HEAD");
      if (paths && paths.length > 0) args.push("--", ...paths);
      const patch = await gitRaw(this.repositoryRoot, args, worktree);
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, patch);
      if (patch.length > 0)
        await verifyReversePatch(this.repositoryRoot, worktree, targetPath);
      return patch.length;
    } catch (error) {
      throw patchCaptureIntegrityError(
        `Failed to capture or verify Git patch from ${worktree}`,
        error,
      );
    }
  }

  async capturePatchAgainstSnapshot(
    worktree: string,
    targetPath: string,
    snapshot: string,
    paths: readonly string[],
  ): Promise<number> {
    if (paths.length === 0)
      throw new Error("A target-relative overlay requires at least one path");
    // Intent-to-add makes untracked test files visible to `git diff` without
    // replacing any content an agent may already have staged.
    // This pathspec comes from the provider submission, so its validation must
    // remain distinguishable from a failure to capture or verify valid bytes.
    await gitScalar(
      this.repositoryRoot,
      ["add", "-N", "--", ...paths],
      worktree,
    );
    try {
      const patch = await gitRaw(
        this.repositoryRoot,
        ["diff", "--binary", "--full-index", snapshot, "--", ...paths],
        worktree,
      );
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, patch);
      if (patch.length > 0)
        await verifyReversePatch(this.repositoryRoot, worktree, targetPath);
      return patch.length;
    } catch (error) {
      throw patchCaptureIntegrityError(
        `Failed to capture or verify Git patch from snapshot ${snapshot}`,
        error,
      );
    }
  }

  async remove(worktree: string): Promise<void> {
    await this.exclusive(() => this.removeUnlocked(worktree));
  }

  private async removeUnlocked(worktree: string): Promise<void> {
    if (!this.worktrees.has(worktree)) return;
    const entry = this.manifest?.worktrees.find(
      (candidate) => candidate.path === worktree,
    );
    const exists = await this.pathExists(worktree);
    let registered = await this.isRegisteredWorktree(worktree);
    if (!exists && registered) {
      await gitScalar(this.repositoryRoot, ["worktree", "prune"]);
      registered = await this.isRegisteredWorktree(worktree);
    }
    if (this.options.keepWorktrees) {
      if (exists && registered) {
        if (entry) {
          entry.state = "retained";
          entry.retainedAt ??= this.timestamp();
          delete entry.cleanupError;
          delete entry.cleanupFailedAt;
          await this.persistManifest();
        }
        return;
      }
      if (registered) {
        const error = `Absent worktree remains registered after prune: ${worktree}`;
        if (entry) {
          entry.state = "cleanup_failure";
          entry.cleanupFailedAt = this.timestamp();
          entry.cleanupError = error;
          await this.persistManifest();
        }
        throw new Error(error);
      }
      this.worktrees.delete(worktree);
      if (entry) {
        entry.state = "removed";
        entry.removedAt = this.timestamp();
        await this.persistManifest();
      }
      return;
    }
    if (!registered) {
      this.worktrees.delete(worktree);
      if (entry) {
        entry.state = "removed";
        entry.removedAt = this.timestamp();
        await this.persistManifest();
      }
      return;
    }
    try {
      await gitScalar(this.repositoryRoot, [
        "worktree",
        "remove",
        "--force",
        worktree,
      ]);
      if (await this.isRegisteredWorktree(worktree))
        throw new Error(
          `Git still registers worktree after removal: ${worktree}`,
        );
      this.worktrees.delete(worktree);
      if (entry) {
        entry.state = "removed";
        entry.removedAt = this.timestamp();
        delete entry.cleanupError;
        delete entry.cleanupFailedAt;
        await this.persistManifest();
      }
    } catch (error) {
      if (entry) {
        entry.state = "cleanup_failure";
        entry.cleanupFailedAt = this.timestamp();
        entry.cleanupError =
          error instanceof Error ? error.message : String(error);
        await this.persistManifest();
      }
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    const failures: unknown[] = [];
    for (const worktree of [...this.worktrees]) {
      try {
        await this.remove(worktree);
      } catch (error) {
        failures.push(error);
      }
    }
    if (!this.options.keepWorktrees) {
      try {
        await gitScalar(this.repositoryRoot, ["worktree", "prune"]);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 0)
        await rm(this.temporaryRoot, { recursive: true, force: true });
    }
    if (this.manifest && this.executionSessionId) {
      const execution = this.manifest.executions.find(
        (candidate) => candidate.id === this.executionSessionId,
      );
      if (execution) execution.finalizedAt = this.timestamp();
      await this.persistManifest();
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "One or more worktrees could not be cleaned up",
      );
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    await this.cleanup();
    this.finalized = true;
  }

  retainedPaths(): string[] {
    return (
      this.manifest?.worktrees
        .filter((entry) => entry.state === "retained")
        .map((entry) => entry.path) ?? []
    );
  }

  private timestamp(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private safeLogicalName(name: string): string {
    const normalized = name.trim();
    if (
      !normalized ||
      normalized === "." ||
      normalized === ".." ||
      path.basename(normalized) !== normalized
    )
      throw new Error(`Invalid worktree logical name: ${name}`);
    return normalized;
  }

  private async pathExists(candidate: string): Promise<boolean> {
    try {
      await access(candidate);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async isRegisteredWorktree(candidate: string): Promise<boolean> {
    const listing = await gitScalar(this.repositoryRoot, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    const resolved = await this.canonicalPath(candidate);
    const registered = listing
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
    return (
      await Promise.all(
        registered.map((worktree) => this.canonicalPath(worktree)),
      )
    ).some((worktree) => worktree === resolved);
  }

  private async canonicalPath(candidate: string): Promise<string> {
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

  private async repositoryIdentity(): Promise<{
    root: string;
    gitCommonDirectory: string;
  }> {
    const root = await realpath(this.repositoryRoot);
    const common = await gitScalar(this.repositoryRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    return { root, gitCommonDirectory: await realpath(common) };
  }

  private async persistManifest(): Promise<void> {
    if (!this.manifest || !this.options.manifestPath) return;
    this.manifest.updatedAt = this.timestamp();
    await writeWorktreeManifest(this.options.manifestPath, this.manifest);
  }
}

export function changedPathsFromPatch(patch: string): string[] {
  const headers = patch.split(/\r?\n/u).flatMap((line) => {
    const parsed = parseGitDiffHeader(line);
    return parsed ? [parsed.after] : [];
  });
  return [
    ...new Set(
      headers.length
        ? headers
        : [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(
            (match) => match[1] ?? "",
          ),
    ),
  ].filter(Boolean);
}

export function parseGitDiffHeader(
  line: string,
): { before: string; after: string } | undefined {
  const match =
    /^diff --git ("(?:\\.|[^"])*"|\S+) ("(?:\\.|[^"])*"|\S+)$/u.exec(line);
  if (!match?.[1] || !match[2]) return undefined;
  try {
    const decode = (token: string): string => {
      const value = token.startsWith('"')
        ? (JSON.parse(token) as string)
        : token;
      return value.replace(/^[ab]\//u, "");
    };
    return { before: decode(match[1]), after: decode(match[2]) };
  } catch {
    return undefined;
  }
}

export function isAllowedAttackPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return (
    /(^|\/)(test|tests|__tests__|spec|specs|fixtures)(\/|$)/.test(normalized) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normalized) ||
    /(^|\/)(test_|conftest\.py)/.test(normalized)
  );
}
