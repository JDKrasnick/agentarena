import { describe, expect, it } from "vitest";
import {
  healDefect,
  normalizeAttackAdjudication,
  PARTIAL_DAMAGE_BY_SEVERITY,
  rankContestants,
  resolveRound,
} from "../../src/core/scoring.js";
import type { Attack, ContestantResult } from "../../src/core/types.js";

function contestant(id: "a" | "b", patchSize = 20): ContestantResult {
  return {
    id,
    provider: id === "a" ? "codex" : "claude",
    role: "solver",
    status: "pending",
    initialHealth: 100,
    finalHealth: 100,
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
      origin: { kind: "contestant", contestant: "a", provider: "codex" },
      rank: 1,
      targets: ["b"],
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
      origin: { kind: "contestant", contestant: "b", provider: "claude" },
      rank: 2,
      targets: ["a"],
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
      a: contestant("a"),
      b: contestant("b"),
    };
    const forward = resolveRound(contestants, attacks(), 1).contestants;
    const reverse = resolveRound(
      contestants,
      attacks().reverse(),
      1,
    ).contestants;
    expect(forward).toEqual(reverse);
    expect(forward.b?.finalHealth).toBe(60);
    expect(forward.b?.healthLedger.permanentRecoil).toBe(10);
  });

  it("heals defect damage without restoring permanent recoil", () => {
    const damaged = resolveRound(
      { a: contestant("a"), b: contestant("b") },
      attacks(),
      1,
    ).contestants.b;
    expect(damaged).toBeDefined();
    const healed = healDefect(damaged!, "root", 1);
    expect(healed.finalHealth).toBe(90);
    expect(healed.healthLedger.permanentRecoil).toBe(10);
  });

  it("ranks by health, then patch size, then draws", () => {
    const codex = contestant("a", 10);
    const claude = contestant("b", 20);
    expect(rankContestants([codex, claude]).winner).toBe("a");
    claude.patchSize = 10;
    expect(rankContestants([codex, claude]).draw).toBe(true);
  });

  it("uses exact 35% values and applies only the definitive-evidence upgrade delta", () => {
    const partial = {
      ...attacks()[0]!,
      id: "partial",
      severity: "medium" as const,
      damage: 50 as const,
      evidenceProvenance: "judge_partial" as const,
    };
    expect(PARTIAL_DAMAGE_BY_SEVERITY).toEqual({
      critical: 17.5,
      high: 10.5,
      medium: 5.25,
      low: 1.75,
    });
    const first = resolveRound(
      { a: contestant("a"), b: contestant("b") },
      [partial],
      1,
    ).contestants;
    expect(first.b?.finalHealth).toBe(94.75);

    const corroboration = {
      ...partial,
      id: "definitive",
      round: 2 as const,
      status: "duplicate" as const,
      severity: "critical" as const,
      evidenceProvenance: "mechanical" as const,
    };
    const upgradedRound = resolveRound(first, [corroboration], 2).contestants;
    const upgraded = upgradedRound.b!;
    expect(upgraded.finalHealth).toBe(85);
    expect(upgraded.healthEvents.at(-1)).toMatchObject({
      type: "damage_upgrade",
      amount: -9.75,
    });
    expect(upgraded.healthLedger.canonicalDefects?.[0]).toMatchObject({
      baseSeverity: "medium",
      currentMultiplier: 1,
      currentDamage: 15,
    });
    expect(upgradedRound.a).toMatchObject({
      finalHealth: 95,
      healthLedger: { permanentRecoil: 5 },
    });
    expect(upgradedRound.a?.healthEvents.at(-1)).toMatchObject({
      type: "recoil",
      amount: -5,
      adjudicationId: "adjudication:definitive",
    });
    expect(healDefect(upgraded, "root", 2).finalHealth).toBe(100);
  });

  it("normalizes legacy outcomes and ignores caller-supplied damage", () => {
    const attack = { ...attacks()[0]!, damage: 5 as const };
    expect(normalizeAttackAdjudication(attack)).toMatchObject({
      verdict: "valid",
      evidenceBasis: "legacy_unknown",
      multiplier: 1,
      exactAmount: 30,
    });
    expect(
      resolveRound({ a: contestant("a"), b: contestant("b") }, [attack], 1)
        .contestants.b?.finalHealth,
    ).toBe(70);
  });

  it("rejects an embedded recoil amount that does not match attack rank", () => {
    const attack = attacks()[1]!;
    expect(() =>
      resolveRound(
        { a: contestant("a"), b: contestant("b") },
        [
          {
            ...attack,
            adjudication: {
              ...normalizeAttackAdjudication(attack),
              exactAmount: 50,
            },
          },
        ],
        1,
      ),
    ).toThrow(/does not match rank-2 recoil 10/);
  });

  it("does not create target damage for a duplicate with no target score effect", () => {
    const duplicate = {
      ...attacks()[0]!,
      status: "duplicate" as const,
      evidenceProvenance: "mechanical" as const,
    };
    const resolved = resolveRound(
      { a: contestant("a"), b: contestant("b") },
      [duplicate],
      1,
    ).contestants;
    expect(resolved.a).toMatchObject({
      finalHealth: 95,
      healthLedger: { permanentRecoil: 5 },
    });
    expect(resolved.b).toMatchObject({
      finalHealth: 100,
      healthLedger: { activeDefects: [], canonicalDefects: [] },
    });
  });

  it("upgrades healed provenance without damage and reactivates only a genuine regression", () => {
    const partial = {
      ...attacks()[0]!,
      id: "partial-healed",
      severity: "low" as const,
      evidenceProvenance: "judge_partial" as const,
    };
    const landed = resolveRound(
      { a: contestant("a"), b: contestant("b") },
      [partial],
      1,
    ).contestants.b!;
    const healed = healDefect(landed, "root", 1);
    const proof = {
      ...partial,
      id: "proof-after-heal",
      round: 2 as const,
      status: "duplicate" as const,
      evidenceProvenance: "mechanical" as const,
    };
    const corroboratedRound = resolveRound(
      { a: contestant("a"), b: healed },
      [proof],
      2,
    ).contestants;
    const corroborated = corroboratedRound.b!;
    expect(corroborated.finalHealth).toBe(100);
    expect(corroborated.healthLedger.canonicalDefects?.[0]).toMatchObject({
      currentMultiplier: 1,
      currentDamage: 5,
      status: "healed",
    });

    const regression = {
      ...proof,
      id: "regression",
      round: 3 as const,
      adjudication: {
        ...normalizeAttackAdjudication(proof),
        id: "adjudication:regression",
        duplicateState: "regression" as const,
        scoreEffect: "damage" as const,
        exactAmount: 5,
      },
    };
    const regressed = resolveRound(
      { a: corroboratedRound.a!, b: corroborated },
      [regression],
      3,
    ).contestants.b!;
    expect(regressed.finalHealth).toBe(95);
    expect(regressed.healthLedger.canonicalDefects?.[0]?.status).toBe("active");
  });
});
