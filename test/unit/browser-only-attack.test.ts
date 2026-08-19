import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it, vi } from "vitest";
import { browserProbeEvidencePatch } from "../../src/attacks/submission.js";
import { validateAttack } from "../../src/attacks/validate.js";
import type { AttackVerifier } from "../../src/agents/adapter.js";
import {
  AttackSubmissionV2Schema,
  FightConfigSchema,
  type Attack,
} from "../../src/core/types.js";
import type {
  BrowserProbeRequest,
  BrowserValidationResult,
} from "../../src/contracts/browser.js";
import { WorktreeManager } from "../../src/repo/git.js";
import { createSlugRepository } from "../helpers/repository.js";

describe("browser-only attacks", () => {
  it("lands only after a symmetric author pass and target failure", async () => {
    const repositoryRoot = await createSlugRepository();
    const baseCommit = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
    ).stdout;
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "arena-browser-only-"),
    );
    const worktrees = new WorktreeManager(
      repositoryRoot,
      temporaryRoot,
      baseCommit,
    );
    await worktrees.initialize();

    try {
      const patches: string[] = [];
      for (const lane of ["author", "target"] as const) {
        const tree = await worktrees.create(lane);
        const relativePath = `src/${lane}.txt`;
        await mkdir(path.dirname(path.join(tree, relativePath)), {
          recursive: true,
        });
        await writeFile(path.join(tree, relativePath), `${lane}\n`);
        const patchPath = path.join(temporaryRoot, `${lane}.diff`);
        await worktrees.capturePatch(tree, patchPath, undefined, true);
        patches.push(patchPath);
      }
      const [authorPatch, targetPatch] = patches as [string, string];
      const evidenceEntry = AttackSubmissionV2Schema.parse({
        version: 2,
        attacks: [
          {
            rank: 1,
            claim: "The settings dialog does not open",
            impact: "The user cannot change settings",
            oracle: {
              expectedBehavior: "The settings dialog opens",
              rationale: "The task explicitly requires the dialog",
            },
            proposedSeverity: "medium",
            confidence: 90,
            reproduction: "Open the settings dialog in the browser",
            requiredCapabilities: ["browser_dom_validation"],
            browserProbe: {
              id: "settings-dialog",
              family: "interaction",
              profile: "desktop",
              expectedBehavior: "The settings dialog opens",
              actions: [{ kind: "goto", path: "/" }],
            },
          },
        ],
      }).attacks[0]!;
      const probePatch = path.join(temporaryRoot, "probe.diff");
      await writeFile(
        probePatch,
        browserProbeEvidencePatch(evidenceEntry, 1, "a"),
      );
      const config = FightConfigSchema.parse({
        task: "Fix the dialog",
        agents: ["codex", "claude"],
        attackVerifier: "codex",
        rounds: 3,
        maxAttacksPerRound: 3,
        testCommand: "npm test",
        repositoryRoot,
        artifactRoot: path.join(repositoryRoot, ".agent-arena", "runs"),
        permissionMode: "confirm",
        nonInteractiveApproval: true,
        limits: {
          implementationMs: 10_000,
          reviewMs: 10_000,
          attackMs: 10_000,
          verifierMs: 10_000,
          repairMs: 10_000,
        },
      });
      const attack: Attack = {
        id: "browser-only-dialog",
        round: 1,
        origin: { kind: "contestant", contestant: "a", provider: "codex" },
        rank: 1,
        targets: ["b"],
        claim: "The settings dialog does not open",
        impact: "The user cannot change settings",
        oracle: {
          expectedBehavior: "The settings dialog opens",
          rationale: "The task explicitly requires the dialog",
        },
        assertionFingerprint: "settings-dialog-opens",
        requiredCapabilities: ["browser_dom_validation"],
        patchPath: probePatch,
        focusedCommand: 'node -e "process.exit(0)"',
        evidenceKind: "browser_probe",
        browserProbe: evidenceEntry.browserProbe,
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
            oracleRationale: "The behavior is explicit",
            rootDefectId: "settings-dialog",
            severity: "medium",
            rationale: "The comparative browser evidence is deterministic",
          }),
      };
      const validateBrowser = vi.fn(
        (
          _worktree: string,
          _probe: BrowserProbeRequest,
          subject: "author" | "target",
          _nativeSuiteIdentityPaths: string[],
        ): Promise<BrowserValidationResult> => {
          void _nativeSuiteIdentityPaths;
          return Promise.resolve({
            status: subject === "author" ? "verified" : "failed",
            provisionAttempts: 1,
            probes: [],
            artifacts: [],
            ...(subject === "target"
              ? {
                  reason: "application_failure" as const,
                  failureAttribution: "contestant_application" as const,
                }
              : {}),
          });
        },
      );

      const result = await validateAttack({
        attack,
        authorPatch,
        targetPatch,
        runSpec: {} as never,
        permissionPolicy: {
          defaultMode: "confirm",
          reducedValidationAccepted: false,
          capabilities: [
            {
              id: "browser_dom_validation",
              reason: "Browser comparison",
              risk: "medium",
              requirement: "required",
              role: "harness_only",
              enforcement: "brokered",
              mode: "confirm",
              scopes: [],
              status: "approved",
            },
          ],
        },
        config,
        worktrees,
        verifier,
        validateBrowser,
        logRoot: path.join(temporaryRoot, "logs"),
        signal: new AbortController().signal,
        knownRootDefects: new Set(),
      });

      expect(result.status).toBe("landed");
      expect(result.evidenceKind).toBe("browser_probe");
      expect(validateBrowser).toHaveBeenCalledTimes(2);
    } finally {
      await worktrees.cleanup();
    }
  });
});
