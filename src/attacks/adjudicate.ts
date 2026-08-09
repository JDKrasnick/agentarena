import type { JudgeAttackVerdict } from "../agents/adapter.js";
import { DAMAGE_BY_SEVERITY } from "../core/scoring.js";
import type { Attack } from "../core/types.js";

/** Apply the ordered neutral-judge fallback without inventing mechanical proof. */
export function applyJudgeVerdict(
  attack: Attack,
  verdict: JudgeAttackVerdict,
): Attack {
  if (verdict.decision === "unable") {
    return {
      ...attack,
      status: "judge_unable",
      outcomeReason: verdict.rationale,
    };
  }
  if (verdict.decision === "rejected" || !verdict.relevant) {
    return {
      ...attack,
      status: "judge_rejected",
      outcomeReason: verdict.rationale,
    };
  }
  if (!verdict.rootDefectId || !verdict.severity) {
    return {
      ...attack,
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
        status: "judge_unable",
        outcomeReason:
          "Half damage requires clear task support and evidence pointing to the defect",
      };
    }
    return {
      ...attack,
      status: "landed",
      rootDefectId: verdict.rootDefectId,
      severity: verdict.severity,
      damage: (normalDamage / 2) as 25 | 15 | 7.5 | 2.5,
      damageActive: true,
      evidenceProvenance: "judge_partial",
      severityRationale: verdict.rationale,
      outcomeReason: `Judge-supported but mechanically untestable; exact half damage. ${verdict.rationale}`,
    };
  }
  return {
    ...attack,
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
  return {
    ...attack,
    status: "duplicate",
    damageActive: false,
    outcomeReason: "Canonical root defect already scored",
  };
}
