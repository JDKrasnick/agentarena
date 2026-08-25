import { z } from "zod";
import type {
  EvaluationCondition,
  EvaluationProvider,
} from "./pause-replan-contracts.js";

export const LifecycleKindSchema = z.enum([
  "drift_detected",
  "interrupt_requested",
  "interrupt_completed",
  "checkpoint_started",
  "checkpoint_acknowledged",
  "decision_recorded",
  "lease_granted",
  "continuation_started",
  "post_checkpoint_action",
  "lease_exhausted",
  "final_checkpoint",
  "credible_test_created",
  "attack_accepted",
  "attack_landed",
  "terminal",
]);
export type LifecycleKind = z.infer<typeof LifecycleKindSchema>;

export const LifecycleEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    timestamp_ms: z.number().int().nonnegative(),
    provider: z.enum(["claude", "codex"]),
    requested_model: z.string().min(1),
    provider_model: z.string().min(1).optional(),
    condition: z.enum(["telemetry_only", "passive_warning", "checkpoint"]),
    kind: LifecycleKindSchema,
    tool_call_index: z.number().int().nonnegative(),
    scope_class: z.enum(["trusted", "leased", "broad", "unknown"]),
    checkpoint_id: z.string().max(64).optional(),
    lease_calls_used: z.number().int().nonnegative(),
    lease_calls_remaining: z.number().int().nonnegative(),
    decision: z.enum(["return_to_scope", "request_lease", "stop"]).optional(),
    terminal_reason: z.string().max(160).optional(),
  })
  .strict();
export type LifecycleEvent = z.infer<typeof LifecycleEventSchema>;

const requiredPredecessor: Partial<Record<LifecycleKind, LifecycleKind>> = {
  interrupt_requested: "drift_detected",
  interrupt_completed: "interrupt_requested",
  checkpoint_started: "interrupt_completed",
  checkpoint_acknowledged: "checkpoint_started",
  decision_recorded: "checkpoint_acknowledged",
  lease_granted: "decision_recorded",
  continuation_started: "decision_recorded",
  post_checkpoint_action: "continuation_started",
  lease_exhausted: "lease_granted",
  final_checkpoint: "lease_exhausted",
  credible_test_created: "continuation_started",
  attack_accepted: "credible_test_created",
  attack_landed: "attack_accepted",
};

export function validateLifecycle(events: readonly LifecycleEvent[]): void {
  const seen = new Set<LifecycleKind>();
  let expectedSequence = 1;
  let terminal = false;
  for (const event of events) {
    LifecycleEventSchema.parse(event);
    if (terminal) throw new Error("lifecycle events cannot follow terminal");
    if (event.sequence !== expectedSequence)
      throw new Error("lifecycle sequence must be contiguous");
    expectedSequence += 1;
    const predecessor = requiredPredecessor[event.kind];
    if (
      event.condition === "checkpoint" &&
      predecessor &&
      !seen.has(predecessor)
    ) {
      throw new Error(`${event.kind} requires ${predecessor}`);
    }
    if (
      event.kind === "checkpoint_acknowledged" &&
      event.checkpoint_id === undefined
    ) {
      throw new Error("checkpoint acknowledgement requires a checkpoint id");
    }
    seen.add(event.kind);
    terminal ||= event.kind === "terminal";
  }
  if (!terminal) throw new Error("lifecycle must end with terminal");
}

export class LifecycleLedger {
  readonly events: LifecycleEvent[] = [];
  private toolCallIndex = 0;
  private leaseUsed = 0;
  private leaseRemaining = 0;

  constructor(
    private readonly identity: {
      provider: EvaluationProvider;
      requestedModel: string;
      providerModel?: string;
      condition: EvaluationCondition;
    },
  ) {}

  setToolCallIndex(value: number): void {
    this.toolCallIndex = value;
  }

  setLease(used: number, remaining: number): void {
    this.leaseUsed = used;
    this.leaseRemaining = remaining;
  }

  record(
    kind: LifecycleKind,
    scopeClass: LifecycleEvent["scope_class"],
    details: Pick<
      LifecycleEvent,
      "checkpoint_id" | "decision" | "terminal_reason"
    > = {},
  ): LifecycleEvent {
    const event = LifecycleEventSchema.parse({
      sequence: this.events.length + 1,
      timestamp_ms: Date.now(),
      provider: this.identity.provider,
      requested_model: this.identity.requestedModel,
      ...(this.identity.providerModel
        ? { provider_model: this.identity.providerModel }
        : {}),
      condition: this.identity.condition,
      kind,
      tool_call_index: this.toolCallIndex,
      scope_class: scopeClass,
      lease_calls_used: this.leaseUsed,
      lease_calls_remaining: this.leaseRemaining,
      ...details,
    });
    this.events.push(event);
    return event;
  }
}

export class ExplorationLease {
  private callsUsed = 0;
  readonly paths: ReadonlySet<string>;

  constructor(
    paths: readonly string[],
    private readonly callLimit = 5,
  ) {
    this.paths = new Set(paths);
    if (this.paths.size === 0 || this.paths.size > 2)
      throw new Error("lease requires one or two files");
  }

  consume(path?: string): {
    allowed: boolean;
    exhausted: boolean;
    used: number;
    remaining: number;
  } {
    this.callsUsed += 1;
    const remaining = Math.max(0, this.callLimit - this.callsUsed);
    return {
      allowed: path === undefined || this.paths.has(path),
      exhausted: this.callsUsed >= this.callLimit,
      used: this.callsUsed,
      remaining,
    };
  }
}
