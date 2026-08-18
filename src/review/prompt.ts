import { stableId } from "../core/ids.js";
import { contestantLabel } from "../core/labels.js";
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
  const selectableContestants = Object.values(state.contestants).filter(
    (contestant) =>
      Boolean(contestant.finalPatchPath) &&
      (state.config.mode !== "siege" || contestant.role === "defender"),
  );
  const choices = selectableContestants.map((contestant) => {
    const facts = state.patchQualityFacts[contestant.id];
    if (!facts)
      throw new Error(
        `Run has no saved patch digest for ${contestant.id}; hydrate the legacy run before review`,
      );
    const comparison = state.patchRecommendation?.comparison.find(
      (candidate) => candidate.contestantId === contestant.id,
    );
    const eligible =
      comparison?.eligible ??
      (contestant.status !== "eliminated" &&
        Boolean(contestant.finalPatchPath));
    const badges: Array<"recommended" | "arena_champion"> = [];
    if (contestant.id === recommendation) badges.push("recommended");
    if (contestant.id === champion) badges.push("arena_champion");
    return {
      contestantId: contestant.id,
      provider: contestant.provider,
      role: contestant.role,
      label: contestantLabel(state.config.contestants, contestant.id),
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
        contestantId: contestant.id,
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
