import { describe, expect, it } from "vitest";
import {
  classifyMargin,
  deriveArenaOutcome,
} from "../../src/outcomes/derive-outcome.js";
import type { Attack, RunState } from "../../src/core/types.js";
import { makeRunState } from "../helpers/run-state.js";

function completeCoverage(state: RunState, explicitEmpty = 6): void {
  state.coverageAssessment = {
    version: 3,
    runId: state.runId,
    mode: state.config.mode,
    confidence: "full_confidence",
    requiredLanes: [],
    counts: { required: 6, completed: 6, degraded: 0, unresolved: 0 },
    evidenceCounts: {
      mechanical: 0,
      judgeConfirmed: 0,
      judgePartial: 0,
      judgeRejected: 0,
      explicitEmpty,
    },
    reasonCodes: [],
    retryHistory: [],
    assessmentDigest: "c".repeat(64),
  };
}

function landing(state: RunState, overrides: Partial<Attack> = {}): Attack {
  return {
    id: "landing-1",
    round: 1,
    origin: { kind: "contestant", contestant: "a", provider: "codex" },
    rank: 1,
    targets: ["b"],
    claim: "A verified differential defect",
    impact: "Incorrect behavior",
    oracle: {
      expectedBehavior: "Correct behavior",
      rationale: "The frozen contract requires it",
    },
    assertionFingerprint: "differential-defect",
    requiredCapabilities: [],
    patchPath: `${state.artifacts.runDirectory}/attacks/landing.diff`,
    focusedCommand: "npm test",
    status: "landed",
    severity: "low",
    damage: 5,
    damageActive: false,
    rootDefectId: "differential-defect",
    checks: [],
    ...overrides,
  };
}

describe("arena outcome", () => {
  it.each([
    [0, "tied"],
    [5, "razor_thin"],
    [10, "narrow"],
    [15, "clear"],
  ] as const)("classifies a %i HP margin as %s", (margin, expected) => {
    expect(classifyMargin(margin)).toBe(expected);
  });

  it("explains a 100–95 recoil-only result", () => {
    const outcome = deriveArenaOutcome(makeRunState());
    expect(outcome).toMatchObject({
      championId: "a",
      marginHp: 5,
      marginClass: "razor_thin",
      decidingFactors: ["recoil"],
    });
    expect(outcome.contestants.b).toMatchObject({
      grossDamageReceived: 0,
      grossHealing: 0,
      activeDefectDamage: 0,
      permanentRecoil: 5,
    });
  });

  it("does not manufacture a champion from a recoil-only margin after complete non-differentiating coverage", () => {
    const state = makeRunState();
    completeCoverage(state);

    const outcome = deriveArenaOutcome(state);
    expect(outcome).toMatchObject({
      version: 2,
      kind: "non_discriminating",
      decisionBasis: "no_differentiator",
      marginHp: 5,
      competitiveLandingCount: 0,
      sharedDefectCount: 0,
      explicitEmptyLaneCount: 6,
    });
    expect(outcome).not.toHaveProperty("championId");
  });

  it("applies the same successful classification to catch-up coverage", () => {
    const state = makeRunState();
    state.config.mode = "catch_up";
    completeCoverage(state);
    state.coverageAssessment!.mode = "catch_up";

    expect(deriveArenaOutcome(state)).toMatchObject({
      kind: "non_discriminating",
      decisionBasis: "no_differentiator",
    });
  });

  it("never classifies siege as non-discriminating", () => {
    const state = makeRunState();
    state.config.mode = "siege";
    completeCoverage(state);
    state.coverageAssessment!.mode = "siege";

    expect(deriveArenaOutcome(state).kind).toBe("winner");
  });

  it("keeps repaired neutral QA findings as shared evidence without creating a champion", () => {
    const state = makeRunState();
    completeCoverage(state, 5);
    state.attacks = [
      landing(state, {
        id: "house-1",
        origin: { kind: "house", methodPackId: "neutral-qa" },
        targets: ["a", "b"],
        rootDefectId: "shared-regression",
      }),
    ];

    const outcome = deriveArenaOutcome(state);
    expect(outcome).toMatchObject({
      kind: "non_discriminating",
      competitiveLandingCount: 0,
      sharedDefectCount: 1,
      explicitEmptyLaneCount: 5,
    });
    expect(outcome).not.toHaveProperty("championId");
  });

  it("withholds a champion while either shared repair target remains unresolved", () => {
    const state = makeRunState();
    completeCoverage(state, 5);
    const shared = landing(state, {
      id: "shared-1",
      status: "shared_defect",
      targets: ["a", "b"],
      rootDefectId: "shared-regression",
      sharedRepairStatus: { a: "repaired", b: "active" },
    });
    state.attacks = [shared];

    expect(deriveArenaOutcome(state)).toMatchObject({
      kind: "draw",
      competitiveLandingCount: 0,
      sharedDefectCount: 1,
    });
    expect(deriveArenaOutcome(state)).not.toHaveProperty("championId");

    shared.sharedRepairStatus = { a: "repaired", b: "repaired" };
    expect(deriveArenaOutcome(state)).toMatchObject({
      kind: "non_discriminating",
      competitiveLandingCount: 0,
      sharedDefectCount: 1,
    });
  });

  it("keeps a canonical shared defect unresolved while any sibling reproducer remains active", () => {
    const state = makeRunState();
    completeCoverage(state, 4);
    const activeSibling = landing(state, {
      id: "shared-active",
      status: "shared_defect",
      targets: ["a", "b"],
      rootDefectId: "shared-regression",
      sharedRepairStatus: { a: "active", b: "active" },
    });
    const repairedSibling = landing(state, {
      id: "shared-repaired",
      status: "shared_defect",
      targets: ["a", "b"],
      rootDefectId: "shared-regression",
      sharedRepairStatus: { a: "repaired", b: "repaired" },
    });
    state.attacks = [activeSibling, repairedSibling];

    expect(deriveArenaOutcome(state)).toMatchObject({
      kind: "draw",
      competitiveLandingCount: 0,
      sharedDefectCount: 1,
    });
  });

  it("preserves an ordinary competitive result when a contestant landing remains valid even after repair", () => {
    const state = makeRunState();
    completeCoverage(state, 5);
    state.attacks = [landing(state)];

    expect(deriveArenaOutcome(state)).toMatchObject({
      kind: "winner",
      championId: "a",
      decisionBasis: "competitive_evidence",
      competitiveLandingCount: 1,
    });
  });

  it("preserves a real draw when competitive evidence exists but the final ranking is tied", () => {
    const state = makeRunState({ claudeHealth: 100, claudeRecoil: 0 });
    completeCoverage(state, 5);
    state.attacks = [landing(state)];
    state.ranking = {
      winner: null,
      draw: true,
      order: ["a", "b"],
      reason: "equal competitive result",
    };

    const outcome = deriveArenaOutcome(state);
    expect(outcome).toMatchObject({
      kind: "draw",
      competitiveLandingCount: 1,
    });
    expect(outcome).not.toHaveProperty("championId");
  });

  it("does not claim a non-discriminating result while required coverage has a gap", () => {
    const state = makeRunState();
    completeCoverage(state, 5);
    state.coverageAssessment!.counts = {
      required: 6,
      completed: 5,
      degraded: 0,
      unresolved: 1,
    };

    expect(deriveArenaOutcome(state).kind).toBe("winner");
  });

  it("excludes a later-overturned landing and an affirming duplicate from competitive evidence", () => {
    const state = makeRunState();
    completeCoverage(state, 4);
    const original = landing(state, {
      id: "original",
      adjudication: {
        version: 1,
        id: "adjudication-original",
        verdict: "valid",
        canonicalDefectId: "differential-defect",
        severity: "low",
        rationale: "Initially accepted",
        evidenceBasis: "mechanical",
        duplicateState: "unique",
        retryArtifactRefs: [],
        diagnosticArtifactRefs: [],
        multiplier: 1,
        scoreEffect: "damage",
        exactAmount: 5,
        relationship: "independent",
      },
    });
    const overturn = landing(state, {
      id: "overturn",
      round: 2,
      status: "judge_rejected",
      adjudication: {
        version: 1,
        id: "adjudication-overturn",
        verdict: "rejected",
        rejectionBasis: "semantic",
        rationale: "The original claim was overturned",
        evidenceBasis: "judge",
        duplicateState: "unique",
        retryArtifactRefs: [],
        diagnosticArtifactRefs: [],
        multiplier: 0,
        scoreEffect: "none",
        exactAmount: 0,
        relationship: "overturn",
        priorAdjudicationId: "adjudication-original",
        supersedesAdjudicationId: "adjudication-original",
      },
    });
    const affirmation = landing(state, {
      id: "affirmation",
      round: 2,
      adjudication: {
        version: 1,
        id: "adjudication-affirmation",
        verdict: "valid",
        canonicalDefectId: "differential-defect",
        severity: "low",
        rationale: "Duplicate affirmation",
        evidenceBasis: "judge",
        duplicateState: "corroborating",
        retryArtifactRefs: [],
        diagnosticArtifactRefs: [],
        multiplier: 1,
        scoreEffect: "none",
        exactAmount: 0,
        relationship: "affirm",
        priorAdjudicationId: "adjudication-original",
      },
    });
    state.attacks = [original, overturn, affirmation];

    expect(deriveArenaOutcome(state)).toMatchObject({
      kind: "non_discriminating",
      competitiveLandingCount: 0,
    });
  });
});
