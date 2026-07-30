import { stableId } from "../core/ids.js";
import {
  ReviewPromptSchema,
  type ReviewPrompt,
  type RunState,
} from "../core/types.js";

export function buildReviewPrompt(state: RunState): ReviewPrompt {
  if (!state.config.baseCommit)
    throw new Error("Run has no frozen base commit");
  const recommendation = state.patchRecommendation?.contestantId;
  const champion = state.arenaOutcome?.championId ?? state.ranking?.winner;
  const choices = Object.values(state.contestants).map((contestant) => {
    const facts = state.patchQualityFacts[contestant.agent];
    if (!facts)
      throw new Error(
        `Run has no saved patch digest for ${contestant.agent}; hydrate the legacy run before review`,
      );
    const comparison = state.patchRecommendation?.comparison.find(
      (candidate) => candidate.contestantId === contestant.agent,
    );
    const eligible =
      comparison?.eligible ??
      (contestant.status !== "eliminated" &&
        Boolean(contestant.finalPatchPath));
    const badges: Array<"recommended" | "arena_champion"> = [];
    if (contestant.agent === recommendation) badges.push("recommended");
    if (contestant.agent === champion) badges.push("arena_champion");
    return {
      contestantId: contestant.agent,
      eligible,
      badges,
      summary: `${String(contestant.finalHealth)} HP; ${String(
        contestant.healthLedger.activeDefects.reduce(
          (total, defect) => total + defect.damage,
          0,
        ),
      )} unresolved damage; ${String(contestant.healthLedger.permanentRecoil)} recoil`,
      patchSha256: facts.patchSha256,
      ...(!eligible
        ? {
            disabledReason:
              comparison && !comparison.requiredValidationPassed
                ? "Required final validation did not pass."
                : "Patch is not eligible for application.",
          }
        : {}),
    };
  });
  const promptId = stableId(
    "review",
    state.runId,
    state.config.baseCommit,
    ...choices.map(
      (choice) =>
        `${choice.contestantId}:${choice.patchSha256}:${String(choice.eligible)}`,
    ),
    recommendation ?? "draw",
    JSON.stringify(
      Object.values(state.contestants).map((contestant) => ({
        contestantId: contestant.agent,
        finalHealth: contestant.finalHealth,
        checks: contestant.checks.map((check) => ({
          id: check.id,
          kind: check.kind,
          status: check.status,
        })),
      })),
    ),
    JSON.stringify(state.patchRecommendation?.comparison ?? []),
  );
  return ReviewPromptSchema.parse({
    version: 1,
    runId: state.runId,
    promptId,
    baseCommit: state.config.baseCommit,
    choices,
    actions: ["inspect", "compare", "reject_all", "leave_pending"],
  });
}
