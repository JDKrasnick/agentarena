import type {
  Attack,
  ContestantId,
  ContestantResult,
  HealthLedger,
  Ranking,
  RoundId,
  Severity,
} from "./types.js";

export const DAMAGE_BY_SEVERITY = {
  critical: 50,
  high: 30,
  medium: 15,
  low: 5,
} as const satisfies Record<Severity, 50 | 30 | 15 | 5>;

export const RECOIL_BY_RANK = {
  1: 5,
  2: 10,
  3: 15,
} as const;

export function calculateHealth(ledger: HealthLedger): number {
  if (ledger.eliminatedByRequiredCheck) return 0;
  const activeDamage = ledger.activeDefects.reduce(
    (sum, defect) => sum + defect.damage,
    0,
  );
  return Math.max(
    0,
    Math.min(100, 100 - ledger.permanentRecoil - activeDamage),
  );
}

export interface RoundResolution {
  contestants: Partial<Record<ContestantId, ContestantResult>>;
  eventsApplied: number;
}

function cloneContestant(contestant: ContestantResult): ContestantResult {
  return structuredClone(contestant);
}

export function resolveRound(
  contestants: Partial<Record<ContestantId, ContestantResult>>,
  attacks: readonly Attack[],
  round: RoundId,
): RoundResolution {
  const next = Object.fromEntries(
    Object.entries(contestants).map(([id, contestant]) => [
      id,
      cloneContestant(contestant),
    ]),
  ) as Partial<Record<ContestantId, ContestantResult>>;
  let eventsApplied = 0;

  const roundAttacks = attacks
    .filter((attack) => attack.round === round)
    .toSorted((left, right) => left.id.localeCompare(right.id));
  for (const attack of roundAttacks) {
    if (
      attack.status === "landed" &&
      attack.damage !== undefined &&
      attack.rootDefectId
    ) {
      for (const target of attack.targets) {
        const contestant = next[target];
        if (!contestant) throw new Error(`Missing target contestant ${target}`);
        const alreadyActive = contestant.healthLedger.activeDefects.some(
          (defect) => defect.rootDefectId === attack.rootDefectId,
        );
        if (!alreadyActive) {
          contestant.healthLedger.activeDefects.push({
            rootDefectId: attack.rootDefectId,
            attackId: attack.id,
            damage: attack.damage,
          });
          contestant.healthEvents.push({
            attackId: attack.id,
            round,
            type: "target_damage",
            amount: -attack.damage,
            reason: attack.outcomeReason ?? attack.claim,
          });
          eventsApplied += 1;
        }
      }
    }

    if (
      attack.origin.kind === "contestant" &&
      [
        "invalid",
        "duplicate",
        "self_defeating",
        "unproven",
        "blocked",
      ].includes(attack.status) &&
      attack.rank !== undefined
    ) {
      const recoil = RECOIL_BY_RANK[attack.rank];
      const author = next[attack.origin.contestant];
      if (!author)
        throw new Error(
          `Missing author contestant ${attack.origin.contestant}`,
        );
      author.healthLedger.permanentRecoil += recoil;
      author.healthEvents.push({
        attackId: attack.id,
        round,
        type: "recoil",
        amount: -recoil,
        reason:
          attack.outcomeReason ?? `${attack.status} rank-${attack.rank} attack`,
      });
      eventsApplied += 1;
    }
  }

  for (const contestant of Object.values(next)) {
    contestant.finalHealth = calculateHealth(contestant.healthLedger);
  }
  return { contestants: next, eventsApplied };
}

export function healDefect(
  contestant: ContestantResult,
  rootDefectId: string,
  round: RoundId,
): ContestantResult {
  const next = cloneContestant(contestant);
  const defect = next.healthLedger.activeDefects.find(
    (entry) => entry.rootDefectId === rootDefectId,
  );
  if (!defect) return next;

  next.healthLedger.activeDefects = next.healthLedger.activeDefects.filter(
    (entry) => entry.rootDefectId !== rootDefectId,
  );
  next.healthEvents.push({
    attackId: defect.attackId,
    round,
    type: "heal",
    amount: defect.damage,
    reason: `All accepted cases pass for ${rootDefectId}`,
  });
  next.finalHealth = calculateHealth(next.healthLedger);
  return next;
}

export function rankContestants(
  contestants: readonly ContestantResult[],
): Ranking {
  const survivors = contestants.filter(
    (contestant) => contestant.status !== "eliminated",
  );
  if (survivors.length === 0) {
    return {
      winner: null,
      draw: true,
      order: [...contestants]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((contestant) => contestant.id),
      reason:
        "No winner: both contestants were eliminated by required validation or zero health",
    };
  }
  if (survivors.length === 1) {
    const winner = survivors[0];
    if (!winner) throw new Error("Missing sole survivor");
    const other = contestants.find((contestant) => contestant.id !== winner.id);
    return {
      winner: winner.id,
      draw: false,
      order: [winner.id, ...(other ? [other.id] : [])],
      reason: `${winner.id} is the only surviving contestant`,
    };
  }
  const sorted = [...contestants].sort((left, right) => {
    if (left.finalHealth !== right.finalHealth)
      return right.finalHealth - left.finalHealth;
    if (left.patchSize !== right.patchSize)
      return left.patchSize - right.patchSize;
    return left.id.localeCompare(right.id);
  });
  const first = sorted[0];
  const second = sorted[1];
  if (!first || !second)
    throw new Error("Ranking requires exactly two contestants");

  const tied =
    first.finalHealth === second.finalHealth &&
    first.patchSize === second.patchSize;
  if (tied) {
    return {
      winner: null,
      draw: true,
      order: sorted.map((contestant) => contestant.id),
      reason: `Draw at ${first.finalHealth} HP and ${first.patchSize}-byte patches`,
    };
  }
  return {
    winner: first.id,
    draw: false,
    order: sorted.map((contestant) => contestant.id),
    reason:
      first.finalHealth !== second.finalHealth
        ? `${first.id} has ${first.finalHealth} HP versus ${second.finalHealth} HP`
        : `${first.id} wins the patch-size tie-breaker (${first.patchSize} versus ${second.patchSize} bytes)`,
  };
}
