import { describe, expect, it } from "vitest";
import {
  parseFaultIsolatedSubmission,
  declaredAttackPaths,
  isCorrectionEligible,
  mergeCorrectionFields,
  reviewRetryFeedback,
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

function reviewFinding() {
  return {
    trust: "reviewer_hypothesis",
    invariant: "invariant",
    observations: [
      {
        trust: "reviewer_hypothesis",
        statement: "observation",
        provenance: { kind: "code_inspection", references: ["src/file.ts:1"] },
      },
    ],
    code_locations: [
      { path: "src/file.ts", line_start: 1, line_end: 1, symbol: "work" },
    ],
    trigger_sequence: ["call"],
    oracle: {
      expected_behavior: "works",
      task_source_ids: ["task-user"],
      task_source_rationale: "The frozen task requires it.",
    },
    confidence: 80,
    required_capability_ids: [],
    regression_test_plan: {
      summary: "assert result",
      suggested_paths: ["test/file.test.ts"],
      focused_command: "npm test",
    },
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

  it("does not confuse a typed handoff blocker with a valid empty attack", () => {
    const parsed = parseFaultIsolatedSubmission(
      "attack",
      JSON.stringify({
        version: 2,
        handoff_blocker: {
          finding_ids: [`finding_${"a".repeat(64)}`],
          category: "cited_context_missing",
          explanation: "The cited file is unavailable.",
          requested_capability_ids: [],
          requested_context: ["src/file.ts"],
        },
      }),
    );

    expect(parsed.outcome).toBe("invalid");
    expect(parsed.rejections).toEqual([
      expect.objectContaining({ code: "handoff_blocker_requires_refresh" }),
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
        JSON.stringify({ version: 2, findings: [] }),
      ).outcome,
    ).toBe("valid_empty");
    expect(parseFaultIsolatedSubmission("review", "not json").outcome).toBe(
      "invalid",
    );
  });

  it("rejects unknown fields on the strict v2 review envelope", () => {
    const parsed = parseFaultIsolatedSubmission(
      "review",
      JSON.stringify({
        version: 2,
        findings: [],
        provider_identity: "claude",
      }),
    );

    expect(parsed.outcome).toBe("invalid");
    expect(parsed.value).toEqual({ version: 2, findings: [] });
    expect(parsed.rejections).toEqual([
      expect.objectContaining({
        path: "$",
        code: "unknown_field",
        received: '["provider_identity"]',
      }),
    ]);
  });

  it("canonicalizes harmless review schema variance with an audit trail", () => {
    const finding = reviewFinding();
    delete (finding as { trust?: string }).trust;
    delete (finding.observations[0] as { trust?: string }).trust;
    finding.observations[0]!.provenance.kind = "execution";
    finding.oracle.task_source_ids = ["task-z", "task-user", "task-user"];
    const varied = {
      ...finding,
      codeLocations: finding.code_locations.map((location) => ({
        path: location.path,
        lineStart: location.line_start,
        lineEnd: location.line_end,
        symbol: location.symbol,
      })),
      code_locations: undefined,
      requiredCapabilityIds: ["shell", "filesystem", "shell"],
      required_capability_ids: undefined,
    };
    delete (varied as { code_locations?: unknown }).code_locations;
    delete (varied as { required_capability_ids?: unknown })
      .required_capability_ids;

    const parsed = parseFaultIsolatedSubmission(
      "review",
      JSON.stringify({ version: 2, findings: [varied] }),
    );

    expect(parsed.outcome).toBe("valid");
    expect(parsed.value.findings[0]).toMatchObject({
      trust: "reviewer_hypothesis",
      observations: [
        {
          trust: "reviewer_hypothesis",
          provenance: { kind: "tool_summary" },
        },
      ],
      oracle: { task_source_ids: ["task-user", "task-z"] },
      required_capability_ids: ["filesystem", "shell"],
    });
    expect(parsed.normalizations.map((entry) => entry.rule)).toEqual(
      expect.arrayContaining([
        "v1.review.trust.default_untrusted",
        "v1.review.provenance.execution_alias",
        "v1.array.task_source_ids.sort_dedupe",
        "v1.field_alias.codeLocations_to_code_locations",
      ]),
    );
  });

  it("accepts canonical test_run provenance without recording a normalization", () => {
    const finding = reviewFinding();
    finding.observations[0]!.provenance.kind = "test_run";

    const parsed = parseFaultIsolatedSubmission(
      "review",
      JSON.stringify({ version: 2, findings: [finding] }),
    );

    expect(parsed.outcome).toBe("valid");
    expect(parsed.value.findings[0]?.observations[0]?.provenance.kind).toBe(
      "test_run",
    );
    expect(parsed.normalizations).toEqual([]);
  });

  it.each(["TEST_RUN", "Test-Run", "test run", " test_run ", "  TeSt-RuN  "])(
    "normalizes the safe %s test-run provenance alias with an audit record",
    (alias) => {
      const finding = reviewFinding();
      finding.observations[0]!.provenance.kind = alias;

      const parsed = parseFaultIsolatedSubmission(
        "review",
        JSON.stringify({ version: 2, findings: [finding] }),
      );

      expect(parsed.outcome).toBe("valid");
      expect(parsed.value.findings[0]?.observations[0]?.provenance.kind).toBe(
        "test_run",
      );
      expect(parsed.normalizations).toContainEqual({
        path: "$.findings[0].observations[0].provenance.kind",
        original: alias,
        normalized: "test_run",
        rule: "v1.review.provenance.test_run_alias",
      });
    },
  );

  it("rejects ambiguous review provenance and returns focused retry feedback", () => {
    const finding = reviewFinding();
    finding.observations[0]!.provenance.kind = "test_execution";

    const parsed = parseFaultIsolatedSubmission(
      "review",
      JSON.stringify({ version: 2, findings: [finding] }),
    );

    expect(parsed.outcome).toBe("invalid");
    expect(parsed.sections.findings?.entries).toHaveLength(1);
    expect(parsed.sections.findings?.entries[0]?.outcome).toBe("rejected");
    expect(parsed.rejections).toEqual([
      expect.objectContaining({
        path: "$.findings[0].observations[0].provenance.kind",
        received: '"test_execution"',
        allowedValues: [
          "code_inspection",
          "task_source",
          "test_inspection",
          "test_run",
          "tool_summary",
          "other",
        ],
      }),
    ]);
    expect(JSON.parse(reviewRetryFeedback(parsed) ?? "null")).toEqual({
      invalid_fields: [
        {
          path: "$.findings[0].observations[0].provenance.kind",
          received: '"test_execution"',
        },
      ],
      allowed_provenance_kinds: [
        "code_inspection",
        "task_source",
        "test_inspection",
        "test_run",
        "tool_summary",
        "other",
      ],
    });
  });

  it("preserves a safely normalized sibling and rejects one ambiguous finding", () => {
    const normalized = reviewFinding();
    normalized.observations[0]!.provenance.kind = "test-run";
    const ambiguous = reviewFinding();
    ambiguous.invariant = "ambiguous provenance";
    ambiguous.observations[0]!.provenance.kind = "test_execution";

    const parsed = parseFaultIsolatedSubmission(
      "review",
      JSON.stringify({ version: 2, findings: [normalized, ambiguous] }),
    );

    expect(parsed.outcome).toBe("partial");
    expect(parsed.value.findings).toHaveLength(1);
    expect(parsed.value.findings[0]?.observations[0]?.provenance.kind).toBe(
      "test_run",
    );
    expect(
      parsed.sections.findings?.entries.filter(
        (entry) => entry.outcome === "rejected",
      ),
    ).toHaveLength(1);
  });

  it("rejects a whole finding once when only one observation is ambiguous", () => {
    const finding = reviewFinding();
    finding.observations.push({
      trust: "reviewer_hypothesis",
      statement: "ambiguous execution evidence",
      provenance: { kind: "test_execution", references: ["npm test"] },
    });

    const parsed = parseFaultIsolatedSubmission(
      "review",
      JSON.stringify({ version: 2, findings: [finding] }),
    );

    expect(parsed.outcome).toBe("invalid");
    expect(parsed.sections.findings?.entries).toHaveLength(1);
    expect(parsed.sections.findings?.entries[0]?.outcome).toBe("rejected");
  });

  it("safely truncates oversized descriptive review text by UTF-8 bytes", () => {
    const finding = reviewFinding();
    const original = `Evidence ${"🧪".repeat(250_000)}`;
    finding.observations[0]!.statement = original;

    const parsed = parseFaultIsolatedSubmission(
      "review",
      JSON.stringify({ version: 2, findings: [finding] }),
    );

    expect(parsed.outcome).toBe("valid");
    const statement = parsed.value.findings[0]?.observations[0]?.statement;
    expect(statement).toBeDefined();
    expect(Buffer.byteLength(statement ?? "", "utf8")).toBeLessThanOrEqual(
      1_000,
    );
    expect(statement).toMatch(/…$/u);
    const normalization = parsed.normalizations.find(
      (entry) =>
        entry.path === "$.findings[0].observations[0].statement" &&
        entry.rule === "v1.review.text.truncate_utf8_1000",
    );
    const auditOriginal = normalization?.original;
    if (!auditOriginal || typeof auditOriginal !== "object")
      throw new Error("Expected a bounded normalization audit object");
    const fields = auditOriginal as Record<string, unknown>;
    expect(fields.utf8Bytes).toBe(Buffer.byteLength(original, "utf8"));
    expect(fields.preview).toBeTypeOf("string");
    expect(fields.preview).toMatch(/\.\.\.$/u);
    expect(fields.sha256).toBeTypeOf("string");
    expect(fields.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(parsed).length).toBeLessThan(10_000);
  });

  it("keeps command fields strict instead of truncating executable semantics", () => {
    const finding = reviewFinding();
    finding.regression_test_plan.focused_command = "x".repeat(1_001);

    const parsed = parseFaultIsolatedSubmission(
      "review",
      JSON.stringify({ version: 2, findings: [finding] }),
    );

    expect(parsed.outcome).toBe("invalid");
    expect(parsed.rejections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.findings[0].regression_test_plan.focused_command",
        }),
      ]),
    );
  });

  it("preserves valid review siblings when another finding is malformed", () => {
    const parsed = parseFaultIsolatedSubmission(
      "review",
      JSON.stringify({
        version: 2,
        findings: [reviewFinding(), { invariant: "missing evidence" }],
      }),
    );

    expect(parsed.outcome).toBe("partial");
    expect(parsed.value.findings).toHaveLength(1);
    expect(parsed.sections.findings?.accepted).toHaveLength(1);
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
    const finding = reviewFinding();
    const review = parseFaultIsolatedSubmission(
      "review",
      JSON.stringify({
        version: 2,
        findings: Array.from({ length: 25 }, () => finding),
      }),
    );
    expect(review.value.findings).toHaveLength(24);
    expect(review.rejections[0]?.path).toBe("$.findings[24]");

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
