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
import {
  CommandAttackVerifier,
  RuleBasedVerifier,
} from "../../src/agents/adapter.js";

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
  it("runs one command per policy-owned judge attempt and stages concrete fallback evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-judge-evidence-"));
    const fightConfig = config(
      root,
      ["Normalize whitespace"],
      [],
      "Normalize whitespace",
    );
    const runSpec = await buildRunSpec({
      runId: "run-judge",
      baseCommit: "b".repeat(40),
      config: fightConfig,
      permissions,
      repositoryRoot: root,
      sourceDirectory: path.join(root, "snapshots"),
    });
    const attackPath = path.join(root, "attack.diff");
    const targetPath = path.join(root, "target.diff");
    const diagnosticPath = path.join(root, "diagnostic.log");
    const countPath = path.join(root, "calls.txt");
    const promptCapturePath = path.join(root, "prompt.txt");
    const scriptPath = path.join(root, "judge.mjs");
    await writeFile(attackPath, "attack evidence\n");
    await writeFile(targetPath, "target patch\n");
    await writeFile(diagnosticPath, "mechanical failure\n");
    await writeFile(
      scriptPath,
      [
        'import { appendFileSync, writeFileSync } from "node:fs";',
        'import path from "node:path";',
        'let prompt = "";',
        "for await (const chunk of process.stdin) prompt += chunk;",
        'appendFileSync(process.argv[2], "1\\n");',
        "writeFileSync(process.argv[3], prompt);",
        'writeFileSync(path.join(process.cwd(), ".agent-arena-judgment.json"), JSON.stringify({ decision: "supported_untestable", relevant: true, expectedBehaviorClearlySupported: true, evidencePointsToDefect: true, rootDefectId: "whitespace", severity: "medium", rationale: "concrete evidence" }));',
      ].join("\n"),
    );
    const verifier = new CommandAttackVerifier("codex", {
      executable: process.execPath,
      args: [scriptPath, countPath, promptCapturePath],
    });

    await expect(
      verifier.adjudicate({
        attack: {
          claim: "Whitespace is mishandled",
          impact: "Unstable output",
          oracle: {
            expectedBehavior: "Normalize whitespace",
            rationale: "The task requires it",
          },
          assertionFingerprint: "whitespace",
          patchPath: attackPath,
        },
        runSpec,
        mechanicalFailureReason: "command infrastructure failed",
        targetPatchPath: targetPath,
        mechanicalDiagnosticArtifactRefs: [diagnosticPath],
        priorCanonicalDefects: [],
        worktree: root,
        promptPath: path.join(root, "judge.prompt.md"),
        transcriptPrefix: path.join(root, "judge"),
        timeoutMs: 1_000,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ decision: "supported_untestable" });

    expect((await readFile(countPath, "utf8")).trim().split("\n")).toEqual([
      "1",
    ]);
    const prompt = await readFile(promptCapturePath, "utf8");
    expect(prompt).toContain('"artifactId": "attack-overlay"');
    expect(prompt).toContain('"artifactId": "target-patch"');
    expect(prompt).toContain('"artifactId": "mechanical-diagnostic-1"');
    expect(
      await readFile(
        path.join(root, ".agent-arena-judge-evidence/target-patch.diff"),
        "utf8",
      ),
    ).toBe("target patch\n");
  });

  it("records an exhausted primary-verifier provider failure for recovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-judge-recovery-"));
    const fightConfig = config(
      root,
      ["Normalize whitespace"],
      [],
      "Normalize whitespace",
    );
    const runSpec = await buildRunSpec({
      runId: "run-judge-recovery",
      baseCommit: "b".repeat(40),
      config: fightConfig,
      permissions,
      repositoryRoot: root,
      sourceDirectory: path.join(root, "snapshots"),
    });
    const attackPath = path.join(root, "attack.diff");
    const scriptPath = path.join(root, "judge-failure.mjs");
    await writeFile(attackPath, "attack evidence\n");
    await writeFile(
      scriptPath,
      'console.error("MCP OAuth authentication failed"); process.exit(8);\n',
    );
    const verifier = new CommandAttackVerifier("codex", {
      executable: process.execPath,
      args: [scriptPath],
    });

    await expect(
      verifier.assess({
        attack: {
          claim: "Whitespace is mishandled",
          impact: "Unstable output",
          oracle: {
            expectedBehavior: "Normalize whitespace",
            rationale: "The task requires it",
          },
          assertionFingerprint: "whitespace",
          patchPath: attackPath,
        },
        runSpec,
        authorPassed: true,
        targetFailed: true,
        worktree: root,
        promptPath: path.join(root, "verifier.prompt.md"),
        transcriptPrefix: path.join(root, "verifier-attempt-2"),
        timeoutMs: 1_000,
        signal: new AbortController().signal,
        retryReason: "Verifier provider infrastructure failed",
      }),
    ).rejects.toThrow(/infrastructure failed/);

    expect(verifier.consumeProviderFailure()).toMatchObject({
      provider: "codex",
      stage: "judge",
      usableTerminalResult: false,
    });
  });

  it("does not promote an Arena judge deadline with transport noise to provider recovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-judge-timeout-"));
    const fightConfig = config(
      root,
      ["Normalize whitespace"],
      [],
      "Normalize whitespace",
    );
    const runSpec = await buildRunSpec({
      runId: "run-judge-timeout",
      baseCommit: "b".repeat(40),
      config: fightConfig,
      permissions,
      repositoryRoot: root,
      sourceDirectory: path.join(root, "snapshots"),
    });
    const attackPath = path.join(root, "attack.diff");
    const scriptPath = path.join(root, "judge-timeout.mjs");
    await writeFile(attackPath, "attack evidence\n");
    await writeFile(
      scriptPath,
      'console.error("transport connection lost"); setInterval(() => undefined, 1000);\n',
    );
    const verifier = new CommandAttackVerifier("codex", {
      executable: process.execPath,
      args: [scriptPath],
      providerStream: "codex",
    });

    await expect(
      verifier.assess({
        attack: {
          claim: "Whitespace is mishandled",
          impact: "Unstable output",
          oracle: {
            expectedBehavior: "Normalize whitespace",
            rationale: "The task requires it",
          },
          assertionFingerprint: "whitespace",
          patchPath: attackPath,
        },
        runSpec,
        authorPassed: true,
        targetFailed: true,
        worktree: root,
        promptPath: path.join(root, "verifier.prompt.md"),
        transcriptPrefix: path.join(root, "verifier-attempt-2"),
        timeoutMs: 120,
        signal: new AbortController().signal,
        retryReason: "Verifier timed out",
      }),
    ).rejects.toThrow(/Verifier output was invalid/);

    expect(verifier.consumeProviderFailure()).toBeUndefined();
  });

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

  it("stops when an explicit official issue cannot be retrieved", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "arena-contract-missing-"),
    );
    const fightConfig = config(
      root,
      ["Return a stable result"],
      ["404"],
      "Use the supplied local behavior instead",
    );
    await expect(
      buildRunSpec({
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
      }),
    ).rejects.toThrow("Explicit issue 404 could not be retrieved");
  });
});
