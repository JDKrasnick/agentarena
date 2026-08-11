import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  ContestantIdSchema,
  RoundIdSchema,
  StageSchema,
  type ContestantId,
  type RoundId,
  type Stage,
} from "../core/types.js";

export const OutputSourceSchema = z.enum([
  "agent",
  "verifier",
  "test",
  "integration",
  "harness",
]);
export type OutputSource = z.infer<typeof OutputSourceSchema>;

const EventBaseSchema = z.object({
  version: z.literal(1),
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
});

const event = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  EventBaseSchema.extend({ type: z.literal(type), ...shape });

export const ArenaEventSchema = z.discriminatedUnion("type", [
  event("battle_started", {
    runId: z.string(),
    task: z.string(),
    contestants: z
      .array(
        z.object({
          id: ContestantIdSchema,
          provider: z.string(),
          model: z.string().optional(),
        }),
      )
      .optional(),
    links: z
      .array(
        z.object({
          kind: z.enum(["pull_request", "issue", "spec", "artifacts"]),
          label: z.string(),
          url: z.string().url(),
        }),
      )
      .optional(),
  }),
  event("stage_changed", {
    stage: StageSchema,
    round: RoundIdSchema.optional(),
  }),
  event("round_started", { round: RoundIdSchema }),
  event("invocation_started", {
    invocationId: z.string(),
    source: OutputSourceSchema,
    contestantId: ContestantIdSchema.optional(),
    stage: z.string(),
    round: RoundIdSchema.optional(),
  }),
  event("invocation_finished", {
    invocationId: z.string(),
    status: z.string(),
    durationMs: z.number().int().nonnegative(),
    contestantId: ContestantIdSchema.optional(),
  }),
  event("output", {
    invocationId: z.string(),
    source: OutputSourceSchema,
    stream: z.enum(["stdout", "stderr"]),
    text: z.string(),
    contestantId: ContestantIdSchema.optional(),
  }),
  event("check_completed", {
    checkId: z.string(),
    status: z.string(),
    contestantId: ContestantIdSchema.optional(),
  }),
  event("attack_mounted", {
    attackId: z.string(),
    round: RoundIdSchema,
    attackerId: ContestantIdSchema.optional(),
    targetId: ContestantIdSchema.optional(),
    claim: z.string().optional(),
  }),
  event("attack_revised", {
    attackId: z.string(),
    round: RoundIdSchema,
    attackerId: ContestantIdSchema.optional(),
    targetId: ContestantIdSchema.optional(),
    explanation: z.string(),
  }),
  event("attack_resolved", {
    attackId: z.string(),
    round: RoundIdSchema.optional(),
    status: z.string(),
    attackerId: ContestantIdSchema.optional(),
    targetId: ContestantIdSchema.optional(),
    severity: z.string().optional(),
    damage: z.number().int().optional(),
  }),
  event("health_changed", {
    contestantId: ContestantIdSchema,
    round: RoundIdSchema.optional(),
    attackId: z.string().optional(),
    health: z.number().int().min(0).max(100),
    amount: z.number().int(),
    reason: z.string(),
  }),
  event("warning", { message: z.string() }),
  event("cancellation_requested", { reason: z.string().optional() }),
  event("cancellation_completed", {}),
  event("steering_queued", {
    interventionId: z.string(),
    contestantId: ContestantIdSchema,
  }),
  event("steering_applied", {
    interventionId: z.string(),
    contestantId: ContestantIdSchema,
    stage: StageSchema,
    round: RoundIdSchema.optional(),
    promptHash: z.string(),
  }),
  event("steering_expired", {
    interventionId: z.string(),
    contestantId: ContestantIdSchema,
  }),
  event("battle_completed", {
    status: z.enum(["complete", "inconclusive", "failed", "cancelled"]),
    roundsCompleted: z.number().int().min(0).max(3).optional(),
    /** Absent when coverage is unresolved and no champion may be published. */
    championId: ContestantIdSchema.optional(),
    recommendedId: ContestantIdSchema.optional(),
    recommendationReason: z.string().optional(),
    coverageConfidence: z
      .enum(["full_confidence", "reduced_confidence", "provisional"])
      .optional(),
    contestants: z
      .array(
        z.object({
          id: ContestantIdSchema,
          health: z.number().int().min(0).max(100),
          status: z.string(),
          checksPassed: z.number().int().nonnegative(),
          checksTotal: z.number().int().nonnegative(),
        }),
      )
      .optional(),
  }),
]);
export type ArenaEvent = z.infer<typeof ArenaEventSchema>;
export type ArenaEventInput = ArenaEvent extends infer E
  ? E extends ArenaEvent
    ? Omit<E, "version" | "sequence" | "timestamp">
    : never
  : never;

export interface ArenaObserver {
  publish(event: ArenaEventInput): void | Promise<void>;
}

export class CompositeArenaObserver implements ArenaObserver {
  constructor(private readonly observers: readonly ArenaObserver[]) {}

  async publish(event: ArenaEventInput): Promise<void> {
    await Promise.all(
      this.observers.map(async (observer) => {
        await observer.publish(event);
      }),
    );
  }
}

export class EventJournal implements ArenaObserver {
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  publish(input: ArenaEventInput): Promise<void> {
    const event = ArenaEventSchema.parse({
      ...input,
      version: 1,
      sequence: ++this.sequence,
      timestamp: this.now().toISOString(),
    });
    this.queue = this.queue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    });
    return this.queue;
  }

  flush(): Promise<void> {
    return this.queue;
  }
}

export interface InvocationObservation {
  invocationId: string;
  source: OutputSource;
  contestantId?: ContestantId;
  stage: string;
  round?: RoundId;
}

export function stageEvent(stage: Stage, round?: RoundId): ArenaEventInput {
  return {
    type: "stage_changed",
    stage,
    ...(round === undefined ? {} : { round }),
  };
}
