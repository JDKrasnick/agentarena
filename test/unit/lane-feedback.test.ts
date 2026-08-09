import { describe, expect, it } from "vitest";
import type { Attack, RunState } from "../../src/core/types.js";
import {
  FEEDBACK_INLINE_LIMIT_BYTES,
  projectContestantFeedback,
} from "../../src/recovery/feedback.js";
import { canonicalJson } from "../../src/contracts/round.js";
import { makeRunState } from "../helpers/run-state.js";

function attack(
  id: string,
  origin: "a" | "b",
  target: "a" | "b",
  overrides: Partial<Attack> = {},
): Attack {
  return {
    id,
    round: 1,
    origin: {
      kind: "contestant",
      contestant: origin,
      provider: origin === "a" ? "codex" : "claude",
    },
    rank: 1,
    targets: [target],
    claim: `public claim ${id}`,
    impact: "public impact",
    oracle: {
      expectedBehavior: "public expected behavior",
      rationale: "frozen task supports it",
    },
    assertionFingerprint: id,
    requiredCapabilities: [],
    patchPath: `/run/attacks/${id}.diff`,
    focusedCommand: `npm test -- ${id}`,
    status: "landed",
    rootDefectId: `defect-${id}`,
    severity: "medium",
    damage: 15,
    checks: [],
    ...overrides,
  };
}

function feedback(state: RunState, contestantId: "a" | "b" = "a") {
  return projectContestantFeedback({
    state,
    contestantId,
    roundId: 2,
    phase: "repair",
    permissions: {
      defaultMode: "confirm",
      reducedValidationAccepted: false,
      capabilities: [
        {
          id: "private_service",
          reason: "not available",
          risk: "high",
          requirement: "optional",
          role: "agent",
          enforcement: "brokered",
          mode: "confirm",
          scopes: [],
          status: "denied",
        },
      ],
    },
  });
}

describe("lane-safe contestant feedback", () => {
  it("exposes only accepted incoming evidence and the lane's own public outcomes", () => {
    const state = makeRunState();
    state.attacks = [
      attack("incoming", "b", "a", {
        outcomeReason: "PRIVATE VERIFIER PROSE",
        severityRationale: "PRIVATE SEVERITY RATIONALE",
        caseBundle: {
          attackId: "incoming",
          rootDefectId: "defect-incoming",
          oracle: {
            expectedBehavior: "public expected behavior",
            rationale: "frozen task supports it",
          },
          createdBeforeRepairAt: "2026-08-08T00:00:00.000Z",
          cases: [
            {
              id: "visible-case",
              category: "boundary",
              visibility: "visible",
              patchPath: "/run/cases/visible.diff",
              contentHash: "a".repeat(64),
              focusedCommand: "npm test -- visible",
              status: "accepted",
            },
            {
              id: "secret-case",
              category: "boundary",
              visibility: "held_out",
              patchPath: "/run/cases/SECRET-INPUT.diff",
              contentHash: "b".repeat(64),
              focusedCommand: "npm test -- SECRET-INPUT",
              status: "accepted",
            },
          ],
        },
      }),
      attack("own", "a", "b"),
      attack("opponent-own", "b", "b"),
    ];
    state.contestants.a!.healthLedger.activeDefects = [
      {
        rootDefectId: "defect-incoming",
        attackId: "incoming",
        damage: 15,
      },
    ];
    const projected = feedback(state);
    const encoded = canonicalJson(projected);

    expect(
      projected.acceptedIncomingAttacks.map((entry) => entry.attackId),
    ).toEqual(["incoming"]);
    expect(projected.ownAttackOutcomes.map((entry) => entry.attackId)).toEqual([
      "own",
    ]);
    expect(projected.capabilityRestrictions).toEqual([
      { capabilityId: "private_service", status: "denied" },
    ]);
    expect(encoded).not.toContain("PRIVATE VERIFIER PROSE");
    expect(encoded).not.toContain("PRIVATE SEVERITY RATIONALE");
    expect(encoded).not.toContain("SECRET-INPUT");
    expect(encoded).not.toContain("opponent-own");
  });

  it("uses hard public reason codes and keeps canonical landed identities", () => {
    const state = makeRunState();
    state.attacks = [
      attack("unsupported", "a", "b", {
        status: "unproven",
        rootDefectId: undefined,
        severity: undefined,
        damage: undefined,
        outcomeReason: "a long private explanation",
      }),
      attack("duplicate", "a", "b", { status: "duplicate" }),
    ];
    const projected = feedback(state);
    expect(projected.ownAttackOutcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attackId: "unsupported",
          reason: "oracle_not_supported",
        }),
        expect.objectContaining({
          attackId: "duplicate",
          reason: "duplicate_root_defect",
          defectId: "defect-duplicate",
        }),
      ]),
    );
  });

  it("compacts deterministically below 24 KiB without evicting active evidence", () => {
    const state = makeRunState();
    state.attacks = Array.from({ length: 180 }, (_, index) =>
      attack(`history-${String(index).padStart(3, "0")}`, "b", "a", {
        claim: `old evidence ${"x".repeat(300)} ${String(index)}`,
      }),
    );
    state.contestants.a!.healthLedger.activeDefects = [
      {
        rootDefectId: "defect-history-179",
        attackId: "history-179",
        damage: 15,
      },
    ];
    const first = feedback(state);
    const second = feedback(structuredClone(state));
    expect(Buffer.byteLength(canonicalJson(first), "utf8")).toBeLessThanOrEqual(
      FEEDBACK_INLINE_LIMIT_BYTES,
    );
    expect(
      Buffer.byteLength(JSON.stringify(first, null, 2), "utf8"),
    ).toBeLessThanOrEqual(FEEDBACK_INLINE_LIMIT_BYTES);
    expect(first).toEqual(second);
    expect(
      first.acceptedIncomingAttacks.some(
        (entry) => entry.defectId === "defect-history-179",
      ),
    ).toBe(true);
    expect(first.unresolvedDefectIds).toContain("defect-history-179");
  });
});
