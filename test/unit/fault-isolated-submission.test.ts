import { describe, expect, it } from "vitest";
import {
  parseFaultIsolatedSubmission,
  declaredAttackPaths,
  isCorrectionEligible,
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

  it("retains rejected V2 sibling paths for quarantine without materializing them", () => {
    const parsed = parseFaultIsolatedSubmission(
      "attack",
      JSON.stringify({
        version: 2,
        sharedSupportPaths: ["test/support.ts"],
        attacks: [
          {
            ...attack(1),
            reproduction: undefined,
            focusedCommand: "npm test -- one",
            paths: ["test/one.test.ts"],
          },
          {
            ...attack(1, { claim: "duplicate" }),
            reproduction: undefined,
            focusedCommand: "npm test -- duplicate",
            paths: ["test/duplicate.test.ts"],
          },
          {
            ...attack(3),
            reproduction: undefined,
            focusedCommand: "npm test -- three",
            paths: ["test/three.test.ts"],
          },
        ],
      }),
    );

    expect(parsed.value.attacks.map((entry) => entry.rank)).toEqual([3]);
    expect(declaredAttackPaths(parsed)).toEqual([
      "test/support.ts",
      "test/one.test.ts",
      "test/duplicate.test.ts",
      "test/three.test.ts",
    ]);
  });

  it("preserves a valid browser-only V2 attack without inventing a command or path", () => {
    const parsed = parseFaultIsolatedSubmission(
      "attack",
      JSON.stringify({
        version: 2,
        attacks: [
          {
            ...attack(1),
            reproduction: undefined,
            requiredCapabilities: ["browser_dom_validation"],
            browserProbe: {
              id: "dialog",
              family: "interaction",
              profile: "desktop",
              expectedBehavior: "The dialog opens",
              actions: [{ kind: "goto", path: "/" }],
            },
          },
        ],
      }),
    );

    expect(parsed.outcome).toBe("valid");
    expect(parsed.value.attacks[0]).toMatchObject({ paths: [] });
    expect("focusedCommand" in parsed.value.attacks[0]!).toBe(false);
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

  it("freezes valid nested oracle fields while correcting a rejected sibling", () => {
    const parsed = parseFaultIsolatedSubmission(
      "attack",
      JSON.stringify({
        version: 1,
        attacks: [
          attack(1, {
            oracle: { expectedBehavior: "original behavior", rationale: "" },
          }),
        ],
      }),
    );
    const entry = parsed.sections.attacks?.entries[0];
    expect(entry?.validatedFields).toMatchObject({
      oracle: { expectedBehavior: "original behavior" },
    });
    expect(
      mergeCorrectionFields(entry?.validatedFields ?? {}, {
        oracle: { rationale: "task requires it" },
      }),
    ).toMatchObject({
      accepted: true,
      value: {
        oracle: {
          expectedBehavior: "original behavior",
          rationale: "task requires it",
        },
      },
    });
    expect(
      mergeCorrectionFields(entry?.validatedFields ?? {}, {
        oracle: {
          expectedBehavior: "changed behavior",
          rationale: "task requires it",
        },
      }),
    ).toEqual({ accepted: false, code: "frozen_field_tampering" });
  });

  it("does not offer correction when required scoring fields were absent", () => {
    const missingAll = parseFaultIsolatedSubmission(
      "attack",
      JSON.stringify({ version: 1, attacks: [{}] }),
    ).sections.attacks?.entries[0];
    const primitive = parseFaultIsolatedSubmission(
      "attack",
      JSON.stringify({ version: 1, attacks: ["not an attack"] }),
    ).sections.attacks?.entries[0];
    const missingOracle = parseFaultIsolatedSubmission(
      "attack",
      JSON.stringify({
        version: 1,
        attacks: [attack(1, { oracle: undefined })],
      }),
    ).sections.attacks?.entries[0];
    const invalidSeverity = parseFaultIsolatedSubmission(
      "attack",
      JSON.stringify({
        version: 1,
        attacks: [attack(1, { proposedSeverity: "catastrophic" })],
      }),
    ).sections.attacks?.entries[0];

    expect(isCorrectionEligible(missingAll!)).toBe(false);
    expect(isCorrectionEligible(primitive!)).toBe(false);
    expect(isCorrectionEligible(missingOracle!)).toBe(false);
    expect(isCorrectionEligible(invalidSeverity!)).toBe(true);
  });

  it("does not hide missing required fields behind a duplicate-rank error", () => {
    const parsed = parseFaultIsolatedSubmission(
      "attack",
      JSON.stringify({
        version: 1,
        attacks: [attack(1), attack(1, { oracle: undefined })],
      }),
    );

    expect(parsed.sections.attacks?.entries[0]?.rejections).toEqual([
      expect.objectContaining({ code: "duplicate_rank" }),
    ]);
    expect(
      parsed.sections.attacks?.entries[1]?.rejections.map(
        (rejection) => rejection.code,
      ),
    ).toEqual(expect.arrayContaining(["duplicate_rank", "invalid_type"]));
    expect(isCorrectionEligible(parsed.sections.attacks!.entries[0]!)).toBe(
      true,
    );
    expect(isCorrectionEligible(parsed.sections.attacks!.entries[1]!)).toBe(
      false,
    );
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
