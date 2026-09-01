import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  access,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sha256 } from "../core/ids.js";
import type { CommandResult } from "../core/types.js";

export const UsageCompletenessSchema = z.enum([
  "complete",
  "partial",
  "unavailable",
]);

export const UsageCountersSchema = z
  .object({
    uncachedInputTokens: z.number().int().nonnegative().nullable(),
    cacheCreationTokens: z.number().int().nonnegative().nullable(),
    cacheReadTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    reasoningTokens: z.number().int().nonnegative().nullable(),
    processedTokens: z.number().int().nonnegative().nullable(),
    newInputOutputTokens: z.number().int().nonnegative().nullable(),
    completeness: UsageCompletenessSchema,
  })
  .strict();
export type UsageCounters = z.infer<typeof UsageCountersSchema>;

export const UsageCostSchema = z
  .object({
    usd: z.number().nonnegative().nullable(),
    source: z.enum(["provider_billing", "rate_card", "unavailable"]),
    rateCardVersion: z.string().min(1).nullable(),
    unavailableReason: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((cost, context) => {
    if (cost.source === "unavailable") {
      if (cost.usd !== null || !cost.unavailableReason) {
        context.addIssue({
          code: "custom",
          message: "Unavailable cost requires null USD and a reason",
        });
      }
      return;
    }
    if (cost.usd === null || cost.unavailableReason !== null) {
      context.addIssue({
        code: "custom",
        message: "Authoritative cost requires USD and no unavailable reason",
      });
    }
    if (cost.source === "rate_card" && !cost.rateCardVersion) {
      context.addIssue({
        code: "custom",
        path: ["rateCardVersion"],
        message: "Rate-card cost requires a stable version",
      });
    }
  });
export type UsageCost = z.infer<typeof UsageCostSchema>;

const RoundSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal("recovery"),
  z.literal("reconciliation"),
  z.null(),
]);

export const InvocationUsageSchema = z
  .object({
    version: z.literal(1),
    accountingVersion: z.literal(1),
    invocationId: z.string().uuid(),
    provider: z.string().min(1),
    requestedModel: z.string().min(1).nullable(),
    resolvedModel: z.string().min(1).nullable(),
    resolvedModelSource: z.enum(["provider", "requested", "unavailable"]),
    role: z.enum(["contestant", "judge"]),
    contestantId: z.enum(["a", "b"]).nullable(),
    stage: z.string().min(1),
    round: RoundSchema,
    status: z.enum([
      "succeeded",
      "failed",
      "cancelled",
      "timed_out",
      "infrastructure_error",
    ]),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    durationMs: z.number().int().nonnegative(),
    usage: UsageCountersSchema,
    cost: UsageCostSchema,
    artifactRefs: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((invocation, context) => {
    if (
      (invocation.resolvedModel === null &&
        invocation.resolvedModelSource !== "unavailable") ||
      (invocation.resolvedModel !== null &&
        invocation.resolvedModelSource === "unavailable")
    ) {
      context.addIssue({
        code: "custom",
        path: ["resolvedModelSource"],
        message: "Resolved model identity and source must agree",
      });
    }
  })
  .readonly();
export type InvocationUsage = z.infer<typeof InvocationUsageSchema>;

const RollupKeySchema = z
  .object({
    key: z.string(),
    invocationCount: z.number().int().nonnegative(),
    providerDurationMs: z.number().int().nonnegative(),
    usage: UsageCountersSchema,
    cost: UsageCostSchema,
  })
  .strict();

export const UsageAggregateSchema = RollupKeySchema.omit({ key: true }).extend({
  version: z.literal(1),
});
export type UsageAggregate = z.infer<typeof UsageAggregateSchema>;

export const RunUsageSummarySchema = z
  .object({
    version: z.literal(1),
    accountingVersion: z.literal(1),
    generatedAt: z.string().datetime(),
    invocationArtifactCount: z.number().int().nonnegative(),
    total: UsageAggregateSchema,
    byProvider: z.array(RollupKeySchema),
    byResolvedModel: z.array(RollupKeySchema),
    byRole: z.array(RollupKeySchema),
    byStage: z.array(RollupKeySchema),
    byRound: z.array(RollupKeySchema),
  })
  .strict()
  .readonly();
export type RunUsageSummary = z.infer<typeof RunUsageSummarySchema>;

export interface ProviderInvocationMetadata {
  provider: string;
  requestedModel?: string;
  role: "contestant" | "judge";
  contestantId?: "a" | "b";
  stage: string;
  round?: 1 | 2 | 3 | 4 | 5 | "recovery" | "reconciliation";
}

export function countersFromCommand(result: CommandResult): UsageCounters {
  const diagnostics = result.providerDiagnostics;
  const usage = diagnostics?.tokenUsage;
  const uncached = usage?.uncachedInputTokens ?? null;
  const cacheCreation = usage?.cacheWriteTokens ?? null;
  const cacheRead = usage?.cacheReadTokens ?? null;
  const output = usage?.outputTokens ?? null;
  const reasoning = usage?.reasoningTokens ?? null;
  const available = [uncached, cacheCreation, cacheRead, output].filter(
    (value) => value !== null,
  );
  const allComponentsAvailable =
    uncached !== null &&
    cacheCreation !== null &&
    cacheRead !== null &&
    output !== null;
  const reportedCompleteness = diagnostics?.usageCompleteness;
  const completeness =
    available.length === 0
      ? "unavailable"
      : allComponentsAvailable &&
          reportedCompleteness !== "partial" &&
          reportedCompleteness !== "unavailable"
        ? "complete"
        : "partial";
  return UsageCountersSchema.parse({
    uncachedInputTokens: uncached,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead,
    outputTokens: output,
    reasoningTokens: reasoning,
    processedTokens:
      completeness === "unavailable"
        ? null
        : (uncached ?? 0) +
          (cacheCreation ?? 0) +
          (cacheRead ?? 0) +
          (output ?? 0),
    newInputOutputTokens:
      uncached === null || output === null ? null : uncached + output,
    completeness,
  });
}

const unavailableCost = (provider: string) => ({
  usd: null,
  source: "unavailable" as const,
  rateCardVersion: null,
  unavailableReason: ["codex", "claude", "gemini"].includes(provider)
    ? "subscription_cli_no_metered_cost"
    : "provider_did_not_report_cost",
});

const costFromCommand = (provider: string, result: CommandResult) =>
  result.providerDiagnostics?.reportedCostUsd === undefined ||
  result.providerDiagnostics.reportedCostSource !== "provider_billing"
    ? unavailableCost(provider)
    : {
        usd: result.providerDiagnostics.reportedCostUsd,
        source: "provider_billing" as const,
        rateCardVersion: null,
        unavailableReason: null,
      };

function sumCounters(records: readonly InvocationUsage[]): UsageCounters {
  const fields = [
    "uncachedInputTokens",
    "cacheCreationTokens",
    "cacheReadTokens",
    "outputTokens",
    "reasoningTokens",
    "processedTokens",
    "newInputOutputTokens",
  ] as const;
  const completeness =
    records.length === 0
      ? "unavailable"
      : records.every((record) => record.usage.completeness === "complete")
        ? "complete"
        : records.every((record) => record.usage.completeness === "unavailable")
          ? "unavailable"
          : "partial";
  return UsageCountersSchema.parse({
    ...Object.fromEntries(
      fields.map((field) => {
        const values = records.map((record) => record.usage[field]);
        return [
          field,
          values.every((value) => value === null)
            ? null
            : values.reduce<number>((sum, value) => sum + (value ?? 0), 0),
        ];
      }),
    ),
    completeness,
  });
}

function aggregate(records: readonly InvocationUsage[]) {
  const rateCardVersions = new Set(
    records.flatMap((record) =>
      record.cost.source === "rate_card" && record.cost.rateCardVersion
        ? [record.cost.rateCardVersion]
        : [],
    ),
  );
  const costCovered =
    records.length > 0 &&
    records.every((record) => record.cost.usd !== null) &&
    rateCardVersions.size <= 1;
  const cost = costCovered
    ? {
        usd: records.reduce((sum, record) => sum + (record.cost.usd ?? 0), 0),
        source: records.every(
          (record) => record.cost.source === "provider_billing",
        )
          ? ("provider_billing" as const)
          : ("rate_card" as const),
        rateCardVersion: [...rateCardVersions][0] ?? null,
        unavailableReason: null,
      }
    : {
        usd: null,
        source: "unavailable" as const,
        rateCardVersion: null,
        unavailableReason: records.length
          ? "incomplete_cost_coverage"
          : "provider_did_not_report_cost",
      };
  return {
    invocationCount: records.length,
    providerDurationMs: records.reduce(
      (sum, record) => sum + record.durationMs,
      0,
    ),
    usage: sumCounters(records),
    cost,
  };
}

function rollup(
  records: readonly InvocationUsage[],
  keyFor: (record: InvocationUsage) => string,
) {
  const groups = new Map<string, InvocationUsage[]>();
  for (const record of records) {
    const key = keyFor(record);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entries]) => ({ key, ...aggregate(entries) }));
}

export function buildUsageSummary(
  records: readonly InvocationUsage[],
  generatedAt = new Date(),
): RunUsageSummary {
  return RunUsageSummarySchema.parse({
    version: 1,
    accountingVersion: 1,
    generatedAt: generatedAt.toISOString(),
    invocationArtifactCount: records.length,
    total: { version: 1, ...aggregate(records) },
    byProvider: rollup(records, (record) => record.provider),
    byResolvedModel: rollup(
      records,
      (record) => record.resolvedModel ?? "unknown",
    ),
    byRole: rollup(records, (record) => record.role),
    byStage: rollup(records, (record) => record.stage),
    byRound: rollup(records, (record) =>
      record.round === null ? "unscoped" : String(record.round),
    ),
  });
}

const ledgerQueues = new Map<string, Promise<void>>();

async function findRunDirectory(
  logPrefix: string,
): Promise<string | undefined> {
  let candidate = path.dirname(path.resolve(logPrefix));
  for (let depth = 0; depth < 10; depth += 1) {
    try {
      await Promise.all([
        access(path.join(candidate, "logs")),
        access(path.join(candidate, "rounds")),
      ]);
      return candidate;
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return undefined;
      candidate = parent;
    }
  }
  return undefined;
}

async function rebuildSummary(runDirectory: string): Promise<void> {
  const directory = path.join(runDirectory, "telemetry", "invocations");
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const records = await Promise.all(
    names.map(async (name) =>
      InvocationUsageSchema.parse(
        JSON.parse(await readFile(path.join(directory, name), "utf8")),
      ),
    ),
  );
  const summary = buildUsageSummary(records);
  const target = path.join(runDirectory, "telemetry", "summary.json");
  const temporary = path.join(runDirectory, `.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

export async function sealInvocationUsage(options: {
  logPrefix: string;
  metadata: ProviderInvocationMetadata;
  result: CommandResult;
  startedAt: Date;
  finishedAt: Date;
}): Promise<{ path: string; sha256: string } | undefined> {
  const runDirectory = await findRunDirectory(options.logPrefix);
  if (!runDirectory) return undefined;
  const invocationId = randomUUID();
  const providerResolvedModel =
    options.result.providerDiagnostics?.resolvedModel ?? null;
  const requestedModel = options.metadata.requestedModel ?? null;
  const record = InvocationUsageSchema.parse({
    version: 1,
    accountingVersion: 1,
    invocationId,
    provider: options.metadata.provider,
    requestedModel,
    resolvedModel: providerResolvedModel ?? requestedModel,
    resolvedModelSource: providerResolvedModel
      ? "provider"
      : requestedModel
        ? "requested"
        : "unavailable",
    role: options.metadata.role,
    contestantId: options.metadata.contestantId ?? null,
    stage: options.metadata.stage,
    round: options.metadata.round ?? null,
    status:
      options.result.failureClass === "arena_infrastructure"
        ? "infrastructure_error"
        : options.result.timedOut
          ? "timed_out"
          : options.result.signal
            ? "cancelled"
            : options.result.exitCode === 0
              ? "succeeded"
              : "failed",
    startedAt: options.startedAt.toISOString(),
    finishedAt: options.finishedAt.toISOString(),
    durationMs: options.result.durationMs,
    usage: countersFromCommand(options.result),
    cost: costFromCommand(options.metadata.provider, options.result),
    artifactRefs: [
      options.result.stdoutPath,
      options.result.stderrPath,
      ...(options.result.providerDiagnostics?.eventLogPath
        ? [options.result.providerDiagnostics.eventLogPath]
        : []),
    ],
  });
  const directory = path.join(runDirectory, "telemetry", "invocations");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${invocationId}.json`);
  const temporary = path.join(runDirectory, `.${randomUUID()}.tmp`);
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(temporary, contents, "utf8");
  try {
    await link(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  const prior = ledgerQueues.get(runDirectory) ?? Promise.resolve();
  const queued = prior.then(() => rebuildSummary(runDirectory));
  ledgerQueues.set(
    runDirectory,
    queued.catch(() => undefined),
  );
  await queued;
  return { path: target, sha256: sha256(contents) };
}

export async function readRunUsageSummary(
  runDirectory: string,
): Promise<RunUsageSummary | undefined> {
  try {
    return RunUsageSummarySchema.parse(
      JSON.parse(
        await readFile(
          path.join(runDirectory, "telemetry", "summary.json"),
          "utf8",
        ),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readInvocationUsages(
  runDirectory: string,
): Promise<InvocationUsage[]> {
  try {
    const directory = path.join(runDirectory, "telemetry", "invocations");
    const names = (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .sort();
    return Promise.all(
      names.map(async (name) =>
        InvocationUsageSchema.parse(
          JSON.parse(await readFile(path.join(directory, name), "utf8")),
        ),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function readRunUsageSummarySync(
  runDirectory: string,
): RunUsageSummary | undefined {
  try {
    return RunUsageSummarySchema.parse(
      JSON.parse(
        readFileSync(
          path.join(runDirectory, "telemetry", "summary.json"),
          "utf8",
        ),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

export function conciseUsage(summary: RunUsageSummary | undefined): string {
  if (!summary) return "usage unavailable";
  const usage = summary.total.usage;
  const tokens = (value: number | null) =>
    value === null ? "unavailable" : value.toLocaleString("en-US");
  const cost =
    summary.total.cost.usd === null
      ? `cost unavailable (${summary.total.cost.unavailableReason ?? "unknown"})`
      : `$${summary.total.cost.usd.toFixed(4)}`;
  return `${(summary.total.providerDurationMs / 1000).toFixed(1)}s provider time · ${String(summary.total.invocationCount)} invocation(s) · ${tokens(usage.processedTokens)} processed tokens (${usage.completeness}) · ${tokens(usage.cacheReadTokens)} cache reads · ${tokens(usage.newInputOutputTokens)} new I/O · ${cost}`;
}
