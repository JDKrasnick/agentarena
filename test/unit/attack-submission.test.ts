import { describe, expect, it } from "vitest";
import {
  AttackSubmissionSchema,
  CaseSubmissionSchema,
} from "../../src/core/types.js";
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
  it("lets the attacker choose one bounded browser probe", () => {
    const base = {
      ...entry(1),
      focusedCommand: "npm test -- test/browser.test.ts",
      paths: ["test/browser.test.ts"],
      browserProbe: {
        id: "dialog-focus",
        family: "keyboard_focus",
        profile: "mobile",
        expectedBehavior: "Focus enters the dialog",
        actions: [
          { kind: "goto", path: "/settings" },
          { kind: "click", role: "button", name: "Settings" },
          { kind: "press", key: "Tab" },
        ],
      },
    };
    expect(() =>
      AttackSubmissionSchema.parse({
        version: 2,
        attacks: [
          { ...base, requiredCapabilities: ["browser_dom_validation"] },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      AttackSubmissionSchema.parse({ version: 2, attacks: [base] }),
    ).toThrow("browser_dom_validation");
  });

  it("accepts zero to three unique failure descriptions", () => {
    const submission = AttackSubmissionSchema.parse({
      version: 1,
      hypotheses: [],
      attacks: [entry(1), entry(2)],
    });
    expect(() => validateAttackOrdering(submission)).not.toThrow();
  });

  it("accepts expected behavior and rationale without source metadata", () => {
    const uncited = entry(1);
    Reflect.deleteProperty(uncited.oracle, "sourceId");
    Reflect.deleteProperty(uncited.oracle, "sourceLocation");
    expect(
      AttackSubmissionSchema.parse({ version: 1, attacks: [uncited] })
        .attacks[0]?.oracle,
    ).toEqual({ expectedBehavior: "expected", rationale: "stated" });
  });

  it("accepts sparse ranks without renumbering", () => {
    const gap = AttackSubmissionSchema.parse({
      version: 1,
      hypotheses: [],
      attacks: [entry(2)],
    });
    expect(() => validateAttackOrdering(gap)).not.toThrow();
    expect(gap.attacks[0]?.rank).toBe(2);
  });

  it("records capabilities selected by the neutral case judge", () => {
    const submission = CaseSubmissionSchema.parse({
      version: 1,
      cases: [
        {
          category: "integration",
          focusedCommand: "npm test -- test/integration.test.ts",
          paths: ["test/integration.test.ts"],
          requiredCapabilities: ["postgres_test"],
        },
      ],
    });

    expect(submission.cases[0]?.requiredCapabilities).toEqual([
      "postgres_test",
    ]);
  });
});
