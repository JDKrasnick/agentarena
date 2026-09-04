import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  conditionOrders,
  PauseReplanManifestSchema,
  type EvaluationCondition,
  type EvaluationProvider,
  type PauseReplanManifest,
  type SubmissionOutcome,
} from "./pause-replan-contracts.js";
import {
  LifecycleKindSchema,
  validateLifecycle,
  type LifecycleKind,
} from "./pause-replan-lifecycle.js";
import {
  createPauseReplanRunner,
  type PauseReplanConditionResult,
  type PauseReplanRunner,
} from "./pause-replan-runner.js";
import { renderPauseReplanSummary } from "./pause-replan-summary.js";
import {
  RediscoveryEvaluationResultSchema,
  renderRediscoverySummary,
} from "./rediscovery.js";

export interface ConditionMeasurement {
  scenario_id: string;
  provider: EvaluationProvider;
  condition: EvaluationCondition;
  condition_order: readonly EvaluationCondition[];
  attempt: 1 | 2;
  requested_model: string;
  provider_model: string;
  cli_version: string;
  duration_ms: number;
  tool_calls: number;
  first_broad_call?: number | undefined;
  first_executable_test_call?: number | undefined;
  right_censored: boolean;
  primary_outcome: boolean;
  outcome: SubmissionOutcome;
  accepted_attacks: number;
  landed_attacks?: number | undefined;
  unusable_submission: boolean;
  checkpoint_acknowledged: boolean;
  passive_warning_delivery:
    "not_applicable" | "not_triggered" | "attempted" | "acknowledged";
  input_tokens?: number | undefined;
  output_tokens?: number | undefined;
  estimated_cost_usd: number;
  cost_source: "provider" | "rate_card";
  lifecycle_path: string;
  lifecycle_kinds: LifecycleKind[];
  protocol_checks: PauseReplanConditionResult["protocolChecks"];
}

export interface ModelVerdictDetail {
  provider: EvaluationProvider;
  comparable_pairs: number;
  control_primary_rate: number;
  checkpoint_primary_rate: number;
  difference_points: number;
  accepted_control: number;
  accepted_checkpoint: number;
  landed_control?: number | undefined;
  landed_checkpoint?: number | undefined;
}

export interface PauseReplanVerdict {
  verdict: "Worked" | "Did not work" | "Inconclusive";
  comparable_pairs: number;
  pooled_difference_points: number;
  bootstrap_interval_points: readonly [number, number];
  acknowledgement_complete: boolean;
  additional_unusable: number;
  models: ModelVerdictDetail[];
  reason: string;
}

export interface TransportGateResult {
  status: "Protocol passed" | "Protocol failed";
  failures: string[];
}

export interface PauseReplanEvaluationResult {
  version: 2;
  manifest: PersistedPauseReplanManifest;
  manifest_sha256: string;
  created_at: string;
  phase: "transport_gate" | "full";
  measurements: ConditionMeasurement[];
  total_estimated_cost_usd: number;
  transport_gate: TransportGateResult;
  verdict?: PauseReplanVerdict | undefined;
}

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const PersistedScenarioSchema = z
  .object({
    id: z.string().min(1),
    source_run_id: z.string().min(1),
    lane: z.string().min(1),
    repository_root: z.string().min(1),
    base_commit: z.string().regex(/^[0-9a-f]{40}$/u),
    target_patch: z
      .object({ path: z.string().min(1), sha256: Sha256Schema })
      .strict(),
    packet_digest: Sha256Schema,
    active_finding_id: z.string().min(1),
    trusted_paths: z.array(z.string()).min(1),
    validation_command_sha256: Sha256Schema,
    attack_prompt_sha256: Sha256Schema,
  })
  .strict();

const PersistedPauseReplanManifestSchema = z
  .object({
    version: z.literal(2),
    evaluation_id: z.string().min(1),
    seed: z.number().int(),
    mode: z.enum(["fake", "live"]),
    phase: z.enum(["transport_gate", "full"]),
    models: z.array(
      z
        .object({
          provider: z.enum(["claude", "codex"]),
          requested_model: z.string().min(1),
          conditions: z.array(
            z.enum(["telemetry_only", "passive_warning", "checkpoint"]),
          ),
        })
        .strict(),
    ),
    scenarios: z.array(PersistedScenarioSchema).length(12),
    transport_gate_scenario_ids: z.array(z.string()).length(4),
    limits: z
      .object({
        duration_ms: z.literal(360_000),
        tool_calls: z.literal(100),
        checkpoint_lease_calls: z.literal(5),
        checkpoint_lease_files: z.literal(2),
        aggregate_cost_usd: z.number().positive().max(40),
        maximum_condition_cost_usd: z.number().positive(),
      })
      .strict(),
    rate_card: z.array(
      z
        .object({
          provider: z.enum(["claude", "codex"]),
          model: z.string().min(1),
          input_usd_per_million: z.number().nonnegative(),
          output_usd_per_million: z.number().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
type PersistedPauseReplanManifest = z.infer<
  typeof PersistedPauseReplanManifestSchema
>;

const ProtocolChecksSchema = z
  .object({
    completeOrdering: z.boolean(),
    modelVersionStable: z.boolean(),
    noRepositoryActionBeforeAcknowledgement: z.boolean(),
    checkpointWithoutRepositoryAccess: z.boolean(),
    validStructuredDecision: z.boolean(),
    continuationAfterDecision: z.boolean(),
    leaseCountingAndPathsEnforced: z.boolean(),
    cleanupComplete: z.boolean(),
    noSurvivingChildProcess: z.boolean(),
    noLeakedWorktree: z.boolean(),
    sourceImmutable: z.boolean(),
  })
  .strict();

export const ConditionMeasurementSchema = z
  .object({
    scenario_id: z.string().min(1),
    provider: z.enum(["claude", "codex"]),
    condition: z.enum(["telemetry_only", "passive_warning", "checkpoint"]),
    condition_order: z.array(
      z.enum(["telemetry_only", "passive_warning", "checkpoint"]),
    ),
    attempt: z.union([z.literal(1), z.literal(2)]),
    requested_model: z.string().min(1),
    provider_model: z.string().min(1),
    cli_version: z.string().min(1),
    duration_ms: z.number().int().nonnegative(),
    tool_calls: z.number().int().nonnegative(),
    first_broad_call: z.number().int().nonnegative().optional(),
    first_executable_test_call: z.number().int().nonnegative().optional(),
    right_censored: z.boolean(),
    primary_outcome: z.boolean(),
    outcome: z.enum([
      "usable",
      "empty",
      "blocker",
      "timeout",
      "malformed",
      "model_failure",
      "checkpoint_policy_failure",
    ]),
    accepted_attacks: z.number().int().nonnegative(),
    landed_attacks: z.number().int().nonnegative().optional(),
    unusable_submission: z.boolean(),
    checkpoint_acknowledged: z.boolean(),
    passive_warning_delivery: z.enum([
      "not_applicable",
      "not_triggered",
      "attempted",
      "acknowledged",
    ]),
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    estimated_cost_usd: z.number().nonnegative(),
    cost_source: z.enum(["provider", "rate_card"]),
    lifecycle_path: z.string().min(1),
    lifecycle_kinds: z.array(LifecycleKindSchema),
    protocol_checks: ProtocolChecksSchema,
  })
  .strict()
  .superRefine((measurement, context) => {
    if (
      measurement.right_censored !==
      (measurement.first_executable_test_call === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["right_censored"],
        message: "right-censoring must reflect a missing executable test event",
      });
    }
    const withinPrimaryBudget =
      measurement.first_broad_call !== undefined &&
      measurement.first_executable_test_call !== undefined &&
      measurement.first_executable_test_call >= measurement.first_broad_call &&
      measurement.first_executable_test_call - measurement.first_broad_call <=
        60;
    if (
      measurement.primary_outcome !==
      (measurement.accepted_attacks > 0 && withinPrimaryBudget)
    ) {
      context.addIssue({
        code: "custom",
        path: ["primary_outcome"],
        message: "primary outcome must use the frozen accepted/60-call rule",
      });
    }
    if (measurement.tool_calls > 100) {
      context.addIssue({
        code: "custom",
        path: ["tool_calls"],
        message: "condition exceeded the 100-call ceiling",
      });
    }
    if (
      measurement.condition === "passive_warning" &&
      measurement.provider !== "claude"
    ) {
      context.addIssue({
        code: "custom",
        path: ["condition"],
        message: "passive warning is unsupported for Codex",
      });
    }
  });

const ModelVerdictDetailSchema = z
  .object({
    provider: z.enum(["claude", "codex"]),
    comparable_pairs: z.number().int().nonnegative(),
    control_primary_rate: z.number().min(0).max(1),
    checkpoint_primary_rate: z.number().min(0).max(1),
    difference_points: z.number(),
    accepted_control: z.number().int().nonnegative(),
    accepted_checkpoint: z.number().int().nonnegative(),
    landed_control: z.number().int().nonnegative().optional(),
    landed_checkpoint: z.number().int().nonnegative().optional(),
  })
  .strict();

const PauseReplanVerdictSchema = z
  .object({
    verdict: z.enum(["Worked", "Did not work", "Inconclusive"]),
    comparable_pairs: z.number().int().nonnegative(),
    pooled_difference_points: z.number(),
    bootstrap_interval_points: z.tuple([z.number(), z.number()]),
    acknowledgement_complete: z.boolean(),
    additional_unusable: z.number().int(),
    models: z.array(ModelVerdictDetailSchema).length(2),
    reason: z.string().min(1),
  })
  .strict();

export const PauseReplanEvaluationResultSchema = z
  .object({
    version: z.literal(2),
    manifest: PersistedPauseReplanManifestSchema,
    manifest_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    created_at: z.string().min(1),
    phase: z.enum(["transport_gate", "full"]),
    measurements: z.array(ConditionMeasurementSchema),
    total_estimated_cost_usd: z.number().nonnegative().max(40),
    transport_gate: z
      .object({
        status: z.enum(["Protocol passed", "Protocol failed"]),
        failures: z.array(z.string()),
      })
      .strict(),
    verdict: PauseReplanVerdictSchema.optional(),
  })
  .strict();

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

export function pairedBootstrapInterval(
  values: readonly number[],
  seed: number,
  samples = 10_000,
): readonly [number, number] {
  if (values.length === 0) return [0, 0];
  const random = seededRandom(seed);
  const estimates = Array.from({ length: samples }, () => {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) {
      sum += values[Math.floor(random() * values.length)] ?? 0;
    }
    return (sum / values.length) * 100;
  }).sort((left, right) => left - right);
  return [
    estimates[Math.floor(samples * 0.025)] ?? 0,
    estimates[Math.floor(samples * 0.975)] ?? 0,
  ];
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function modelDetail(
  provider: EvaluationProvider,
  pairs: readonly {
    control: ConditionMeasurement;
    checkpoint: ConditionMeasurement;
  }[],
): ModelVerdictDetail {
  const selected = pairs.filter((pair) => pair.control.provider === provider);
  const acceptedControl = sum(
    selected.map((pair) => pair.control.accepted_attacks),
  );
  const acceptedCheckpoint = sum(
    selected.map((pair) => pair.checkpoint.accepted_attacks),
  );
  const landedVisible = selected.every(
    (pair) =>
      pair.control.landed_attacks !== undefined &&
      pair.checkpoint.landed_attacks !== undefined,
  );
  const controlRate =
    selected.length === 0
      ? 0
      : selected.filter((pair) => pair.control.primary_outcome).length /
        selected.length;
  const checkpointRate =
    selected.length === 0
      ? 0
      : selected.filter((pair) => pair.checkpoint.primary_outcome).length /
        selected.length;
  return {
    provider,
    comparable_pairs: selected.length,
    control_primary_rate: controlRate,
    checkpoint_primary_rate: checkpointRate,
    difference_points: (checkpointRate - controlRate) * 100,
    accepted_control: acceptedControl,
    accepted_checkpoint: acceptedCheckpoint,
    ...(landedVisible
      ? {
          landed_control: sum(
            selected.map((pair) => pair.control.landed_attacks ?? 0),
          ),
          landed_checkpoint: sum(
            selected.map((pair) => pair.checkpoint.landed_attacks ?? 0),
          ),
        }
      : {}),
  };
}

export function evaluatePauseReplan(
  measurements: readonly ConditionMeasurement[],
  seed: number,
): PauseReplanVerdict {
  const pairs = measurements.flatMap((control) => {
    const protocolPassed = (measurement: ConditionMeasurement) =>
      Object.values(measurement.protocol_checks).every(Boolean);
    if (
      control.condition !== "telemetry_only" ||
      control.first_broad_call === undefined ||
      !protocolPassed(control)
    )
      return [];
    const checkpoint = measurements.find(
      (candidate) =>
        candidate.scenario_id === control.scenario_id &&
        candidate.provider === control.provider &&
        candidate.condition === "checkpoint" &&
        candidate.first_broad_call !== undefined &&
        protocolPassed(candidate),
    );
    return checkpoint ? [{ control, checkpoint }] : [];
  });
  const differences = pairs.map(
    (pair) =>
      Number(pair.checkpoint.primary_outcome) -
      Number(pair.control.primary_outcome),
  );
  const pooledDifference =
    differences.length === 0
      ? 0
      : (sum(differences) / differences.length) * 100;
  const interval = pairedBootstrapInterval(differences, seed);
  const models = (["claude", "codex"] as const).map((provider) =>
    modelDetail(provider, pairs),
  );
  const acknowledgementComplete = pairs.every(
    (pair) => pair.checkpoint.checkpoint_acknowledged,
  );
  const acceptedGuardrail = models.every(
    (model) => model.accepted_checkpoint >= model.accepted_control - 1,
  );
  const landedComplete = models.every(
    (model) =>
      model.landed_control !== undefined &&
      model.landed_checkpoint !== undefined,
  );
  const landedGuardrail = models.every(
    (model) =>
      (model.landed_checkpoint ?? -Infinity) >=
      (model.landed_control ?? Infinity) - 1,
  );
  const overallAcceptedGuardrail =
    sum(models.map((model) => model.accepted_checkpoint)) >=
    sum(models.map((model) => model.accepted_control)) - 1;
  const overallLandedGuardrail =
    landedComplete &&
    sum(models.map((model) => model.landed_checkpoint ?? 0)) >=
      sum(models.map((model) => model.landed_control ?? 0)) - 1;
  const additionalUnusable =
    pairs.filter((pair) => pair.checkpoint.unusable_submission).length -
    pairs.filter((pair) => pair.control.unusable_submission).length;
  const enoughPairs =
    pairs.length >= 20 && models.every((model) => model.comparable_pairs >= 8);
  const qualityFailed =
    !acceptedGuardrail ||
    !overallAcceptedGuardrail ||
    (landedComplete && !landedGuardrail) ||
    (landedComplete && !overallLandedGuardrail) ||
    additionalUnusable > 1;
  const worked =
    enoughPairs &&
    acknowledgementComplete &&
    pooledDifference >= 20 &&
    interval[0] >= 0 &&
    models.every((model) => model.difference_points >= 0) &&
    acceptedGuardrail &&
    overallAcceptedGuardrail &&
    landedComplete &&
    landedGuardrail &&
    overallLandedGuardrail &&
    additionalUnusable <= 1;
  const didNotWork = pooledDifference <= 0 || qualityFailed;
  const verdict = worked
    ? "Worked"
    : didNotWork
      ? "Did not work"
      : "Inconclusive";
  const reason = worked
    ? "The pooled effect met the 20-point threshold and every transport and quality guardrail passed."
    : qualityFailed
      ? "At least one accepted-attack, landed-attack, or usability guardrail was exceeded."
      : pooledDifference <= 0
        ? "Checkpoint mode produced no positive pooled primary-outcome difference."
        : !enoughPairs
          ? "Too few comparable triggered pairs were available."
          : !landedComplete
            ? "Landed-attack measurement was incomplete."
            : interval[0] < 0
              ? "The paired bootstrap interval crossed below zero."
              : "The effect was positive but below the Worked threshold.";
  return {
    verdict,
    comparable_pairs: pairs.length,
    pooled_difference_points: pooledDifference,
    bootstrap_interval_points: interval,
    acknowledgement_complete: acknowledgementComplete,
    additional_unusable: additionalUnusable,
    models,
    reason,
  };
}

function estimateCost(
  result: PauseReplanConditionResult,
  manifest: PauseReplanManifest,
  provider: EvaluationProvider,
  requestedModel: string,
): { cost: number; source: "provider" | "rate_card" } {
  if (result.providerCostUsd !== undefined)
    return { cost: result.providerCostUsd, source: "provider" };
  const rate = manifest.rate_card.find(
    (entry) => entry.provider === provider && entry.model === requestedModel,
  );
  if (
    !rate ||
    result.inputTokens === undefined ||
    result.outputTokens === undefined
  )
    return { cost: 0, source: "rate_card" };
  return {
    cost:
      (result.inputTokens / 1_000_000) * rate.input_usd_per_million +
      (result.outputTokens / 1_000_000) * rate.output_usd_per_million,
    source: "rate_card",
  };
}

function gateFailures(measurements: readonly ConditionMeasurement[]): string[] {
  const failures: string[] = [];
  for (const measurement of measurements) {
    if (measurement.condition !== "checkpoint") continue;
    if (measurement.first_broad_call === undefined)
      failures.push(
        `${measurement.provider}/${measurement.scenario_id}: drift not triggered`,
      );
    if (!measurement.checkpoint_acknowledged)
      failures.push(
        `${measurement.provider}/${measurement.scenario_id}: no acknowledgement`,
      );
    if (measurement.outcome === "checkpoint_policy_failure")
      failures.push(
        `${measurement.provider}/${measurement.scenario_id}: policy failure`,
      );
    if (
      measurement.input_tokens === undefined ||
      measurement.output_tokens === undefined
    ) {
      failures.push(
        `${measurement.provider}/${measurement.scenario_id}: incomplete cost accounting`,
      );
    }
    for (const [check, passed] of Object.entries(measurement.protocol_checks)) {
      if (!passed)
        failures.push(
          `${measurement.provider}/${measurement.scenario_id}: ${check}`,
        );
    }
  }
  return failures;
}

function frozenProtocolDigest(manifest: PauseReplanManifest): string {
  const frozen = { ...manifest, phase: undefined };
  return createHash("sha256").update(JSON.stringify(frozen)).digest("hex");
}

async function writeImmutableJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

async function verifyGateArtifact(file: string, manifest: PauseReplanManifest) {
  const parsed = PauseReplanEvaluationResultSchema.parse(
    JSON.parse(await readFile(file, "utf8")),
  );
  if (
    parsed.version !== 2 ||
    parsed.phase !== "transport_gate" ||
    parsed.transport_gate.status !== "Protocol passed" ||
    parsed.manifest_sha256 !== frozenProtocolDigest(manifest)
  ) {
    throw new Error(
      "Full evaluation requires a passing gate for this exact manifest",
    );
  }
}

export async function runPauseReplanEvaluation(
  manifestPath: string,
  options: {
    cwd?: string;
    gateArtifactPath?: string;
    runner?: PauseReplanRunner;
  } = {},
): Promise<{ outputPath: string; result: PauseReplanEvaluationResult }> {
  const manifest = PauseReplanManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  if (
    manifest.mode === "live" &&
    process.env.AGENT_ARENA_PAUSE_REPLAN_LIVE !== "1"
  )
    throw new Error(
      "Live evaluation is disabled; explicitly set AGENT_ARENA_PAUSE_REPLAN_LIVE=1.",
    );
  if (manifest.mode === "fake" && !options.runner)
    throw new Error(
      "Fake evaluation manifests require an injected test runner and cannot invoke provider CLIs.",
    );
  if (manifest.phase === "full") {
    if (!options.gateArtifactPath)
      throw new Error("Full evaluation requires --transport-gate");
    await verifyGateArtifact(options.gateArtifactPath, manifest);
  }
  const cwd = options.cwd ?? process.cwd();
  const outputDirectory = path.join(
    cwd,
    ".agent-arena",
    "evaluations",
    manifest.evaluation_id,
    manifest.phase,
  );
  await mkdir(path.dirname(outputDirectory), { recursive: true });
  await mkdir(outputDirectory, { recursive: false });
  await mkdir(path.join(outputDirectory, "ledgers"));
  const runner = options.runner ?? createPauseReplanRunner(outputDirectory);
  const measurements: ConditionMeasurement[] = [];
  let spent = 0;
  const selectedScenarios =
    manifest.phase === "transport_gate"
      ? manifest.scenarios.filter((scenario) =>
          manifest.transport_gate_scenario_ids.includes(scenario.id),
        )
      : manifest.scenarios;
  try {
    for (const model of manifest.models) {
      for (const [scenarioIndex, scenario] of selectedScenarios.entries()) {
        const order =
          manifest.phase === "transport_gate"
            ? (["checkpoint"] as const)
            : conditionOrders(model.provider, scenarioIndex);
        let completed: ConditionMeasurement[] | undefined;
        for (const attempt of [1, 2] as const) {
          const candidate: ConditionMeasurement[] = [];
          for (const condition of order) {
            if (
              spent + manifest.limits.maximum_condition_cost_usd >
              manifest.limits.aggregate_cost_usd
            ) {
              throw new Error(
                "Aggregate cost ceiling reached before starting condition",
              );
            }
            const result = await runner.runCondition({
              manifest,
              scenario,
              provider: model.provider,
              requestedModel: model.requested_model,
              condition,
              attempt,
            });
            let lifecycleValid = true;
            try {
              validateLifecycle(result.lifecycle);
            } catch {
              lifecycleValid = false;
            }
            const cost = estimateCost(
              result,
              manifest,
              model.provider,
              model.requested_model,
            );
            spent += cost.cost;
            const lifecycleName = `${model.provider}-${scenario.id}-${condition}-attempt-${String(attempt)}.json`;
            const lifecyclePath = path.posix.join("ledgers", lifecycleName);
            await writeImmutableJson(
              path.join(outputDirectory, lifecyclePath),
              result.lifecycle,
            );
            const callsAfterBroad =
              result.firstBroadCall === undefined ||
              result.firstExecutableTestCall === undefined
                ? undefined
                : result.firstExecutableTestCall - result.firstBroadCall;
            candidate.push({
              scenario_id: scenario.id,
              provider: model.provider,
              condition,
              condition_order: order,
              attempt,
              requested_model: model.requested_model,
              provider_model: result.providerModel,
              cli_version: result.cliVersion,
              duration_ms: result.durationMs,
              tool_calls: result.toolCalls,
              ...(result.firstBroadCall === undefined
                ? {}
                : { first_broad_call: result.firstBroadCall }),
              ...(result.firstExecutableTestCall === undefined
                ? {}
                : {
                    first_executable_test_call: result.firstExecutableTestCall,
                  }),
              right_censored: result.firstExecutableTestCall === undefined,
              primary_outcome:
                result.acceptedAttacks > 0 &&
                callsAfterBroad !== undefined &&
                callsAfterBroad <= 60,
              outcome: result.outcome,
              accepted_attacks: result.acceptedAttacks,
              ...(result.landedAttacks === undefined
                ? {}
                : { landed_attacks: result.landedAttacks }),
              unusable_submission: !["usable", "empty"].includes(
                result.outcome,
              ),
              checkpoint_acknowledged: result.lifecycle.some(
                (event) => event.kind === "checkpoint_acknowledged",
              ),
              passive_warning_delivery: result.passiveWarningDelivery,
              ...(result.inputTokens === undefined
                ? {}
                : { input_tokens: result.inputTokens }),
              ...(result.outputTokens === undefined
                ? {}
                : { output_tokens: result.outputTokens }),
              estimated_cost_usd: cost.cost,
              cost_source: cost.source,
              lifecycle_path: lifecyclePath,
              lifecycle_kinds: result.lifecycle.map((event) => event.kind),
              protocol_checks: {
                ...result.protocolChecks,
                completeOrdering:
                  result.protocolChecks.completeOrdering && lifecycleValid,
              },
            });
            const accountingComplete =
              result.inputTokens !== undefined &&
              result.outputTokens !== undefined;
            if (
              result.infrastructureFailure ||
              !lifecycleValid ||
              !accountingComplete
            )
              break;
          }
          const providerModels = new Set(
            candidate.map((value) => value.provider_model),
          );
          const infrastructureFailure = candidate.length !== order.length;
          if (!infrastructureFailure && providerModels.size === 1) {
            completed = candidate;
            break;
          }
          candidate.forEach((measurement) => {
            measurement.protocol_checks.modelVersionStable =
              providerModels.size === 1;
            measurement.protocol_checks.completeOrdering = false;
          });
          if (attempt === 2) {
            completed = candidate;
            break;
          }
        }
        measurements.push(...(completed ?? []));
      }
    }
  } finally {
    await runner.cleanup();
  }
  const failures = gateFailures(measurements);
  const transportGate: TransportGateResult = {
    status: failures.length === 0 ? "Protocol passed" : "Protocol failed",
    failures,
  };
  const manifestSha = frozenProtocolDigest(manifest);
  const persistedManifest = PersistedPauseReplanManifestSchema.parse({
    ...manifest,
    scenarios: manifest.scenarios.map((scenario) => {
      const validationCommand = scenario.validation_command;
      const attackPrompt = scenario.attack_prompt;
      const safeScenario: Record<string, unknown> = { ...scenario };
      delete safeScenario.packet;
      delete safeScenario.validation_command;
      delete safeScenario.attack_prompt;
      return {
        ...safeScenario,
        validation_command_sha256: createHash("sha256")
          .update(validationCommand)
          .digest("hex"),
        attack_prompt_sha256: createHash("sha256")
          .update(attackPrompt)
          .digest("hex"),
      };
    }),
  });
  const result = PauseReplanEvaluationResultSchema.parse({
    version: 2,
    manifest: persistedManifest,
    manifest_sha256: manifestSha,
    created_at: new Date().toISOString(),
    phase: manifest.phase,
    measurements,
    total_estimated_cost_usd: spent,
    transport_gate: transportGate,
    ...(manifest.phase === "full"
      ? { verdict: evaluatePauseReplan(measurements, manifest.seed) }
      : {}),
  });
  await writeImmutableJson(
    path.join(outputDirectory, "evaluation.json"),
    result,
  );
  await writeFile(
    path.join(outputDirectory, "SUMMARY.html"),
    renderPauseReplanSummary(result),
    { encoding: "utf8", flag: "wx" },
  );
  return { outputPath: outputDirectory, result };
}

export async function renderEvaluationArtifact(file: string): Promise<string> {
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { version?: unknown }).version === 2
  ) {
    return renderPauseReplanSummary(
      PauseReplanEvaluationResultSchema.parse(value),
    );
  }
  return renderRediscoverySummary(
    RediscoveryEvaluationResultSchema.parse(value),
  );
}

export { PauseReplanManifestSchema } from "./pause-replan-contracts.js";
export {
  CheckpointDecisionSchema,
  conditionOrders,
  normalizeLeasePath,
} from "./pause-replan-contracts.js";
export {
  ExplorationLease,
  LifecycleEventSchema,
  LifecycleLedger,
  validateLifecycle,
} from "./pause-replan-lifecycle.js";
