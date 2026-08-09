import { deriveArenaOutcome } from "../outcomes/derive-outcome.js";
import { buildReviewPrompt } from "../review/prompt.js";
import { openRun } from "../review/service.js";
import { selectRecommendedPatch } from "../recommendation/select-patch.js";
import { createCoverageDecision } from "../confidence/assessment.js";
import type { CoverageDecision } from "../core/types.js";
import { renderBattleReport } from "../reports/markdown.js";
import { renderBattleHtml } from "../reports/html.js";
import { renderBattleVisual } from "../reports/visual.js";

export async function resolveCoverage(options: {
  runId: string;
  assessmentDigest: string;
  decision: CoverageDecision["decision"];
  repositoryRoot?: string;
  artifactRoot?: string;
  now?: Date;
}): Promise<CoverageDecision> {
  const { store, state } = await openRun(options);
  const assessment = state.coverageAssessment;
  if (!assessment)
    throw new Error("Legacy run has no coverage assessment to resolve");
  if (assessment.confidence !== "provisional")
    throw new Error(
      "Coverage resolution is only valid for a provisional battle",
    );
  if (assessment.assessmentDigest !== options.assessmentDigest)
    throw new Error("Coverage assessment digest is stale");
  if (state.coverageDecision) {
    if (
      state.coverageDecision.assessmentDigest === options.assessmentDigest &&
      state.coverageDecision.decision === options.decision
    )
      return state.coverageDecision;
    throw new Error(
      "Coverage has already been resolved by an immutable decision",
    );
  }
  const decision = createCoverageDecision({
    runId: state.runId,
    assessmentDigest: options.assessmentDigest,
    decision: options.decision,
    decidedAt: (options.now ?? new Date()).toISOString(),
  });
  state.artifacts.coverageDecision = await store.writeImmutableJson(
    "coverage/decision.json",
    decision,
  );
  state.coverageDecision = decision;
  if (decision.decision === "accept-reduced") {
    state.status = "complete";
    state.arenaOutcome = deriveArenaOutcome(state);
    state.patchRecommendation = selectRecommendedPatch({
      contestants: state.contestants,
      ...(state.ranking?.winner ? { championId: state.ranking.winner } : {}),
      ...(state.patchQualityVerdict
        ? { qualityVerdict: state.patchQualityVerdict }
        : {}),
    });
    state.reviewPrompt = buildReviewPrompt(state);
  } else {
    state.status = "inconclusive";
    if (state.ranking) {
      state.ranking = {
        ...state.ranking,
        winner: null,
        draw: false,
        reason: `Coverage was finalized as inconclusive; ledger order only. ${state.ranking.reason}`,
      };
    }
    if (state.arenaOutcome) delete state.arenaOutcome.championId;
    delete state.patchRecommendation;
    delete state.reviewPrompt;
  }
  await store.writeState(state);
  await store.writeText("BATTLE.md", renderBattleReport(state));
  await store.writeText("BATTLE.html", renderBattleHtml(state));
  await store.writeText("BATTLE.svg", renderBattleVisual(state));
  return decision;
}
