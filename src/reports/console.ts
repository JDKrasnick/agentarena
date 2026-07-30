import type { RunState } from "../core/types.js";
import { contestantLabel } from "../core/labels.js";

export function renderConsoleSummary(state: RunState): string {
  const contestants = Object.values(state.contestants);
  return [
    "Agent Arena — final result",
    `Mode: ${state.config.mode}`,
    `Rounds completed: ${String(
      Math.max(
        0,
        ...contestants.flatMap((contestant) =>
          contestant.rounds
            .filter((round) => typeof round.round === "number")
            .map((round) => Number(round.round)),
        ),
      ),
    )}/3`,
    "",
    ...contestants.map(
      (contestant) =>
        `${contestantLabel(state.config.contestants, contestant.id).padEnd(10)} ${String(contestant.finalHealth).padStart(3)} HP  ${contestant.status}`,
    ),
    "",
    state.ranking?.draw
      ? `Draw: ${state.ranking.reason}`
      : `Arena champion: ${state.ranking?.winner ?? "none"} (${String(state.arenaOutcome?.marginHp ?? 0)} HP, ${state.arenaOutcome?.marginClass ?? "unknown"})`,
    state.config.mode === "siege"
      ? "Production artifact: defender final patch only"
      : `Recommended patch: ${state.patchRecommendation?.contestantId ?? "draw"}`,
    state.config.mode === "siege"
      ? "Patch comparison: disabled for asymmetric siege"
      : `Recommendation reason: ${state.patchRecommendation?.rationale.join(" ") ?? "run incomplete"}`,
    ...contestants.map((contestant) => {
      const outcome = state.arenaOutcome?.contestants[contestant.id];
      return `${contestantLabel(state.config.contestants, contestant.id)}: unresolved ${String(outcome?.activeDefectDamage ?? 0)}, recoil ${String(outcome?.permanentRecoil ?? 0)}, gross damage ${String(outcome?.grossDamageReceived ?? 0)}, healed ${String(outcome?.grossHealing ?? 0)}`;
    }),
    "Human review: pending",
    `Artifacts: ${state.artifacts.runDirectory ?? ""}`,
    `Next: agent-arena review ${state.runId}`,
  ].join("\n");
}
