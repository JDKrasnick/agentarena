import {
  FightConfigSchema,
  RunStateSchema,
  type AgentId,
  type ContestantId,
  type ContestantResult,
  type RunState,
} from "../../src/core/types.js";
import { deriveArenaOutcome } from "../../src/outcomes/derive-outcome.js";
import { collectPatchQualityFacts } from "../../src/quality/collect-facts.js";
import { selectRecommendedPatch } from "../../src/recommendation/select-patch.js";
import { buildReviewPrompt } from "../../src/review/prompt.js";
import { EFFORT_PROFILES } from "../../src/effort/policy.js";

function contestant(
  id: ContestantId,
  provider: AgentId,
  health: number,
  recoil = 0,
  activeDamage: 0 | 5 | 15 | 30 | 50 = 0,
): ContestantResult {
  return {
    id,
    provider,
    role: "solver",
    status: "survived",
    initialHealth: 100,
    finalHealth: health,
    healthLedger: {
      permanentRecoil: recoil,
      activeDefects: activeDamage
        ? [
            {
              rootDefectId: `${id}-defect`,
              attackId: `${id}-attack`,
              damage: activeDamage,
            },
          ]
        : [],
      eliminatedByRequiredCheck: false,
    },
    healthEvents: [
      ...(activeDamage
        ? [
            {
              attackId: `${id}-attack`,
              round: 1 as const,
              type: "target_damage" as const,
              amount: -activeDamage,
              reason: "test fixture",
            },
          ]
        : []),
      ...(recoil
        ? [
            {
              attackId: `${id}-miss`,
              round: 1 as const,
              type: "recoil" as const,
              amount: -recoil,
              reason: "test fixture",
            },
          ]
        : []),
    ],
    patchSize: 1,
    rounds: [],
    checks: [{ id: "final", kind: "required", status: "passed" }],
    finalPatchPath: `/tmp/${id}.diff`,
  };
}

export function makeRunState(
  options: {
    codexHealth?: number;
    claudeHealth?: number;
    codexRecoil?: number;
    claudeRecoil?: number;
    codexDamage?: 0 | 5 | 15 | 30 | 50;
    claudeDamage?: 0 | 5 | 15 | 30 | 50;
    repositoryRoot?: string;
    runDirectory?: string;
  } = {},
): RunState {
  const codex = contestant(
    "a",
    "codex",
    options.codexHealth ?? 100,
    options.codexRecoil ?? 0,
    options.codexDamage ?? 0,
  );
  const claude = contestant(
    "b",
    "claude",
    options.claudeHealth ?? 95,
    options.claudeRecoil ?? 5,
    options.claudeDamage ?? 0,
  );
  const repositoryRoot = options.repositoryRoot ?? "/tmp/repository";
  const runDirectory = options.runDirectory ?? "/tmp/run";
  codex.finalPatchPath = `${runDirectory}/patches/a.diff`;
  claude.finalPatchPath = `${runDirectory}/patches/b.diff`;
  const state = RunStateSchema.parse({
    schemaVersion: 8,
    runId: "run-12345678",
    harnessVersion: "0.1.0",
    status: "complete",
    startedAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:01:00.000Z",
    completedAt: "2026-07-29T00:01:00.000Z",
    stage: "complete",
    runSpecHash: "a".repeat(64),
    config: FightConfigSchema.parse({
      task: "Implement the fixture",
      agents: ["codex", "claude"],
      attackVerifier: "codex",
      harnessMaintainer: "codex",
      rounds: 3,
      effortMode: "medium",
      fixedRounds: true,
      resolvedEffortProfile: EFFORT_PROFILES.medium,
      maxAttacksPerRound: 3,
      infrastructureRecoveryRound: true,
      maxHeldOutCasesPerDefect: 2,
      testCommand: "npm test",
      repositoryRoot,
      artifactRoot: `${repositoryRoot}/.agent-arena/runs`,
      baseCommit: "a".repeat(40),
      permissionMode: "confirm",
      limits: {
        implementationMs: 1,
        attackMs: 1,
        verifierMs: 1,
        repairMs: 1,
      },
    }),
    contestants: { a: codex, b: claude },
    attacks: [],
    promptManifests: [],
    harnessOverlays: [],
    ranking: {
      winner: "a",
      draw: false,
      order: ["a", "b"],
      reason: "higher health",
    },
    artifacts: {
      runDirectory,
      battle: `${runDirectory}/BATTLE.md`,
      battleHtml: `${runDirectory}/BATTLE.html`,
      battleVisual: `${runDirectory}/BATTLE.svg`,
      result: `${runDirectory}/result.json`,
    },
    warnings: [],
    patchQualityFacts: {
      a: collectPatchQualityFacts({
        contestantId: "a",
        patch:
          "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+export const a = 1;\n",
      }),
      b: collectPatchQualityFacts({
        contestantId: "b",
        patch:
          "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+export const a = 2;\n",
      }),
    },
  });
  state.arenaOutcome = deriveArenaOutcome(state);
  state.patchRecommendation = selectRecommendedPatch({
    contestants: state.contestants,
    championId: "a",
    qualityVerdict: {
      version: 1,
      verdict: "patch_b",
      criteria: [],
      rationale: ["Patch B is more focused."],
    },
    anonymizationMap: { patch_a: "a", patch_b: "b" },
  });
  state.reviewPrompt = buildReviewPrompt(state);
  return state;
}
