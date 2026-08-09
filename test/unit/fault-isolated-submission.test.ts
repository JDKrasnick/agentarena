import { describe, expect, it } from "vitest";
import {
  parseFaultIsolatedSubmission,
  mergeCorrectionFields,
  safelyRenderReceived,
} from "../../src/attacks/fault-isolated-submission.js";

function attack(rank: number, overrides: Record<string, unknown> = {}) {
  return {
    rank,
    claim: "A real defect",
    impact: "Incorrect result",
    oracle: { expectedBehavior: "works", rationale: "task requires it" },
    proposedSeverity: "low",
    confidence: 80,
    reproduction: "run the public operation",
    requiredCapabilities: [],
    ...overrides,
  };
}

describe("fault-isolated provider submissions", () => {
  it("keeps a valid attack when malformed legacy hypotheses coexist", () => {
    const parsed = parseFaultIsolatedSubmission(
      "attack",
      JSON.stringify({
        version: 1,
        hypotheses: [
          { category: "state" },
          { category: "lifecycle" },
          { category: "generated_inputs" },
        ],
        attacks: [attack(2, { reproduction: "malformed date 2024-99-99" })],
      }),
    );

    expect(parsed.outcome).toBe("valid");
    expect(parsed.value.attacks).toHaveLength(1);
    expect(parsed.value.attacks[0]?.rank).toBe(2);
    expect(parsed.rejections).toEqual([]);
  });

  it("rejects every duplicate rank while preserving an unrelated sparse rank", () => {
    const parsed = parseFaultIsolatedSubmission(
      "attack",
      JSON.stringify({
        version: 1,
        attacks: [attack(1), attack(1, { claim: "duplicate" }), attack(3)],
      }),
    );

    expect(parsed.outcome).toBe("partial");
    expect(parsed.value.attacks.map((entry) => entry.rank)).toEqual([3]);
    expect(parsed.rejections.map((entry) => entry.code)).toEqual([
      "duplicate_rank",
      "duplicate_rank",
    ]);
  });

  it("normalizes only known path-specific enum aliases and records each rule", () => {
    const parsed = parseFaultIsolatedSubmission(
      "house",
      JSON.stringify({
        version: 1,
        hypotheses: [
          {
            category: " Lifecycle ",
            invariant: "state closes",
            probe: "close twice",
            confidence: 75,
          },
          {
            category: "generated_inputs",
            invariant: "ambiguous",
            probe: "generate",
            confidence: 50,
          },
        ],
        attacks: [
          {
            ...attack(1, { proposedSeverity: " HIGH " }),
            rank: undefined,
            focusedCommand: "npm test",
            paths: ["test/example.test.ts"],
          },
        ],
      }),
    );

    expect(parsed.outcome).toBe("partial");
    expect(parsed.sections.hypotheses?.outcome).toBe("partial");
    expect(parsed.value.hypotheses[0]?.category).toBe("state_lifecycle");
    expect(parsed.value.attacks[0]?.proposedSeverity).toBe("high");
    expect(parsed.normalizations.map((entry) => entry.rule)).toEqual(
      expect.arrayContaining([
        "v1.enum.category.state_lifecycle_alias",
        "v1.enum.proposedSeverity.casefold_trim",
      ]),
    );
  });

  it("records explicit empty evidence separately from an invalid envelope", () => {
    expect(
      parseFaultIsolatedSubmission(
        "review",
        JSON.stringify({ version: 1, findings: [] }),
      ).outcome,
    ).toBe("valid_empty");
    expect(parseFaultIsolatedSubmission("review", "not json").outcome).toBe(
      "invalid",
    );
  });

  it("reports exact paths and allowed enums while safely rendering values", () => {
    const parsed = parseFaultIsolatedSubmission(
      "attack",
      JSON.stringify({
        version: 1,
        attacks: [attack(1, { proposedSeverity: "catastrophic" }), attack(3)],
      }),
    );
    expect(parsed.value.attacks.map((entry) => entry.rank)).toEqual([3]);
    expect(parsed.rejections[0]).toMatchObject({
      path: "$.attacks[0].proposedSeverity",
      received: '"catastrophic"',
      code: "invalid_value",
      allowedValues: ["critical", "high", "medium", "low"],
    });
    expect(safelyRenderReceived("$.credentials.apiToken", "super-secret")).toBe(
      "[REDACTED]",
    );
    expect(safelyRenderReceived("$.claim", "x".repeat(300))).toHaveLength(240);
  });

  it("freezes validated fields during the single correction attempt", () => {
    expect(
      mergeCorrectionFields(
        { rank: 2, claim: "frozen" },
        { proposedSeverity: "medium" },
      ),
    ).toEqual({
      accepted: true,
      value: { rank: 2, claim: "frozen", proposedSeverity: "medium" },
    });
    expect(
      mergeCorrectionFields({ rank: 2, claim: "frozen" }, { rank: 1 }),
    ).toEqual({ accepted: false, code: "frozen_field_tampering" });
  });

  it("limits review and case positions without suppressing valid siblings", () => {
    const finding = {
      invariant: "invariant",
      codeLocation: "src/file.ts:1",
      triggerSequence: ["call"],
      expectedBehavior: "works",
      confidence: 80,
      suggestedMinimalRegressionTest: "assert result",
    };
    const review = parseFaultIsolatedSubmission(
      "review",
      JSON.stringify({
        version: 1,
        findings: Array.from({ length: 13 }, () => finding),
      }),
    );
    expect(review.value.findings).toHaveLength(12);
    expect(review.rejections[0]?.path).toBe("$.findings[12]");

    const cases = parseFaultIsolatedSubmission(
      "case",
      JSON.stringify({
        version: 1,
        cases: Array.from({ length: 3 }, (_, index) => ({
          category: `case-${String(index)}`,
          focusedCommand: "npm test",
          paths: ["test/example.test.ts"],
        })),
      }),
    );
    expect(cases.value.cases).toHaveLength(2);
    expect(cases.rejections[0]?.code).toBe("position_limit");
  });
});
