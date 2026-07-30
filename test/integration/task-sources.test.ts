import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildTaskContract } from "../../src/task/task-contract.js";

describe("task source resolution", () => {
  it("snapshots pull request requirements and metadata without its diff", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-pr-source-"));
    const contract = await buildTaskContract({
      task: "Improve pull request #7",
      acceptanceCriteria: [],
      specPaths: [],
      issueReferences: [],
      pullRequestReferences: ["7"],
      repositoryRoot: root,
      sourceDirectory: path.join(root, "sources"),
      pullRequestResolver: {
        resolve: () =>
          Promise.resolve({
            origin: "https://github.com/acme/repo/pull/7",
            url: "https://github.com/acme/repo/pull/7",
            repository: "acme/repo",
            number: 7,
            title: "Improve parser",
            body: "- [ ] Preserve empty fields.",
            comments: [{ author: "maintainer", body: "Keep the public API." }],
            baseBranch: "main",
            headBranch: "parser",
            headRepository: "contributor/repo",
            headCommit: "a".repeat(40),
          }),
      },
    });
    const source = contract.sources.find(
      (candidate) => candidate.kind === "pull_request",
    );
    expect(source?.github).toMatchObject({
      repository: "acme/repo",
      number: 7,
      headBranch: "parser",
      headCommit: "a".repeat(40),
    });
    const snapshot = await readFile(source!.snapshotPath, "utf8");
    expect(snapshot).toContain("Preserve empty fields");
    expect(snapshot).not.toContain("diff --git");
  });
});
