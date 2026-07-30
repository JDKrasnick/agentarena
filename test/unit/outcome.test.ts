import { describe, expect, it } from "vitest";
import {
  classifyMargin,
  deriveArenaOutcome,
} from "../../src/outcomes/derive-outcome.js";
import { makeRunState } from "../helpers/run-state.js";

describe("arena outcome", () => {
  it.each([
    [0, "tied"],
    [5, "razor_thin"],
    [10, "narrow"],
    [15, "clear"],
  ] as const)("classifies a %i HP margin as %s", (margin, expected) => {
    expect(classifyMargin(margin)).toBe(expected);
  });

  it("explains a 100–95 recoil-only result", () => {
    const outcome = deriveArenaOutcome(makeRunState());
    expect(outcome).toMatchObject({
      championId: "a",
      marginHp: 5,
      marginClass: "razor_thin",
      decidingFactors: ["recoil"],
    });
    expect(outcome.contestants.b).toMatchObject({
      grossDamageReceived: 0,
      grossHealing: 0,
      activeDefectDamage: 0,
      permanentRecoil: 5,
    });
  });
});
