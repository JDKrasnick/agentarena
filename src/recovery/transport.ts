import { z } from "zod";
import type {
  AgentAdapter,
  ConnectivityProbeInput,
} from "../agents/adapter.js";
import type { ArtifactStore } from "../artifacts/store.js";
import { ConnectivityProbeResultSchema, type AgentId } from "../core/types.js";
import { calculateCanonicalHash } from "../contracts/round.js";
import { ProviderStageSchema } from "./provider-policy.js";

const ProbeAttemptSchema = z.object({
  attempt: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  results: z.array(ConnectivityProbeResultSchema).min(1),
  healthy: z.boolean(),
});

export const TransportRecoverySchema = z.object({
  version: z.literal(1),
  parentRunId: z.string().min(1),
  providers: z.array(z.string().min(1)).min(1),
  createdAt: z.string().datetime(),
  probeAttempts: z.array(ProbeAttemptSchema).max(3),
  disposition: z.enum([
    "provider_recovered",
    "probe_exhausted",
    "restart_limit_reached",
    "cancelled",
  ]),
  restartOrdinal: z.number().int().min(1).max(3),
  replacementRunId: z.string().min(1).optional(),
  failedStage: ProviderStageSchema.optional(),
  runChain: z.array(z.string().min(1)).default([]),
  recoveryReason: z.string().min(1).optional(),
  recoveryHash: z.string().length(64),
});
export type TransportRecovery = z.infer<typeof TransportRecoverySchema>;

function sealRecovery(
  value: Omit<TransportRecovery, "recoveryHash">,
): TransportRecovery {
  return TransportRecoverySchema.parse({
    ...value,
    recoveryHash: calculateCanonicalHash(value),
  });
}

export async function probeProviderConnectivity(options: {
  parentRunId: string;
  store: ArtifactStore;
  adapters: ReadonlyMap<AgentId, AgentAdapter>;
  restartOrdinal: number;
  cwd: string;
  signal: AbortSignal;
  now?: () => Date;
  failedStage?: z.infer<typeof ProviderStageSchema>;
  runChain?: readonly string[];
  recoveryReason?: string;
}): Promise<TransportRecovery> {
  const now = options.now ?? (() => new Date());
  const providers = [...options.adapters.keys()];
  if (options.restartOrdinal > 2) {
    return sealRecovery({
      version: 1,
      parentRunId: options.parentRunId,
      providers,
      createdAt: now().toISOString(),
      probeAttempts: [],
      disposition: "restart_limit_reached",
      restartOrdinal: 3,
      ...(options.failedStage ? { failedStage: options.failedStage } : {}),
      runChain: [...(options.runChain ?? [options.parentRunId])],
      ...(options.recoveryReason
        ? { recoveryReason: options.recoveryReason }
        : {}),
    });
  }
  if (options.signal.aborted) {
    return sealRecovery({
      version: 1,
      parentRunId: options.parentRunId,
      providers,
      createdAt: now().toISOString(),
      probeAttempts: [],
      disposition: "cancelled",
      restartOrdinal: options.restartOrdinal,
      ...(options.failedStage ? { failedStage: options.failedStage } : {}),
      runChain: [...(options.runChain ?? [options.parentRunId])],
      ...(options.recoveryReason
        ? { recoveryReason: options.recoveryReason }
        : {}),
    });
  }
  const deadline = Date.now() + 30_000;
  const probeAttempts: z.infer<typeof ProbeAttemptSchema>[] = [];
  for (const attempt of [1, 2, 3] as const) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0 || options.signal.aborted) break;
    const controller = new AbortController();
    const cancel = (): void => controller.abort(options.signal.reason);
    options.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("Provider health probe deadline")),
      Math.min(10_000, remainingMs),
    );
    try {
      const results = await Promise.all(
        [...options.adapters.entries()].map(([provider, adapter]) => {
          const input: ConnectivityProbeInput = {
            cwd: options.cwd,
            transcriptPrefix: options.store.resolve(
              `logs/provider-health-${provider}-attempt-${String(attempt)}`,
            ),
            timeoutMs: Math.min(10_000, remainingMs),
            signal: controller.signal,
          };
          return adapter.probeConnectivity(input);
        }),
      );
      const healthy = results.every((result) => result.healthy);
      probeAttempts.push({ attempt, results, healthy });
      if (options.signal.aborted) break;
      if (healthy)
        return sealRecovery({
          version: 1,
          parentRunId: options.parentRunId,
          providers,
          createdAt: now().toISOString(),
          probeAttempts,
          disposition: "provider_recovered",
          restartOrdinal: options.restartOrdinal,
          ...(options.failedStage ? { failedStage: options.failedStage } : {}),
          runChain: [...(options.runChain ?? [options.parentRunId])],
          ...(options.recoveryReason
            ? { recoveryReason: options.recoveryReason }
            : {}),
        });
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", cancel);
    }
  }
  return sealRecovery({
    version: 1,
    parentRunId: options.parentRunId,
    providers,
    createdAt: now().toISOString(),
    probeAttempts,
    disposition: options.signal.aborted ? "cancelled" : "probe_exhausted",
    restartOrdinal: options.restartOrdinal,
    ...(options.failedStage ? { failedStage: options.failedStage } : {}),
    runChain: [...(options.runChain ?? [options.parentRunId])],
    ...(options.recoveryReason
      ? { recoveryReason: options.recoveryReason }
      : {}),
  });
}

export function withReplacementRunId(
  recovery: TransportRecovery,
  replacementRunId: string,
): TransportRecovery {
  return sealRecovery({
    version: recovery.version,
    parentRunId: recovery.parentRunId,
    providers: recovery.providers,
    createdAt: recovery.createdAt,
    probeAttempts: recovery.probeAttempts,
    disposition: recovery.disposition,
    restartOrdinal: recovery.restartOrdinal,
    replacementRunId,
    ...(recovery.failedStage ? { failedStage: recovery.failedStage } : {}),
    runChain: [...recovery.runChain, replacementRunId],
    ...(recovery.recoveryReason
      ? { recoveryReason: recovery.recoveryReason }
      : {}),
  });
}
