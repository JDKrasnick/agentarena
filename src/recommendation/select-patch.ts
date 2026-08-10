import {
  PatchRecommendationSchema,
  type ContestantId,
  type PatchQualityVerdict,
  type PatchRecommendation,
  type RunState,
} from "../core/types.js";

export interface RecommendationInput {
  contestants: RunState["contestants"];
  championId?: ContestantId;
  qualityVerdict?: PatchQualityVerdict;
  anonymizationMap?: { patch_a: ContestantId; patch_b: ContestantId };
}

function finalRequiredPassed(
  contestant: NonNullable<RunState["contestants"][ContestantId]>,
): boolean {
  return (
    [...contestant.checks].reverse().find((check) => check.kind === "required")
      ?.status === "passed"
  );
}

export function selectRecommendedPatch(
  input: RecommendationInput,
): PatchRecommendation {
  const contestants = Object.values(input.contestants);
  const comparison = contestants.map((contestant) => {
    const requiredValidationPassed = finalRequiredPassed(contestant);
    const finalApplicabilityPassed = Boolean(contestant.finalPatchPath);
    return {
      contestantId: contestant.id,
      eligible:
        contestant.status !== "eliminated" &&
        requiredValidationPassed &&
        finalApplicabilityPassed,
      activeDefectDamage: contestant.healthLedger.activeDefects.reduce(
        (total, defect) => total + defect.damage,
        0,
      ),
      requiredValidationPassed,
      finalApplicabilityPassed,
    };
  });
  const eligible = comparison.filter((candidate) => candidate.eligible);
  if (eligible.length === 0) {
    return PatchRecommendationSchema.parse({
      reason: "inconclusive",
      rationale: [
        "No final patch passed applicability and required validation.",
      ],
      comparison,
    });
  }
  const leastDamage = Math.min(
    ...eligible.map((candidate) => candidate.activeDefectDamage),
  );
  const correct = eligible.filter(
    (candidate) => candidate.activeDefectDamage === leastDamage,
  );
  if (correct.length === 1) {
    return PatchRecommendationSchema.parse({
      contestantId: correct[0]?.contestantId,
      reason: "correctness",
      rationale: [
        "Selected the eligible patch with less active defect damage.",
      ],
      comparison,
    });
  }
  const legacyVerdict = input.qualityVerdict?.verdict;
  if (
    (legacyVerdict === "patch_a" || legacyVerdict === "patch_b") &&
    input.anonymizationMap
  ) {
    const selected = input.anonymizationMap[legacyVerdict];
    if (correct.some((candidate) => candidate.contestantId === selected)) {
      return PatchRecommendationSchema.parse({
        contestantId: selected,
        reason: "implementation_quality",
        qualityVerdict: legacyVerdict,
        rationale: input.qualityVerdict?.rationale.length
          ? input.qualityVerdict.rationale
          : ["Legacy quality comparison preferred this patch."],
        comparison,
      });
    }
  }
  const smallestPatchSize = Math.min(
    ...correct.map(
      (candidate) =>
        contestants.find((entry) => entry.id === candidate.contestantId)!
          .patchSize,
    ),
  );
  const smallest = correct.filter(
    (candidate) =>
      contestants.find((entry) => entry.id === candidate.contestantId)!
        .patchSize === smallestPatchSize,
  );
  if (smallest.length === 1) {
    return PatchRecommendationSchema.parse({
      contestantId: smallest[0]!.contestantId,
      reason: "patch_size",
      rationale: [
        `Equal-correctness patches were tied on active defect damage; selected the smaller ${String(smallestPatchSize)}-byte patch.`,
      ],
      comparison,
    });
  }
  return PatchRecommendationSchema.parse({
    reason: "draw",
    rationale: [
      "Required-check eligibility, active defect damage, and patch size are tied.",
    ],
    comparison,
  });
}
