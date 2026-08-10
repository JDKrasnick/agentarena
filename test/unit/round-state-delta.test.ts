import { describe, expect, it } from "vitest";
import type { RoundResult } from "../../src/contracts/round.js";
import {
  applyCompletedRound,
  projectRoundStateDelta,
} from "../../src/core/round-state-delta.js";
import { makeRunState } from "../helpers/run-state.js";

describe("completed round state application", () => {
  it("reproduces health history, patch metadata, attack updates, and coordinator fields", () => {
    const before = makeRunState();
    before.status = "running";
    before.stage = "preflight";
    before.warnings = [];
    before.attacks = [];
    for (const contestant of Object.values(before.contestants)) {
      contestant.status = "pending";
      contestant.finalHealth = 100;
      contestant.healthEvents = [];
      contestant.checks = [];
      contestant.rounds = [];
      contestant.patchSize = 0;
      delete contestant.initialPatchPath;
      delete contestant.currentPatchPath;
    }

    const after = structuredClone(before);
    after.stage = "validate_repairs";
    after.currentRound = 1;
    after.updatedAt = "2026-08-08T01:00:00.000Z";
    after.warnings.push("round warning");
    after.repairJudgments.push({
      version: 1,
      id: "repair-judgment-1",
      round: 1,
      canonicalDefectId: "defect-1",
      contestantId: "a",
      attemptId: "repair-attempt-1",
      patchDigest: "c".repeat(64),
      packetDigest: "d".repeat(64),
      decision: "repaired",
      rationale: "the patch fixes the immutable claim",
      adjudicationId: "adjudication-1",
      artifactRefs: ["/tmp/a-round-1.diff"],
      createdAt: "2026-08-08T00:59:00.000Z",
    });
    const contestant = after.contestants.a!;
    contestant.status = "survived";
    contestant.finalHealth = 85;
    contestant.initialPatchPath = "/tmp/a-initial.diff";
    contestant.currentPatchPath = "/tmp/a-round-1.diff";
    contestant.patchSize = 123;
    contestant.healthLedger.activeDefects = [
      { rootDefectId: "defect-1", attackId: "attack-1", damage: 15 },
    ];
    contestant.healthEvents.push({
      attackId: "attack-1",
      round: 1,
      type: "target_damage",
      amount: -15,
      reason: "fixture damage",
    });

    const delta = projectRoundStateDelta(before, after, 1);
    const result = {
      status: "completed",
      runId: before.runId,
      roundId: 1,
      resultingContestants: [
        {
          contestantId: "a",
          patch: { path: contestant.currentPatchPath, sha256: "a".repeat(64) },
          health: contestant.finalHealth,
          permanentRecoil: 0,
          activeDefects: [
            {
              defectId: "defect-1",
              attackId: "attack-1",
              severity: "medium",
              damage: 15,
            },
          ],
          replacementCredits: [],
          status: "active",
        },
        {
          contestantId: "b",
          patch: { path: "/tmp/b.diff", sha256: "b".repeat(64) },
          health: 100,
          permanentRecoil: 0,
          activeDefects: [],
          replacementCredits: [],
          status: "active",
        },
      ],
    } as unknown as RoundResult;

    const applied = structuredClone(before);
    applyCompletedRound(applied, result, delta);

    expect(applied.contestants.a).toMatchObject({
      status: "survived",
      finalHealth: 85,
      initialPatchPath: "/tmp/a-initial.diff",
      currentPatchPath: "/tmp/a-round-1.diff",
      patchSize: 123,
      healthEvents: [expect.objectContaining({ amount: -15 })],
    });
    expect(applied).toMatchObject({
      stage: "validate_repairs",
      currentRound: 1,
      warnings: ["round warning"],
      updatedAt: "2026-08-08T01:00:00.000Z",
      repairJudgments: [
        expect.objectContaining({
          id: "repair-judgment-1",
          decision: "repaired",
        }),
      ],
    });
  });
});
