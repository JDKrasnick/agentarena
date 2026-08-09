import { z } from "zod";
import {
  ArtifactReferenceSchema,
  RoundResultSchema,
} from "../contracts/round.js";

const IdentifierSchema = z.string().trim().min(1);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IsoDateSchema = z.string().datetime({ offset: true });
const RoundIdSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal("recovery"),
  z.literal("reconciliation"),
]);
const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const AppliedEnvelopeSchema = z
  .object({
    roundId: RoundIdSchema,
    snapshotHash: Sha256Schema,
    replayHash: Sha256Schema,
    envelopeHash: Sha256Schema,
  })
  .strict();
export type AppliedEnvelope = z.infer<typeof AppliedEnvelopeSchema>;

export const RoundEnvelopeSchema = z
  .object({
    version: z.literal(1),
    runId: IdentifierSchema,
    roundId: RoundIdSchema,
    sealedAt: IsoDateSchema,
    priorEnvelopeHash: Sha256Schema.nullable(),
    snapshotHash: Sha256Schema,
    replayHash: Sha256Schema,
    stateDelta: ArtifactReferenceSchema.extend({
      kind: z.literal("round_state_delta"),
    }),
    artifacts: z.array(ArtifactReferenceSchema),
    result: RoundResultSchema,
    envelopeHash: Sha256Schema,
  })
  .strict()
  .superRefine((envelope, context) => {
    if (
      envelope.result.runId !== envelope.runId ||
      envelope.result.roundId !== envelope.roundId ||
      envelope.result.replay.snapshotHash !== envelope.snapshotHash ||
      envelope.result.replay.replayHash !== envelope.replayHash
    ) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "Envelope and round result identities must match",
      });
    }
  })
  .readonly();
export type RoundEnvelope = z.infer<typeof RoundEnvelopeSchema>;

export const RunBaselineSchema = z
  .object({
    version: z.literal(1),
    runId: IdentifierSchema,
    createdAt: IsoDateSchema,
    repositoryIdentity: z.string().min(1),
    baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    runSpecHash: Sha256Schema,
    state: JsonValueSchema,
    baselineHash: Sha256Schema,
  })
  .strict()
  .readonly();
export type RunBaseline = z.infer<typeof RunBaselineSchema>;

export const FinalizationRecordSchema = z
  .object({
    version: z.literal(1),
    runId: IdentifierSchema,
    createdAt: IsoDateSchema,
    appliedEnvelopeHash: Sha256Schema,
    projection: JsonValueSchema,
    finalizationHash: Sha256Schema,
  })
  .strict()
  .readonly();
export type FinalizationRecord = z.infer<typeof FinalizationRecordSchema>;

const RuntimeFingerprintSchema = z
  .object({
    node: z.string().min(1),
    os: z.string().min(1),
    architecture: z.string().min(1),
    packageManager: z.string().min(1),
  })
  .strict();

export const DependencyManifestSchema = z
  .object({
    version: z.literal(1),
    runId: IdentifierSchema,
    capturedAt: IsoDateSchema,
    repository: z
      .object({
        identity: z.string().min(1),
        path: z.string().min(1),
        baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
      })
      .strict(),
    frozenSources: z.record(z.string(), Sha256Schema),
    dependencyFiles: z.record(z.string(), Sha256Schema),
    runtime: RuntimeFingerprintSchema,
    providers: z.array(
      z
        .object({
          contestantId: z.enum(["a", "b"]),
          provider: z.string().min(1),
          model: z.string().min(1).optional(),
          cliVersion: z.string().min(1).optional(),
        })
        .strict(),
    ),
    commandsHash: Sha256Schema,
    capabilitiesHash: Sha256Schema,
    credentialsHash: Sha256Schema,
    servicesHash: Sha256Schema,
    displayHash: Sha256Schema,
    manifestHash: Sha256Schema,
  })
  .strict()
  .readonly();
export type DependencyManifest = z.infer<typeof DependencyManifestSchema>;

export const DriftEntrySchema = z
  .object({
    code: z.enum([
      "repository_mismatch",
      "base_commit_missing",
      "source_corrupt",
      "envelope_corrupt",
      "chain_broken",
      "schema_incompatible",
      "dependency_changed",
      "toolchain_changed",
      "provider_changed",
      "service_changed",
      "capability_changed",
      "credential_changed",
      "os_changed",
      "path_relocated",
      "display_changed",
    ]),
    severity: z.enum(["hard_stop", "approval_required", "informational"]),
    subject: z.string().min(1),
    before: z.string().optional(),
    after: z.string().optional(),
  })
  .strict();
export type DriftEntry = z.infer<typeof DriftEntrySchema>;

export const DriftReportSchema = z
  .object({
    version: z.literal(1),
    runId: IdentifierSchema,
    createdAt: IsoDateSchema,
    entries: z.array(DriftEntrySchema),
    reportHash: Sha256Schema,
  })
  .strict()
  .readonly();
export type DriftReport = z.infer<typeof DriftReportSchema>;

export const DriftApprovalSchema = z
  .object({
    version: z.literal(1),
    runId: IdentifierSchema,
    reportHash: Sha256Schema,
    approvedAt: IsoDateSchema,
    approvedBy: z.string().min(1),
    approvalHash: Sha256Schema,
  })
  .strict()
  .readonly();
export type DriftApproval = z.infer<typeof DriftApprovalSchema>;

const SummaryContestantSchema = z
  .object({
    id: z.enum(["a", "b"]),
    provider: z.string().min(1),
    role: z.string().min(1),
    status: z.string().min(1),
    health: z.number().int().min(0).max(100),
    patchPath: z.string().min(1).optional(),
    patchSha256: Sha256Schema.optional(),
  })
  .strict();

/** Compact, replaceable public summary. Baseline and envelopes are authority. */
export const RunSummaryV5Schema = z
  .object({
    schemaVersion: z.literal(5),
    runId: IdentifierSchema,
    harnessVersion: z.string().min(1),
    status: z.enum([
      "running",
      "complete",
      "inconclusive",
      "failed",
      "cancelled",
    ]),
    stage: z.string().min(1),
    currentRound: RoundIdSchema.optional(),
    startedAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
    completedAt: IsoDateSchema.optional(),
    runSpecHash: Sha256Schema,
    baseline: z
      .object({ path: z.string().min(1), sha256: Sha256Schema })
      .strict()
      .optional(),
    finalization: z
      .object({ path: z.string().min(1), sha256: Sha256Schema })
      .strict()
      .optional(),
    contestants: z.tuple([SummaryContestantSchema, SummaryContestantSchema]),
    outcome: JsonValueSchema.optional(),
    recommendation: JsonValueSchema.optional(),
    warnings: z.array(z.string()),
    artifacts: z.record(z.string(), z.string()),
    appliedEnvelopes: z.array(AppliedEnvelopeSchema),
    provenance: z
      .object({
        assisted: z.boolean(),
        competitivelyComparable: z.boolean(),
        driftApprovalHashes: z.array(Sha256Schema),
        parentRunId: IdentifierSchema.optional(),
        parentCheckpointHash: Sha256Schema.optional(),
      })
      .strict(),
  })
  .strict()
  .readonly();
export type RunSummaryV5 = z.infer<typeof RunSummaryV5Schema>;

export const CheckpointDescriptorSchema = z
  .object({
    version: z.literal(1),
    runId: IdentifierSchema,
    roundId: RoundIdSchema,
    envelopeHash: Sha256Schema,
    snapshotHash: Sha256Schema,
    replayHash: Sha256Schema,
    stateHash: Sha256Schema,
    createdAt: IsoDateSchema,
    checkpointHash: Sha256Schema,
  })
  .strict()
  .readonly();
export type CheckpointDescriptor = z.infer<typeof CheckpointDescriptorSchema>;

export const ForkSpecSchema = z
  .object({
    version: z.literal(1),
    runId: IdentifierSchema,
    parentRunId: IdentifierSchema,
    parentCheckpointHash: Sha256Schema,
    createdAt: IsoDateSchema,
    intervention: z
      .object({
        taskChanged: z.boolean(),
        steering: z
          .object({
            a: z.array(z.string()),
            b: z.array(z.string()),
          })
          .strict(),
        configuration: JsonValueSchema,
      })
      .strict(),
    assisted: z.boolean(),
    competitivelyComparable: z.boolean(),
    forkHash: Sha256Schema,
  })
  .strict()
  .readonly();
export type ForkSpec = z.infer<typeof ForkSpecSchema>;
