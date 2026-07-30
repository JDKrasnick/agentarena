import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

async function git(
  repositoryRoot: string,
  args: string[],
  cwd = repositoryRoot,
): Promise<string> {
  const result = await execa("git", args, { cwd, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

export async function resolveRepositoryRoot(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

export async function resolveCommit(
  repositoryRoot: string,
  ref = "HEAD",
): Promise<string> {
  return git(repositoryRoot, ["rev-parse", `${ref}^{commit}`]);
}

export async function fetchRemoteCommit(
  repositoryRoot: string,
  repository: string,
  commit: string,
): Promise<string> {
  await git(repositoryRoot, [
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

export async function resolveGitHubRepositoryIdentity(
  repositoryRoot: string,
): Promise<{ repository: string; baseBranch?: string } | undefined> {
  let remote: string;
  try {
    remote = await git(repositoryRoot, ["remote", "get-url", "origin"]);
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
    const symbolic = await git(repositoryRoot, [
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    baseBranch = symbolic.replace(/^origin\//u, "");
  } catch {
    try {
      baseBranch = await git(repositoryRoot, ["branch", "--show-current"]);
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
  const status = await git(repositoryRoot, [
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
    await git(this.repositoryRoot, [
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
    await git(
      this.repositoryRoot,
      ["apply", "--index", "--3way", patchPath],
      worktree,
    );
  }

  async capturePatch(
    worktree: string,
    targetPath: string,
    paths?: readonly string[],
    againstHead = false,
  ): Promise<number> {
    if (paths && paths.length > 0) {
      await git(this.repositoryRoot, ["add", "-N", "--", ...paths], worktree);
    } else {
      await git(this.repositoryRoot, ["add", "-N", "."], worktree);
    }
    const args = ["diff", "--binary", "--full-index"];
    if (againstHead) args.push("HEAD");
    if (paths && paths.length > 0) args.push("--", ...paths);
    const patch = await git(this.repositoryRoot, args, worktree);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, patch.length === 0 ? "" : `${patch}\n`, "utf8");
    return Buffer.byteLength(patch);
  }

  async remove(worktree: string): Promise<void> {
    if (!this.worktrees.has(worktree)) return;
    await git(this.repositoryRoot, ["worktree", "remove", "--force", worktree]);
    this.worktrees.delete(worktree);
  }

  async cleanup(): Promise<void> {
    for (const worktree of [...this.worktrees]) {
      await this.remove(worktree);
    }
    await git(this.repositoryRoot, ["worktree", "prune"]);
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
