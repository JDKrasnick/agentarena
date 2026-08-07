import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import type { AttackVerifier } from "../../src/agents/adapter.js";
import { validateHouseAttack } from "../../src/attacks/validate.js";
import { FightConfigSchema, type Attack } from "../../src/core/types.js";
import { RunSpecSchema } from "../../src/contracts/round.js";
import { WorktreeManager } from "../../src/repo/git.js";
import { createSlugRepository } from "../helpers/repository.js";

describe("target-relative test overlays", () => {
  it("captures and replays a regression edit relative to the frozen target patch", async () => {
    const repositoryRoot = await createSlugRepository();
    const baseCommit = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
    ).stdout;
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "agent-arena-overlay-"),
    );
    const worktrees = new WorktreeManager(
      repositoryRoot,
      temporaryRoot,
      baseCommit,
    );
    await worktrees.initialize();

    try {
      const implementationTree = await worktrees.create("implementation");
      const testPath = path.join(implementationTree, "test", "slug.test.mjs");
      await writeFile(
        testPath,
        `${await readFile(testPath, "utf8")}test("target-owned case", () => assert.equal(slug("Target Case"), "target-case"));\n`,
      );
      const implementationPatch = path.join(
        temporaryRoot,
        "implementation.diff",
      );
      await worktrees.capturePatch(
        implementationTree,
        implementationPatch,
        undefined,
        true,
      );

      const generationTree = await worktrees.create("generation");
      await worktrees.applyPatch(generationTree, implementationPatch);
      const targetSnapshot = await worktrees.snapshot(generationTree);
      const generationTestPath = path.join(
        generationTree,
        "test",
        "slug.test.mjs",
      );
      await writeFile(
        generationTestPath,
        `${await readFile(generationTestPath, "utf8")}test("arena regression", () => assert.equal(slug("Arena Case"), "arena-case"));\n`,
      );
      const overlayPatch = path.join(temporaryRoot, "regression-overlay.diff");
      await worktrees.capturePatchAgainstSnapshot(
        generationTree,
        overlayPatch,
        targetSnapshot,
        ["test/slug.test.mjs"],
      );

      const verifierTree = await worktrees.create("verifier");
      await worktrees.applyPatch(verifierTree, implementationPatch);
      await worktrees.applyPatch(verifierTree, overlayPatch);
      const replayed = await readFile(
        path.join(verifierTree, "test", "slug.test.mjs"),
        "utf8",
      );
      expect(replayed).toContain("target-owned case");
      expect(replayed).toContain("arena regression");
      expect(await readFile(overlayPatch, "utf8")).not.toContain(
        '+test("target-owned case"',
      );
    } finally {
      await worktrees.cleanup();
    }
  });

  it("validates a house overlay that edits a target-added test file", async () => {
    const repositoryRoot = await createSlugRepository();
    const baseCommit = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
    ).stdout;
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "agent-arena-house-overlay-"),
    );
    const worktrees = new WorktreeManager(
      repositoryRoot,
      temporaryRoot,
      baseCommit,
    );
    await worktrees.initialize();

    try {
      const implementationTree = await worktrees.create("implementation");
      const targetTestPath = path.join(
        implementationTree,
        "test",
        "target-owned.test.mjs",
      );
      await writeFile(
        targetTestPath,
        `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slug } from "../src/slug.mjs";\ntest("target smoke test", () => assert.equal(slug("Target Case"), "target-case"));\n`,
      );
      const implementationPatch = path.join(
        temporaryRoot,
        "target-implementation.diff",
      );
      await worktrees.capturePatch(
        implementationTree,
        implementationPatch,
        undefined,
        true,
      );

      const generationTree = await worktrees.create("house-generation");
      await worktrees.applyPatch(generationTree, implementationPatch);
      const targetSnapshot = await worktrees.snapshot(generationTree);
      const generationTestPath = path.join(
        generationTree,
        "test",
        "target-owned.test.mjs",
      );
      await writeFile(
        generationTestPath,
        `${await readFile(generationTestPath, "utf8")}test("collapses repeated whitespace", () => assert.equal(slug("Alpha   Beta"), "alpha-beta"));\n`,
      );
      const overlayPatch = path.join(temporaryRoot, "house-overlay.diff");
      await worktrees.capturePatchAgainstSnapshot(
        generationTree,
        overlayPatch,
        targetSnapshot,
        ["test/target-owned.test.mjs"],
      );

      const config = FightConfigSchema.parse({
        task: "Normalize slugs",
        agents: ["codex", "claude"],
        attackVerifier: "codex",
        harnessMaintainer: "codex",
        rounds: 3,
        maxAttacksPerRound: 3,
        infrastructureRecoveryRound: true,
        maxHeldOutCasesPerDefect: 2,
        testCommand: "npm test",
        repositoryRoot,
        artifactRoot: path.join(repositoryRoot, ".agent-arena", "runs"),
        permissionMode: "confirm",
        permissionAllow: {},
        permissionDeny: [],
        reducedValidationAccepted: false,
        nonInteractiveApproval: true,
        keepWorktrees: false,
        limits: {
          implementationMs: 10_000,
          attackMs: 10_000,
          verifierMs: 10_000,
          repairMs: 10_000,
        },
      });
      const runSpec = RunSpecSchema.parse({
        version: 1,
        runId: "run-1",
        task: {
          task: "Normalize slugs",
          acceptanceCriteria: ["Collapse every whitespace run"],
          sources: [
            {
              id: "task-user",
              kind: "user_task",
              origin: "task",
              retrievedAt: "2026-01-01T00:00:00.000Z",
              contentHash: "a".repeat(64),
              snapshotPath: "task.md",
            },
          ],
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        baseCommit: "b".repeat(40),
        topology: { mode: "duel", contestants: config.contestants },
        commands: [
          {
            id: "required-test",
            kind: "required",
            command: config.testCommand,
            timeoutMs: config.limits.attackMs,
            required: true,
          },
        ],
        budgets: config.limits,
        permissions: {
          mode: "confirm",
          reducedValidationAccepted: false,
          capabilities: [],
        },
        contentHash: "c".repeat(64),
      });
      const attack: Attack = {
        id: "house-target-relative",
        round: 2,
        origin: { kind: "house", methodPackId: "test@1" },
        targets: ["a"],
        claim: "Repeated whitespace produces repeated separators",
        impact: "Generated slugs violate the task contract",
        oracle: {
          expectedBehavior: "Whitespace runs collapse to one separator",
          sourceId: "task-user",
          sourceLocation: "acceptance criteria",
          rationale: "The task explicitly requires collapsed whitespace",
        },
        assertionFingerprint: "whitespace-collapse",
        requiredCapabilities: [],
        patchPath: overlayPatch,
        focusedCommand: "node --test test/target-owned.test.mjs",
        status: "submitted",
        proposedSeverity: "medium",
        checks: [],
      };
      const verifier: AttackVerifier = {
        id: "codex",
        assess: () =>
          Promise.resolve({
            relevant: true,
            oracleSupported: true,
            oracleRationale: "The acceptance criterion is explicit",
            rootDefectId: "whitespace-collapse",
            severity: "medium",
            rationale: "A realistic input violates the required normalization",
          }),
      };

      const result = await validateHouseAttack({
        attack,
        targetPatches: { a: implementationPatch },
        runSpec,
        permissionPolicy: {
          defaultMode: "confirm",
          capabilities: [],
          reducedValidationAccepted: false,
        },
        config,
        worktrees,
        verifier,
        logRoot: path.join(temporaryRoot, "logs"),
        signal: new AbortController().signal,
        knownRootDefects: new Set(),
      });

      expect(result.status).toBe("landed");
      expect(result.targets).toEqual(["a"]);
      expect(result.checks.some((check) => check.kind === "baseline")).toBe(
        false,
      );
    } finally {
      await worktrees.cleanup();
    }
  });
});
