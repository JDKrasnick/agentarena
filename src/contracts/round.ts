import { createHash } from "node:crypto";
import { z } from "zod";
import { BrowserPlanSchema } from "./browser.js";
import { FailureRecordSchema } from "./failure.js";

const PointValueSchema = z.number().min(0).max(100).multipleOf(0.25);
const DamageValueSchema = z.number().positive().max(50).multipleOf(0.25);
const ContractVersionSchema = z.literal(4);
const FeedbackVersionSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
const EvidenceBasisSchema = z.enum([
  "mechanical",
  "judge",
  "partial_judge",
  "none",
  "legacy_unknown",
]);

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Canonical JSON requires finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  throw new Error(`Value is not JSON-safe: ${typeof value}`);
}

/** Stable JSON encoding used for all round-boundary digests. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function hashWithout(value: object, field: string): string {
  const copy = { ...(value as Record<string, unknown>) };
  delete copy[field];
  return createHash("sha256").update(canonicalJson(copy)).digest("hex");
}

/** SHA-256 of any strict JSON-safe value using the arena canonical encoding. */
export function calculateCanonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function calculateSnapshotHash(snapshot: object): string {
  return hashWithout(snapshot, "snapshotHash");
}

export function calculateReplayHash(replay: object): string {
  return hashWithout(replay, "replayHash");
}

const IdentifierSchema = z.string().trim().min(1);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const GitCommitSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const IsoDateSchema = z.string().datetime({ offset: true });
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

const ContestantIdSchema = z.enum(["a", "b"]);
const RoundIdSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const SeveritySchema = z.enum(["critical", "high", "medium", "low"]);

const FrozenSourceSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.enum([
      "user_task",
      "issue",
      "pull_request",
      "repo_spec",
      "public_contract",
    ]),
    origin: z.string().min(1),
    retrievedAt: IsoDateSchema,
    contentHash: Sha256Schema,
    snapshotPath: z.string().min(1),
    github: z
      .object({
        repository: z.string().min(1),
        number: z.number().int().positive(),
        url: z.string().url(),
        baseBranch: z.string().min(1).optional(),
        headBranch: z.string().min(1).optional(),
        headRepository: z.string().min(1).optional(),
        headCommit: GitCommitSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const ImmutableTaskSchema = z
  .object({
    task: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)),
    sources: z.array(FrozenSourceSchema).min(1),
    createdAt: IsoDateSchema,
  })
  .strict();

const TopologyContestantSchema = z
  .object({
    id: ContestantIdSchema,
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1).optional(),
    role: z.enum(["solver", "attacker", "defender", "incumbent", "challenger"]),
    startingPatch: z.enum(["none", "pull_request"]),
  })
  .strict();

const BattleTopologySchema = z
  .object({
    mode: z.enum(["duel", "catch_up", "siege"]),
    contestants: z.tuple([TopologyContestantSchema, TopologyContestantSchema]),
  })
  .strict()
  .superRefine(({ mode, contestants }, context) => {
    const [first, second] = contestants;
    if (first.id !== "a" || second.id !== "b") {
      context.addIssue({
        code: "custom",
        path: ["contestants"],
        message: "Battle topology contestants must be ordered a then b",
      });
    }
    const validRoles =
      (mode === "duel" &&
        first.role === "solver" &&
        first.startingPatch === "none" &&
        second.role === "solver" &&
        second.startingPatch === "none") ||
      (mode === "catch_up" &&
        first.role === "incumbent" &&
        first.startingPatch === "pull_request" &&
        second.role === "challenger" &&
        second.startingPatch === "none") ||
      (mode === "siege" &&
        first.role === "attacker" &&
        first.startingPatch === "none" &&
        second.role === "defender" &&
        second.startingPatch === "pull_request");
    if (!validRoles) {
      context.addIssue({
        code: "custom",
        path: ["contestants"],
        message: `Contestant roles and starting patches must match ${mode} topology`,
      });
    }
  });

const RunCommandSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.enum([
      "install",
      "required",
      "integration_setup",
      "integration_check",
      "integration_teardown",
      "browser_startup",
      "browser_test",
      "browser_teardown",
    ]),
    command: z.string().min(1),
    timeoutMs: z.number().int().positive(),
    required: z.boolean(),
  })
  .strict();

const RunBudgetsSchema = z
  .object({
    implementationMs: z.number().int().positive(),
    reviewMs: z.number().int().positive(),
    attackMs: z.number().int().positive(),
    verifierMs: z.number().int().positive(),
    repairMs: z.number().int().positive(),
    maxSpendUsd: z.number().finite().nonnegative().optional(),
  })
  .strict();

const CapabilitySchema = z
  .object({
    id: IdentifierSchema,
    reason: z.string().min(1),
    risk: z.enum(["low", "medium", "high", "critical"]),
    requirement: z.enum(["required", "optional"]),
    role: z.enum(["agent", "harness_only", "both"]),
    enforcement: z.enum(["enforced", "brokered", "advisory"]),
    decision: z.enum([
      "approved",
      "denied",
      "unavailable",
      "provisioning_failed",
    ]),
    scopes: z.array(z.string().min(1)),
  })
  .strict();

const RunPermissionsSchema = z
  .object({
    mode: z.enum(["auto", "confirm", "deny"]),
    reducedValidationAccepted: z.boolean(),
    capabilities: z.array(CapabilitySchema),
  })
  .strict();

const BrowserValidationSchema = BrowserPlanSchema.extend({
  decision: z.enum([
    "approved",
    "denied",
    "unavailable",
    "provisioning_failed",
  ]),
  approvedScopes: z.array(z.string()),
}).strict();

/** Immutable, JSON-safe input shared by all rounds in a battle. */
export const RunSpecSchema = z
  .object({
    version: z.literal(1),
    runId: IdentifierSchema,
    task: ImmutableTaskSchema,
    baseCommit: GitCommitSchema,
    topology: BattleTopologySchema,
    commands: z.array(RunCommandSchema).min(1),
    budgets: RunBudgetsSchema,
    permissions: RunPermissionsSchema,
    browserValidation: BrowserValidationSchema.optional(),
    contentHash: Sha256Schema,
  })
  .strict()
  .readonly();
export type RunSpec = z.infer<typeof RunSpecSchema>;

const PatchStateSchema = z
  .object({
    path: z.string().min(1),
    sha256: Sha256Schema,
  })
  .strict();

const ActiveDefectSchema = z
  .object({
    defectId: IdentifierSchema,
    attackId: IdentifierSchema,
    severity: SeveritySchema,
    damage: DamageValueSchema,
    multiplier: z.union([z.literal(0.35), z.literal(1)]).optional(),
  })
  .strict();

const CanonicalDefectSchema = z
  .object({
    defectId: IdentifierSchema,
    firstAttackId: IdentifierSchema,
    firstAdjudicationId: IdentifierSchema.optional(),
    baseSeverity: SeveritySchema,
    currentMultiplier: z.union([z.literal(0.35), z.literal(1)]),
    currentDamage: DamageValueSchema,
    evidenceHistory: z.array(
      z
        .object({
          attackId: IdentifierSchema,
          basis: EvidenceBasisSchema,
          multiplier: z.union([z.literal(0.35), z.literal(1)]),
          rationale: z.string(),
        })
        .strict(),
    ),
    status: z.enum(["active", "healed"]),
    repairAllowance: z.number().int().positive().optional(),
    repairAttemptsUsed: z.number().int().nonnegative().optional(),
    repairAttemptIds: z.array(IdentifierSchema).optional(),
    regressionResets: z.number().int().nonnegative().optional(),
  })
  .strict();

export const RoundContestantStateSchema = z
  .object({
    contestantId: ContestantIdSchema,
    patch: PatchStateSchema.nullable(),
    health: PointValueSchema,
    permanentRecoil: PointValueSchema,
    activeDefects: z.array(ActiveDefectSchema),
    canonicalDefects: z.array(CanonicalDefectSchema).optional(),
    status: z.enum(["pending", "active", "downed", "eliminated"]),
  })
  .strict();
export type RoundContestantState = z.infer<typeof RoundContestantStateSchema>;

const KnownDefectSchema = z
  .object({
    defectId: IdentifierSchema,
    attackId: IdentifierSchema,
    target: ContestantIdSchema,
    severity: SeveritySchema,
    damage: DamageValueSchema,
    multiplier: z.union([z.literal(0.35), z.literal(1)]).optional(),
    evidenceBasis: EvidenceBasisSchema.optional(),
    status: z.enum(["active", "healed"]),
    visibleReproducerArtifactIds: z.array(IdentifierSchema),
  })
  .strict();

/** A complete, serializable input for exactly one transactional round. */
export const RoundSnapshotSchema = z
  .object({
    version: ContractVersionSchema,
    runId: IdentifierSchema,
    roundId: RoundIdSchema,
    snapshotHash: Sha256Schema,
    runSpec: RunSpecSchema,
    contestants: z.tuple([
      RoundContestantStateSchema,
      RoundContestantStateSchema,
    ]),
    knownDefects: z.array(KnownDefectSchema),
    failureRecords: z.array(FailureRecordSchema),
    priorReplayHash: Sha256Schema.nullable(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.runId !== snapshot.runSpec.runId) {
      context.addIssue({
        code: "custom",
        path: ["runId"],
        message: "Snapshot runId must match runSpec.runId",
      });
    }
    snapshot.contestants.forEach((contestant, index) => {
      const topologyContestant = snapshot.runSpec.topology.contestants[index]!;
      if (contestant.contestantId !== topologyContestant.id) {
        context.addIssue({
          code: "custom",
          path: ["contestants", index, "contestantId"],
          message: "Round snapshot contestants must match topology order",
        });
      }
      const ownsProductionPatch = topologyContestant.role !== "attacker";
      const mayBePendingInitialization =
        snapshot.roundId === 1 && contestant.status === "pending";
      const patchOwnershipMismatch = ownsProductionPatch
        ? contestant.patch === null && !mayBePendingInitialization
        : contestant.patch !== null;
      if (patchOwnershipMismatch) {
        context.addIssue({
          code: "custom",
          path: ["contestants", index, "patch"],
          message: ownsProductionPatch
            ? "A production-owning contestant requires a patch"
            : "A test-only attacker must not have a production patch",
        });
      }
      if (snapshot.roundId !== 1 && contestant.status === "pending") {
        context.addIssue({
          code: "custom",
          path: ["contestants", index, "status"],
          message: "Only round 1 may contain pending contestants",
        });
      }
    });
  })
  .readonly();
export type RoundSnapshot = z.infer<typeof RoundSnapshotSchema>;

export const ArtifactReferenceSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.enum([
      "prompt",
      "transcript",
      "patch",
      "attack",
      "check_log",
      "case",
      "diagnostic",
      "submission",
      "failure_record",
      "round_state_delta",
    ]),
    path: z.string().min(1),
    sha256: Sha256Schema,
  })
  .strict();
export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;

export const RoundDiagnosticSchema = z
  .object({
    code: IdentifierSchema,
    severity: z.enum(["info", "warning", "error"]),
    message: z.string().min(1),
    contestantId: ContestantIdSchema.optional(),
    artifactIds: z.array(IdentifierSchema),
  })
  .strict();
export type RoundDiagnostic = z.infer<typeof RoundDiagnosticSchema>;

const ReplayInvocationSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.enum([
      "implementation",
      "review",
      "attack",
      "case_generation",
      "house",
      "verification",
      "repair",
      "validation",
    ]),
    actor: z.enum(["contestant_a", "contestant_b", "harness", "verifier"]),
    status: z.enum([
      "succeeded",
      "failed",
      "timed_out",
      "cancelled",
      "infrastructure_error",
    ]),
    startedAt: IsoDateSchema,
    finishedAt: IsoDateSchema,
    artifactIds: z.array(IdentifierSchema),
  })
  .strict();

const ReplayAttackSchema = z
  .object({
    attackId: IdentifierSchema,
    origin: z.enum(["contestant_a", "contestant_b", "house"]),
    target: ContestantIdSchema,
    status: z.enum([
      "landed",
      "missed",
      "capability_denied",
      "infrastructure_error",
      "execution_inconclusive",
    ]),
    defectId: IdentifierSchema.optional(),
    adjudication: JsonValueSchema.optional(),
    artifactIds: z.array(IdentifierSchema),
  })
  .strict();

const ReplayCheckSchema = z
  .object({
    checkId: IdentifierSchema,
    contestantId: ContestantIdSchema.optional(),
    status: z.enum(["passed", "failed", "infrastructure_error", "skipped"]),
    artifactIds: z.array(IdentifierSchema),
  })
  .strict();

const ReplayRepairSchema = z
  .object({
    contestantId: ContestantIdSchema,
    status: z.enum([
      "repaired",
      "unresolved",
      "not_attempted",
      "infrastructure_error",
    ]),
    healedDefectIds: z.array(IdentifierSchema),
    unresolvedDefectIds: z.array(IdentifierSchema),
    invocationId: IdentifierSchema.optional(),
    artifactIds: z.array(IdentifierSchema),
  })
  .strict();

const ReplayScoreEventSchema = z
  .object({
    contestantId: ContestantIdSchema,
    type: z.enum(["damage", "damage_upgrade", "recoil", "heal", "elimination"]),
    amount: z.number().multipleOf(0.25),
    healthAfter: PointValueSchema,
    defectId: IdentifierSchema.optional(),
    adjudicationId: IdentifierSchema.optional(),
    upgradesAdjudicationId: IdentifierSchema.optional(),
  })
  .strict();

/** Immutable audit envelope from which a round can be inspected and replayed. */
export const RoundReplaySchema = z
  .object({
    version: ContractVersionSchema,
    runId: IdentifierSchema,
    roundId: RoundIdSchema,
    snapshotHash: Sha256Schema,
    priorReplayHash: Sha256Schema.nullable(),
    invocations: z.array(ReplayInvocationSchema),
    attacks: z.array(ReplayAttackSchema),
    checks: z.array(ReplayCheckSchema),
    repairs: z.array(ReplayRepairSchema),
    scoreEvents: z.array(ReplayScoreEventSchema),
    diagnostics: z.array(RoundDiagnosticSchema),
    failureRecords: z.array(FailureRecordSchema),
    artifacts: z.array(ArtifactReferenceSchema),
    stateDeltaArtifactId: IdentifierSchema,
    replayHash: Sha256Schema,
  })
  .strict()
  .superRefine((replay, context) => {
    const delta = replay.artifacts.find(
      (artifact) => artifact.id === replay.stateDeltaArtifactId,
    );
    if (delta?.kind !== "round_state_delta") {
      context.addIssue({
        code: "custom",
        path: ["stateDeltaArtifactId"],
        message: "Replay must reference its round-state-delta artifact",
      });
    }
  })
  .readonly();
export type RoundReplay = z.infer<typeof RoundReplaySchema>;

const RoundResultBaseSchema = z
  .object({
    version: ContractVersionSchema,
    runId: IdentifierSchema,
    roundId: RoundIdSchema,
    resultingContestants: z.tuple([
      RoundContestantStateSchema,
      RoundContestantStateSchema,
    ]),
    failureRecords: z.array(FailureRecordSchema),
    replay: RoundReplaySchema,
    terminalOutcome: z
      .discriminatedUnion("version", [
        z
          .object({
            version: z.literal(1),
            phase: z.literal("pre_review"),
            kind: z.enum(["forfeit", "inconclusive", "cancelled"]),
            reasonCode: z.enum([
              "implementation_timeout",
              "implementation_failed",
              "implementation_empty_patch",
              "implementation_unapplicable_patch",
              "initial_validation_failed",
              "frozen_incumbent_invalid",
              "provider_transport_failure",
              "harness_infrastructure_failure",
              "external_cancellation",
            ]),
            affectedContestantIds: z.array(ContestantIdSchema),
            eligibleContestantIds: z.array(ContestantIdSchema),
            artifactPaths: z.array(z.string().min(1)),
            reason: z.string().min(1),
          })
          .strict(),
        z
          .object({
            version: z.literal(2),
            phase: z.literal("pre_review"),
            kind: z.enum(["forfeit", "inconclusive", "cancelled"]),
            status: z.enum(["completed", "inconclusive", "cancelled"]),
            reasonCode: z.enum([
              "implementation_timeout",
              "implementation_failed",
              "implementation_empty_patch",
              "implementation_unapplicable_patch",
              "initial_validation_failed",
              "frozen_incumbent_invalid",
              "provider_transport_failure",
              "harness_infrastructure_failure",
              "external_cancellation",
            ]),
            affectedContestantIds: z.array(ContestantIdSchema),
            eligibleContestantIds: z.array(ContestantIdSchema),
            artifactPaths: z.array(z.string().min(1)),
            contestants: z.array(
              z.object({
                contestantId: ContestantIdSchema,
                eligible: z.boolean(),
                reasonCode: z
                  .enum([
                    "implementation_timeout",
                    "implementation_failed",
                    "implementation_empty_patch",
                    "implementation_unapplicable_patch",
                    "initial_validation_failed",
                    "frozen_incumbent_invalid",
                    "provider_transport_failure",
                    "harness_infrastructure_failure",
                    "external_cancellation",
                    "peer_cancelled_due_to_transport",
                    "test_only_role",
                  ])
                  .optional(),
                artifactPaths: z.array(z.string().min(1)),
              }),
            ),
            reason: z.string().min(1),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();

const CompletedRoundResultSchema = RoundResultBaseSchema.extend({
  status: z.literal("completed"),
}).strict();

function exceptionalResult(status: "inconclusive" | "cancelled" | "failed") {
  return RoundResultBaseSchema.extend({
    status: z.literal(status),
    diagnostics: z.array(RoundDiagnosticSchema).min(1),
  }).strict();
}

/** Typed terminal result. Expected execution failures are values, not throws. */
export const RoundResultSchema = z
  .discriminatedUnion("status", [
    CompletedRoundResultSchema,
    exceptionalResult("inconclusive"),
    exceptionalResult("cancelled"),
    exceptionalResult("failed"),
  ])
  .superRefine((result, context) => {
    if (
      result.runId !== result.replay.runId ||
      result.roundId !== result.replay.roundId
    ) {
      context.addIssue({
        code: "custom",
        path: ["replay"],
        message: "Result and replay identities must match",
      });
    }
    if (
      result.resultingContestants[0].contestantId !== "a" ||
      result.resultingContestants[1].contestantId !== "b"
    ) {
      context.addIssue({
        code: "custom",
        path: ["resultingContestants"],
        message: "Round result contestants must be ordered a then b",
      });
    }
    if (
      result.status === "completed" &&
      result.resultingContestants.some(
        (contestant) => contestant.status === "pending",
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["resultingContestants"],
        message: "A completed round cannot leave a contestant pending",
      });
    }
  })
  .readonly();
export type RoundResult = z.infer<typeof RoundResultSchema>;

/** Parse and verify an immutable snapshot at the engine boundary. */
export function validateRoundSnapshot(value: unknown): RoundSnapshot {
  const snapshot = RoundSnapshotSchema.parse(value);
  if (snapshot.snapshotHash !== calculateSnapshotHash(snapshot))
    throw new Error("Snapshot hash does not match canonical snapshot JSON");
  return snapshot;
}

/** Parse and verify a result and its replay against the accepted snapshot. */
export function validateRoundResult(
  value: unknown,
  snapshot: RoundSnapshot,
): RoundResult {
  const result = RoundResultSchema.parse(value);
  if (
    result.runId !== snapshot.runId ||
    result.roundId !== snapshot.roundId ||
    result.replay.snapshotHash !== snapshot.snapshotHash ||
    result.replay.priorReplayHash !== snapshot.priorReplayHash
  )
    throw new Error("Round result does not match its accepted snapshot");
  if (result.replay.replayHash !== calculateReplayHash(result.replay))
    throw new Error("Replay hash does not match canonical replay JSON");
  return result;
}

/**
 * Immutable projection used to apply a completed transactional round to the
 * legacy RunState report without sharing that mutable object with the engine.
 */
export const RoundStateDeltaSchema = z
  .object({
    version: ContractVersionSchema,
    runId: IdentifierSchema,
    roundId: RoundIdSchema,
    attacks: z.array(JsonValueSchema),
    invocations: z.array(JsonValueSchema),
    cases: z.array(JsonValueSchema),
    promptManifests: z.array(JsonValueSchema),
    failureRecords: z.array(FailureRecordSchema),
    checks: z.array(JsonValueSchema),
    roundSummaries: z.array(JsonValueSchema),
    healthEvents: z.array(JsonValueSchema),
    patchMetadata: z.array(JsonValueSchema),
    submissionArtifacts: z.array(JsonValueSchema).optional(),
    repairJudgments: z.array(JsonValueSchema).optional(),
    coordinator: z
      .object({
        stage: IdentifierSchema,
        currentRound: RoundIdSchema.optional(),
        warnings: z.array(z.string()),
        updatedAt: IsoDateSchema,
      })
      .strict(),
  })
  .strict()
  .readonly();
export type RoundStateDelta = z.infer<typeof RoundStateDeltaSchema>;

const VisibleReproducerSchema = z
  .object({
    artifactId: IdentifierSchema,
    command: z.string().min(1),
    expectedBehavior: z.string().min(1),
  })
  .strict();

const IncomingAttackFeedbackSchema = z
  .object({
    attackId: IdentifierSchema,
    defectId: IdentifierSchema,
    severity: SeveritySchema,
    damage: DamageValueSchema,
    evidenceBasis: EvidenceBasisSchema.optional(),
    multiplier: z.union([z.literal(0.35), z.literal(1)]).optional(),
    rationale: z.string().min(1).optional(),
    claim: z.string().min(1),
    visibleReproducers: z.array(VisibleReproducerSchema).min(1),
  })
  .strict();

const OwnAttackOutcomeSchema = z
  .object({
    attackId: IdentifierSchema,
    target: ContestantIdSchema,
    status: z.enum([
      "landed",
      "duplicate",
      "missed",
      "capability_denied",
      "infrastructure_error",
      "execution_inconclusive",
    ]),
    reason: z.enum([
      "landed",
      "oracle_not_supported",
      "duplicate_root_defect",
      "target_did_not_fail",
      "author_patch_failed",
      "capability_denied",
      "infrastructure_inconclusive",
      "invalid_evidence",
      "blocked",
    ]),
    recoil: z.number().int().nonnegative(),
    defectId: IdentifierSchema.optional(),
  })
  .strict()
  .superRefine((outcome, context) => {
    const hasCanonicalDefect =
      outcome.status === "landed" || outcome.status === "duplicate";
    if (hasCanonicalDefect && !outcome.defectId) {
      context.addIssue({
        code: "custom",
        path: ["defectId"],
        message:
          "A landed or duplicate own attack must expose its canonical defect ID",
      });
    }
    if (!hasCanonicalDefect && outcome.defectId) {
      context.addIssue({
        code: "custom",
        path: ["defectId"],
        message:
          "Only a landed or duplicate own attack may expose a canonical defect ID",
      });
    }
  });

/** Deliberately narrow, contestant-visible projection of round evidence. */
export const ContestantFeedbackSchema = z
  .object({
    version: FeedbackVersionSchema,
    runId: IdentifierSchema,
    roundId: RoundIdSchema,
    contestantId: ContestantIdSchema,
    phase: z.enum(["review", "attack", "repair"]),
    health: z
      .object({
        starting: PointValueSchema,
        afterAttacks: PointValueSchema,
        ending: PointValueSchema,
      })
      .strict(),
    acceptedIncomingAttacks: z.array(IncomingAttackFeedbackSchema),
    ownAttackOutcomes: z.array(OwnAttackOutcomeSchema),
    healedDefectIds: z.array(IdentifierSchema),
    unresolvedDefectIds: z.array(IdentifierSchema),
    capabilityRestrictions: z.array(
      z
        .object({
          capabilityId: IdentifierSchema,
          status: z.enum(["denied", "unavailable", "provisioning_failed"]),
        })
        .strict(),
    ),
    evidencePointers: z.array(
      z
        .object({
          artifactId: IdentifierSchema,
          path: z.string().min(1),
          sha256: Sha256Schema.optional(),
        })
        .strict(),
    ),
    projectionDigest: Sha256Schema.optional(),
  })
  .strict()
  .superRefine((feedback, context) => {
    if (feedback.version >= 2 && !feedback.projectionDigest) {
      context.addIssue({
        code: "custom",
        path: ["projectionDigest"],
        message: "Contestant feedback v2 requires a projection digest",
      });
    }
    feedback.ownAttackOutcomes.forEach((attack, index) => {
      if (attack.target === feedback.contestantId) {
        context.addIssue({
          code: "custom",
          path: ["ownAttackOutcomes", index, "target"],
          message: "A contestant's own attack must target another lane",
        });
      }
    });
  })
  .readonly();
export type ContestantFeedback = z.infer<typeof ContestantFeedbackSchema>;

export function calculateContestantFeedbackDigest(feedback: object): string {
  const payload = Object.fromEntries(
    Object.entries(feedback).filter(([key]) => key !== "projectionDigest"),
  );
  return calculateCanonicalHash(payload);
}

export function validateContestantFeedback(value: unknown): ContestantFeedback {
  const feedback = ContestantFeedbackSchema.parse(value);
  if (
    feedback.version >= 2 &&
    feedback.projectionDigest !== calculateContestantFeedbackDigest(feedback)
  ) {
    throw new Error("Contestant feedback projection digest mismatch");
  }
  return feedback;
}
