import { z } from "zod";

export const EffortTierSchema = z.enum([
  "ultra-low",
  "low",
  "medium",
  "high",
  "ultra-high",
]);
export type EffortTier = z.infer<typeof EffortTierSchema>;

export const EffortModeSchema = z.union([z.literal("auto"), EffortTierSchema]);
export type EffortMode = z.infer<typeof EffortModeSchema>;

export const TokenTelemetrySchema = z
  .object({
    state: z.enum(["complete", "partial", "unavailable"]),
    uncachedInputTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((telemetry, context) => {
    const components = [
      telemetry.uncachedInputTokens,
      telemetry.cacheReadTokens,
      telemetry.cacheWriteTokens,
      telemetry.outputTokens,
    ];
    if (
      telemetry.state === "complete" &&
      (components.some((value) => value === undefined) ||
        telemetry.totalTokens === undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Complete token telemetry requires every normalized count",
      });
    if (
      telemetry.state === "complete" &&
      telemetry.totalTokens !==
        components.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    )
      context.addIssue({
        code: "custom",
        message: "Complete token telemetry total must equal normalized counts",
      });
    if (
      telemetry.state === "partial" &&
      components.every((value) => value === undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Partial token telemetry requires at least one count",
      });
    if (
      telemetry.state === "unavailable" &&
      (components.some((value) => value !== undefined) ||
        telemetry.totalTokens !== undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Unavailable token telemetry cannot contain counts",
      });
  });
export type TokenTelemetry = z.infer<typeof TokenTelemetrySchema>;

export const TOKEN_PRESSURE_POLICY_V1 = {
  version: 1 as const,
  cacheReadWeightNumerator: 1,
  cacheReadWeightDenominator: 10,
} as const;

const TokenPressureTriggerSchema = z.enum([
  "none",
  "new_input_output",
  "cache_creation",
  "cache_reads",
  "combined",
]);
type TokenPressureTrigger = z.infer<typeof TokenPressureTriggerSchema>;

function tokenPressureTrigger(
  pressure: boolean,
  thresholdTokens: number,
  contributions: ReadonlyArray<
    readonly [Exclude<TokenPressureTrigger, "none" | "combined">, number]
  >,
): TokenPressureTrigger {
  if (!pressure) return "none";
  const individuallyExhausted = contributions.filter(
    ([, tokens]) => tokens >= thresholdTokens,
  );
  return individuallyExhausted.length === 1
    ? individuallyExhausted[0]![0]
    : "combined";
}

export const TokenPressureEvaluationV1Schema = z
  .discriminatedUnion("state", [
    z
      .object({
        version: z.literal(1),
        state: z.literal("unavailable"),
        thresholdTokens: z.number().int().positive(),
        reason: z.literal("incomplete_token_telemetry"),
      })
      .strict(),
    z
      .object({
        version: z.literal(1),
        state: z.literal("complete"),
        thresholdTokens: z.number().int().positive(),
        newInputOutputTokens: z.number().int().nonnegative(),
        cacheCreationTokens: z.number().int().nonnegative(),
        cacheReadTokens: z.number().int().nonnegative(),
        weightedCacheReadTokens: z.number().int().nonnegative(),
        weightedTokens: z.number().int().nonnegative(),
        cacheReadWeightNumerator: z.literal(1),
        cacheReadWeightDenominator: z.literal(10),
        pressure: z.boolean(),
        trigger: TokenPressureTriggerSchema,
      })
      .strict(),
  ])
  .superRefine((evaluation, context) => {
    if (evaluation.state !== "complete") return;
    const expectedWeightedCacheReads = Math.ceil(
      evaluation.cacheReadTokens /
        TOKEN_PRESSURE_POLICY_V1.cacheReadWeightDenominator,
    );
    const expectedWeightedTokens =
      evaluation.newInputOutputTokens +
      evaluation.cacheCreationTokens +
      expectedWeightedCacheReads;
    const expectedPressure =
      expectedWeightedTokens >= evaluation.thresholdTokens;
    const expectedTrigger = tokenPressureTrigger(
      expectedPressure,
      evaluation.thresholdTokens,
      [
        ["new_input_output", evaluation.newInputOutputTokens],
        ["cache_creation", evaluation.cacheCreationTokens],
        ["cache_reads", expectedWeightedCacheReads],
      ],
    );
    if (
      evaluation.weightedCacheReadTokens !== expectedWeightedCacheReads ||
      evaluation.weightedTokens !== expectedWeightedTokens ||
      evaluation.pressure !== expectedPressure ||
      evaluation.trigger !== expectedTrigger
    )
      context.addIssue({
        code: "custom",
        message: "Token pressure evaluation does not match policy v1",
      });
  });
export type TokenPressureEvaluationV1 = z.infer<
  typeof TokenPressureEvaluationV1Schema
>;

export function evaluateTokenPressureV1(
  telemetry: TokenTelemetry,
  thresholdTokens: number,
): TokenPressureEvaluationV1 {
  if (telemetry.state !== "complete")
    return {
      version: 1,
      state: "unavailable",
      thresholdTokens,
      reason: "incomplete_token_telemetry",
    };
  const newInputOutputTokens =
    (telemetry.uncachedInputTokens ?? 0) + (telemetry.outputTokens ?? 0);
  const cacheCreationTokens = telemetry.cacheWriteTokens ?? 0;
  const cacheReadTokens = telemetry.cacheReadTokens ?? 0;
  const weightedCacheReadTokens = Math.ceil(
    (cacheReadTokens * TOKEN_PRESSURE_POLICY_V1.cacheReadWeightNumerator) /
      TOKEN_PRESSURE_POLICY_V1.cacheReadWeightDenominator,
  );
  const weightedTokens =
    newInputOutputTokens + cacheCreationTokens + weightedCacheReadTokens;
  const pressure = weightedTokens >= thresholdTokens;
  const trigger = tokenPressureTrigger(pressure, thresholdTokens, [
    ["new_input_output", newInputOutputTokens],
    ["cache_creation", cacheCreationTokens],
    ["cache_reads", weightedCacheReadTokens],
  ]);
  return {
    version: 1,
    state: "complete",
    thresholdTokens,
    newInputOutputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    weightedCacheReadTokens,
    weightedTokens,
    cacheReadWeightNumerator: TOKEN_PRESSURE_POLICY_V1.cacheReadWeightNumerator,
    cacheReadWeightDenominator:
      TOKEN_PRESSURE_POLICY_V1.cacheReadWeightDenominator,
    pressure,
    trigger,
  };
}

export function describeTokenPressureV1(
  evaluation: TokenPressureEvaluationV1,
): string {
  if (evaluation.state === "unavailable")
    return `weighted pressure unavailable/${String(evaluation.thresholdTokens)} (incomplete telemetry)`;
  const trigger = evaluation.pressure
    ? `pressure: ${evaluation.trigger.replaceAll("_", " ")}`
    : "no pressure";
  return `weighted ${String(evaluation.weightedTokens)}/${String(evaluation.thresholdTokens)} (new I/O ${String(evaluation.newInputOutputTokens)} + cache creation ${String(evaluation.cacheCreationTokens)} + cache reads ${String(evaluation.cacheReadTokens)} × 0.1 = ${String(evaluation.weightedCacheReadTokens)}; ${trigger})`;
}

const DimensionSchema = z.number().int().min(0).max(2);
export const TaskEffortDimensionsSchema = z
  .object({
    changeSurface: DimensionSchema,
    behavioralComplexity: DimensionSchema,
    validationBurden: DimensionSchema,
    operationalRisk: DimensionSchema,
  })
  .strict();
export type TaskEffortDimensions = z.infer<typeof TaskEffortDimensionsSchema>;

export const TaskEffortAttemptSchema = z
  .object({
    attempt: z.union([z.literal(1), z.literal(2)]),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    status: z.enum(["succeeded", "failed"]),
    promptPath: z.string().min(1),
    transcriptPrefix: z.string().min(1),
    dimensions: TaskEffortDimensionsSchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
    rationale: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
    durationMs: z.number().int().nonnegative(),
    tokenTelemetry: TokenTelemetrySchema,
  })
  .strict();

export const TaskEffortAssessmentV1Schema = z
  .object({
    version: z.literal(1),
    mode: EffortModeSchema,
    dimensions: TaskEffortDimensionsSchema,
    rawScore: z.number().int().min(0).max(8),
    confidence: z.number().min(0).max(1),
    selectedTier: EffortTierSchema,
    promotedForConfidence: z.boolean(),
    riskFloorApplied: z.boolean(),
    fallback: z.boolean(),
    fallbackReason: z.string().min(1).optional(),
    attempts: z.array(TaskEffortAttemptSchema).max(2),
    assessedAt: z.string().datetime(),
  })
  .strict();
export type TaskEffortAssessmentV1 = z.infer<
  typeof TaskEffortAssessmentV1Schema
>;

export const EffortProfileSchema = z
  .object({
    tier: EffortTierSchema,
    plannedRounds: z.number().int().min(1).max(3),
    maxRounds: z.number().int().min(1).max(5),
    roundEnvelopeMs: z.number().int().positive(),
    // Compatibility name: this is evaluated at the sealed-round boundary as
    // pressure telemetry; it does not preempt a transactional round in flight.
    maxProviderCallsPerRound: z.number().int().positive(),
    maxTokensPerRound: z.number().int().positive(),
    implementationMs: z.number().int().positive(),
    reviewMs: z.number().int().positive(),
    attackMs: z.number().int().positive(),
    judgeMs: z.number().int().positive(),
    repairMs: z.number().int().positive(),
  })
  .strict();
export type EffortProfile = z.infer<typeof EffortProfileSchema>;

export const EFFORT_PROFILES: Readonly<Record<EffortTier, EffortProfile>> = {
  "ultra-low": {
    tier: "ultra-low",
    plannedRounds: 1,
    maxRounds: 3,
    roundEnvelopeMs: 15 * 60_000,
    maxProviderCallsPerRound: 6,
    maxTokensPerRound: 500_000,
    implementationMs: 8 * 60_000,
    reviewMs: 2 * 60_000,
    attackMs: 3 * 60_000,
    judgeMs: 60_000,
    repairMs: 4 * 60_000,
  },
  low: {
    tier: "low",
    plannedRounds: 1,
    maxRounds: 3,
    roundEnvelopeMs: 20 * 60_000,
    maxProviderCallsPerRound: 8,
    maxTokensPerRound: 750_000,
    implementationMs: 10 * 60_000,
    reviewMs: 3 * 60_000,
    attackMs: 4 * 60_000,
    judgeMs: 90_000,
    repairMs: 5 * 60_000,
  },
  medium: {
    tier: "medium",
    plannedRounds: 2,
    maxRounds: 4,
    roundEnvelopeMs: 25 * 60_000,
    maxProviderCallsPerRound: 10,
    maxTokensPerRound: 1_500_000,
    implementationMs: 15 * 60_000,
    reviewMs: 4 * 60_000,
    attackMs: 5 * 60_000,
    judgeMs: 2 * 60_000,
    repairMs: 6 * 60_000,
  },
  high: {
    tier: "high",
    plannedRounds: 3,
    maxRounds: 5,
    roundEnvelopeMs: 45 * 60_000,
    maxProviderCallsPerRound: 14,
    maxTokensPerRound: 4_000_000,
    implementationMs: 20 * 60_000,
    reviewMs: 8 * 60_000,
    attackMs: 8 * 60_000,
    judgeMs: 3 * 60_000,
    repairMs: 10 * 60_000,
  },
  "ultra-high": {
    tier: "ultra-high",
    plannedRounds: 3,
    maxRounds: 5,
    roundEnvelopeMs: 60 * 60_000,
    maxProviderCallsPerRound: 18,
    maxTokensPerRound: 7_000_000,
    implementationMs: 30 * 60_000,
    reviewMs: 10 * 60_000,
    attackMs: 12 * 60_000,
    judgeMs: 4 * 60_000,
    repairMs: 15 * 60_000,
  },
};

const TIER_ORDER: EffortTier[] = [
  "ultra-low",
  "low",
  "medium",
  "high",
  "ultra-high",
];

export function scoreEffort(
  dimensions: TaskEffortDimensions,
  confidence: number,
): {
  score: number;
  tier: EffortTier;
  promotedForConfidence: boolean;
  riskFloorApplied: boolean;
} {
  const parsed = TaskEffortDimensionsSchema.parse(dimensions);
  const score = Object.values(parsed).reduce((sum, value) => sum + value, 0);
  let tier: EffortTier =
    score === 0
      ? "ultra-low"
      : score <= 2
        ? "low"
        : score <= 4
          ? "medium"
          : score <= 6
            ? "high"
            : "ultra-high";
  let riskFloorApplied = false;
  if (parsed.validationBurden === 2 && parsed.operationalRisk === 2) {
    riskFloorApplied = tier !== "ultra-high";
    tier = "ultra-high";
  } else if (
    (parsed.validationBurden === 2 || parsed.operationalRisk === 2) &&
    TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf("high")
  ) {
    riskFloorApplied = true;
    tier = "high";
  }
  const promotedForConfidence = confidence < 0.7 && tier !== "ultra-high";
  if (promotedForConfidence) tier = TIER_ORDER[TIER_ORDER.indexOf(tier) + 1]!;
  return { score, tier, promotedForConfidence, riskFloorApplied };
}

export function resolveEffortProfile(
  tier: EffortTier,
  overrides: Partial<
    Pick<
      EffortProfile,
      "implementationMs" | "reviewMs" | "attackMs" | "judgeMs" | "repairMs"
    >
  > = {},
): EffortProfile {
  return EffortProfileSchema.parse({ ...EFFORT_PROFILES[tier], ...overrides });
}

export function hasProviderCallPressure(
  profile: Pick<EffortProfile, "maxProviderCallsPerRound">,
  providerCalls: number,
): boolean {
  return providerCalls >= profile.maxProviderCallsPerRound;
}

export const ConvergenceSignalsSchema = z
  .object({
    intactExecutedLaneCoverage: z.boolean(),
    noUnresolvedAdjudication: z.boolean(),
    zeroActiveDamage: z.boolean(),
    acceptedDefectsHealedWithRegressionPasses: z.boolean(),
    noNewCanonicalDefectOrScoreCorrection: z.boolean(),
    allLanesExplicitlyEmpty: z.boolean(),
    patchesSmallAndStable: z.boolean(),
    passed: z.boolean(),
  })
  .strict();

export const RoundConsumptionSchema = z
  .object({
    wallTimeMs: z.number().int().nonnegative(),
    providerDurationMs: z.number().int().nonnegative().optional(),
    providerCalls: z.number().int().nonnegative(),
    tokenTelemetry: TokenTelemetrySchema,
    wallTimePressure: z.boolean(),
    invocationPressure: z.boolean(),
    tokenPressure: z.boolean(),
    overrunMs: z.number().int().nonnegative(),
  })
  .strict();

export const RoundConsumptionV3Schema = RoundConsumptionSchema.extend({
  tokenPressureEvaluation: TokenPressureEvaluationV1Schema,
}).superRefine((consumption, context) => {
  const expected = evaluateTokenPressureV1(
    consumption.tokenTelemetry,
    consumption.tokenPressureEvaluation.thresholdTokens,
  );
  const recorded = consumption.tokenPressureEvaluation;
  const matchesTelemetry =
    expected.state === recorded.state &&
    (expected.state === "unavailable" ||
      (recorded.state === "complete" &&
        expected.newInputOutputTokens === recorded.newInputOutputTokens &&
        expected.cacheCreationTokens === recorded.cacheCreationTokens &&
        expected.cacheReadTokens === recorded.cacheReadTokens &&
        expected.weightedCacheReadTokens === recorded.weightedCacheReadTokens &&
        expected.weightedTokens === recorded.weightedTokens &&
        expected.pressure === recorded.pressure &&
        expected.trigger === recorded.trigger));
  const expectedPressure =
    expected.state === "complete" ? expected.pressure : false;
  if (!matchesTelemetry || consumption.tokenPressure !== expectedPressure)
    context.addIssue({
      code: "custom",
      message: "Round token pressure does not match complete token telemetry",
    });
});

export const AdaptiveRoundDecisionReasonSchema = z.enum([
  "fixed_rounds_remaining",
  "fixed_rounds_complete",
  "planned_rounds_remaining",
  "strong_evidence_despite_budget_pressure",
  "extension_qualified",
  "adaptive_convergence",
  "planned_effort_complete",
  "round_time_budget_exhausted",
  "round_invocation_budget_exhausted",
  "round_token_budget_exhausted",
  "extension_not_qualified",
  "extension_limit_reached",
  "terminal_condition",
  "repeated_low_signal",
]);

const AdaptiveRoundDecisionV1Schema = z
  .object({
    version: z.literal(1),
    round: z.number().int().min(1).max(5),
    consumption: RoundConsumptionSchema,
    convergence: ConvergenceSignalsSchema,
    extensionQualified: z.boolean(),
    extensionTriggerDefectIds: z.array(z.string().min(1)),
    action: z.enum(["continue", "stop"]),
    reason: AdaptiveRoundDecisionReasonSchema,
    skippedBriefs: z.array(z.string().min(1)),
    decidedAt: z.string().datetime(),
  })
  .strict();
export const LowSignalTelemetrySchema = z
  .object({
    competitiveLandings: z.number().int().nonnegative(),
    sharedDefects: z.number().int().nonnegative(),
    explicitEmptyLanes: z.number().int().nonnegative(),
    lowSignal: z.boolean(),
    consecutiveLowSignalCount: z.number().int().nonnegative(),
  })
  .strict();
export const AdaptiveRoundDecisionV2Schema = AdaptiveRoundDecisionV1Schema.omit(
  { version: true },
).extend({
  version: z.literal(2),
  signal: LowSignalTelemetrySchema,
});
export const AdaptiveRoundDecisionV3Schema = AdaptiveRoundDecisionV2Schema.omit(
  { version: true, consumption: true },
).extend({
  version: z.literal(3),
  consumption: RoundConsumptionV3Schema,
});
export const AdaptiveRoundDecisionSchema = z.union([
  AdaptiveRoundDecisionV1Schema,
  AdaptiveRoundDecisionV2Schema,
  AdaptiveRoundDecisionV3Schema,
]);
export type AdaptiveRoundDecision = z.infer<typeof AdaptiveRoundDecisionSchema>;

export function nextLowSignalCount(
  lowSignal: boolean,
  previousDecision?: AdaptiveRoundDecision,
): number {
  if (!lowSignal) return 0;
  return previousDecision &&
    "signal" in previousDecision &&
    previousDecision.signal.lowSignal
    ? previousDecision.signal.consecutiveLowSignalCount + 1
    : 1;
}

export function decideAdaptiveRound(input: {
  round: 1 | 2 | 3 | 4 | 5;
  fixedRounds?: number;
  profile: EffortProfile;
  convergencePassed: boolean;
  extensionQualified: boolean;
  lowSignal?: boolean;
  consecutiveLowSignalCount?: number;
  terminalCondition?: boolean;
  pressureReason?: Extract<
    AdaptiveRoundDecision["reason"],
    | "round_time_budget_exhausted"
    | "round_invocation_budget_exhausted"
    | "round_token_budget_exhausted"
  >;
}): Pick<AdaptiveRoundDecision, "action" | "reason"> {
  if (input.terminalCondition)
    return { action: "stop", reason: "terminal_condition" };
  if (input.fixedRounds !== undefined)
    return input.round < input.fixedRounds
      ? { action: "continue", reason: "fixed_rounds_remaining" }
      : { action: "stop", reason: "fixed_rounds_complete" };
  if ((input.consecutiveLowSignalCount ?? 0) >= 2)
    return { action: "stop", reason: "repeated_low_signal" };
  if (
    input.convergencePassed &&
    !(input.lowSignal && input.round < input.profile.plannedRounds)
  )
    return { action: "stop", reason: "adaptive_convergence" };
  if (input.round < input.profile.plannedRounds) {
    if (input.pressureReason && input.extensionQualified)
      return {
        action: "continue",
        reason: "strong_evidence_despite_budget_pressure",
      };
    if (input.pressureReason)
      return { action: "stop", reason: input.pressureReason };
    return { action: "continue", reason: "planned_rounds_remaining" };
  }
  if (input.round >= input.profile.maxRounds)
    return { action: "stop", reason: "extension_limit_reached" };
  if (input.extensionQualified)
    return { action: "continue", reason: "extension_qualified" };
  if (input.pressureReason)
    return { action: "stop", reason: input.pressureReason };
  return {
    action: "stop",
    reason:
      input.round === input.profile.plannedRounds
        ? "planned_effort_complete"
        : "extension_not_qualified",
  };
}

export function unavailableTokenTelemetry(): TokenTelemetry {
  return { state: "unavailable" };
}
