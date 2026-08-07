import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRunSpec } from "../../src/task/run-spec.js";
import { FightConfigSchema } from "../../src/core/types.js";

describe("task source resolution", () => {
  it("snapshots pull request requirements and metadata without its diff", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-pr-source-"));
    const config = FightConfigSchema.parse({
      task: "Improve pull request #7",
      pullRequestReferences: ["7"],
      agents: ["codex", "claude"],
      attackVerifier: "codex",
      harnessMaintainer: "codex",
      rounds: 3,
      maxAttacksPerRound: 3,
      infrastructureRecoveryRound: true,
      maxHeldOutCasesPerDefect: 2,
      testCommand: "npm test",
      repositoryRoot: root,
      artifactRoot: path.join(root, "runs"),
      permissionMode: "confirm",
      nonInteractiveApproval: true,
      limits: {
        implementationMs: 1_000,
        reviewMs: 1_000,
        attackMs: 1_000,
        verifierMs: 1_000,
        repairMs: 1_000,
      },
    });
    const runSpec = await buildRunSpec({
      runId: "run-1",
      baseCommit: "b".repeat(40),
      config,
      permissions: {
        defaultMode: "confirm",
        reducedValidationAccepted: false,
        capabilities: [],
      },
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
    const source = runSpec.task.sources.find(
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
