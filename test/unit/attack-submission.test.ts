import { describe, expect, it } from "vitest";
import { AttackSubmissionSchema } from "../../src/core/types.js";
import { validateAttackOrdering } from "../../src/attacks/submission.js";

function entry(rank: 1 | 2 | 3) {
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
    reproduction: "Call slug with repeated whitespace and expect one hyphen",
    requiredCapabilities: [],
  };
}

describe("ordered attack sets", () => {
  it("accepts zero to three contiguous failure descriptions", () => {
    const submission = AttackSubmissionSchema.parse({
      version: 1,
      hypotheses: [],
      attacks: [entry(1), entry(2)],
    });
    expect(() => validateAttackOrdering(submission)).not.toThrow();
  });

  it("rejects gaps", () => {
    const gap = AttackSubmissionSchema.parse({
      version: 1,
      hypotheses: [],
      attacks: [entry(2)],
    });
    expect(() => validateAttackOrdering(gap)).toThrow(/contiguous/);
  });
});
