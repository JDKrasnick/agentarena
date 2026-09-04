import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";

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
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString() || result.stdout.toString()}`,
    );
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

  constructor(
    readonly repositoryRoot: string,
    readonly temporaryRoot: string,
    readonly baseCommit: string,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.temporaryRoot, { recursive: true });
  }

  async create(name: string): Promise<string> {
    const target = path.join(this.temporaryRoot, name);
    await rm(target, { recursive: true, force: true });
    await gitScalar(this.repositoryRoot, [
      "worktree",
      "add",
      "--detach",
      target,
      this.baseCommit,
    ]);
    this.worktrees.add(target);
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
    try {
      if (paths && paths.length > 0) {
        await gitScalar(
          this.repositoryRoot,
          ["add", "-N", "--", ...paths],
          worktree,
        );
      } else {
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
    try {
      await gitScalar(
        this.repositoryRoot,
        ["add", "-N", "--", ...paths],
        worktree,
      );
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
    if (!this.worktrees.has(worktree)) return;
    await gitScalar(this.repositoryRoot, [
      "worktree",
      "remove",
      "--force",
      worktree,
    ]);
    this.worktrees.delete(worktree);
  }

  async cleanup(): Promise<void> {
    for (const worktree of [...this.worktrees]) {
      await this.remove(worktree);
    }
    await gitScalar(this.repositoryRoot, ["worktree", "prune"]);
    await rm(this.temporaryRoot, { recursive: true, force: true });
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
