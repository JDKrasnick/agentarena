import { describe, expect, it } from "vitest";
import {
  AttackSubmissionV2Schema,
  FightConfigSchema,
} from "../../src/core/types.js";
import {
  repairAllowanceForSeverity,
  resolveRound,
} from "../../src/core/scoring.js";
import { makeRunState } from "../helpers/run-state.js";
import {
  buildJudgePacket,
  JUDGE_PACKET_MAX_BYTES,
  verifyJudgePacket,
} from "../../src/judge/packets.js";

const attack = (rank: 1 | 2 | 3, paths: string[]) => ({
  rank,
  claim: `rank ${String(rank)} defect`,
  impact: "incorrect observable behavior",
  oracle: {
    expectedBehavior: "the operation succeeds",
    rationale: "the frozen task requires success",
  },
  proposedSeverity: "high" as const,
  confidence: 90,
  focusedCommand: `npm test -- arena-rank-${String(rank)}`,
  paths,
  requiredCapabilities: [],
});

describe("three-role arena contracts", () => {
  it("builds identity-blind digest-linked judge packets within the hard cap", () => {
    const packet = buildJudgePacket({
      kind: "attack",
      task: { request: "preserve data", acceptanceCriteria: ["no loss"] },
      claim: "data is lost",
      oracle: "saved data must remain",
      diagnostics: "x".repeat(30_000),
    });
    expect(JSON.stringify(packet)).not.toContain("contestant");
    expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThanOrEqual(
      JUDGE_PACKET_MAX_BYTES,
    );
    expect(packet.diagnosticsTruncated).toBe(true);
    expect(verifyJudgePacket(packet)).toBe(true);
  });

  it("accepts explicit empty and sparse independent V2 attack overlays", () => {
    expect(
      AttackSubmissionV2Schema.parse({ version: 2, attacks: [] }).attacks,
    ).toEqual([]);
    const parsed = AttackSubmissionV2Schema.parse({
      version: 2,
      sharedSupportPaths: ["test/support/arena.ts"],
      attacks: [
        attack(1, ["test/arena-one.test.ts"]),
        attack(3, ["test/arena-three.test.ts"]),
      ],
    });
    expect(parsed.attacks.map((entry) => entry.rank)).toEqual([1, 3]);
  });

  it("rejects shared/rank overlap and rank-path overlap", () => {
    expect(() =>
      AttackSubmissionV2Schema.parse({
        version: 2,
        sharedSupportPaths: ["test/shared.ts"],
        attacks: [
          attack(1, ["test/shared.ts"]),
          attack(2, ["test/duplicate.ts"]),
          attack(3, ["test/duplicate.ts"]),
        ],
      }),
    ).toThrow();
  });

  it("normalizes legacy verifier configuration into the public judge role", () => {
    const config = FightConfigSchema.parse({
      ...makeRunState().config,
      judge: undefined,
      attackVerifier: "gemini",
    });
    expect(config.judge).toBe("gemini");
  });

  it("assigns three repair attempts to critical/high and two to medium/low", () => {
    expect(repairAllowanceForSeverity("critical")).toBe(3);
    expect(repairAllowanceForSeverity("high")).toBe(3);
    expect(repairAllowanceForSeverity("medium")).toBe(2);
    expect(repairAllowanceForSeverity("low")).toBe(2);

    const state = makeRunState();
    const resolution = resolveRound(
      state.contestants,
      [
        {
          id: "high-defect",
          round: 1,
          origin: { kind: "contestant", contestant: "a", provider: "codex" },
          rank: 1,
          targets: ["b"],
          claim: "failure",
          impact: "major",
          oracle: { expectedBehavior: "works", rationale: "required" },
          assertionFingerprint: "fingerprint",
          requiredCapabilities: [],
          patchPath: "attack.diff",
          focusedCommand: "npm test",
          status: "landed",
          rootDefectId: "canonical-high",
          severity: "high",
          evidenceProvenance: "mechanical",
          checks: [],
        },
      ],
      1,
    );
    expect(
      resolution.contestants.b?.healthLedger.canonicalDefects?.[0],
    ).toMatchObject({ repairAllowance: 3, repairAttemptsUsed: 0 });
  });
});
