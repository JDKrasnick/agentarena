import { z } from "zod";

const IdentifierSchema = z.string().trim().min(1);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const FailureStageSchema = z.enum([
  "model_invocation",
  "parsing",
  "git",
  "filesystem",
  "service",
  "transport",
  "capability_provisioning",
  "command",
  "evidence_execution",
  "implementation",
  "repair_validation",
  "required_validation",
  "final_validation",
]);
export type FailureStage = z.infer<typeof FailureStageSchema>;

export const FailureCategorySchema = z.enum([
  "timeout",
  "transport",
  "invalid_output",
  "process_launch",
  "command_execution",
  "git_operation",
  "filesystem_operation",
  "service_unavailable",
  "capability_unavailable",
  "unknown",
]);
export type FailureCategory = z.infer<typeof FailureCategorySchema>;

export const FailureDispositionSchema = z.enum([
  "recovered",
  "judge_confirmed",
  "judge_partial",
  "judge_rejected",
  "judge_unable",
  "advisory_unavailable",
  "coverage_lost",
  "run_level_coverage_lost",
  "validation_unstable",
]);
export type FailureDisposition = z.infer<typeof FailureDispositionSchema>;

export const FailureAttemptSchema = z
  .object({
    attempt: z.union([z.literal(1), z.literal(2)]),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    status: z.enum(["failed", "succeeded"]),
    diagnosticArtifactRefs: z.array(z.string()),
    timeout: z
      .object({
        kind: z.enum(["fixed", "idle", "absolute"]),
        elapsedMs: z.number().int().nonnegative(),
        lastMeaningfulProgressAt: z.string().datetime().optional(),
        policy: z.object({
          mode: z.enum(["fixed", "progress_extended"]),
          softTimeoutMs: z.number().int().positive(),
          absoluteTimeoutMs: z.number().int().positive(),
          startedAt: z.string().datetime(),
          initialSoftDeadlineAt: z.string().datetime(),
          absoluteDeadlineAt: z.string().datetime(),
          lastProgressAt: z.string().datetime().optional(),
          progressExtensions: z.number().int().nonnegative(),
        }),
        termination: z.object({
          cause: z.enum([
            "exit",
            "signal",
            "timeout",
            "cancelled",
            "spawn_error",
          ]),
          timeoutType: z.literal("wall_clock").nullable(),
          startedAt: z.string().datetime(),
          finishedAt: z.string().datetime(),
          lastOutputAt: z.string().datetime().nullable(),
          escalation: z.array(
            z.object({
              pid: z.number().int().positive(),
              identity: z.string().min(1),
              signal: z.enum(["SIGTERM", "SIGKILL"]),
              outcome: z.enum([
                "sent",
                "already_exited",
                "identity_changed",
                "error",
              ]),
            }),
          ),
        }),
      })
      .optional(),
  })
  .strict();
export type FailureAttempt = z.infer<typeof FailureAttemptSchema>;

/** Durable identity and retry ledger for one distinct stage failure. */
export const FailureRecordSchema = z
  .object({
    version: z.literal(1),
    failureId: IdentifierSchema,
    stage: FailureStageSchema,
    laneId: IdentifierSchema.optional(),
    attackId: IdentifierSchema.optional(),
    contestantId: z.enum(["a", "b"]).optional(),
    subject: IdentifierSchema,
    category: FailureCategorySchema,
    causalDigest: Sha256Schema,
    attempts: z.array(FailureAttemptSchema).min(1).max(2),
    reusedArtifactRefs: z.array(z.string()),
    diagnosticArtifactRefs: z.array(z.string()),
    terminalDisposition: FailureDispositionSchema.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    record.attempts.forEach((attempt, index) => {
      if (attempt.attempt !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["attempts", index, "attempt"],
          message: "Failure attempts must be contiguous and ordered",
        });
      }
    });
    if (
      record.terminalDisposition === "recovered" &&
      record.attempts.at(-1)?.status !== "succeeded"
    ) {
      context.addIssue({
        code: "custom",
        path: ["terminalDisposition"],
        message: "Recovered failures require a successful final attempt",
      });
    }
  });
export type FailureRecord = z.infer<typeof FailureRecordSchema>;
