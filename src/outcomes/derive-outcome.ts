import {
  ArenaOutcomeV2Schema,
  type ArenaOutcome,
  type RunState,
} from "../core/types.js";
import {
  activeDefectDamage,
  competitiveLandings,
  explicitEmptyLaneCount,
  finalPatchEligible,
  sharedDefects,
} from "./evidence.js";

export function classifyMargin(marginHp: number): ArenaOutcome["marginClass"] {
  if (marginHp === 0) return "tied";
  if (marginHp <= 5) return "razor_thin";
  if (marginHp <= 10) return "narrow";
  return "clear";
}

export function deriveArenaOutcome(
  state: Pick<RunState, "contestants" | "ranking"> &
    Partial<
      Pick<
        RunState,
        "config" | "attacks" | "attackInvocations" | "coverageAssessment"
      >
    >,
): ArenaOutcome {
  const contestants = Object.values(state.contestants);
  const derived = Object.fromEntries(
    contestants.map((contestant) => {
      const grossDamageReceived = contestant.healthEvents
        .filter((event) => event.type === "target_damage")
        .reduce((total, event) => total + Math.abs(event.amount), 0);
      const grossHealing = contestant.healthEvents
        .filter((event) => event.type === "heal")
        .reduce((total, event) => total + Math.abs(event.amount), 0);
      const activeDefectDamage = contestant.healthLedger.activeDefects.reduce(
        (total, defect) => total + defect.damage,
        0,
      );
      const recomputed = contestant.healthLedger.eliminatedByRequiredCheck
        ? 0
        : Math.max(
            0,
            Math.min(
              100,
              contestant.initialHealth -
                contestant.healthLedger.permanentRecoil -
                activeDefectDamage,
            ),
          );
      if (recomputed !== contestant.finalHealth) {
        throw new Error(
          `Persisted final health for ${contestant.id} is ${String(contestant.finalHealth)} but the ledger derives ${String(recomputed)}`,
        );
      }
      return [
        contestant.id,
        {
          contestantId: contestant.id,
          initialHealth: contestant.initialHealth,
          finalHealth: contestant.finalHealth,
          grossDamageReceived,
          grossHealing,
          activeDefectDamage,
          permanentRecoil: contestant.healthLedger.permanentRecoil,
          eliminatedByRequiredCheck:
            contestant.healthLedger.eliminatedByRequiredCheck,
        },
      ] as const;
    }),
  );
  const orderedHealth = contestants
    .map((contestant) => contestant.finalHealth)
    .sort((left, right) => right - left);
  const marginHp = Math.max(
    0,
    (orderedHealth[0] ?? 0) - (orderedHealth[1] ?? 0),
  );
  const decidingFactors = new Set<ArenaOutcome["decidingFactors"][number]>();
  if (
    contestants.some(
      (contestant) =>
        contestant.healthLedger.eliminatedByRequiredCheck ||
        contestant.status === "eliminated",
    )
  ) {
    decidingFactors.add("elimination");
  }
  const activeDamageValues = contestants.map((contestant) =>
    contestant.healthLedger.activeDefects.reduce(
      (total, defect) => total + defect.damage,
      0,
    ),
  );
  if (new Set(activeDamageValues).size > 1)
    decidingFactors.add("unresolved_defects");
  const recoilValues = contestants.map(
    (contestant) => contestant.healthLedger.permanentRecoil,
  );
  if (new Set(recoilValues).size > 1) decidingFactors.add("recoil");
  if (marginHp === 0 && state.ranking?.winner)
    decidingFactors.add("tie_breaker");

  const evidenceState = {
    attacks: state.attacks ?? [],
    attackInvocations: state.attackInvocations ?? [],
    coverageAssessment: state.coverageAssessment,
  };
  const competitiveLandingCount = competitiveLandings(evidenceState).length;
  const sharedDefectCount = sharedDefects(evidenceState).length;
  const explicitEmptyLanes = explicitEmptyLaneCount(evidenceState);
  const equalActiveDamage =
    activeDefectDamage(state, "a") === activeDefectDamage(state, "b");
  const completeRequiredCoverage = Boolean(
    state.coverageAssessment &&
    state.coverageAssessment.counts.required > 0 &&
    state.coverageAssessment.counts.unresolved === 0,
  );
  const nonDiscriminating = Boolean(
    state.config &&
    (state.config.mode === "duel" || state.config.mode === "catch_up") &&
    completeRequiredCoverage &&
    finalPatchEligible(state, "a") &&
    finalPatchEligible(state, "b") &&
    equalActiveDamage &&
    competitiveLandingCount === 0,
  );
  const kind: ArenaOutcome["kind"] = nonDiscriminating
    ? "non_discriminating"
    : state.ranking?.draw || !state.ranking?.winner
      ? "draw"
      : "winner";
  const decisionBasis: ArenaOutcome["decisionBasis"] = nonDiscriminating
    ? "no_differentiator"
    : decidingFactors.has("tie_breaker")
      ? "fallback_tie_break"
      : competitiveLandingCount > 0 ||
          decidingFactors.has("unresolved_defects") ||
          decidingFactors.has("recoil") ||
          decidingFactors.has("elimination")
        ? "competitive_evidence"
        : "no_differentiator";

  return ArenaOutcomeV2Schema.parse({
    version: 2,
    kind,
    decisionBasis,
    ...(kind === "winner" && state.ranking?.winner
      ? { championId: state.ranking.winner }
      : {}),
    contestants: derived,
    marginHp,
    marginClass: classifyMargin(marginHp),
    decidingFactors: [...decidingFactors],
    competitiveLandingCount,
    sharedDefectCount,
    explicitEmptyLaneCount: explicitEmptyLanes,
  });
}
