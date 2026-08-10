import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyJudgeVerdict,
  suppressKnownJudgeDefect,
} from "../../src/attacks/adjudicate.js";
import { ArtifactStore } from "../../src/artifacts/store.js";
import { resolveCoverage } from "../../src/commands/resolve-coverage.js";
import {
  assessBattleCoverage,
  assertTargetedRetryAllowed,
  coverageAllowsPatchReview,
  createCoverageDecision,
  requiredCoverageLanes,
} from "../../src/confidence/assessment.js";
import { healDefect, resolveRound } from "../../src/core/scoring.js";
import type {
  AgentInvocation,
  Attack,
  ContestantResult,
  RunState,
} from "../../src/core/types.js";
import { RunStateV6Schema } from "../../src/core/types.js";
import { makeRunState } from "../helpers/run-state.js";
import { reviewRun } from "../../src/review/service.js";

function invocation(status: AgentInvocation["status"]): AgentInvocation {
  return {
    agent: "codex",
    stage: "collect_attacks",
    startedAt: "2026-08-09T00:00:00.000Z",
    finishedAt: "2026-08-09T00:00:01.000Z",
    durationMs: 1000,
    status,
    promptPath: "/tmp/prompt",
    transcriptPath: "/tmp/transcript",
  };
}

function addLaneRecords(state: RunState, timeoutCount = 0): void {
  requiredCoverageLanes(state.config.mode).forEach((lane, index) => {
    state.reviewInvocations.push({
      round: lane.round,
      reviewer: lane.attacker,
      target: lane.target,
      invocation: invocation("succeeded"),
      submissionStatus: "submitted",
      findingCount: 0,
      parseOutcome: "valid_empty",
    });
    const timedOut = index < timeoutCount;
    state.attackInvocations.push({
      round: lane.round,
      attacker: lane.attacker,
      target: lane.target,
      invocation: invocation(timedOut ? "timed_out" : "succeeded"),
      submissionStatus: timedOut ? "not_run" : "submitted",
      attackCount: 0,
      ...(timedOut ? {} : { parseOutcome: "valid_empty" as const }),
    });
  });
}

function baseAttack(): Attack {
  return {
    id: "judge-attack",
    round: 1,
    origin: { kind: "contestant", contestant: "a", provider: "codex" },
    rank: 1,
    targets: ["b"],
    claim: "wrong behavior",
    impact: "incorrect result",
    oracle: {
      expectedBehavior: "specified behavior",
      rationale: "the task says so",
    },
    assertionFingerprint: "fingerprint",
    requiredCapabilities: [],
    patchPath: "/tmp/attack.diff",
    focusedCommand: "npm test",
    status: "submitted",
    checks: [],
  };
}

function contestant(id: "a" | "b"): ContestantResult {
  return {
    id,
    provider: id === "a" ? "codex" : "claude",
    role: "solver",
    status: "survived",
    initialHealth: 100,
    finalHealth: 100,
    replacementCredits: [],
    healthLedger: {
      permanentRecoil: 0,
      activeDefects: [],
      eliminatedByRequiredCheck: false,
    },
    healthEvents: [],
    patchSize: 1,
    rounds: [],
    checks: [],
  };
}

function addRepairAttempts(
  state: RunState,
  target: "a" | "b",
  round: 1 | 2 | 3,
  statuses: AgentInvocation["status"][],
): void {
  const attempts = statuses.map(invocation);
  state.contestants[target]!.rounds.push({
    round,
    startingHealth: 100,
    submittedAttackIds: [],
    postAttackHealth: 95,
    postAttackStatus: "active",
    repair: attempts.at(-1),
    repairAttempts: attempts,
    endingHealth: 100,
    endingStatus: "active",
  });
}

describe("coverage assessment", () => {
  it("requires six duel/catch-up lanes, three siege lanes, and ignores house", () => {
    expect(requiredCoverageLanes("duel")).toHaveLength(6);
    expect(requiredCoverageLanes("catch_up")).toHaveLength(6);
    expect(requiredCoverageLanes("siege")).toEqual([
      { round: 1, attacker: "a", target: "b" },
      { round: 2, attacker: "a", target: "b" },
      { round: 3, attacker: "a", target: "b" },
    ]);
  });

  it("treats explicit empty submissions as complete coverage", () => {
    const state = makeRunState();
    addLaneRecords(state);
    const assessment = assessBattleCoverage(state);
    expect(assessment.confidence).toBe("full_confidence");
    expect(assessment.counts).toEqual({
      required: 6,
      completed: 6,
      degraded: 0,
      unresolved: 0,
    });
    expect(assessment.requiredLanes[0]?.stages.slice(2)).toSatisfy(
      (stages: Array<{ finalState: string }>) =>
        stages.every((entry) => entry.finalState === "not_applicable"),
    );
  });

  it("reproduces four missing terminal lanes as a provisional result", () => {
    const state = makeRunState();
    addLaneRecords(state, 4);
    const assessment = assessBattleCoverage(state);
    expect(assessment.confidence).toBe("provisional");
    expect(assessment.counts.unresolved).toBe(4);
    expect(assessment.counts.completed).toBe(2);
    expect(coverageAllowsPatchReview({ coverageAssessment: assessment })).toBe(
      false,
    );
    const decision = createCoverageDecision({
      runId: state.runId,
      assessmentDigest: assessment.assessmentDigest,
      decision: "accept-reduced",
      decidedAt: "2026-08-09T00:00:00.000Z",
    });
    expect(
      coverageAllowsPatchReview({
        coverageAssessment: assessment,
        coverageDecision: decision,
      }),
    ).toBe(true);
  });

  it("prevents stacked retries for the same failure", () => {
    expect(() => assertTargetedRetryAllowed(1)).not.toThrow();
    expect(() => assertTargetedRetryAllowed(2)).toThrow(/exhausted/);
  });

  it("records targeted retry success and exhaustion without a third attempt", () => {
    const recovered = makeRunState();
    addLaneRecords(recovered, 1);
    recovered.attackInvocations.push({
      round: 1,
      attacker: "a",
      target: "b",
      invocation: invocation("succeeded"),
      submissionStatus: "submitted",
      attackCount: 0,
      parseOutcome: "valid_empty",
    });
    const recoveredAssessment = assessBattleCoverage(recovered);
    expect(recoveredAssessment.requiredLanes[0]?.finalState).toBe("completed");
    expect(recoveredAssessment.retryHistory).toContainEqual(
      expect.objectContaining({
        laneId: "round-1:a->b",
        stage: "focused_description",
        result: "succeeded",
      }),
    );

    const exhausted = makeRunState();
    addLaneRecords(exhausted, 1);
    exhausted.attackInvocations.push({
      round: 1,
      attacker: "a",
      target: "b",
      invocation: invocation("timed_out"),
      submissionStatus: "not_run",
      attackCount: 0,
    });
    // A third record is ignored by the two-attempt coverage contract.
    exhausted.attackInvocations.push({
      round: 1,
      attacker: "a",
      target: "b",
      invocation: invocation("succeeded"),
      submissionStatus: "submitted",
      attackCount: 0,
      parseOutcome: "valid_empty",
    });
    const exhaustedAssessment = assessBattleCoverage(exhausted);
    expect(exhaustedAssessment.requiredLanes[0]?.finalState).toBe("unresolved");
    expect(
      exhaustedAssessment.requiredLanes[0]?.stages.find(
        (entry) => entry.stage === "focused_description",
      )?.attempts,
    ).toHaveLength(2);
  });

  it("distinguishes a degraded sibling path and required capability gaps", () => {
    const state = makeRunState();
    addLaneRecords(state);
    state.attackInvocations[0]!.parseOutcome = "valid";
    state.attackInvocations[0]!.attackCount = 2;
    state.attacks.push({
      ...baseAttack(),
      status: "landed",
      rootDefectId: "partial-root",
      severity: "low",
      damage: 2.5,
      evidenceProvenance: "judge_partial",
    });
    addRepairAttempts(state, "b", 1, ["succeeded"]);
    const assessment = assessBattleCoverage(state, {
      defaultMode: "confirm",
      reducedValidationAccepted: true,
      capabilities: [
        {
          id: "required_service",
          reason: "integration contract",
          risk: "medium",
          requirement: "required",
          role: "harness_only",
          enforcement: "brokered",
          mode: "deny",
          scopes: [],
          status: "denied",
        },
      ],
    });
    expect(assessment.confidence).toBe("reduced_confidence");
    expect(assessment.counts).toMatchObject({ degraded: 1, unresolved: 0 });
    expect(assessment.reasonCodes).toEqual(
      expect.arrayContaining([
        "judge_partial_35_percent_damage",
        "submitted_path_lost",
        "required_capability_gap_accepted",
      ]),
    );
  });

  it("requires usable repair evidence after landed damage", () => {
    const missing = makeRunState();
    addLaneRecords(missing);
    missing.attackInvocations[0]!.parseOutcome = "valid";
    missing.attackInvocations[0]!.attackCount = 1;
    missing.attacks.push({
      ...baseAttack(),
      status: "landed",
      rootDefectId: "repair-root",
      severity: "low",
      damage: 5,
      damageActive: true,
      evidenceProvenance: "mechanical",
    });
    const missingAssessment = assessBattleCoverage(missing);
    expect(missingAssessment.confidence).toBe("provisional");
    expect(missingAssessment.requiredLanes[0]?.finalState).toBe("unresolved");
    expect(missingAssessment.requiredLanes[0]?.reasonCodes).toContain(
      "repair_missing",
    );

    const retried = structuredClone(missing);
    addRepairAttempts(retried, "b", 1, ["timed_out", "succeeded"]);
    const retriedAssessment = assessBattleCoverage(retried);
    expect(retriedAssessment.confidence).toBe("full_confidence");
    expect(retriedAssessment.retryHistory).toContainEqual({
      laneId: "round-1:a->b",
      stage: "repair",
      result: "succeeded",
    });
  });

  it("records all three v2 repair attempts and leaves an unable judge repair unresolved", () => {
    const state = RunStateV6Schema.parse({
      ...makeRunState(),
      schemaVersion: 6,
    });
    addLaneRecords(state);
    state.attackInvocations[0]!.parseOutcome = "valid";
    state.attackInvocations[0]!.attackCount = 1;
    state.attacks.push({
      ...baseAttack(),
      status: "landed",
      rootDefectId: "repair-root",
      severity: "high",
      damage: 30,
      damageActive: true,
      evidenceProvenance: "judge_confirmed",
    });
    addRepairAttempts(state, "b", 1, ["succeeded", "succeeded", "succeeded"]);
    state.repairJudgments.push({
      version: 1,
      id: "repair-judgment-1",
      round: 1,
      canonicalDefectId: "repair-root",
      contestantId: "b",
      attemptId: "repair-attempt-3",
      patchDigest: "a".repeat(64),
      packetDigest: "b".repeat(64),
      decision: "unable",
      rationale: "insufficient bounded evidence",
      adjudicationId: "adjudication-1",
      artifactRefs: [],
      createdAt: "2026-08-09T00:00:00.000Z",
    });

    const assessment = assessBattleCoverage(state);
    const repair = assessment.requiredLanes[0]?.stages.find(
      (entry) => entry.stage === "repair",
    );
    expect(repair?.attempts.map((entry) => entry.attempt)).toEqual([1, 2, 3]);
    expect(repair?.finalState).toBe("failed");
    expect(assessment.requiredLanes[0]?.finalState).toBe("unresolved");
    expect(assessment.requiredLanes[0]?.reasonCodes).toContain(
      "repair_judge_unable",
    );
  });

  it("does not reuse correction evidence across rounds", () => {
    const state = makeRunState();
    addLaneRecords(state);
    const roundTwo = state.attackInvocations.find(
      (entry) =>
        entry.round === 2 && entry.attacker === "a" && entry.target === "b",
    )!;
    roundTwo.invocation = invocation("timed_out");
    delete roundTwo.parseOutcome;
    roundTwo.submissionStatus = "not_run";
    state.attackInvocations.push({
      round: 1,
      attacker: "a",
      target: "b",
      invocation: invocation("succeeded"),
      submissionStatus: "submitted",
      attackCount: 1,
      parseOutcome: "valid",
      detail: "Correction-only reconciliation lane",
    });
    state.attacks.push({
      ...baseAttack(),
      id: "round-two-blocked",
      round: 2,
      status: "blocked",
    });
    const assessment = assessBattleCoverage(state);
    const roundTwoLane = assessment.requiredLanes.find(
      (lane) => lane.id === "round-2:a->b",
    );
    expect(roundTwoLane?.finalState).toBe("unresolved");
    expect(roundTwoLane?.reasonCodes).toContain("focused_description_failed");
  });

  it("keeps evidence-count categories mutually exclusive", () => {
    const state = makeRunState();
    addLaneRecords(state);
    state.attacks.push(
      { ...baseAttack(), id: "blocked", status: "blocked" },
      { ...baseAttack(), id: "rejected", status: "judge_rejected" },
      { ...baseAttack(), id: "unable", status: "judge_unable" },
    );
    const assessment = assessBattleCoverage(state);
    expect(assessment.evidenceCounts).toMatchObject({
      mechanical: 1,
      judgeRejected: 1,
    });
  });

  it("binds an inconclusive decision to the assessment digest and keeps patch review blocked", async () => {
    const repositoryRoot = await mkdtemp(
      path.join(os.tmpdir(), "arena-coverage-decision-"),
    );
    const artifactRoot = path.join(repositoryRoot, ".agent-arena", "runs");
    const runDirectory = path.join(artifactRoot, "run-12345678");
    const state = makeRunState({ repositoryRoot, runDirectory });
    addLaneRecords(state, 4);
    state.coverageAssessment = assessBattleCoverage(state);
    delete state.patchRecommendation;
    delete state.reviewPrompt;
    if (state.arenaOutcome) delete state.arenaOutcome.championId;
    const store = new ArtifactStore(artifactRoot, state.runId);
    await store.initialize();
    await store.writeState(state);
    await expect(
      resolveCoverage({
        runId: state.runId,
        repositoryRoot,
        assessmentDigest: "f".repeat(64),
        decision: "inconclusive",
      }),
    ).rejects.toThrow(/stale/);
    const decision = await resolveCoverage({
      runId: state.runId,
      repositoryRoot,
      assessmentDigest: state.coverageAssessment.assessmentDigest,
      decision: "inconclusive",
      now: new Date("2026-08-09T00:00:00.000Z"),
    });
    const resolvedState = await store.readState();
    expect(resolvedState).toMatchObject({
      status: "inconclusive",
      ranking: { winner: null, draw: false },
    });
    expect(
      await resolveCoverage({
        runId: state.runId,
        repositoryRoot,
        assessmentDigest: state.coverageAssessment.assessmentDigest,
        decision: "inconclusive",
      }),
    ).toEqual(decision);
    await expect(
      reviewRun({ runId: state.runId, repositoryRoot }),
    ).rejects.toThrow(/blocked/);
  });
});

describe("judge adjudication and quarter-point scoring", () => {
  it("applies and exactly heals supported-but-untestable 35% damage", () => {
    const attack = applyJudgeVerdict(baseAttack(), {
      decision: "supported_untestable",
      relevant: true,
      expectedBehaviorClearlySupported: true,
      evidencePointsToDefect: true,
      rootDefectId: "root",
      severity: "medium",
      rationale: "evidence points to the defect",
    });
    expect(attack).toMatchObject({
      status: "landed",
      damage: 5.25,
      evidenceProvenance: "judge_partial",
    });
    const resolved = resolveRound(
      { a: contestant("a"), b: contestant("b") },
      [attack],
      1,
    );
    expect(resolved.contestants.b?.finalHealth).toBe(94.75);
    expect(healDefect(resolved.contestants.b!, "root", 1).finalHealth).toBe(
      100,
    );
  });

  it("uses normal recoil for a merits rejection and none when unable", () => {
    const rejected = applyJudgeVerdict(baseAttack(), {
      decision: "rejected",
      relevant: true,
      expectedBehaviorClearlySupported: false,
      evidencePointsToDefect: false,
      rationale: "claim fails on the merits",
    });
    const unable = applyJudgeVerdict(
      { ...baseAttack(), id: "unable" },
      {
        decision: "unable",
        relevant: true,
        expectedBehaviorClearlySupported: false,
        evidencePointsToDefect: false,
        rationale: "insufficient evidence",
      },
    );
    const result = resolveRound(
      { a: contestant("a"), b: contestant("b") },
      [rejected, unable],
      1,
    );
    expect(result.contestants.a?.healthLedger.permanentRecoil).toBe(5);
    expect(result.contestants.b?.finalHealth).toBe(100);
  });

  it("requires both guard conditions for partial damage and preserves full judge damage", () => {
    const guarded = applyJudgeVerdict(baseAttack(), {
      decision: "supported_untestable",
      relevant: true,
      expectedBehaviorClearlySupported: true,
      evidencePointsToDefect: false,
      rootDefectId: "root",
      severity: "critical",
      rationale: "ambiguous evidence",
    });
    expect(guarded.status).toBe("judge_unable");
    const confirmed = applyJudgeVerdict(baseAttack(), {
      decision: "confirmed",
      relevant: true,
      expectedBehaviorClearlySupported: true,
      evidencePointsToDefect: true,
      rootDefectId: "root",
      severity: "critical",
      rationale: "definitive semantic evidence",
    });
    expect(confirmed).toMatchObject({
      status: "landed",
      damage: 50,
      evidenceProvenance: "judge_confirmed",
    });
  });

  it("suppresses duplicate root defects returned by judge fallback", () => {
    const confirmed = applyJudgeVerdict(baseAttack(), {
      decision: "confirmed",
      relevant: true,
      expectedBehaviorClearlySupported: true,
      evidencePointsToDefect: true,
      rootDefectId: "known-root",
      severity: "critical",
      rationale: "same canonical defect",
    });
    expect(
      suppressKnownJudgeDefect(confirmed, new Set(["known-root"])),
    ).toMatchObject({
      status: "duplicate",
      damageActive: false,
      rootDefectId: "known-root",
      adjudication: { duplicateState: "corroborating", scoreEffect: "none" },
    });
  });
});
