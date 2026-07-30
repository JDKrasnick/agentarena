import { describe, expect, it } from "vitest";
import { buildReviewPrompt } from "../../src/review/prompt.js";
import { makeRunState } from "../helpers/run-state.js";

describe("review prompt", () => {
  it("keeps recommendation and arena champion badges independent", () => {
    const prompt = buildReviewPrompt(makeRunState());
    expect(
      prompt.choices.find((choice) => choice.contestantId === "claude")?.badges,
    ).toEqual(["recommended"]);
    expect(
      prompt.choices.find((choice) => choice.contestantId === "codex")?.badges,
    ).toEqual(["arena_champion"]);
    expect(prompt.promptId).toHaveLength("review-".length + 16);
  });
});
