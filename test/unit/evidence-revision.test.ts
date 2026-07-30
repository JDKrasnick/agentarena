import { describe, expect, it } from "vitest";
import { assertEvidenceIdentityPreserved } from "../../src/attacks/evidence-revision.js";
import type { Attack } from "../../src/core/types.js";

const original: Attack = {
  id: "attack",
  round: 2,
  origin: { kind: "contestant", contestant: "a", provider: "codex" },
  rank: 1,
  targets: ["b"],
  claim: "target-only timeout",
  impact: "request hangs",
  oracle: {
    expectedBehavior: "bounded response",
    sourceId: "task-user",
    sourceLocation: "task",
    rationale: "explicit timeout contract",
  },
  assertionFingerprint: "assertion",
  requiredCapabilities: [],
  patchPath: "original.diff",
  focusedCommand: "npm test",
  status: "provisional_infrastructure",
  rootDefectId: "timeout-root",
  checks: [],
};

describe("bounded infrastructure evidence revision", () => {
  it("allows setup/command evidence changes while preserving the attack identity", () => {
    const revised: Attack = {
      ...original,
      patchPath: "revision.diff",
      focusedCommand: "npm test -- timeout",
      status: "submitted",
      evidenceRevision: {
        attempt: 1,
        setupChanged: true,
        teardownChanged: false,
        timeoutChanged: true,
        observabilityChanged: true,
        focusedCommandChanged: true,
        patchPath: "revision.diff",
        explanation: "isolated replay",
      },
    };
    expect(() =>
      assertEvidenceIdentityPreserved(original, revised),
    ).not.toThrow();
  });

  it("rejects a changed claim or a second revision", () => {
    expect(() =>
      assertEvidenceIdentityPreserved(original, {
        ...original,
        claim: "different attack",
      }),
    ).toThrow(/claim/);
    expect(() =>
      assertEvidenceIdentityPreserved(
        {
          ...original,
          evidenceRevision: {
            attempt: 1,
            setupChanged: false,
            teardownChanged: false,
            timeoutChanged: false,
            observabilityChanged: false,
            focusedCommandChanged: false,
            patchPath: "one.diff",
            explanation: "first",
          },
        },
        original,
      ),
    ).toThrow(/Only one/);
  });
});
