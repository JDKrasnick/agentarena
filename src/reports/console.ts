import type { RunState } from "../core/types.js";

export function renderConsoleSummary(state: RunState): string {
  const contestants = Object.values(state.contestants);
  return [
    "Agent Arena — final result",
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
        `${contestant.agent.padEnd(10)} ${String(contestant.finalHealth).padStart(3)} HP  ${contestant.status}`,
    ),
    "",
    state.ranking?.draw
      ? `Draw: ${state.ranking.reason}`
      : `Arena champion: ${state.ranking?.winner ?? "none"} (${String(state.arenaOutcome?.marginHp ?? 0)} HP, ${state.arenaOutcome?.marginClass ?? "unknown"})`,
    `Recommended patch: ${state.patchRecommendation?.contestantId ?? "draw"}`,
    `Recommendation reason: ${state.patchRecommendation?.rationale.join(" ") ?? "run incomplete"}`,
    ...contestants.map((contestant) => {
      const outcome = state.arenaOutcome?.contestants[contestant.agent];
      return `${contestant.agent}: unresolved ${String(outcome?.activeDefectDamage ?? 0)}, recoil ${String(outcome?.permanentRecoil ?? 0)}, gross damage ${String(outcome?.grossDamageReceived ?? 0)}, healed ${String(outcome?.grossHealing ?? 0)}`;
    }),
    "Human review: pending",
    `Artifacts: ${state.artifacts.runDirectory ?? ""}`,
    `Next: agent-arena review ${state.runId}`,
  ].join("\n");
}
