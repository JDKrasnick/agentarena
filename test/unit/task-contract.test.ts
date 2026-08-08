import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRunSpec, calculateRunSpecHash } from "../../src/task/run-spec.js";
import type { IssueResolver } from "../../src/task/task-contract.js";
import {
  FightConfigSchema,
  OracleCitationSchema,
} from "../../src/core/types.js";
import { RuleBasedVerifier } from "../../src/agents/adapter.js";

function config(
  root: string,
  acceptanceCriteria: string[] = [],
  issueReferences: string[] = ["241"],
  task = "Implement issue #241",
) {
  return FightConfigSchema.parse({
    task,
    acceptanceCriteria,
    issueReferences,
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
      reviewMs: 2_000,
      attackMs: 3_000,
      verifierMs: 4_000,
      repairMs: 5_000,
    },
  });
}

const permissions = {
  defaultMode: "confirm" as const,
  reducedValidationAccepted: false,
  capabilities: [],
};

describe("run specification", () => {
  it("snapshots exact task sources without extracting checklist criteria", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-contract-"));
    await writeFile(path.join(root, "AGENTS.md"), "Keep changes focused.\n");
    let calls = 0;
    const resolver: IssueResolver = {
      resolve() {
        calls += 1;
        return Promise.resolve({
          origin: "https://github.com/acme/service/issues/241",
          repository: "acme/service",
          number: 241,
          url: "https://github.com/acme/service/issues/241",
          baseBranch: "main",
          title: "Slug whitespace normalization",
          body: "- [ ] Collapse every whitespace run to one hyphen.",
          comments: [
            { author: "maintainer", body: "Tabs count as whitespace." },
          ],
        });
      },
    };
    const fightConfig = config(root);
    const runSpec = await buildRunSpec({
      runId: "run-1",
      baseCommit: "b".repeat(40),
      config: fightConfig,
      permissions,
      repositoryRoot: root,
      sourceDirectory: path.join(root, "snapshots"),
      issueResolver: resolver,
      now: new Date("2026-01-02T03:04:05Z"),
    });
    expect(calls).toBe(1);
    expect(runSpec.task.task).toBe("Implement issue #241");
    expect(runSpec.task.acceptanceCriteria).toEqual([]);
    const issue = runSpec.task.sources.find(
      (source) => source.kind === "issue",
    );
    expect(issue?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(issue?.github).toMatchObject({
      repository: "acme/service",
      number: 241,
      baseBranch: "main",
    });
    expect(issue).not.toHaveProperty("visibility");
    expect(issue).not.toHaveProperty("primary");
    expect(await readFile(issue!.snapshotPath, "utf8")).toContain(
      "Tabs count as whitespace",
    );
    const { contentHash, ...hashInput } = runSpec;
    expect(contentHash).toBe(calculateRunSpecHash(hashInput));
    expect(
      runSpec.task.sources.some(
        (source) =>
          source.kind === "repo_spec" && source.origin === "AGENTS.md",
      ),
    ).toBe(true);
    expect(
      calculateRunSpecHash({
        ...hashInput,
        budgets: { ...hashInput.budgets, attackMs: 3_001 },
      }),
    ).not.toBe(contentHash);

    const verifier = new RuleBasedVerifier("codex");
    const verifierInput = {
      attack: {
        claim: "Whitespace is mishandled",
        impact: "Slugs are unstable",
        oracle: {
          expectedBehavior: "Collapse every whitespace run to one hyphen.",
          rationale: "The issue states this behavior",
        },
        assertionFingerprint: "whitespace",
        patchPath: "attack.diff",
        proposedSeverity: "medium" as const,
      },
      runSpec,
      authorPassed: true,
      targetFailed: true,
      worktree: root,
      promptPath: path.join(root, "verifier.prompt.md"),
      transcriptPrefix: path.join(root, "verifier"),
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    };
    expect((await verifier.assess(verifierInput)).oracleSupported).toBe(true);
    expect(
      (
        await verifier.assess({
          ...verifierInput,
          attack: {
            ...verifierInput.attack,
            oracle: {
              expectedBehavior: "Invent an unrelated deployment workflow",
              sourceId: issue!.id,
              rationale: "A source ID exists",
            },
          },
        })
      ).oracleSupported,
    ).toBe(false);
    expect(
      (
        await verifier.assess({
          ...verifierInput,
          attack: {
            ...verifierInput.attack,
            oracle: {
              expectedBehavior: " ",
              rationale: "No behavior was stated",
            },
          },
        })
      ).oracleSupported,
    ).toBe(false);
    expect(() =>
      OracleCitationSchema.parse({
        expectedBehavior: " ",
        rationale: "No behavior was stated",
      }),
    ).toThrow();
  });

  it("never invents a missing official issue and retains an explicit task with a warning", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "arena-contract-missing-"),
    );
    const warnings: string[] = [];
    const fightConfig = config(
      root,
      ["Return a stable result"],
      ["404"],
      "Use the supplied local behavior instead",
    );
    const runSpec = await buildRunSpec({
      runId: "run-2",
      baseCommit: "b".repeat(40),
      config: fightConfig,
      permissions,
      repositoryRoot: root,
      sourceDirectory: path.join(root, "snapshots"),
      issueResolver: {
        resolve() {
          return Promise.reject(new Error("not found"));
        },
      },
      warnings,
    });
    expect(runSpec.task.sources.map((source) => source.kind)).toEqual([
      "user_task",
    ]);
    expect(warnings[0]).toMatch(/could not be retrieved/);
  });
});
