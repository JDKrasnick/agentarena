import { describe, expect, it } from "vitest";
import {
  EFFORT_PROFILES,
  decideAdaptiveRound,
  nextLowSignalCount,
  resolveEffortProfile,
  scoreEffort,
  TokenTelemetrySchema,
} from "../../src/effort/policy.js";

describe("task-scaled effort policy", () => {
  it("maps all score bands to the five tiers", () => {
    expect(
      scoreEffort(
        {
          changeSurface: 0,
          behavioralComplexity: 0,
          validationBurden: 0,
          operationalRisk: 0,
        },
        1,
      ).tier,
    ).toBe("ultra-low");
    expect(
      scoreEffort(
        {
          changeSurface: 1,
          behavioralComplexity: 1,
          validationBurden: 0,
          operationalRisk: 0,
        },
        1,
      ).tier,
    ).toBe("low");
    expect(
      scoreEffort(
        {
          changeSurface: 1,
          behavioralComplexity: 1,
          validationBurden: 1,
          operationalRisk: 1,
        },
        1,
      ).tier,
    ).toBe("medium");
    expect(
      scoreEffort(
        {
          changeSurface: 2,
          behavioralComplexity: 2,
          validationBurden: 1,
          operationalRisk: 1,
        },
        1,
      ).tier,
    ).toBe("high");
    expect(
      scoreEffort(
        {
          changeSurface: 2,
          behavioralComplexity: 2,
          validationBurden: 2,
          operationalRisk: 2,
        },
        1,
      ).tier,
    ).toBe("ultra-high");
  });

  it("applies confidence promotion and validation/risk guardrails", () => {
    expect(
      scoreEffort(
        {
          changeSurface: 0,
          behavioralComplexity: 0,
          validationBurden: 0,
          operationalRisk: 0,
        },
        0.69,
      ),
    ).toMatchObject({ tier: "low", promotedForConfidence: true });
    expect(
      scoreEffort(
        {
          changeSurface: 0,
          behavioralComplexity: 0,
          validationBurden: 2,
          operationalRisk: 0,
        },
        1,
      ),
    ).toMatchObject({ tier: "high", riskFloorApplied: true });
    expect(
      scoreEffort(
        {
          changeSurface: 0,
          behavioralComplexity: 0,
          validationBurden: 2,
          operationalRisk: 2,
        },
        1,
      ).tier,
    ).toBe("ultra-high");
  });

  it("publishes the exact five profiles and retains explicit phase overrides", () => {
    expect(Object.keys(EFFORT_PROFILES)).toEqual([
      "ultra-low",
      "low",
      "medium",
      "high",
      "ultra-high",
    ]);
    expect(EFFORT_PROFILES.low).toMatchObject({
      plannedRounds: 1,
      roundEnvelopeMs: 20 * 60_000,
      maxProviderCallsPerRound: 8,
      maxTokensPerRound: 750_000,
      implementationMs: 10 * 60_000,
      reviewMs: 3 * 60_000,
      attackMs: 4 * 60_000,
      judgeMs: 90_000,
      repairMs: 5 * 60_000,
    });
    expect(resolveEffortProfile("low", { reviewMs: 42_000 }).reviewMs).toBe(
      42_000,
    );
  });

  it("distinguishes complete, partial, and unavailable token telemetry", () => {
    expect(TokenTelemetrySchema.parse({ state: "unavailable" }).state).toBe(
      "unavailable",
    );
    expect(
      TokenTelemetrySchema.parse({ state: "partial", outputTokens: 5 }).state,
    ).toBe("partial");
    expect(
      TokenTelemetrySchema.parse({
        state: "complete",
        uncachedInputTokens: 1,
        cacheReadTokens: 2,
        cacheWriteTokens: 3,
        outputTokens: 4,
        totalTokens: 10,
      }).totalTokens,
    ).toBe(10);
    expect(() =>
      TokenTelemetrySchema.parse({
        state: "complete",
        uncachedInputTokens: 1,
        cacheReadTokens: 2,
        cacheWriteTokens: 3,
        outputTokens: 4,
        totalTokens: 9,
      }),
    ).toThrow(/total must equal/u);
  });

  it("requires immediately requalified evidence for each extension", () => {
    const profile = EFFORT_PROFILES.medium;
    expect(
      decideAdaptiveRound({
        round: 2,
        profile,
        convergencePassed: false,
        extensionQualified: true,
      }),
    ).toEqual({ action: "continue", reason: "extension_qualified" });
    expect(
      decideAdaptiveRound({
        round: 3,
        profile,
        convergencePassed: false,
        extensionQualified: false,
      }),
    ).toEqual({ action: "stop", reason: "extension_not_qualified" });
    expect(
      decideAdaptiveRound({
        round: 3,
        profile,
        convergencePassed: false,
        extensionQualified: true,
      }),
    ).toEqual({ action: "continue", reason: "extension_qualified" });
    expect(
      decideAdaptiveRound({
        round: 4,
        profile,
        convergencePassed: false,
        extensionQualified: true,
      }),
    ).toEqual({ action: "stop", reason: "extension_limit_reached" });
  });

  it("persists the exact pressure reason when no evidence earns continuation", () => {
    const profile = EFFORT_PROFILES.medium;
    expect(
      decideAdaptiveRound({
        round: 2,
        profile,
        convergencePassed: false,
        extensionQualified: false,
        pressureReason: "round_time_budget_exhausted",
      }),
    ).toEqual({ action: "stop", reason: "round_time_budget_exhausted" });
    expect(
      decideAdaptiveRound({
        round: 3,
        profile,
        convergencePassed: false,
        extensionQualified: false,
        pressureReason: "round_invocation_budget_exhausted",
      }),
    ).toEqual({
      action: "stop",
      reason: "round_invocation_budget_exhausted",
    });
  });

  it("continues after planned rounds when strong evidence qualifies despite pressure", () => {
    expect(
      decideAdaptiveRound({
        round: 2,
        profile: EFFORT_PROFILES.medium,
        convergencePassed: false,
        extensionQualified: true,
        pressureReason: "round_token_budget_exhausted",
      }),
    ).toEqual({ action: "continue", reason: "extension_qualified" });
  });

  it("keeps explicit round counts exact despite convergence", () => {
    expect(
      decideAdaptiveRound({
        round: 1,
        fixedRounds: 5,
        profile: EFFORT_PROFILES.low,
        convergencePassed: true,
        extensionQualified: false,
      }).action,
    ).toBe("continue");
    expect(
      decideAdaptiveRound({
        round: 5,
        fixedRounds: 5,
        profile: EFFORT_PROFILES.low,
        convergencePassed: true,
        extensionQualified: false,
      }),
    ).toEqual({ action: "stop", reason: "fixed_rounds_complete" });
  });

  it("stops for a terminal condition even when fixed rounds remain", () => {
    expect(
      decideAdaptiveRound({
        round: 1,
        fixedRounds: 5,
        profile: EFFORT_PROFILES.medium,
        convergencePassed: false,
        extensionQualified: true,
        terminalCondition: true,
      }),
    ).toEqual({ action: "stop", reason: "terminal_condition" });
  });

  it("pivots after one low-signal round and stops after two consecutive low-signal rounds", () => {
    expect(
      decideAdaptiveRound({
        round: 1,
        profile: EFFORT_PROFILES.medium,
        convergencePassed: true,
        extensionQualified: false,
        lowSignal: true,
        consecutiveLowSignalCount: 1,
      }),
    ).toEqual({ action: "continue", reason: "planned_rounds_remaining" });
    expect(
      decideAdaptiveRound({
        round: 2,
        profile: EFFORT_PROFILES.medium,
        convergencePassed: true,
        extensionQualified: false,
        lowSignal: true,
        consecutiveLowSignalCount: 2,
      }),
    ).toEqual({ action: "stop", reason: "repeated_low_signal" });
  });

  it("does not let the low-signal stop shorten an exact fixed-round battle", () => {
    expect(
      decideAdaptiveRound({
        round: 2,
        fixedRounds: 3,
        profile: EFFORT_PROFILES.low,
        convergencePassed: true,
        extensionQualified: false,
        lowSignal: true,
        consecutiveLowSignalCount: 2,
      }),
    ).toEqual({ action: "continue", reason: "fixed_rounds_remaining" });
  });

  it("reconstructs a persisted low-signal streak and resets it on competitive evidence", () => {
    const persisted = {
      version: 2 as const,
      round: 1 as const,
      consumption: {
        wallTimeMs: 1,
        providerCalls: 1,
        tokenTelemetry: { state: "unavailable" as const },
        wallTimePressure: false,
        invocationPressure: false,
        tokenPressure: false,
        overrunMs: 0,
      },
      convergence: {
        intactExecutedLaneCoverage: true,
        noUnresolvedAdjudication: true,
        zeroActiveDamage: true,
        acceptedDefectsHealedWithRegressionPasses: true,
        noNewCanonicalDefectOrScoreCorrection: true,
        allLanesExplicitlyEmpty: true,
        patchesSmallAndStable: true,
        passed: true,
      },
      extensionQualified: false,
      extensionTriggerDefectIds: [],
      action: "continue" as const,
      reason: "planned_rounds_remaining" as const,
      signal: {
        competitiveLandings: 0,
        sharedDefects: 0,
        explicitEmptyLanes: 2,
        lowSignal: true,
        consecutiveLowSignalCount: 1,
      },
      skippedBriefs: [],
      decidedAt: "2026-08-28T00:00:00.000Z",
    };

    expect(nextLowSignalCount(true, persisted)).toBe(2);
    expect(nextLowSignalCount(false, persisted)).toBe(0);
  });
});
