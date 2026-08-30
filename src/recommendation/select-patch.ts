import {
  type Attack,
  PatchRecommendationSchema,
  type ContestantId,
  type ContestantResult,
  type PatchQualityVerdict,
  type PatchRecommendation,
  type RunState,
} from "../core/types.js";
import { unresolvedSharedDefects } from "../outcomes/evidence.js";

export interface RecommendationInput {
  contestants: RunState["contestants"];
  attacks?: Attack[];
  championId?: ContestantId;
  outcomeKind?: "winner" | "draw" | "non_discriminating";
  qualityVerdict?: PatchQualityVerdict;
  anonymizationMap?: { patch_a: ContestantId; patch_b: ContestantId };
}

export function isCompetitiveQualityTie(
  contestants: readonly ContestantResult[],
  outcomeKind: RecommendationInput["outcomeKind"],
): boolean {
  return (
    outcomeKind === "draw" &&
    contestants.length === 2 &&
    new Set(contestants.map((contestant) => contestant.finalHealth)).size ===
      1 &&
    new Set(
      contestants.map((contestant) =>
        contestant.healthLedger.activeDefects.reduce(
          (total, defect) => total + defect.damage,
          0,
        ),
      ),
    ).size === 1
  );
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
        finalApplicabilityPassed &&
        (!input.attacks ||
          unresolvedSharedDefects({ attacks: input.attacks }, contestant.id)
            .length === 0),
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
        "No final patch passed applicability, required validation, and shared-defect repair validation.",
      ],
      comparison,
    });
  }
  const decisiveQualityVerdict = input.qualityVerdict?.verdict;
  if (
    input.outcomeKind === "winner" &&
    input.championId &&
    input.anonymizationMap &&
    (decisiveQualityVerdict === "patch_a" ||
      decisiveQualityVerdict === "patch_b") &&
    input.anonymizationMap[decisiveQualityVerdict] === input.championId &&
    eligible.some((candidate) => candidate.contestantId === input.championId)
  ) {
    return PatchRecommendationSchema.parse({
      contestantId: input.championId,
      reason: "implementation_quality",
      qualityVerdict: decisiveQualityVerdict,
      rationale: input.qualityVerdict?.rationale.length
        ? input.qualityVerdict.rationale
        : ["A decisive identity-blind quality verdict resolved the HP tie."],
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
  if (input.outcomeKind === "non_discriminating") {
    return PatchRecommendationSchema.parse({
      reason: "no_differentiator",
      qualityVerdict: input.qualityVerdict?.verdict,
      rationale: [
        input.qualityVerdict?.verdict === "equivalent"
          ? "The identity-blind quality comparison found the eligible patches equivalent."
          : input.qualityVerdict?.verdict === "inconclusive"
            ? "The identity-blind quality comparison found no reliable differentiator."
            : "No identity-blind quality recommendation was available.",
      ],
      comparison,
    });
  }
  return PatchRecommendationSchema.parse({
    reason: "draw",
    rationale: [
      "Required-check eligibility and active defect damage are tied, and no decisive identity-blind quality verdict is available.",
    ],
    comparison,
  });
}
