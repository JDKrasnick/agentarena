import {
  AdjudicationRecordSchema,
  type AdjudicationRecord,
  type Attack,
  type ContestantId,
  type ContestantResult,
  type EvidenceBasis,
  type HealthLedger,
  type Ranking,
  type RoundId,
  type Severity,
} from "./types.js";

export const DAMAGE_BY_SEVERITY = {
  critical: 50,
  high: 30,
  medium: 15,
  low: 5,
} as const satisfies Record<Severity, 50 | 30 | 15 | 5>;

export const PARTIAL_DAMAGE_BY_SEVERITY = {
  critical: 17.5,
  high: 10.5,
  medium: 5.25,
  low: 1.75,
} as const satisfies Record<Severity, 17.5 | 10.5 | 5.25 | 1.75>;

export const RECOIL_BY_RANK = { 1: 5, 2: 10, 3: 15 } as const;

function expectedRecoil(attack: Attack): 0 | 5 | 10 | 15 {
  return attack.origin.kind === "contestant" && attack.rank
    ? RECOIL_BY_RANK[attack.rank]
    : 0;
}

function adjudicationRecoil(
  attack: Attack,
  adjudication: AdjudicationRecord,
): 0 | 5 | 10 | 15 {
  const shouldRecoil =
    adjudication.verdict === "rejected" ||
    adjudication.duplicateState !== "unique";
  if (!shouldRecoil || attack.origin.kind !== "contestant") return 0;
  const expected = expectedRecoil(attack);
  if (expected === 0)
    throw new Error("A contestant miss adjudication requires an attack rank");
  const recorded =
    adjudication.recoilAmount ??
    (adjudication.scoreEffect === "recoil"
      ? adjudication.exactAmount
      : expected);
  if (recorded !== expected)
    throw new Error(
      `Adjudication recoil amount ${String(recorded)} does not match rank-${String(attack.rank)} recoil ${String(expected)}`,
    );
  return expected;
}

function evidenceBasis(attack: Attack): EvidenceBasis {
  if (attack.evidenceProvenance === "mechanical") return "mechanical";
  if (attack.evidenceProvenance === "judge_confirmed") return "judge";
  if (attack.evidenceProvenance === "judge_partial") return "partial_judge";
  return "legacy_unknown";
}

function rejectionBasis(
  status: Attack["status"],
): AdjudicationRecord["rejectionBasis"] {
  if (status === "invalid") return "malformed_submission";
  if (status === "judge_rejected" || status === "unproven") return "semantic";
  return "mechanical";
}

/**
 * Convert legacy/free-form attack outcomes into the immutable scoring contract.
 * Caller-provided `damage` is deliberately ignored.
 */
export function normalizeAttackAdjudication(
  attack: Attack,
): AdjudicationRecord {
  if (attack.adjudication)
    return AdjudicationRecordSchema.parse(attack.adjudication);
  const id = `adjudication:${attack.id}`;
  const basis = evidenceBasis(attack);
  const diagnosticArtifactRefs = attack.checks.flatMap((check) =>
    check.command ? [check.command.stdoutPath, check.command.stderrPath] : [],
  );
  const retryArtifactRefs = attack.checks.flatMap((check) =>
    check.command && check.command.attempts > 1
      ? [check.command.stdoutPath, check.command.stderrPath]
      : [],
  );
  if (attack.status === "landed" && attack.rootDefectId && attack.severity) {
    const multiplier = basis === "partial_judge" ? 0.35 : 1;
    return AdjudicationRecordSchema.parse({
      version: 1,
      id,
      verdict: "valid",
      canonicalDefectId: attack.rootDefectId,
      severity: attack.severity,
      rationale:
        attack.severityRationale ?? attack.outcomeReason ?? attack.claim,
      evidenceBasis: basis,
      duplicateState: "unique",
      retryArtifactRefs,
      diagnosticArtifactRefs,
      multiplier,
      scoreEffect: "damage",
      exactAmount:
        multiplier === 0.35
          ? PARTIAL_DAMAGE_BY_SEVERITY[attack.severity]
          : DAMAGE_BY_SEVERITY[attack.severity],
    });
  }
  if (attack.status === "duplicate" && attack.rootDefectId && attack.severity) {
    const multiplier = basis === "partial_judge" ? 0.35 : 1;
    const recoil = expectedRecoil(attack);
    return AdjudicationRecordSchema.parse({
      version: 1,
      id,
      verdict: "valid",
      canonicalDefectId: attack.rootDefectId,
      severity: attack.severity,
      rationale:
        attack.outcomeReason ?? "Corroborates an existing canonical defect",
      evidenceBasis: basis,
      duplicateState: "corroborating",
      retryArtifactRefs,
      diagnosticArtifactRefs,
      multiplier,
      scoreEffect: "none",
      exactAmount: 0,
      ...(recoil ? { recoilAmount: recoil } : {}),
    });
  }
  if (
    [
      "capability_denied",
      "provisional_infrastructure",
      "infrastructure_error",
      "execution_inconclusive",
      "judge_unable",
      "submitted",
    ].includes(attack.status)
  ) {
    return AdjudicationRecordSchema.parse({
      version: 1,
      id,
      verdict: "unable",
      rationale: attack.outcomeReason ?? attack.claim,
      evidenceBasis: "none",
      duplicateState: "unique",
      retryArtifactRefs,
      diagnosticArtifactRefs,
      multiplier: 0,
      scoreEffect: "none",
      exactAmount: 0,
    });
  }
  const recoil = expectedRecoil(attack);
  return AdjudicationRecordSchema.parse({
    version: 1,
    id,
    verdict: "rejected",
    rejectionBasis: rejectionBasis(attack.status),
    rationale: attack.outcomeReason ?? attack.claim,
    evidenceBasis: basis === "legacy_unknown" ? "none" : basis,
    duplicateState: attack.status === "duplicate" ? "duplicate" : "unique",
    retryArtifactRefs,
    diagnosticArtifactRefs,
    multiplier: 0,
    scoreEffect: recoil ? "recoil" : "none",
    exactAmount: recoil,
  });
}

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

  for (const attack of attacks
    .filter((entry) => entry.round === round)
    .toSorted((a, b) => {
      const left = normalizeAttackAdjudication(a);
      const right = normalizeAttackAdjudication(b);
      const leftOrder = left.duplicateState === "unique" ? 0 : 1;
      const rightOrder = right.duplicateState === "unique" ? 0 : 1;
      return leftOrder - rightOrder || a.id.localeCompare(b.id);
    })) {
    const adjudication = normalizeAttackAdjudication(attack);
    if (
      adjudication.verdict === "valid" &&
      adjudication.canonicalDefectId &&
      adjudication.severity &&
      adjudication.multiplier > 0
    ) {
      const provenMultiplier = adjudication.multiplier as 0.35 | 1;
      for (const target of attack.targets) {
        const contestant = next[target];
        if (!contestant) throw new Error(`Missing target contestant ${target}`);
        const ledger = contestant.healthLedger;
        ledger.canonicalDefects ??= [];
        let canonical = ledger.canonicalDefects.find(
          (defect) => defect.rootDefectId === adjudication.canonicalDefectId,
        );
        if (!canonical) {
          if (adjudication.scoreEffect !== "damage") continue;
          const newCanonical = {
            rootDefectId: adjudication.canonicalDefectId,
            firstAttackId: attack.id,
            firstAdjudicationId: adjudication.id,
            baseSeverity: adjudication.severity,
            currentMultiplier: provenMultiplier,
            currentDamage:
              provenMultiplier === 0.35
                ? PARTIAL_DAMAGE_BY_SEVERITY[adjudication.severity]
                : DAMAGE_BY_SEVERITY[adjudication.severity],
            evidenceHistory: [],
            status: "active",
          } as NonNullable<typeof ledger.canonicalDefects>[number];
          ledger.canonicalDefects.push(newCanonical);
          canonical = newCanonical;
          ledger.activeDefects.push({
            rootDefectId: canonical.rootDefectId,
            attackId: attack.id,
            damage: canonical.currentDamage,
            severity: canonical.baseSeverity,
            multiplier: canonical.currentMultiplier,
          });
          contestant.healthEvents.push({
            attackId: attack.id,
            adjudicationId: adjudication.id,
            round,
            type: "target_damage",
            amount: -canonical.currentDamage,
            reason: adjudication.rationale,
          });
          eventsApplied += 1;
        } else if (adjudication.multiplier > canonical.currentMultiplier) {
          const fullDamage = DAMAGE_BY_SEVERITY[canonical.baseSeverity];
          const delta = fullDamage - canonical.currentDamage;
          canonical.currentMultiplier = 1;
          canonical.currentDamage = fullDamage;
          if (canonical.status === "active" && delta > 0) {
            const active = ledger.activeDefects.find(
              (defect) => defect.rootDefectId === canonical!.rootDefectId,
            );
            if (active) {
              active.damage = fullDamage;
              active.multiplier = 1;
              active.severity = canonical.baseSeverity;
            }
            contestant.healthEvents.push({
              attackId: attack.id,
              adjudicationId: adjudication.id,
              ...(canonical.firstAdjudicationId
                ? { upgradesAdjudicationId: canonical.firstAdjudicationId }
                : {}),
              round,
              type: "damage_upgrade",
              amount: -delta,
              reason: `Definitive evidence upgraded ${canonical.rootDefectId} from 35% to full damage`,
            });
            eventsApplied += 1;
          } else if (
            canonical.status === "healed" &&
            adjudication.duplicateState === "regression"
          ) {
            canonical.status = "active";
            ledger.activeDefects.push({
              rootDefectId: canonical.rootDefectId,
              attackId: attack.id,
              damage: canonical.currentDamage,
              severity: canonical.baseSeverity,
              multiplier: canonical.currentMultiplier,
            });
            contestant.healthEvents.push({
              attackId: attack.id,
              adjudicationId: adjudication.id,
              round,
              type: "target_damage",
              amount: -canonical.currentDamage,
              reason: `Definitive regression evidence reactivated ${canonical.rootDefectId}`,
            });
            eventsApplied += 1;
          }
        } else if (
          canonical.status === "healed" &&
          adjudication.duplicateState === "regression"
        ) {
          canonical.status = "active";
          ledger.activeDefects.push({
            rootDefectId: canonical.rootDefectId,
            attackId: attack.id,
            damage: canonical.currentDamage,
            severity: canonical.baseSeverity,
            multiplier: canonical.currentMultiplier,
          });
          contestant.healthEvents.push({
            attackId: attack.id,
            adjudicationId: adjudication.id,
            round,
            type: "target_damage",
            amount: -canonical.currentDamage,
            reason: `Regression reactivated ${canonical.rootDefectId}`,
          });
          eventsApplied += 1;
        }
        if (
          !canonical.evidenceHistory.some(
            (entry) => entry.attackId === attack.id,
          )
        ) {
          canonical.evidenceHistory.push({
            attackId: attack.id,
            basis: adjudication.evidenceBasis,
            multiplier: provenMultiplier,
            rationale: adjudication.rationale,
          });
        }
      }
    }

    const recoil = adjudicationRecoil(attack, adjudication);
    if (recoil > 0 && attack.origin.kind === "contestant") {
      const author = next[attack.origin.contestant];
      if (!author)
        throw new Error(
          `Missing author contestant ${attack.origin.contestant}`,
        );
      author.healthLedger.permanentRecoil += recoil;
      author.healthEvents.push({
        attackId: attack.id,
        adjudicationId: adjudication.id,
        round,
        type: "recoil",
        amount: -recoil,
        reason: adjudication.rationale,
      });
      eventsApplied += 1;
    }
  }

  for (const contestant of Object.values(next))
    contestant.finalHealth = calculateHealth(contestant.healthLedger);
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
  const canonical = next.healthLedger.canonicalDefects?.find(
    (entry) => entry.rootDefectId === rootDefectId,
  );
  if (canonical) canonical.status = "healed";
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
  options: { patchSizeTieBreaker?: boolean } = {},
): Ranking {
  const survivors = contestants.filter(
    (contestant) => contestant.status !== "eliminated",
  );
  if (survivors.length === 0)
    return {
      winner: null,
      draw: true,
      order: [...contestants]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((entry) => entry.id),
      reason:
        "No winner: both contestants were eliminated by required validation or zero health",
    };
  if (survivors.length === 1) {
    const winner = survivors[0]!;
    const other = contestants.find((entry) => entry.id !== winner.id);
    return {
      winner: winner.id,
      draw: false,
      order: [winner.id, ...(other ? [other.id] : [])],
      reason: `${winner.id} is the only surviving contestant`,
    };
  }
  const sorted = [...contestants].sort((a, b) =>
    a.finalHealth !== b.finalHealth
      ? b.finalHealth - a.finalHealth
      : options.patchSizeTieBreaker !== false && a.patchSize !== b.patchSize
        ? a.patchSize - b.patchSize
        : a.id.localeCompare(b.id),
  );
  const [first, second] = sorted as [ContestantResult, ContestantResult];
  const tied =
    first.finalHealth === second.finalHealth &&
    (options.patchSizeTieBreaker === false ||
      first.patchSize === second.patchSize);
  if (tied)
    return {
      winner: null,
      draw: true,
      order: sorted.map((entry) => entry.id),
      reason:
        options.patchSizeTieBreaker === false
          ? `Draw at ${first.finalHealth} HP`
          : `Draw at ${first.finalHealth} HP and ${first.patchSize}-byte patches`,
    };
  return {
    winner: first.id,
    draw: false,
    order: sorted.map((entry) => entry.id),
    reason:
      first.finalHealth !== second.finalHealth
        ? `${first.id} has ${first.finalHealth} HP versus ${second.finalHealth} HP`
        : `${first.id} wins the patch-size tie-breaker (${first.patchSize} versus ${second.patchSize} bytes)`,
  };
}
