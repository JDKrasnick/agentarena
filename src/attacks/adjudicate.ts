import type { JudgeAttackVerdict } from "../agents/adapter.js";
import {
  DAMAGE_BY_SEVERITY,
  normalizeAttackAdjudication,
  PARTIAL_DAMAGE_BY_SEVERITY,
} from "../core/scoring.js";
import type { Attack } from "../core/types.js";

/** Apply the ordered neutral-judge fallback without inventing mechanical proof. */
function applyJudgeVerdictInternal(
  attack: Attack,
  verdict: JudgeAttackVerdict,
): Attack {
  const relationship = {
    ...(verdict.relationship
      ? { challengeRelationship: verdict.relationship }
      : {}),
    ...(verdict.priorAdjudicationId
      ? { relatedAdjudicationId: verdict.priorAdjudicationId }
      : {}),
  };
  if (verdict.decision === "unable") {
    return {
      ...attack,
      ...relationship,
      status: "judge_unable",
      outcomeReason: verdict.rationale,
    };
  }
  if (verdict.decision === "rejected" || !verdict.relevant) {
    return {
      ...attack,
      ...relationship,
      status: "judge_rejected",
      outcomeReason: verdict.rationale,
    };
  }
  if (!verdict.rootDefectId || !verdict.severity) {
    return {
      ...attack,
      ...relationship,
      status: "judge_unable",
      outcomeReason: "Judge verdict omitted a root defect or severity",
    };
  }
  const normalDamage = DAMAGE_BY_SEVERITY[verdict.severity];
  if (verdict.decision === "supported_untestable") {
    if (
      !verdict.expectedBehaviorClearlySupported ||
      !verdict.evidencePointsToDefect
    ) {
      return {
        ...attack,
        ...relationship,
        status: "judge_unable",
        outcomeReason:
          "35% partial-judge damage requires clear task support and evidence pointing to the defect",
      };
    }
    return {
      ...attack,
      ...relationship,
      status: "landed",
      rootDefectId: verdict.rootDefectId,
      severity: verdict.severity,
      damage: PARTIAL_DAMAGE_BY_SEVERITY[verdict.severity],
      damageActive: true,
      evidenceProvenance: "judge_partial",
      severityRationale: verdict.rationale,
      outcomeReason: `Judge-supported but mechanically untestable; exact 35% partial-judge damage. ${verdict.rationale}`,
    };
  }
  return {
    ...attack,
    ...relationship,
    status: "landed",
    rootDefectId: verdict.rootDefectId,
    severity: verdict.severity,
    damage: normalDamage,
    damageActive: true,
    evidenceProvenance: "judge_confirmed",
    severityRationale: verdict.rationale,
    outcomeReason: `Judge-confirmed after mechanical failure; ${verdict.rationale}`,
  };
}

export function applyJudgeVerdict(
  attack: Attack,
  verdict: JudgeAttackVerdict,
): Attack {
  const adjudicated = applyJudgeVerdictInternal(attack, verdict);
  return {
    ...adjudicated,
    adjudication: normalizeAttackAdjudication(adjudicated),
  };
}

/** Apply the same canonical-defect suppression used by mechanical verdicts. */
export function suppressKnownJudgeDefect(
  attack: Attack,
  knownRootDefects: ReadonlySet<string>,
): Attack {
  if (
    attack.status !== "landed" ||
    !attack.rootDefectId ||
    !knownRootDefects.has(attack.rootDefectId)
  )
    return attack;
  const duplicate: Attack = {
    ...attack,
    status: "duplicate",
    damageActive: false,
    outcomeReason: "Canonical root defect already scored",
    adjudication: undefined,
  };
  return {
    ...duplicate,
    adjudication: normalizeAttackAdjudication(duplicate),
  };
}
