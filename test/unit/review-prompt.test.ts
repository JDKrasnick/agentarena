import { describe, expect, it } from "vitest";
import { deriveArenaOutcome } from "../../src/outcomes/derive-outcome.js";
import { selectRecommendedPatch } from "../../src/recommendation/select-patch.js";
import { buildReviewPrompt } from "../../src/review/prompt.js";
import { makeRunState } from "../helpers/run-state.js";

describe("review prompt", () => {
  it("keeps recommendation and arena champion badges independent", () => {
    const prompt = buildReviewPrompt(makeRunState());
    expect(
      prompt.choices.find((choice) => choice.contestantId === "b")?.badges,
    ).toEqual(["recommended"]);
    expect(
      prompt.choices.find((choice) => choice.contestantId === "a")?.badges,
    ).toEqual(["arena_champion"]);
    expect(prompt.promptId).toHaveLength("review-".length + 16);
  });

  it("offers eligible explicit choices without inventing a champion badge for a non-discriminating battle", () => {
    const state = makeRunState();
    state.coverageAssessment = {
      version: 3,
      runId: state.runId,
      mode: "duel",
      confidence: "full_confidence",
      requiredLanes: [],
      counts: { required: 6, completed: 6, degraded: 0, unresolved: 0 },
      evidenceCounts: {
        mechanical: 0,
        judgeConfirmed: 0,
        judgePartial: 0,
        judgeRejected: 0,
        explicitEmpty: 6,
      },
      reasonCodes: [],
      retryHistory: [],
      assessmentDigest: "e".repeat(64),
    };
    const outcome = deriveArenaOutcome(state);
    state.arenaOutcome = outcome;
    state.patchRecommendation = selectRecommendedPatch({
      contestants: state.contestants,
      outcomeKind: outcome.kind,
    });

    const prompt = buildReviewPrompt(state);
    expect(prompt.choices).toHaveLength(2);
    expect(prompt.choices.every((choice) => choice.eligible)).toBe(true);
    expect(prompt.choices.flatMap((choice) => choice.badges)).not.toContain(
      "arena_champion",
    );
    expect(prompt.choices.flatMap((choice) => choice.badges)).not.toContain(
      "recommended",
    );
  });
});
