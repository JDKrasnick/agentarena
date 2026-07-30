import {
  PatchRecommendationSchema,
  type AgentId,
  type PatchQualityVerdict,
  type PatchRecommendation,
  type RunState,
} from "../core/types.js";

export interface RecommendationInput {
  contestants: RunState["contestants"];
  championId?: AgentId;
  qualityVerdict?: PatchQualityVerdict;
  anonymizationMap?: { patch_a: AgentId; patch_b: AgentId };
}

function finalRequiredPassed(
  contestant: NonNullable<RunState["contestants"][AgentId]>,
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
      contestantId: contestant.agent,
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
  const verdict = input.qualityVerdict?.verdict;
  if (
    (verdict === "patch_a" || verdict === "patch_b") &&
    input.anonymizationMap
  ) {
    const selected = input.anonymizationMap[verdict];
    if (correct.some((candidate) => candidate.contestantId === selected)) {
      return PatchRecommendationSchema.parse({
        contestantId: selected,
        reason: "implementation_quality",
        qualityVerdict: verdict,
        rationale: input.qualityVerdict?.rationale.length
          ? input.qualityVerdict.rationale
          : ["Neutral quality comparison preferred this patch."],
        comparison,
      });
    }
  }
  if (
    input.championId &&
    correct.some((candidate) => candidate.contestantId === input.championId)
  ) {
    return PatchRecommendationSchema.parse({
      contestantId: input.championId,
      reason: "arena_fallback",
      ...(verdict ? { qualityVerdict: verdict } : {}),
      rationale: [
        verdict === "equivalent"
          ? "Quality comparison found the patches equivalent; using the arena champion."
          : "Quality comparison was unavailable or inconclusive; using the arena champion.",
      ],
      comparison,
    });
  }
  return PatchRecommendationSchema.parse({
    reason: "draw",
    ...(verdict ? { qualityVerdict: verdict } : {}),
    rationale: [
      "No correctness or quality comparison produced a unique patch.",
    ],
    comparison,
  });
}
