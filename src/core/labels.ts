import type { AgentId, ContestantId, RunState } from "./types.js";

const PROVIDER_DISPLAY: Record<AgentId, string> = {
  codex: "Codex",
  claude: "Claude",
  gemini: "Gemini",
};

export function providerDisplayName(provider: AgentId): string {
  return PROVIDER_DISPLAY[provider];
}

interface Slot {
  id: ContestantId;
  provider: AgentId;
}

/**
 * Render a contestant's display name. Two contestants using the same provider
 * (a mirror match) are disambiguated by slot, e.g. `Codex A` and `Codex B`.
 */
export function contestantLabel(
  contestants: readonly Slot[],
  id: ContestantId,
): string {
  const self = contestants.find((contestant) => contestant.id === id);
  if (!self) return id.toUpperCase();
  const duplicated =
    contestants.filter((contestant) => contestant.provider === self.provider)
      .length > 1;
  return duplicated
    ? `${PROVIDER_DISPLAY[self.provider]} ${id.toUpperCase()}`
    : PROVIDER_DISPLAY[self.provider];
}

export function contestantSlots(state: Pick<RunState, "config">): Slot[] {
  return state.config.contestants.map((contestant) => ({
    id: contestant.id,
    provider: contestant.provider,
  }));
}

export function labelForState(
  state: Pick<RunState, "config">,
  id: ContestantId,
): string {
  return contestantLabel(contestantSlots(state), id);
}
