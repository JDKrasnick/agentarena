import type { Attack, ContestantId, RunState } from "../core/types.js";

function decisionWasOverturned(
  attacks: readonly Attack[],
  attack: Attack,
): boolean {
  const adjudicationId = attack.adjudication?.id;
  if (!adjudicationId) return false;
  return attacks.some(
    (candidate) =>
      candidate.adjudication?.relationship === "overturn" &&
      candidate.adjudication.verdict !== "unable" &&
      candidate.adjudication.supersedesAdjudicationId === adjudicationId,
  );
}

function remainsValidLanding(attacks: readonly Attack[], attack: Attack) {
  return (
    attack.status === "landed" &&
    attack.adjudication?.verdict !== "rejected" &&
    attack.adjudication?.verdict !== "unable" &&
    (!attack.adjudication ||
      ["damage", "damage_upgrade"].includes(attack.adjudication.scoreEffect)) &&
    !decisionWasOverturned(attacks, attack)
  );
}

/** Contestant-authored differential evidence that still stands at finalization. */
export function competitiveLandings(
  state: Pick<RunState, "attacks">,
  round?: number,
): Attack[] {
  return state.attacks.filter(
    (attack) =>
      attack.origin.kind === "contestant" &&
      (round === undefined || attack.round === round) &&
      remainsValidLanding(state.attacks, attack),
  );
}

/** Neutral findings are counted once by their original canonical identity. */
export function sharedDefects(
  state: Pick<RunState, "attacks">,
  round?: number,
): Attack[] {
  const byCanonicalIdentity = new Map<string, Attack>();
  for (const attack of state.attacks) {
    if (
      attack.origin.kind !== "house" ||
      (round !== undefined && attack.round !== round) ||
      !remainsValidLanding(state.attacks, attack)
    )
      continue;
    byCanonicalIdentity.set(attack.rootDefectId ?? attack.id, attack);
  }
  return [...byCanonicalIdentity.values()];
}

export function explicitEmptyLaneCount(
  state: Pick<RunState, "attackInvocations" | "coverageAssessment">,
  round?: number,
): number {
  if (round === undefined && state.coverageAssessment)
    return state.coverageAssessment.evidenceCounts.explicitEmpty;
  const latestByLane = new Map<
    string,
    (typeof state.attackInvocations)[number]
  >();
  for (const invocation of state.attackInvocations) {
    if (typeof invocation.round !== "number") continue;
    if (round !== undefined && invocation.round !== round) continue;
    latestByLane.set(
      `${String(invocation.round)}:${invocation.attacker}->${invocation.target}`,
      invocation,
    );
  }
  return [...latestByLane.values()].filter(
    (invocation) => invocation.parseOutcome === "valid_empty",
  ).length;
}

export function activeDefectDamage(
  state: Pick<RunState, "contestants">,
  contestantId: ContestantId,
): number {
  return (
    state.contestants[contestantId]?.healthLedger.activeDefects.reduce(
      (total, defect) => total + defect.damage,
      0,
    ) ?? 0
  );
}

export function finalRequiredPassed(
  state: Pick<RunState, "contestants">,
  contestantId: ContestantId,
): boolean {
  const contestant = state.contestants[contestantId];
  return Boolean(
    contestant &&
    [...contestant.checks].reverse().find((check) => check.kind === "required")
      ?.status === "passed",
  );
}

export function finalPatchEligible(
  state: Pick<RunState, "contestants">,
  contestantId: ContestantId,
): boolean {
  const contestant = state.contestants[contestantId];
  return Boolean(
    contestant &&
    contestant.status !== "eliminated" &&
    contestant.status !== "failed" &&
    contestant.finalPatchPath &&
    finalRequiredPassed(state, contestantId),
  );
}
