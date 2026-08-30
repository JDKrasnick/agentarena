import { describe, expect, it } from "vitest";
import {
  applyChallengeCorrections,
  challengeCorrectionRecoil,
  defectEvidenceAttacks,
  healDefect,
  normalizeAttackAdjudication,
  PARTIAL_DAMAGE_BY_SEVERITY,
  rankContestants,
  repairEvidenceAttacks,
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
  it("records a shared defect without damage or recoil", () => {
    const shared: Attack = {
      ...attacks()[0]!,
      id: "shared",
      targets: ["a", "b"],
      status: "shared_defect",
      damage: undefined,
      damageActive: false,
    };
    shared.adjudication = normalizeAttackAdjudication(shared);

    const resolved = resolveRound(
      { a: contestant("a"), b: contestant("b") },
      [shared],
      1,
    );

    expect(shared.adjudication).toMatchObject({
      verdict: "valid",
      scoreEffect: "none",
      exactAmount: 0,
      multiplier: 0,
    });
    expect(resolved.contestants.a?.finalHealth).toBe(100);
    expect(resolved.contestants.b?.finalHealth).toBe(100);
    expect(resolved.eventsApplied).toBe(0);
  });

  it("refunds recoil and applies replacement damage for an overturned rejection", () => {
    const rejected = {
      ...attacks()[1]!,
      id: "prior-rejection",
      origin: {
        kind: "contestant" as const,
        contestant: "a" as const,
        provider: "codex" as const,
      },
      rank: 1 as const,
      targets: ["b" as const],
    };
    rejected.adjudication = normalizeAttackAdjudication(rejected);
    const afterPrior = resolveRound(
      { a: contestant("a"), b: contestant("b") },
      [rejected],
      1,
    ).contestants;
    const challenge = {
      ...attacks()[0]!,
      id: "overturn-rejection",
      round: 2 as const,
    };
    challenge.adjudication = {
      ...normalizeAttackAdjudication(challenge),
      relationship: "overturn" as const,
      priorAdjudicationId: rejected.adjudication.id,
      supersedesAdjudicationId: rejected.adjudication.id,
    };
    const corrected = applyChallengeCorrections(
      afterPrior,
      [rejected],
      [challenge],
      2,
    );
    const final = resolveRound(corrected, [challenge], 2).contestants;
    expect(final.a?.healthLedger.permanentRecoil).toBe(0);
    expect(final.a?.healthEvents.at(-1)).toMatchObject({
      type: "score_correction",
      amount: 5,
    });
    expect(final.b?.finalHealth).toBe(70);
  });

  it("keeps prior damage when an unable verdict claims to overturn it", () => {
    const prior = attacks()[0]!;
    prior.adjudication = normalizeAttackAdjudication(prior);
    const afterPrior = resolveRound(
      { a: contestant("a"), b: contestant("b") },
      [prior],
      1,
    ).contestants;
    const challenge: Attack = {
      ...attacks()[1]!,
      id: "overturn-valid",
      round: 2,
      status: "judge_unable",
      adjudication: {
        ...normalizeAttackAdjudication({
          ...attacks()[1]!,
          id: "overturn-valid",
          round: 2,
          status: "judge_unable",
        }),
        relationship: "overturn",
        priorAdjudicationId: prior.adjudication.id,
        supersedesAdjudicationId: prior.adjudication.id,
      },
    };
    const corrected = applyChallengeCorrections(
      afterPrior,
      [prior],
      [challenge],
      2,
    );
    expect(corrected.b?.finalHealth).toBe(70);
    expect(corrected.b?.healthLedger.activeDefects).toHaveLength(1);
    expect(corrected.b?.healthLedger.canonicalDefects?.[0]).toMatchObject({
      status: "active",
    });
    expect(
      corrected.b?.healthEvents.filter(
        (event) => event.type === "score_correction",
      ),
    ).toEqual([]);
  });

  it("reports original-rank recoil for a valid-to-rejected overturn", () => {
    const prior = attacks()[0]!;
    prior.rank = 1;
    prior.adjudication = normalizeAttackAdjudication(prior);
    const challenge: Attack = {
      ...attacks()[1]!,
      id: "rejected-overturn",
      rank: 3,
      round: 2,
      status: "judge_rejected",
    };
    challenge.adjudication = {
      ...normalizeAttackAdjudication(challenge),
      relationship: "overturn",
      priorAdjudicationId: prior.adjudication.id,
      supersedesAdjudicationId: prior.adjudication.id,
      scoreEffect: "none",
      exactAmount: 0,
      recoilAmount: undefined,
    };

    expect(challengeCorrectionRecoil([prior, challenge], challenge)).toBe(5);
  });

  it("applies only one correction when two challenges name the same decision", () => {
    const prior = attacks()[0]!;
    prior.adjudication = normalizeAttackAdjudication(prior);
    const afterPrior = resolveRound(
      { a: contestant("a"), b: contestant("b") },
      [prior],
      1,
    ).contestants;
    const challenges = ["first", "second"].map((id) => {
      const challenge: Attack = {
        ...attacks()[1]!,
        id: `${id}-replacement`,
        round: 2,
        rank: 3,
      };
      challenge.adjudication = {
        ...normalizeAttackAdjudication(challenge),
        relationship: "overturn",
        priorAdjudicationId: prior.adjudication!.id,
        supersedesAdjudicationId: prior.adjudication!.id,
        scoreEffect: "none",
        exactAmount: 0,
        recoilAmount: undefined,
      };
      return challenge;
    });

    const corrected = applyChallengeCorrections(
      afterPrior,
      [prior, ...challenges],
      challenges,
      2,
    );

    expect(corrected.a?.healthLedger.permanentRecoil).toBe(5);
    expect(
      corrected.a?.healthEvents.filter(
        (event) => event.type === "score_correction",
      ),
    ).toHaveLength(1);
    expect(corrected.b?.healthLedger.activeDefects).toEqual([]);
  });

  it("applies only the damage delta for a severity overturn", () => {
    const prior = attacks()[0]!;
    prior.adjudication = normalizeAttackAdjudication(prior);
    const afterPrior = resolveRound(
      { a: contestant("a"), b: contestant("b") },
      [prior],
      1,
    ).contestants;
    const challenge: Attack = {
      ...prior,
      id: "severity-overturn",
      round: 2,
      severity: "medium",
      adjudication: {
        ...normalizeAttackAdjudication({
          ...prior,
          id: "severity-overturn",
          round: 2,
          severity: "medium",
          adjudication: undefined,
        }),
        severity: "medium",
        exactAmount: 0,
        scoreEffect: "none",
        relationship: "overturn",
        priorAdjudicationId: prior.adjudication.id,
        supersedesAdjudicationId: prior.adjudication.id,
      },
    };
    const corrected = applyChallengeCorrections(
      afterPrior,
      [prior],
      [challenge],
      2,
    );
    expect(corrected.b?.finalHealth).toBe(85);
    expect(corrected.b?.healthEvents.at(-1)).toMatchObject({
      type: "score_correction",
      amount: 15,
    });
    expect(corrected.b?.healthLedger.activeDefects[0]).toMatchObject({
      severity: "medium",
      damage: 15,
    });
  });

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

  it("reactivates healed damage for an affirm without scoring it twice", () => {
    const original = attacks()[0]!;
    original.adjudication = normalizeAttackAdjudication(original);
    const landed = resolveRound(
      { a: contestant("a"), b: contestant("b") },
      [original],
      1,
    ).contestants.b!;
    const healed = healDefect(landed, "root", 1);
    const affirm: Attack = {
      ...original,
      id: "affirm-variant",
      round: 2,
      adjudication: {
        ...original.adjudication,
        id: "adjudication:affirm-variant",
        relationship: "affirm",
        priorAdjudicationId: original.adjudication.id,
        scoreEffect: "none",
        exactAmount: 0,
      },
    };

    const affirmed = resolveRound(
      { a: contestant("a"), b: healed },
      [affirm],
      2,
    );
    expect(affirmed.contestants.b).toMatchObject({
      finalHealth: 70,
      healthLedger: {
        activeDefects: [
          { rootDefectId: "root", attackId: "affirm-variant", damage: 30 },
        ],
        canonicalDefects: [
          {
            rootDefectId: "root",
            status: "active",
            repairAttemptsUsed: 0,
            repairAttemptIds: [],
            regressionResets: 1,
          },
        ],
      },
    });
    expect(affirmed.eventsApplied).toBe(1);

    const repeated = resolveRound(affirmed.contestants, [affirm], 2);
    expect(repeated.contestants.b?.finalHealth).toBe(70);
    expect(repeated.eventsApplied).toBe(0);
  });

  it("selects every accepted reproducer for a canonical defect", () => {
    const original = attacks()[0]!;
    const affirm = {
      ...original,
      id: "affirm-variant",
      round: 2 as const,
    };
    const shared = {
      ...original,
      id: "shared-variant",
      status: "shared_defect" as const,
    };
    const unrelated = { ...original, id: "other", rootDefectId: "other" };
    const superseded = {
      ...original,
      id: "superseded",
      adjudication: { ...normalizeAttackAdjudication(original), id: "old" },
    };
    const replacement = {
      ...original,
      id: "replacement",
      adjudication: {
        ...normalizeAttackAdjudication(original),
        id: "replacement-adjudication",
        supersedesAdjudicationId: "old",
      },
    };

    expect(
      defectEvidenceAttacks(
        [original, affirm, shared, unrelated, superseded, replacement],
        "b",
        "root",
      ).map((attack) => attack.id),
    ).toEqual(["land", "affirm-variant", "shared-variant", "replacement"]);
  });

  it("expands one canonical repair unit into every non-overturned evidence case", () => {
    const original = attacks()[0]!;
    const sibling = { ...original, id: "same-root-sibling" };
    const otherRoot = { ...original, id: "other", rootDefectId: "other" };

    expect(
      repairEvidenceAttacks([original, sibling, otherRoot], "b", [
        sibling,
        otherRoot,
      ]).map((attack) => attack.id),
    ).toEqual(["land", "same-root-sibling", "other"]);
  });
});
