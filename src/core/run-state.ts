import { deriveArenaOutcome } from "../outcomes/derive-outcome.js";
import { contestantLabel } from "./labels.js";
import {
  AnyRunStateSchema,
  RunStateV3Schema,
  RunStateV7Schema,
  RunStateV8Schema,
  RunStateV9Schema,
  type AgentId,
  type AnyRunState,
  type ContestantId,
  type ContestantRole,
  type RunState,
  type RunStateV1,
  type RunStateV2,
} from "./types.js";

type LegacyRunState = RunStateV1 | RunStateV2;

function providerToSlot(state: LegacyRunState): Map<AgentId, ContestantId> {
  const map = new Map<AgentId, ContestantId>();
  for (const contestant of state.config.contestants) {
    map.set(contestant.provider, contestant.id);
  }
  return map;
}

function slotOf(
  map: Map<AgentId, ContestantId>,
  provider: AgentId,
): ContestantId {
  const slot = map.get(provider);
  if (!slot)
    throw new Error(`Legacy run references unknown provider ${provider}`);
  return slot;
}

function roleOf(state: LegacyRunState, slot: ContestantId): ContestantRole {
  return (
    state.config.contestants.find((contestant) => contestant.id === slot)
      ?.role ?? "solver"
  );
}

function migrateLegacyRunState(state: LegacyRunState): RunState {
  const map = providerToSlot(state);
  const slots = [...map.entries()].map(([provider, id]) => ({ id, provider }));

  const contestants = Object.fromEntries(
    Object.values(state.contestants).map((contestant) => {
      const slot = slotOf(map, contestant.agent);
      const { agent, ...rest } = contestant;
      return [
        slot,
        { id: slot, provider: agent, role: roleOf(state, slot), ...rest },
      ];
    }),
  );

  const attacks = state.attacks.map((attack) => ({
    ...attack,
    origin:
      attack.origin.kind === "contestant"
        ? {
            kind: "contestant" as const,
            contestant: slotOf(map, attack.origin.agent),
            provider: attack.origin.agent,
          }
        : attack.origin,
    targets: attack.targets.map((target) => slotOf(map, target)),
  }));

  const ranking = state.ranking
    ? {
        ...state.ranking,
        winner: state.ranking.winner ? slotOf(map, state.ranking.winner) : null,
        order: state.ranking.order.map((entry) => slotOf(map, entry)),
      }
    : undefined;

  const patchQualityFacts =
    state.schemaVersion === 2
      ? Object.fromEntries(
          Object.entries(state.patchQualityFacts).map(([provider, facts]) => {
            const slot = slotOf(map, provider as AgentId);
            return [slot, { ...facts, contestantId: slot }];
          }),
        )
      : {};

  const patchRecommendation =
    state.schemaVersion === 2 && state.patchRecommendation
      ? {
          ...state.patchRecommendation,
          ...(state.patchRecommendation.contestantId
            ? {
                contestantId: slotOf(
                  map,
                  state.patchRecommendation.contestantId,
                ),
              }
            : {}),
          comparison: state.patchRecommendation.comparison.map((entry) => ({
            ...entry,
            contestantId: slotOf(map, entry.contestantId),
          })),
        }
      : undefined;

  const reviewPrompt =
    state.schemaVersion === 2 && state.reviewPrompt
      ? {
          ...state.reviewPrompt,
          choices: state.reviewPrompt.choices.map((choice) => {
            const slot = slotOf(map, choice.contestantId);
            return {
              ...choice,
              contestantId: slot,
              provider: choice.contestantId,
              role: roleOf(state, slot),
              label: contestantLabel(slots, slot),
            };
          }),
        }
      : undefined;

  const migrated = {
    ...state,
    schemaVersion: 3 as const,
    contestants,
    attacks,
    ...(ranking ? { ranking } : {}),
    patchQualityFacts,
    ...(patchRecommendation ? { patchRecommendation } : {}),
    ...(reviewPrompt ? { reviewPrompt } : {}),
    ...(state.schemaVersion === 2 && state.patchQualityVerdict
      ? { patchQualityVerdict: state.patchQualityVerdict }
      : {}),
    ...(state.schemaVersion === 2 && state.deliveryTarget
      ? { deliveryTarget: state.deliveryTarget }
      : {}),
  };
  const arenaOutcome = deriveArenaOutcome(
    migrated as unknown as Pick<RunState, "contestants" | "ranking">,
  );
  return RunStateV3Schema.parse({ ...migrated, arenaOutcome });
}

export function migrateRunStateV1(state: RunStateV1): RunState {
  return migrateLegacyRunState(state);
}

export function migrateRunStateV2(state: RunStateV2): RunState {
  return migrateLegacyRunState(state);
}

export function parseRunState(value: unknown): RunState {
  const state: AnyRunState = AnyRunStateSchema.parse(value);
  switch (state.schemaVersion) {
    case 1:
    case 2:
      return migrateLegacyRunState(state);
    case 3:
    case 4:
    case 5:
    case 6:
      return state;
    case 7:
      return RunStateV7Schema.parse(state);
    case 8:
      return RunStateV8Schema.parse(state);
    case 9:
      return RunStateV9Schema.parse(state);
  }
}
