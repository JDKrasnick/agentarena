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
      : `Winner: ${state.ranking?.winner ?? "none"}`,
    `Reason: ${state.ranking?.reason ?? "run incomplete"}`,
    `Artifacts: ${state.artifacts.runDirectory ?? ""}`,
    ...(state.ranking?.winner
      ? [
          `Apply: agent-arena apply ${state.runId} --agent ${state.ranking.winner}`,
        ]
      : []),
  ].join("\n");
}
