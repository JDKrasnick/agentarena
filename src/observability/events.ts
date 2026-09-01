import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  ContestantIdSchema,
  RequiredValidationEvidenceSchema,
  RoundIdSchema,
  StageSchema,
  TerminalContestantDispositionSchema,
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
  event("effort_assessed", {
    tier: z.enum(["ultra-low", "low", "medium", "high", "ultra-high"]),
    score: z.number().int().min(0).max(8),
    plannedRounds: z.number().int().min(1).max(3),
    maxRounds: z.number().int().min(1).max(5),
    fallback: z.boolean(),
  }),
  event("effort_resolved", {
    tier: z.enum(["ultra-low", "low", "medium", "high", "ultra-high"]),
    plannedRounds: z.number().int().min(1).max(5),
    maxRounds: z.number().int().min(1).max(5),
  }),
  event("budget_pressure", {
    round: RoundIdSchema,
    wallTime: z.boolean(),
    invocations: z.boolean(),
    tokens: z.boolean(),
  }),
  event("convergence_evaluated", {
    round: RoundIdSchema,
    passed: z.boolean(),
  }),
  event("extension_qualified", {
    round: RoundIdSchema,
    defectIds: z.array(z.string()),
  }),
  event("extension_declined", {
    round: RoundIdSchema,
    defectIds: z.array(z.string()),
  }),
  event("adaptive_stop", {
    round: RoundIdSchema,
    reason: z.string().min(1),
    skippedBriefs: z.array(z.string()),
  }),
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
    summary: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    diagnosticArtifactRefs: z.array(z.string().min(1)).optional(),
  }),
  event("invocation_progress", {
    invocationId: z.string(),
    source: OutputSourceSchema,
    contestantId: ContestantIdSchema.optional(),
    kind: z.enum([
      "message",
      "tool_started",
      "tool_finished",
      "progress",
      "result",
    ]),
    label: z.string().min(1).max(160),
    toolName: z.string().min(1).max(80).optional(),
    sessionId: z.string().min(1).optional(),
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
  event("browser_session_started", {
    sessionId: z.string().uuid(),
    label: z.string().min(1),
    contestantId: ContestantIdSchema.optional(),
    url: z.string().url(),
    runner: z.enum(["playwright", "cypress", "custom"]),
    attempt: z.number().int().min(1).max(2),
  }),
  event("browser_session_finished", {
    sessionId: z.string().uuid(),
  }),
  event("attack_mounted", {
    attackId: z.string(),
    round: RoundIdSchema,
    attackerId: ContestantIdSchema.optional(),
    targetId: ContestantIdSchema.optional(),
    claim: z.string().optional(),
    evidenceClass: z.enum(["competitive", "shared"]).optional(),
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
    damage: z.number().multipleOf(0.25).optional(),
    evidenceClass: z.enum(["competitive", "shared"]).optional(),
  }),
  event("health_changed", {
    contestantId: ContestantIdSchema,
    round: RoundIdSchema.optional(),
    attackId: z.string().optional(),
    health: z.number().min(0).max(100).multipleOf(0.25),
    amount: z.number().multipleOf(0.25),
    reason: z.string(),
  }),
  event("failure_updated", {
    failureId: z.string().min(1),
    stage: z.string().min(1),
    subject: z.string().min(1),
    attempt: z.number().int().min(1).max(2),
    attemptStatus: z.enum(["failed", "succeeded"]),
    state: z.enum(["retrying", "recovered", "resolved"]),
    terminalDisposition: z.string().optional(),
    contestantId: ContestantIdSchema.optional(),
    laneId: z.string().min(1).optional(),
    attackId: z.string().min(1).optional(),
    diagnosticArtifactRefs: z.array(z.string()),
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
    roundsCompleted: z.number().int().min(0).max(5).optional(),
    /** Absent when coverage is unresolved and no champion may be published. */
    championId: ContestantIdSchema.optional(),
    outcomeKind: z.enum(["winner", "draw", "non_discriminating"]).optional(),
    decisionBasis: z
      .enum([
        "competitive_evidence",
        "independent_patch_quality",
        "fallback_tie_break",
        "no_differentiator",
      ])
      .optional(),
    competitiveLandingCount: z.number().int().nonnegative().optional(),
    sharedDefectCount: z.number().int().nonnegative().optional(),
    explicitEmptyLaneCount: z.number().int().nonnegative().optional(),
    recommendedId: ContestantIdSchema.optional(),
    recommendationReason: z.string().optional(),
    coverageConfidence: z
      .enum(["full_confidence", "reduced_confidence", "provisional"])
      .optional(),
    implementationEligibility: z
      .array(TerminalContestantDispositionSchema)
      .max(2)
      .optional(),
    terminalOutcome: z
      .object({
        kind: z.enum(["forfeit", "inconclusive", "cancelled"]),
        reasonCode: z.string().min(1),
        affectedContestantIds: z.array(ContestantIdSchema),
        eligibleContestantIds: z.array(ContestantIdSchema),
        reason: z.string().min(1),
        artifactPaths: z.array(z.string()),
        contestants: z
          .array(
            z.object({
              contestantId: ContestantIdSchema,
              eligible: z.boolean(),
              reasonCode: z.string().min(1).optional(),
              artifactPaths: z.array(z.string()),
              validation: RequiredValidationEvidenceSchema.optional(),
            }),
          )
          .optional(),
      })
      .optional(),
    contestants: z
      .array(
        z.object({
          id: ContestantIdSchema,
          health: z.number().min(0).max(100).multipleOf(0.25),
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

/** Accepts unsequenced run events. The run-level bus is the sole finalizer. */
export interface ArenaObserver {
  publish(event: ArenaEventInput): void | Promise<void>;
}

/** Receives an already timestamped and sequenced event. */
export interface ArenaEventSink {
  publish(event: ArenaEvent): void | Promise<void>;
}

export class CompositeArenaObserver implements ArenaEventSink {
  constructor(private readonly observers: readonly ArenaEventSink[]) {}

  async publish(event: ArenaEvent): Promise<void> {
    await Promise.all(
      this.observers.map(async (observer) => {
        await observer.publish(event);
      }),
    );
  }
}

export class EventJournal implements ArenaEventSink {
  private sequence = 0;
  private readonly ready: Promise<void>;
  private queue: Promise<void>;

  constructor(
    readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.ready = this.resumeSequence();
    this.queue = this.ready;
  }

  publish(value: ArenaEvent | ArenaEventInput): Promise<void> {
    this.queue = this.queue.then(async () => {
      const event = ArenaEventSchema.safeParse(value).success
        ? ArenaEventSchema.parse(value)
        : ArenaEventSchema.parse({
            ...value,
            version: 1,
            sequence: ++this.sequence,
            timestamp: this.now().toISOString(),
          });
      this.sequence = Math.max(this.sequence, event.sequence);
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    });
    return this.queue;
  }

  flush(): Promise<void> {
    return this.queue;
  }

  private async resumeSequence(): Promise<void> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      let last = 0;
      const validLines: string[] = [];
      let invalidTail = false;
      for (const line of contents.split("\n")) {
        if (!line.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          invalidTail = true;
          break;
        }
        const parsed = ArenaEventSchema.safeParse(value);
        if (!parsed.success || parsed.data.sequence !== last + 1) {
          invalidTail = true;
          break;
        }
        last = parsed.data.sequence;
        validLines.push(line);
      }
      this.sequence = last;
      if (invalidTail)
        await writeFile(
          this.filePath,
          validLines.length ? `${validLines.join("\n")}\n` : "",
          "utf8",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/**
 * Serializes publication, assigns event identity once, persists first, then
 * fans the identical immutable event to best-effort live sinks.
 */
export class ArenaEventBus implements ArenaObserver {
  private sequence = 0;
  private readonly ready: Promise<void>;
  private queue: Promise<void>;

  constructor(
    private readonly journal: EventJournal,
    private readonly sinks: readonly ArenaEventSink[] = [],
    private readonly now: () => Date = () => new Date(),
  ) {
    this.ready = journal.flush().then(async () => {
      try {
        const contents = await readFile(journal.filePath, "utf8");
        for (const line of contents.trim().split("\n")) {
          if (!line) continue;
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            break;
          }
          const event = ArenaEventSchema.safeParse(value);
          if (!event.success || event.data.sequence !== this.sequence + 1)
            break;
          this.sequence = event.data.sequence;
          await Promise.allSettled(
            this.sinks.map(async (sink) => {
              await sink.publish(event.data);
            }),
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    });
    this.queue = this.ready;
  }

  publish(input: ArenaEventInput): Promise<void> {
    this.queue = this.queue.then(async () => {
      const event = ArenaEventSchema.parse({
        ...input,
        version: 1,
        sequence: ++this.sequence,
        timestamp: this.now().toISOString(),
      });
      await this.journal.publish(event);
      await Promise.allSettled(
        this.sinks.map(async (sink) => {
          await sink.publish(event);
        }),
      );
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
