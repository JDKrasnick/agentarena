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
});
