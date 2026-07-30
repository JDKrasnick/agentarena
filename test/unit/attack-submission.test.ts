import { describe, expect, it } from "vitest";
import { AttackSubmissionSchema } from "../../src/core/types.js";
import { validateAttackOrdering } from "../../src/attacks/submission.js";

function entry(rank: 1 | 2 | 3, file: string) {
  return {
    rank,
    claim: "claim",
    impact: "impact",
    oracle: {
      expectedBehavior: "expected",
      sourceId: "task-user",
      sourceLocation: "task",
      rationale: "stated",
    },
    proposedSeverity: "low" as const,
    confidence: 80,
    focusedCommand: "npm test",
    requiredCapabilities: [],
    paths: [file],
  };
}

describe("ordered attack sets", () => {
  it("accepts zero to three contiguous disjoint attacks", () => {
    const submission = AttackSubmissionSchema.parse({
      version: 1,
      hypotheses: [],
      attacks: [entry(1, "test/a.test.ts"), entry(2, "test/b.test.ts")],
    });
    expect(() => validateAttackOrdering(submission)).not.toThrow();
  });

  it("rejects gaps and shared paths", () => {
    const gap = AttackSubmissionSchema.parse({
      version: 1,
      hypotheses: [],
      attacks: [entry(2, "test/a.test.ts")],
    });
    expect(() => validateAttackOrdering(gap)).toThrow(/contiguous/);
    const shared = AttackSubmissionSchema.parse({
      version: 1,
      hypotheses: [],
      attacks: [entry(1, "test/a.test.ts"), entry(2, "test/a.test.ts")],
    });
    expect(() => validateAttackOrdering(shared)).toThrow(/disjoint/);
  });
});
