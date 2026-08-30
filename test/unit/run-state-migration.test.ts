import { describe, expect, it } from "vitest";
import { parseRunState } from "../../src/core/run-state.js";
import { makeRunState } from "../helpers/run-state.js";

describe("legacy run-state migration", () => {
  it("reads v3 state with its task-contract hash without inventing a RunSpec hash", () => {
    const current = makeRunState();
    const legacy = {
      ...current,
      schemaVersion: 3,
      taskContractHash: "legacy-contract",
      harnessOverlays: [],
      reconciliationQueue: [],
    };
    Reflect.deleteProperty(legacy, "runSpecHash");
    const parsed = parseRunState(legacy);
    expect(parsed.schemaVersion).toBe(3);
    if (parsed.schemaVersion !== 3) throw new Error("expected v3 state");
    expect(parsed.taskContractHash).toBe("legacy-contract");
    expect(parsed).not.toHaveProperty("runSpecHash");
  });

  it("defaults additive integrity fields for existing v4 artifacts", () => {
    const existing = makeRunState();
    const value = structuredClone(existing) as Record<string, unknown>;
    delete value.integrity;
    delete value.operatorInterventions;
    const parsed = parseRunState(value);
    expect(parsed.integrity).toBe("competitive");
    expect(parsed.operatorInterventions).toEqual([]);
  });

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
      taskContractHash: "legacy-contract",
      harnessOverlays: [],
      reconciliationQueue: [],
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
    Reflect.deleteProperty(legacy, "runSpecHash");
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

  it("reads legacy v8 outcomes while requiring versioned outcomes for current v10 state", () => {
    const current = makeRunState();
    expect(parseRunState(current)).toMatchObject({
      schemaVersion: 10,
      arenaOutcome: { version: 2, kind: "winner" },
    });

    const legacy = structuredClone(current) as Record<string, unknown>;
    legacy.schemaVersion = 8;
    const outcome = legacy.arenaOutcome as Record<string, unknown>;
    delete outcome.version;
    delete outcome.kind;
    delete outcome.decisionBasis;
    delete outcome.competitiveLandingCount;
    delete outcome.sharedDefectCount;
    delete outcome.explicitEmptyLaneCount;

    expect(parseRunState(legacy)).toMatchObject({
      schemaVersion: 8,
      arenaOutcome: { championId: "a" },
    });
  });
});
