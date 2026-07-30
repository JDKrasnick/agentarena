import { deriveArenaOutcome } from "../outcomes/derive-outcome.js";
import {
  AnyRunStateSchema,
  RunStateV2Schema,
  type AnyRunState,
  type RunState,
  type RunStateV1,
} from "./types.js";

export function migrateRunStateV1(state: RunStateV1): RunState {
  const migrated = {
    ...state,
    schemaVersion: 2 as const,
    patchQualityFacts: {},
  };
  const arenaOutcome = deriveArenaOutcome(migrated);
  return RunStateV2Schema.parse({
    ...migrated,
    arenaOutcome,
    patchRecommendation: {
      ...(state.ranking?.winner ? { contestantId: state.ranking.winner } : {}),
      reason: state.ranking?.winner ? "arena_fallback" : "draw",
      rationale: [
        "This version 1 run has no saved neutral quality comparison; using its recorded arena result.",
      ],
      comparison: Object.values(state.contestants).map((contestant) => ({
        contestantId: contestant.agent,
        eligible:
          contestant.status !== "eliminated" &&
          Boolean(contestant.finalPatchPath),
        activeDefectDamage: contestant.healthLedger.activeDefects.reduce(
          (total, defect) => total + defect.damage,
          0,
        ),
        requiredValidationPassed:
          [...contestant.checks]
            .reverse()
            .find((check) => check.kind === "required")?.status === "passed",
        finalApplicabilityPassed: Boolean(contestant.finalPatchPath),
      })),
    },
  });
}

export function parseRunState(value: unknown): RunState {
  const state: AnyRunState = AnyRunStateSchema.parse(value);
  return state.schemaVersion === 1 ? migrateRunStateV1(state) : state;
}
