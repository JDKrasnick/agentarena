import { z } from "zod";
import { renderRediscoverySummary } from "./rediscovery-summary.js";

export type Condition = "telemetry_only" | "warning";
export type SubmissionOutcome =
  "usable" | "empty" | "blocker" | "timeout" | "malformed" | "model_failure";

const MeasurementSchema = z
  .object({
    pairId: z.string(),
    condition: z.enum(["telemetry_only", "warning"]),
    visibility: z.enum(["complete", "partial", "unsupported"]),
    triggered: z.boolean(),
    warningTriggerCall: z.number().int().nonnegative().optional(),
    callsToEdit: z.number().nonnegative(),
    triggerToEditMs: z.number().nonnegative().optional(),
    durationMs: z.number().nonnegative(),
    totalCalls: z.number().int().nonnegative(),
    tokens: z.number().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    outsideTargetFiles: z.number().int().nonnegative(),
    submissionLatencyMs: z.number().nonnegative().optional(),
    outcome: z.enum([
      "usable",
      "empty",
      "blocker",
      "timeout",
      "malformed",
      "model_failure",
    ]),
    acceptedAttacks: z.number().int().nonnegative().optional(),
    landedAttacks: z.number().int().nonnegative().optional(),
    warningStatus: z.enum([
      "shown",
      "not_triggered",
      "unsupported",
      "delivery_failed",
    ]),
    cliVersion: z.string().optional(),
    modelVersion: z.string().optional(),
  })
  .strict();
export type Measurement = z.infer<typeof MeasurementSchema>;

const EffectMetricSchema = z
  .object({
    measuredPairs: z.number().int().nonnegative(),
    median: z.number().optional(),
    interval: z.tuple([z.number(), z.number()]).optional(),
  })
  .strict();

const VerdictSchema = z
  .object({
    verdict: z.enum(["Worked", "Did not work", "Inconclusive"]),
    measurablePairs: z.number().int().nonnegative(),
    triggeredPairs: z.number().int().nonnegative(),
    improvedPairs: z.number().int().nonnegative(),
    medianImprovementPct: z.number(),
    medianDurationDeltaMs: z.number(),
    additionalUnusable: z.number().int(),
    controlAcceptedAttacks: z.number().int().nonnegative().optional(),
    treatmentAcceptedAttacks: z.number().int().nonnegative().optional(),
    controlLandedAttacks: z.number().int().nonnegative().optional(),
    treatmentLandedAttacks: z.number().int().nonnegative().optional(),
    effects: z
      .object({
        callsPct: EffectMetricSchema,
        durationMs: EffectMetricSchema,
        tokens: EffectMetricSchema,
        costUsd: EffectMetricSchema,
      })
      .strict(),
  })
  .strict();

const LegacyManifestSchema = z
  .object({
    version: z.literal(1),
    evaluationId: z.string(),
    seed: z.number().int(),
    sourceRuns: z.array(
      z
        .object({
          runId: z.string(),
          lane: z.string(),
          artifact: z.string(),
        })
        .strict(),
    ),
    adapter: z.enum(["codex", "claude", "gemini"]),
    model: z.string(),
    timeoutMs: z.number().positive(),
    minPairs: z.number().int().positive(),
    maxPairs: z.number().int().positive(),
    minTriggeredPairs: z.number().int().positive(),
    conditions: z.tuple([z.literal("telemetry_only"), z.literal("warning")]),
    callCeiling: z.number().int().positive(),
    costCeilingUsd: z.number().positive().optional(),
    mode: z.enum(["synthetic", "live"]),
  })
  .strict();

const PairSchema = z
  .object({
    pairId: z.string(),
    sourceRunId: z.string(),
    lane: z.string(),
    conditionOrder: z.tuple([
      z.enum(["telemetry_only", "warning"]),
      z.enum(["telemetry_only", "warning"]),
    ]),
    cacheOrder: z.tuple([
      z.enum(["telemetry_only", "warning"]),
      z.enum(["telemetry_only", "warning"]),
    ]),
    attempt: z.union([z.literal(1), z.literal(2)]),
    control: MeasurementSchema,
    treatment: MeasurementSchema,
  })
  .strict();

const ExcludedPairSchema = z
  .object({
    pairId: z.string(),
    sourceRunId: z.string(),
    lane: z.string(),
    attempts: z.union([z.literal(1), z.literal(2)]),
    reason: z.enum(["infrastructure_failure", "warning_unsupported"]),
    detail: z.string(),
  })
  .strict();

export const RediscoveryEvaluationResultSchema = z
  .object({
    manifest: LegacyManifestSchema,
    pairs: z.array(PairSchema),
    excludedPairs: z.array(ExcludedPairSchema),
    verdict: VerdictSchema,
  })
  .strict();
export type RediscoveryEvaluationResult = z.infer<
  typeof RediscoveryEvaluationResultSchema
>;

export { renderRediscoverySummary };
