import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CheckpointDecisionSchema,
  conditionOrders,
  evaluatePauseReplan,
  ExplorationLease,
  LifecycleLedger,
  normalizeLeasePath,
  pairedBootstrapInterval,
  PauseReplanManifestSchema,
  renderEvaluationArtifact,
  validateLifecycle,
  type ConditionMeasurement,
} from "../../src/evaluation/pause-replan.js";
import { decodeInspectionJsonl } from "../../src/review/inspection-telemetry.js";

function findingPacket() {
  return { findings: [{ finding_id: "finding-1" }] };
}

function manifest() {
  return {
    version: 2,
    evaluation_id: "pause-replan-test",
    seed: 41,
    mode: "fake",
    phase: "full",
    models: [
      {
        provider: "claude",
        requested_model: "sonnet",
        conditions: ["telemetry_only", "passive_warning", "checkpoint"],
      },
      {
        provider: "codex",
        requested_model: "gpt-5.6-sol",
        conditions: ["telemetry_only", "checkpoint"],
      },
    ],
    scenarios: Array.from({ length: 12 }, (_, index) => ({
      id: `scenario-${String(index)}`,
      source_run_id: `run-${String(index)}`,
      lane: "a-to-b",
      repository_root: "/tmp/repository",
      base_commit: "1".repeat(40),
      target_patch: { path: "patch.diff", sha256: "2".repeat(64) },
      packet: findingPacket(),
      packet_digest: "3".repeat(64),
      active_finding_id: "finding-1",
      trusted_paths: ["src/value.ts"],
      validation_command: "npm test",
      attack_prompt: "Create one focused executable attack.",
    })),
    transport_gate_scenario_ids: [
      "scenario-0",
      "scenario-1",
      "scenario-2",
      "scenario-3",
    ],
    limits: {
      duration_ms: 360_000,
      tool_calls: 100,
      checkpoint_lease_calls: 5,
      checkpoint_lease_files: 2,
      aggregate_cost_usd: 40,
      maximum_condition_cost_usd: 0.5,
    },
    rate_card: [
      {
        provider: "claude",
        model: "sonnet",
        input_usd_per_million: 3,
        output_usd_per_million: 15,
      },
      {
        provider: "codex",
        model: "gpt-5.6-sol",
        input_usd_per_million: 2,
        output_usd_per_million: 8,
      },
    ],
  };
}

function measurement(
  provider: "claude" | "codex",
  condition: "telemetry_only" | "checkpoint",
  scenario: number,
  primary: boolean,
  overrides: Partial<ConditionMeasurement> = {},
): ConditionMeasurement {
  return {
    scenario_id: `scenario-${String(scenario)}`,
    provider,
    condition,
    condition_order: ["telemetry_only", "checkpoint"],
    attempt: 1,
    requested_model: provider === "claude" ? "sonnet" : "gpt-5.6-sol",
    provider_model: provider === "claude" ? "sonnet" : "gpt-5.6-sol",
    cli_version: "fake 1",
    duration_ms: 100,
    tool_calls: 20,
    first_broad_call: 2,
    ...(primary ? { first_executable_test_call: 20 } : {}),
    right_censored: !primary,
    primary_outcome: primary,
    outcome: "usable",
    accepted_attacks: 1,
    landed_attacks: 1,
    unusable_submission: false,
    checkpoint_acknowledged: condition === "checkpoint",
    passive_warning_delivery: "not_applicable",
    estimated_cost_usd: 0.1,
    cost_source: "rate_card",
    lifecycle_path: "ledgers/fake.json",
    lifecycle_kinds: ["terminal"],
    protocol_checks: {
      completeOrdering: true,
      modelVersionStable: true,
      noRepositoryActionBeforeAcknowledgement: true,
      checkpointWithoutRepositoryAccess: true,
      validStructuredDecision: true,
      continuationAfterDecision: true,
      leaseCountingAndPathsEnforced: true,
      cleanupComplete: true,
      noSurvivingChildProcess: true,
      noLeakedWorktree: true,
      sourceImmutable: true,
    },
    ...overrides,
  };
}

describe("pause–replan v2 contracts", () => {
  it("renders schema-v1 results read-only without preserving a v1 run path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-v1-render-"));
    const artifact = path.join(root, "evaluation.json");
    await writeFile(
      artifact,
      JSON.stringify({
        manifest: {
          version: 1,
          evaluationId: "legacy",
          seed: 1,
          sourceRuns: [],
          adapter: "claude",
          model: "legacy-model",
          timeoutMs: 1_000,
          minPairs: 12,
          maxPairs: 24,
          minTriggeredPairs: 8,
          conditions: ["telemetry_only", "warning"],
          callCeiling: 100,
          mode: "synthetic",
        },
        pairs: [],
        excludedPairs: [],
        verdict: {
          verdict: "Inconclusive",
          measurablePairs: 0,
          triggeredPairs: 0,
          improvedPairs: 0,
          medianImprovementPct: 0,
          medianDurationDeltaMs: 0,
          additionalUnusable: 0,
          effects: {
            callsPct: { measuredPairs: 0 },
            durationMs: { measuredPairs: 0 },
            tokens: { measuredPairs: 0 },
            costUsd: { measuredPairs: 0 },
          },
        },
      }),
    );
    expect(await renderEvaluationArtifact(artifact)).toContain(
      "Rediscovery warning evaluation",
    );
  });

  it("freezes both real models, twelve scenarios, and one active finding", () => {
    expect(PauseReplanManifestSchema.parse(manifest()).scenarios).toHaveLength(
      12,
    );
    const missing = manifest();
    missing.scenarios[0]!.active_finding_id = "not-present";
    expect(() => PauseReplanManifestSchema.parse(missing)).toThrow(
      /exactly one packet finding/u,
    );
  });

  it("rejects unsupported Codex passive warning and changed model selections", () => {
    const invalid = manifest();
    invalid.models[1]!.conditions.push("passive_warning");
    invalid.models[1]!.requested_model = "different";
    expect(() => PauseReplanManifestSchema.parse(invalid)).toThrow();
  });

  it("uses all six Claude orders and alternating Codex pairs", () => {
    expect(
      new Set(
        Array.from({ length: 6 }, (_, index) =>
          conditionOrders("claude", index).join(","),
        ),
      ).size,
    ).toBe(6);
    expect(conditionOrders("codex", 0)).toEqual([
      "telemetry_only",
      "checkpoint",
    ]);
    expect(conditionOrders("codex", 1)).toEqual([
      "checkpoint",
      "telemetry_only",
    ]);
  });

  it("normalizes only repository files and validates structured decisions", () => {
    expect(normalizeLeasePath("./src/value.ts")).toBe("src/value.ts");
    for (const value of ["../secret", "/tmp/file", "src/**", "src/"]) {
      expect(normalizeLeasePath(value)).toBeUndefined();
    }
    expect(
      CheckpointDecisionSchema.parse({
        version: 1,
        decision: "request_lease",
        hypothesis: "The serializer may drop zero values.",
        requested_paths: ["src/serializer.ts", "test/serializer.test.ts"],
      }).requested_paths,
    ).toHaveLength(2);
    expect(() =>
      CheckpointDecisionSchema.parse({
        version: 1,
        decision: "return_to_scope",
        hypothesis: "Return.",
        requested_paths: ["src/value.ts"],
      }),
    ).toThrow();
  });
});

describe("lifecycle and lease policy", () => {
  it("counts generic provider tools without retaining their arguments", () => {
    const decoded = decodeInspectionJsonl(
      "codex",
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          tool: "Bash",
          arguments: { command: "npm test -- --secret token" },
        },
      }),
    );
    expect(decoded.events).toEqual([expect.objectContaining({ kind: "tool" })]);
    expect(JSON.stringify(decoded.events)).not.toContain("secret");
  });

  it("requires acknowledgement before a recorded decision", () => {
    const ledger = new LifecycleLedger({
      provider: "codex",
      requestedModel: "gpt-5.6-sol",
      condition: "checkpoint",
    });
    ledger.record("drift_detected", "broad");
    ledger.record("interrupt_requested", "broad");
    ledger.record("interrupt_completed", "broad", {
      checkpoint_id: "checkpoint-1",
    });
    ledger.record("checkpoint_started", "trusted", {
      checkpoint_id: "checkpoint-1",
    });
    ledger.record("checkpoint_acknowledged", "trusted", {
      checkpoint_id: "checkpoint-1",
    });
    ledger.record("decision_recorded", "trusted", {
      checkpoint_id: "checkpoint-1",
      decision: "return_to_scope",
    });
    ledger.record("continuation_started", "trusted", {
      checkpoint_id: "checkpoint-1",
    });
    ledger.record("terminal", "unknown", { terminal_reason: "empty" });
    expect(() => validateLifecycle(ledger.events)).not.toThrow();

    const withoutAcknowledgement = ledger.events.filter(
      (event) => event.kind !== "checkpoint_acknowledged",
    );
    withoutAcknowledgement.forEach((event, index) => {
      event.sequence = index + 1;
    });
    expect(() => validateLifecycle(withoutAcknowledgement)).toThrow(
      /requires checkpoint_acknowledged/u,
    );
  });

  it("charges every invocation and enforces both file and five-call bounds", () => {
    const lease = new ExplorationLease(["src/a.ts", "src/b.ts"]);
    expect(lease.consume("src/a.ts")).toMatchObject({
      allowed: true,
      used: 1,
      remaining: 4,
    });
    expect(lease.consume("src/outside.ts").allowed).toBe(false);
    lease.consume();
    lease.consume("src/b.ts");
    expect(lease.consume("src/a.ts")).toMatchObject({
      exhausted: true,
      used: 5,
      remaining: 0,
    });
  });
});

describe("paired verdict", () => {
  it("returns Worked at the exact threshold with deterministic bootstrap", () => {
    const measurements = (["claude", "codex"] as const).flatMap((provider) =>
      Array.from({ length: 10 }, (_, index) => [
        measurement(provider, "telemetry_only", index, index >= 4),
        measurement(provider, "checkpoint", index, index >= 2),
      ]).flat(),
    );
    const verdict = evaluatePauseReplan(measurements, 7);
    expect(verdict.verdict).toBe("Worked");
    expect(verdict.pooled_difference_points).toBeCloseTo(20);
    expect(pairedBootstrapInterval([0, 1, 0], 9)).toEqual(
      pairedBootstrapInterval([0, 1, 0], 9),
    );
  });

  it("preserves censoring and returns Inconclusive below the effect threshold", () => {
    const measurements = (["claude", "codex"] as const).flatMap((provider) =>
      Array.from({ length: 10 }, (_, index) => [
        measurement(provider, "telemetry_only", index, index >= 3),
        measurement(provider, "checkpoint", index, index >= 2),
      ]).flat(),
    );
    expect(
      measurements.filter((value) => value.right_censored),
    ).not.toHaveLength(0);
    expect(evaluatePauseReplan(measurements, 7).verdict).toBe("Inconclusive");
  });

  it("returns Did not work for a model-level quality guardrail failure", () => {
    const measurements = (["claude", "codex"] as const).flatMap((provider) =>
      Array.from({ length: 10 }, (_, index) => [
        measurement(provider, "telemetry_only", index, false),
        measurement(provider, "checkpoint", index, true, {
          accepted_attacks: provider === "codex" ? 0 : 1,
          landed_attacks: provider === "codex" ? 0 : 1,
        }),
      ]).flat(),
    );
    expect(evaluatePauseReplan(measurements, 7).verdict).toBe("Did not work");
  });
});
