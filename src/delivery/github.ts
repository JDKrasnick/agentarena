import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import type { DeliveryTarget, RunState } from "../core/types.js";
import { changedPathsFromPatch } from "../repo/git.js";
import { PullRequestStateSchema, type PullRequestState } from "./types.js";

interface PreparedDelivery {
  branch: string;
  commitSha: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
}

export interface GitHubDeliveryInput {
  state: RunState;
  target: DeliveryTarget;
  patchPath: string;
  patchSha256: string;
  branch: string;
  closeIssue: boolean;
  signal?: AbortSignal;
}

export interface GitHubDeliveryAdapter {
  prepare(input: GitHubDeliveryInput): Promise<PreparedDelivery>;
  getPullRequest(repository: string, number: number): Promise<PullRequestState>;
  requestMerge(
    repository: string,
    number: number,
    expectedHeadSha: string,
  ): Promise<void>;
  getIssueState(repository: string, number: number): Promise<string>;
}

async function command(
  executable: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal | undefined },
): Promise<string> {
  const result = await execa(executable, args, {
    cwd: options.cwd,
    reject: false,
    ...(options.signal ? { cancelSignal: options.signal } : {}),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function stateFromGh(value: {
  url: string;
  number: number;
  state: string;
  mergedAt?: string | null;
  headRefOid: string;
  mergeable?: string;
  mergeStateStatus?: string;
  statusCheckRollup?: Array<{ status?: string; conclusion?: string }>;
  reviews?: Array<{ state: string }>;
}): PullRequestState {
  const checks = value.statusCheckRollup ?? [];
  const checkState = checks.some((check) =>
    ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT"].includes(
      check.conclusion ?? "",
    ),
  )
    ? "failure"
    : checks.some(
          (check) =>
            check.status !== "COMPLETED" ||
            !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion ?? ""),
        )
      ? "pending"
      : "success";
  const reviews = value.reviews ?? [];
  const reviewState = reviews.some(
    (review) => review.state === "CHANGES_REQUESTED",
  )
    ? "changes_requested"
    : reviews.some((review) => review.state === "APPROVED")
      ? "approved"
      : "pending";
  return PullRequestStateSchema.parse({
    repository: "",
    number: value.number,
    url: value.url,
    headSha: value.headRefOid,
    state: value.mergedAt
      ? "merged"
      : value.state.toUpperCase() === "CLOSED"
        ? "closed"
        : "open",
    checks: checkState,
    reviews: reviewState,
    mergeable:
      value.mergeable === "MERGEABLE"
        ? "mergeable"
        : value.mergeable === "CONFLICTING"
          ? "conflicting"
          : "unknown",
    queued: value.mergeStateStatus === "QUEUED",
  });
}

export class GitHubCliDeliveryAdapter implements GitHubDeliveryAdapter {
  constructor(private readonly repositoryRoot: string) {}

  async prepare(input: GitHubDeliveryInput): Promise<PreparedDelivery> {
    if (!input.target.repository)
      throw new Error("GitHub delivery target has no repository identity");
    const patch = await readFile(input.patchPath, "utf8");
    if (changedPathsFromPatch(patch).length === 0)
      throw new Error("Accepted patch has no changed paths");
    let base = input.state.config.baseCommit;
    let branch = input.branch;
    let pushRepository = input.target.repository;
    if (input.target.kind === "github_pull_request") {
      if (
        !input.target.number ||
        !input.target.headCommit ||
        !input.target.headBranch
      )
        throw new Error("Frozen pull request target is incomplete");
      const current = JSON.parse(
        await command(
          "gh",
          [
            "pr",
            "view",
            String(input.target.number),
            "--repo",
            input.target.repository,
            "--json",
            "headRefOid,headRefName,headRepository",
          ],
          { cwd: this.repositoryRoot, signal: input.signal },
        ),
      ) as {
        headRefOid: string;
        headRefName: string;
        headRepository: { nameWithOwner: string };
      };
      if (
        current.headRefName !== input.target.headBranch ||
        current.headRepository.nameWithOwner !== input.target.headRepository
      ) {
        throw new Error(
          "Pull request head moved after review; rerun/rebase, create a follow-up pull request, or cancel",
        );
      }
      if (base !== input.target.headCommit)
        throw new Error(
          "The accepted patch was not validated from the frozen pull request head",
        );
      base = input.target.headCommit;
      branch = input.target.headBranch;
      pushRepository = input.target.headRepository ?? input.target.repository;
    }
    if (!base) throw new Error("Run has no frozen implementation base");
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), `agent-arena-delivery-${input.state.runId}-`),
    );
    try {
      await command(
        "git",
        ["worktree", "add", "--detach", temporaryRoot, base],
        { cwd: this.repositoryRoot, signal: input.signal },
      );
      await command("git", ["apply", "--check", input.patchPath], {
        cwd: temporaryRoot,
        signal: input.signal,
      });
      await command("git", ["apply", input.patchPath], {
        cwd: temporaryRoot,
        signal: input.signal,
      });
      await command("git", ["diff", "--check"], {
        cwd: temporaryRoot,
        signal: input.signal,
      });
      await command("git", ["add", "--all"], {
        cwd: temporaryRoot,
        signal: input.signal,
      });
      await command(
        "git",
        [
          "-c",
          "user.name=Agent Arena",
          "-c",
          "user.email=agent-arena@localhost",
          "commit",
          "-m",
          `Agent Arena: ${input.state.config.task.slice(0, 72)}`,
        ],
        { cwd: temporaryRoot, signal: input.signal },
      );
      const commitSha = await command("git", ["rev-parse", "HEAD"], {
        cwd: temporaryRoot,
        signal: input.signal,
      });
      const preparedTree = await command("git", ["rev-parse", "HEAD^{tree}"], {
        cwd: temporaryRoot,
        signal: input.signal,
      });
      const remote = `https://github.com/${pushRepository}.git`;
      const existing = await execa(
        "git",
        ["ls-remote", "--heads", remote, `refs/heads/${branch}`],
        { cwd: temporaryRoot, reject: false },
      );
      const remoteSha = existing.stdout.split(/\s/u)[0];
      let deliveredSha = commitSha;
      if (remoteSha) {
        if (input.target.kind === "github_pull_request") {
          if (remoteSha === input.target.headCommit) {
            await command(
              "git",
              ["push", remote, `HEAD:refs/heads/${branch}`],
              { cwd: temporaryRoot, signal: input.signal },
            );
          } else {
            await command("git", ["fetch", remote, remoteSha], {
              cwd: temporaryRoot,
              signal: input.signal,
            });
            const remoteTree = await command(
              "git",
              ["rev-parse", "FETCH_HEAD^{tree}"],
              { cwd: temporaryRoot, signal: input.signal },
            );
            if (remoteTree !== preparedTree)
              throw new Error(
                "Pull request head moved before the authorized non-force push",
              );
            deliveredSha = remoteSha;
          }
        } else {
          await command("git", ["fetch", remote, remoteSha], {
            cwd: temporaryRoot,
            signal: input.signal,
          });
          const remoteTree = await command(
            "git",
            ["rev-parse", "FETCH_HEAD^{tree}"],
            { cwd: temporaryRoot, signal: input.signal },
          );
          if (remoteTree !== preparedTree)
            throw new Error(
              `Delivery branch ${branch} already exists with different content`,
            );
          deliveredSha = remoteSha;
        }
      } else {
        await command("git", ["push", remote, `HEAD:refs/heads/${branch}`], {
          cwd: temporaryRoot,
          signal: input.signal,
        });
      }
      if (input.target.kind === "github_pull_request") {
        return {
          branch,
          commitSha: deliveredSha,
          pullRequestNumber: input.target.number ?? 0,
          pullRequestUrl: input.target.url ?? "",
        };
      }
      const existingPr = JSON.parse(
        await command(
          "gh",
          [
            "pr",
            "list",
            "--repo",
            input.target.repository,
            "--head",
            branch,
            "--state",
            "all",
            "--json",
            "number,url,headRefOid",
          ],
          { cwd: temporaryRoot, signal: input.signal },
        ),
      ) as Array<{ number: number; url: string; headRefOid: string }>;
      const matching = existingPr.find(
        (candidate) => candidate.headRefOid === deliveredSha,
      );
      if (matching) {
        return {
          branch,
          commitSha: deliveredSha,
          pullRequestNumber: matching.number,
          pullRequestUrl: matching.url,
        };
      }
      const linkage =
        input.target.kind === "github_issue" && input.target.number
          ? `${input.closeIssue ? "Fixes" : "Refs"} #${String(input.target.number)}`
          : "";
      const url = await command(
        "gh",
        [
          "pr",
          "create",
          "--repo",
          input.target.repository,
          "--head",
          `${pushRepository.split("/")[0] ?? ""}:${branch}`,
          "--base",
          input.target.baseBranch ?? "main",
          "--title",
          input.state.config.task.slice(0, 120),
          "--body",
          [
            "Implemented and selected by Agent Arena.",
            "",
            `Run: ${input.state.runId}`,
            `Patch SHA-256: ${input.patchSha256}`,
            linkage,
          ]
            .filter(Boolean)
            .join("\n"),
        ],
        { cwd: temporaryRoot, signal: input.signal },
      );
      const numberMatch = /\/pull\/(\d+)(?:\s|$)/u.exec(url);
      if (!numberMatch?.[1])
        throw new Error(
          `Unable to determine created pull request number: ${url}`,
        );
      return {
        branch,
        commitSha: deliveredSha,
        pullRequestNumber: Number(numberMatch[1]),
        pullRequestUrl: url.trim(),
      };
    } finally {
      await execa("git", ["worktree", "remove", "--force", temporaryRoot], {
        cwd: this.repositoryRoot,
        reject: false,
      });
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  async getPullRequest(
    repository: string,
    number: number,
  ): Promise<PullRequestState> {
    const value = JSON.parse(
      await command(
        "gh",
        [
          "pr",
          "view",
          String(number),
          "--repo",
          repository,
          "--json",
          "url,number,state,mergedAt,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,reviews",
        ],
        { cwd: this.repositoryRoot },
      ),
    ) as Parameters<typeof stateFromGh>[0];
    return { ...stateFromGh(value), repository };
  }

  async requestMerge(
    repository: string,
    number: number,
    expectedHeadSha: string,
  ): Promise<void> {
    const current = await this.getPullRequest(repository, number);
    if (current.headSha !== expectedHeadSha)
      throw new Error("Pull request head changed after merge authorization");
    const policy = JSON.parse(
      await command(
        "gh",
        [
          "repo",
          "view",
          repository,
          "--json",
          "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed",
        ],
        { cwd: this.repositoryRoot },
      ),
    ) as {
      mergeCommitAllowed: boolean;
      squashMergeAllowed: boolean;
      rebaseMergeAllowed: boolean;
    };
    const method = policy.mergeCommitAllowed
      ? "--merge"
      : policy.squashMergeAllowed
        ? "--squash"
        : policy.rebaseMergeAllowed
          ? "--rebase"
          : undefined;
    if (!method) throw new Error("Repository policy allows no merge method");
    await command(
      "gh",
      ["pr", "merge", String(number), "--repo", repository, "--auto", method],
      { cwd: this.repositoryRoot },
    );
  }

  async getIssueState(repository: string, number: number): Promise<string> {
    const value = JSON.parse(
      await command(
        "gh",
        [
          "issue",
          "view",
          String(number),
          "--repo",
          repository,
          "--json",
          "state",
        ],
        { cwd: this.repositoryRoot },
      ),
    ) as { state: string };
    return value.state.toLowerCase();
  }
}
