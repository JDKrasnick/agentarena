import { describe, expect, it } from "vitest";
import { parseRunState } from "../../src/core/run-state.js";
import { makeRunState } from "../helpers/run-state.js";

describe("legacy run-state migration", () => {
  it("loads a provider-keyed v1 fixture into stable contestant slots", () => {
    const current = makeRunState();
    const { a, b } = current.contestants;
    if (!a || !b) throw new Error("fixture contestants are required");
    const toLegacy = (contestant: typeof a, agent: "codex" | "claude") => {
      const legacy = { ...contestant, agent };
      Reflect.deleteProperty(legacy, "id");
      Reflect.deleteProperty(legacy, "provider");
      Reflect.deleteProperty(legacy, "role");
      return legacy;
    };
    const legacy = {
      ...current,
      schemaVersion: 1,
      contestants: {
        codex: toLegacy(a, "codex"),
        claude: toLegacy(b, "claude"),
      },
      ranking: {
        winner: "codex",
        draw: false,
        order: ["codex", "claude"],
        reason: "higher health",
      },
    };
    const migrated = parseRunState(legacy);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.contestants.a).toMatchObject({
      id: "a",
      provider: "codex",
    });
    expect(migrated.contestants.b).toMatchObject({
      id: "b",
      provider: "claude",
    });
    expect(migrated.ranking).toMatchObject({
      winner: "a",
      order: ["a", "b"],
    });
  });
});
