import { describe, expect, it } from "vitest";
import type { Attack } from "../../src/core/types.js";
import {
  isCompetitiveQualityTie,
  selectRecommendedPatch,
} from "../../src/recommendation/select-patch.js";
import { makeRunState } from "../helpers/run-state.js";

describe("recommended patch selection", () => {
  it("can recommend the cleaner 95 HP patch when the margin is recoil only", () => {
    const state = makeRunState();
    expect(
      selectRecommendedPatch({
        contestants: state.contestants,
        championId: "a",
        qualityVerdict: {
          version: 1,
          verdict: "patch_b",
          criteria: [],
          rationale: ["Patch B is cleaner."],
        },
        anonymizationMap: { patch_a: "a", patch_b: "b" },
      }),
    ).toMatchObject({
      contestantId: "b",
      reason: "implementation_quality",
    });
  });

  it("prefers less active defect damage before quality", () => {
    const state = makeRunState({
      codexHealth: 85,
      codexDamage: 15,
      claudeHealth: 95,
      claudeRecoil: 5,
    });
    expect(
      selectRecommendedPatch({
        contestants: state.contestants,
        championId: "b",
        outcomeKind: "non_discriminating",
        qualityVerdict: {
          version: 1,
          verdict: "patch_a",
          criteria: [],
          rationale: [],
        },
        anonymizationMap: { patch_a: "a", patch_b: "b" },
      }),
    ).toMatchObject({ contestantId: "b", reason: "correctness" });
  });

  it("does not recommend a patch that failed required browser validation", () => {
    const state = makeRunState();
    state.contestants.a!.checks.push({
      id: "final-browser-required",
      kind: "required",
      status: "failed",
      reason: "application_failure",
    });

    const recommendation = selectRecommendedPatch({
      contestants: state.contestants,
      championId: "a",
      qualityVerdict: {
        version: 1,
        verdict: "patch_a",
        criteria: [],
        rationale: ["The verifier preferred the now-ineligible patch."],
      },
      anonymizationMap: { patch_a: "a", patch_b: "b" },
    });

    expect(recommendation).toMatchObject({ contestantId: "b" });
    expect(
      recommendation.comparison.find(
        (candidate) => candidate.contestantId === "a",
      ),
    ).toMatchObject({
      eligible: false,
      requiredValidationPassed: false,
    });
  });

  it("excludes only contestants with unresolved shared repair targets", () => {
    const state = makeRunState();
    state.attacks = [
      {
        id: "shared-1",
        round: 1,
        origin: { kind: "contestant", contestant: "a", provider: "codex" },
        rank: 1,
        targets: ["a", "b"],
        claim: "A common-mode regression",
        impact: "Both patches violate the contract",
        oracle: {
          expectedBehavior: "The shared case passes",
          rationale: "The task requires this behavior",
        },
        assertionFingerprint: "shared-regression",
        requiredCapabilities: [],
        patchPath: "/tmp/shared.diff",
        focusedCommand: "npm test -- shared",
        status: "shared_defect",
        rootDefectId: "shared-regression",
        sharedRepairStatus: { a: "repaired", b: "active" },
        checks: [],
      },
    ];

    const recommendation = selectRecommendedPatch({
      contestants: state.contestants,
      attacks: state.attacks,
      championId: "b",
    });

    expect(recommendation).toMatchObject({
      contestantId: "a",
      reason: "correctness",
    });
    expect(recommendation.comparison).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contestantId: "a", eligible: true }),
        expect.objectContaining({ contestantId: "b", eligible: false }),
      ]),
    );

    state.attacks[0]!.sharedRepairStatus = { a: "active", b: "active" };
    expect(
      selectRecommendedPatch({
        contestants: state.contestants,
        attacks: state.attacks,
      }),
    ).toMatchObject({ reason: "inconclusive" });
  });

  it("does not let a repaired sibling hide an active canonical shared reproducer", () => {
    const state = makeRunState();
    const shared: Attack = {
      id: "shared-active",
      round: 1,
      origin: { kind: "contestant", contestant: "a", provider: "codex" },
      rank: 1,
      targets: ["a", "b"],
      claim: "A common-mode regression",
      impact: "Both patches violate the contract",
      oracle: {
        expectedBehavior: "The shared case passes",
        rationale: "The task requires this behavior",
      },
      assertionFingerprint: "shared-regression",
      requiredCapabilities: [],
      patchPath: "/tmp/shared.diff",
      focusedCommand: "npm test -- shared",
      status: "shared_defect",
      rootDefectId: "shared-regression",
      sharedRepairStatus: { a: "active", b: "active" },
      checks: [],
    };
    state.attacks = [
      shared,
      {
        ...shared,
        id: "shared-repaired",
        sharedRepairStatus: { a: "repaired", b: "repaired" },
      },
    ];

    expect(
      selectRecommendedPatch({
        contestants: state.contestants,
        attacks: state.attacks,
      }),
    ).toMatchObject({ reason: "inconclusive" });
  });

  it("can independently recommend the better implementation after a non-discriminating battle", () => {
    const state = makeRunState();
    expect(
      selectRecommendedPatch({
        contestants: state.contestants,
        outcomeKind: "non_discriminating",
        qualityVerdict: {
          version: 1,
          verdict: "patch_b",
          criteria: [],
          rationale: ["Patch B has the cleaner boundary."],
        },
        anonymizationMap: { patch_a: "a", patch_b: "b" },
      }),
    ).toMatchObject({
      contestantId: "b",
      reason: "implementation_quality",
    });
  });

  it.each(["equivalent", "inconclusive"] as const)(
    "does not use patch size to break a non-discriminating %s quality verdict",
    (verdict) => {
      const state = makeRunState();
      state.contestants.a!.patchSize = 1;
      state.contestants.b!.patchSize = 100;

      const recommendation = selectRecommendedPatch({
        contestants: state.contestants,
        outcomeKind: "non_discriminating",
        qualityVerdict: {
          version: 1,
          verdict,
          criteria: [],
          rationale: ["No decisive quality difference."],
        },
        anonymizationMap: { patch_a: "a", patch_b: "b" },
      });
      expect(recommendation).toMatchObject({
        reason: "no_differentiator",
      });
      expect(recommendation).not.toHaveProperty("contestantId");
    },
  );

  it("returns no recommendation when a non-discriminating battle has no verifier", () => {
    const state = makeRunState();
    const recommendation = selectRecommendedPatch({
      contestants: state.contestants,
      outcomeKind: "non_discriminating",
    });
    expect(recommendation).toMatchObject({
      reason: "no_differentiator",
    });
    expect(recommendation).not.toHaveProperty("contestantId");
  });

  it("does not reward a smaller raw patch when quality judging is unavailable", () => {
    const state = makeRunState();
    state.contestants.a!.patchSize = 1;
    state.contestants.b!.patchSize = 1000;
    expect(
      selectRecommendedPatch({
        contestants: state.contestants,
        outcomeKind: "draw",
      }),
    ).toMatchObject({ reason: "draw" });
  });

  it("does not let quality override unequal active defect damage at equal HP", () => {
    const state = makeRunState({
      codexHealth: 85,
      codexDamage: 15,
      claudeHealth: 85,
      claudeRecoil: 10,
      claudeDamage: 5,
    });
    expect(
      isCompetitiveQualityTie(Object.values(state.contestants), "draw"),
    ).toBe(false);
    expect(
      selectRecommendedPatch({
        contestants: state.contestants,
        outcomeKind: "draw",
        qualityVerdict: {
          version: 1,
          verdict: "patch_a",
          criteria: [],
          rationale: ["Patch A wins the quality tie-break."],
        },
        anonymizationMap: { patch_a: "a", patch_b: "b" },
      }),
    ).toMatchObject({
      contestantId: "b",
      reason: "correctness",
    });
  });

  it("permits quality judging when both HP and active defect damage tie", () => {
    const state = makeRunState({
      codexHealth: 85,
      codexDamage: 15,
      claudeHealth: 85,
      claudeRecoil: 0,
      claudeDamage: 15,
    });
    expect(
      isCompetitiveQualityTie(Object.values(state.contestants), "draw"),
    ).toBe(true);
  });
});
