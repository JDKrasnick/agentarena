import { describe, expect, it } from "vitest";
import { selectRecommendedPatch } from "../../src/recommendation/select-patch.js";
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
});
