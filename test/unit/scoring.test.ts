import { describe, expect, it } from "vitest";
import {
  healDefect,
  rankContestants,
  resolveRound,
} from "../../src/core/scoring.js";
import type { Attack, ContestantResult } from "../../src/core/types.js";

function contestant(
  agent: "codex" | "claude",
  patchSize = 20,
): ContestantResult {
  return {
    agent,
    status: "pending",
    initialHealth: 100,
    finalHealth: 100,
    replacementCredits: [],
    healthLedger: {
      permanentRecoil: 0,
      activeDefects: [],
      eliminatedByRequiredCheck: false,
    },
    healthEvents: [],
    patchSize,
    rounds: [],
    checks: [],
  };
}

function attacks(): Attack[] {
  return [
    {
      id: "land",
      round: 1,
      origin: { kind: "contestant", agent: "codex" },
      rank: 1,
      targets: ["claude"],
      claim: "core defect",
      impact: "wrong result",
      oracle: {
        expectedBehavior: "right",
        sourceId: "task",
        sourceLocation: "line 1",
        rationale: "specified",
      },
      assertionFingerprint: "a",
      requiredCapabilities: [],
      patchPath: "attack.diff",
      focusedCommand: "test",
      status: "landed",
      rootDefectId: "root",
      severity: "high",
      damage: 30,
      checks: [],
    },
    {
      id: "miss",
      round: 1,
      origin: { kind: "contestant", agent: "claude" },
      rank: 2,
      targets: ["codex"],
      claim: "guess",
      impact: "none",
      oracle: {
        expectedBehavior: "right",
        sourceId: "task",
        sourceLocation: "line 1",
        rationale: "specified",
      },
      assertionFingerprint: "b",
      requiredCapabilities: [],
      patchPath: "miss.diff",
      focusedCommand: "test",
      status: "blocked",
      checks: [],
    },
  ];
}

describe("ledger scoring", () => {
  it("resolves damage and recoil independently of attack processing order", () => {
    const contestants = {
      codex: contestant("codex"),
      claude: contestant("claude"),
    };
    const forward = resolveRound(contestants, attacks(), 1).contestants;
    const reverse = resolveRound(
      contestants,
      attacks().reverse(),
      1,
    ).contestants;
    expect(forward).toEqual(reverse);
    expect(forward.claude?.finalHealth).toBe(60);
    expect(forward.claude?.healthLedger.permanentRecoil).toBe(10);
  });

  it("heals defect damage without restoring permanent recoil", () => {
    const damaged = resolveRound(
      { codex: contestant("codex"), claude: contestant("claude") },
      attacks(),
      1,
    ).contestants.claude;
    expect(damaged).toBeDefined();
    const healed = healDefect(damaged!, "root", 1);
    expect(healed.finalHealth).toBe(90);
    expect(healed.healthLedger.permanentRecoil).toBe(10);
  });

  it("ranks by health, then patch size, then draws", () => {
    const codex = contestant("codex", 10);
    const claude = contestant("claude", 20);
    expect(rankContestants([codex, claude]).winner).toBe("codex");
    claude.patchSize = 10;
    expect(rankContestants([codex, claude]).draw).toBe(true);
  });
});
