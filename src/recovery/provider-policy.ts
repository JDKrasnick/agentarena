import { z } from "zod";

export const ProviderStageSchema = z.enum([
  "implementation",
  "review",
  "attack_construction",
  "repair",
  "judge",
  "semantic_adjudication",
  "required_validation",
  "final_validation",
]);
export type ProviderStage = z.infer<typeof ProviderStageSchema>;

export const ProviderStageFailureSchema = z
  .object({
    version: z.literal(1),
    provider: z.enum(["codex", "claude", "gemini"]),
    stage: ProviderStageSchema,
    round: z
      .union([
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
      ])
      .optional(),
    contestantId: z.enum(["a", "b"]).optional(),
    reason: z.string().min(1),
    causalEvidence: z.array(z.string().min(1)).min(1),
    artifactRefs: z.array(z.string().min(1)),
    usableTerminalResult: z.literal(false),
  })
  .strict();
export type ProviderStageFailure = z.infer<typeof ProviderStageFailureSchema>;

export interface ProviderRecoveryChainState {
  continuationsCreated: number;
  recoveredProviders: ReadonlySet<string>;
  unrecoveredFailures: number;
}

export type ProviderRecoveryDecision =
  | { action: "recover"; continuationOrdinal: 1 | 2 }
  | {
      action: "ordinary_stage_semantics" | "inconclusive";
      reason:
        | "provider_already_recovered"
        | "continuation_limit_reached"
        | "correctness_critical_stage"
        | "second_unrecovered_failure";
    };

const CORRECTNESS_CRITICAL = new Set<ProviderStage>([
  "implementation",
  "repair",
  "judge",
  "semantic_adjudication",
  "required_validation",
  "final_validation",
]);

export function decideProviderRecovery(
  failure: ProviderStageFailure,
  chain: ProviderRecoveryChainState,
): ProviderRecoveryDecision {
  const recoveryUnavailable =
    chain.continuationsCreated >= 2 ||
    chain.recoveredProviders.has(failure.provider);
  if (!recoveryUnavailable) {
    return {
      action: "recover",
      continuationOrdinal: (chain.continuationsCreated + 1) as 1 | 2,
    };
  }
  if (CORRECTNESS_CRITICAL.has(failure.stage)) {
    return {
      action: "inconclusive",
      reason: "correctness_critical_stage",
    };
  }
  if (chain.unrecoveredFailures >= 1) {
    return {
      action: "inconclusive",
      reason: "second_unrecovered_failure",
    };
  }
  return {
    action: "ordinary_stage_semantics",
    reason: chain.recoveredProviders.has(failure.provider)
      ? "provider_already_recovered"
      : "continuation_limit_reached",
  };
}

export function isCausalProviderFailure(options: {
  transportEvidence: readonly unknown[];
  usableTerminalResult: boolean;
  targetedAttempts: number;
}): boolean {
  return (
    options.targetedAttempts >= 2 &&
    options.transportEvidence.length > 0 &&
    !options.usableTerminalResult
  );
}
