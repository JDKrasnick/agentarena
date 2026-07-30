import { describe, expect, it } from "vitest";
import { assertTransition } from "../../src/core/state-machine.js";

describe("state machine", () => {
  it("accepts the normal persisted path", () => {
    expect(() =>
      assertTransition("implement", "initial_validate"),
    ).not.toThrow();
    expect(() =>
      assertTransition("validate_repairs", "collect_attacks"),
    ).not.toThrow();
  });

  it("rejects stage skipping", () => {
    expect(() => assertTransition("implement", "complete")).toThrow(
      /Invalid arena transition/,
    );
  });
});
