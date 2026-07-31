import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { GitHubCliDeliveryAdapter } from "../../src/delivery/github.js";
import { makeRunState } from "../helpers/run-state.js";

describe("GitHub CLI delivery adapter", () => {
  it("delivers a base-relative PR result as a child of the unchanged frozen head", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-gh-prepare-"));
    const repositoryRoot = path.join(root, "repository");
    const remoteRoot = path.join(root, "remote.git");
    const bin = path.join(root, "bin");
    await mkdir(repositoryRoot, { recursive: true });
    await mkdir(bin, { recursive: true });
    await execa("git", ["init", "-q"], { cwd: repositoryRoot });
    await execa("git", ["config", "user.email", "arena@example.test"], {
      cwd: repositoryRoot,
    });
    await execa("git", ["config", "user.name", "Agent Arena Test"], {
      cwd: repositoryRoot,
    });
    const sourcePath = path.join(repositoryRoot, "result.txt");
    await writeFile(sourcePath, "base\n");
    await execa("git", ["add", "result.txt"], { cwd: repositoryRoot });
    await execa("git", ["commit", "-qm", "base"], { cwd: repositoryRoot });
    const baseCommit = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
    ).stdout;
    await writeFile(sourcePath, "incumbent\n");
    await execa("git", ["add", "result.txt"], { cwd: repositoryRoot });
    await execa("git", ["commit", "-qm", "pull request head"], {
      cwd: repositoryRoot,
    });
    const headCommit = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
    ).stdout;
    await execa("git", ["init", "--bare", "-q", remoteRoot]);
    await execa("git", ["push", remoteRoot, `HEAD:refs/heads/feature/result`], {
      cwd: repositoryRoot,
    });
    await execa(
      "git",
      [
        "config",
        `url.${pathToFileURL(remoteRoot).href}.insteadOf`,
        "https://github.com/acme/repo.git",
      ],
      { cwd: repositoryRoot },
    );

    await writeFile(sourcePath, "accepted final result\n");
    const patch = await execa(
      "git",
      ["diff", "--binary", "--full-index", baseCommit, "--", "result.txt"],
      {
        cwd: repositoryRoot,
        stripFinalNewline: false,
      },
    );
    const patchPath = path.join(root, "accepted.patch");
    await writeFile(patchPath, patch.stdout);
    await execa("git", ["checkout", "--", "result.txt"], {
      cwd: repositoryRoot,
    });

    const executable = path.join(bin, "gh");
    await writeFile(
      executable,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  state: "OPEN",
  headRefOid: process.env.FAKE_GH_HEAD,
  headRefName: "feature/result",
  headRepository: { nameWithOwner: "acme/repo" }
}));
`,
    );
    await chmod(executable, 0o755);
    const previousPath = process.env.PATH;
    const previousHead = process.env.FAKE_GH_HEAD;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;

    const state = makeRunState({ repositoryRoot });
    state.config.baseCommit = baseCommit;
    const target = {
      kind: "github_pull_request" as const,
      repository: "acme/repo",
      number: 9,
      url: "https://github.com/acme/repo/pull/9",
      baseBranch: "main",
      headBranch: "feature/result",
      headRepository: "acme/repo",
      headCommit,
    };
    const input = {
      state,
      target,
      patchPath,
      patchSha256: "a".repeat(64),
      branch: "feature/result",
      closeIssue: false,
    };
    try {
      process.env.FAKE_GH_HEAD = baseCommit;
      await expect(
        new GitHubCliDeliveryAdapter(repositoryRoot).prepare(input),
      ).rejects.toThrow("Pull request head moved after review");

      process.env.FAKE_GH_HEAD = headCommit;
      const prepared = await new GitHubCliDeliveryAdapter(
        repositoryRoot,
      ).prepare(input);
      expect(
        (
          await execa(
            "git",
            ["show", "-s", "--format=%P", prepared.commitSha],
            {
              cwd: repositoryRoot,
            },
          )
        ).stdout,
      ).toBe(headCommit);
      expect(
        (
          await execa("git", ["show", `${prepared.commitSha}:result.txt`], {
            cwd: repositoryRoot,
          })
        ).stdout,
      ).toBe("accepted final result");
      expect(
        (
          await execa(
            "git",
            ["ls-remote", remoteRoot, "refs/heads/feature/result"],
            { cwd: repositoryRoot },
          )
        ).stdout.split(/\s/u)[0],
      ).toBe(prepared.commitSha);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousHead === undefined) delete process.env.FAKE_GH_HEAD;
      else process.env.FAKE_GH_HEAD = previousHead;
    }
  });

  it("reads normalized required checks through the gh subprocess boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-gh-adapter-"));
    const bin = path.join(root, "bin");
    const logPath = path.join(root, "gh.log");
    await mkdir(bin, { recursive: true });
    const executable = path.join(bin, "gh");
    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "pr" && args[1] === "view" && args.includes("isDraft")) {
  process.stdout.write(JSON.stringify({ isDraft: true }));
} else if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify({
    url: "https://github.com/acme/repo/pull/9",
    number: 9,
    state: "OPEN",
    mergedAt: null,
    headRefOid: "head",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [],
    reviewDecision: "APPROVED",
    reviews: []
  }));
} else if (args[0] === "pr" && args[1] === "checks") {
  if (process.env.FAKE_GH_NO_CHECKS === "1") {
    process.stderr.write("no checks reported on the validation branch");
    process.exit(1);
  }
  const pending = process.env.FAKE_GH_PENDING === "1";
  process.stdout.write(JSON.stringify([
    {
      name: "build",
      state: pending ? "IN_PROGRESS" : "SUCCESS",
      bucket: pending ? "pending" : "pass"
    }
  ]));
  if (pending) process.exitCode = 8;
} else if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(JSON.stringify({
    mergeCommitAllowed: true,
    squashMergeAllowed: true,
    rebaseMergeAllowed: true
  }));
} else if (args[0] === "pr" && ["ready", "merge"].includes(args[1])) {
  process.stdout.write("");
} else {
  process.stderr.write("unexpected gh invocation: " + args.join(" "));
  process.exitCode = 2;
}
`,
    );
    await chmod(executable, 0o755);
    const previousPath = process.env.PATH;
    const previousLog = process.env.FAKE_GH_LOG;
    const previousPending = process.env.FAKE_GH_PENDING;
    const previousNoChecks = process.env.FAKE_GH_NO_CHECKS;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    process.env.FAKE_GH_LOG = logPath;
    try {
      const state = await new GitHubCliDeliveryAdapter(root).getPullRequest(
        "acme/repo",
        9,
      );
      expect(state).toMatchObject({
        state: "open",
        checks: "success",
        reviews: "approved",
        headSha: "head",
      });
      process.env.FAKE_GH_PENDING = "1";
      await expect(
        new GitHubCliDeliveryAdapter(root).getPullRequest("acme/repo", 9),
      ).resolves.toMatchObject({ checks: "pending" });
      delete process.env.FAKE_GH_PENDING;
      process.env.FAKE_GH_NO_CHECKS = "1";
      await expect(
        new GitHubCliDeliveryAdapter(root).getPullRequest("acme/repo", 9),
      ).resolves.toMatchObject({ checks: "pending" });
      const calls = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(calls).toHaveLength(6);
      expect(calls[1]).toContain("--required");
      delete process.env.FAKE_GH_NO_CHECKS;
      await new GitHubCliDeliveryAdapter(root).requestMerge(
        "acme/repo",
        9,
        "head",
      );
      const mergeCalls = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const readyIndex = mergeCalls.findIndex(
        (call) => call[0] === "pr" && call[1] === "ready",
      );
      const mergeIndex = mergeCalls.findIndex(
        (call) => call[0] === "pr" && call[1] === "merge",
      );
      expect(readyIndex).toBeGreaterThan(-1);
      expect(mergeIndex).toBeGreaterThan(readyIndex);
      expect(mergeCalls[mergeIndex]).toContain("--auto");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousLog === undefined) delete process.env.FAKE_GH_LOG;
      else process.env.FAKE_GH_LOG = previousLog;
      if (previousPending === undefined) delete process.env.FAKE_GH_PENDING;
      else process.env.FAKE_GH_PENDING = previousPending;
      if (previousNoChecks === undefined) delete process.env.FAKE_GH_NO_CHECKS;
      else process.env.FAKE_GH_NO_CHECKS = previousNoChecks;
    }
  });
});
