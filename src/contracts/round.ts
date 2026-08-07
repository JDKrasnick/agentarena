import { z } from "zod";

const IdentifierSchema = z.string().trim().min(1);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const GitCommitSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const IsoDateSchema = z.string().datetime({ offset: true });

const ContestantIdSchema = z.enum(["a", "b"]);
const RoundIdSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal("recovery"),
]);
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
    visibility: z.enum(["shared", "judge_only"]),
    primary: z.boolean().optional(),
  })
  .strict();

const ImmutableTaskSchema = z
  .object({
    task: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    sources: z.array(FrozenSourceSchema).min(1),
    createdAt: IsoDateSchema,
    contractHash: Sha256Schema,
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
    decision: z.enum(["approved", "denied", "unavailable"]),
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
    damage: z.number().int().positive(),
  })
  .strict();

const ReplacementCreditStateSchema = z
  .object({
    id: IdentifierSchema,
    sourceAttackId: IdentifierSchema,
    issuedRound: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    reason: z.enum([
      "accepted_infrastructure",
      "final_infrastructure",
      "inconclusive",
    ]),
    status: z.enum(["available", "spent", "void"]),
    replacementAttackId: IdentifierSchema.optional(),
  })
  .strict();

export const RoundContestantStateSchema = z
  .object({
    contestantId: ContestantIdSchema,
    patch: PatchStateSchema.nullable(),
    health: z.number().int().min(0).max(100),
    permanentRecoil: z.number().int().nonnegative(),
    activeDefects: z.array(ActiveDefectSchema),
    replacementCredits: z.array(ReplacementCreditStateSchema),
    status: z.enum(["active", "downed", "eliminated"]),
  })
  .strict();
export type RoundContestantState = z.infer<typeof RoundContestantStateSchema>;

const KnownDefectSchema = z
  .object({
    defectId: IdentifierSchema,
    attackId: IdentifierSchema,
    target: ContestantIdSchema,
    severity: SeveritySchema,
    damage: z.number().int().positive(),
    status: z.enum(["active", "healed"]),
    visibleReproducerArtifactIds: z.array(IdentifierSchema),
  })
  .strict();

/** A complete, serializable input for exactly one transactional round. */
export const RoundSnapshotSchema = z
  .object({
    version: z.literal(1),
    runId: IdentifierSchema,
    roundId: RoundIdSchema,
    snapshotHash: Sha256Schema,
    runSpec: RunSpecSchema,
    contestants: z.tuple([
      RoundContestantStateSchema,
      RoundContestantStateSchema,
    ]),
    knownDefects: z.array(KnownDefectSchema),
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
      const patchOwnershipMismatch = ownsProductionPatch
        ? contestant.patch === null
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
    });
    if (
      snapshot.roundId === "recovery" &&
      !snapshot.contestants.some(
        (contestant) =>
          contestant.status !== "eliminated" &&
          contestant.replacementCredits.some(
            (credit) => credit.status === "available",
          ),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["contestants"],
        message: "A recovery round requires at least one available credit",
      });
    }
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
      "review",
      "attack",
      "case_generation",
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
    type: z.enum(["damage", "recoil", "heal", "elimination"]),
    amount: z.number().int(),
    healthAfter: z.number().int().min(0).max(100),
    defectId: IdentifierSchema.optional(),
  })
  .strict();

/** Immutable audit envelope from which a round can be inspected and replayed. */
export const RoundReplaySchema = z
  .object({
    version: z.literal(1),
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
    artifacts: z.array(ArtifactReferenceSchema),
    replayHash: Sha256Schema,
  })
  .strict()
  .readonly();
export type RoundReplay = z.infer<typeof RoundReplaySchema>;

const RoundResultBaseSchema = z
  .object({
    version: z.literal(1),
    runId: IdentifierSchema,
    roundId: RoundIdSchema,
    resultingContestants: z.tuple([
      RoundContestantStateSchema,
      RoundContestantStateSchema,
    ]),
    replay: RoundReplaySchema,
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
  })
  .readonly();
export type RoundResult = z.infer<typeof RoundResultSchema>;

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
    damage: z.number().int().positive(),
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
    reason: z.string().min(1),
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
    version: z.literal(1),
    runId: IdentifierSchema,
    roundId: RoundIdSchema,
    contestantId: ContestantIdSchema,
    health: z
      .object({
        starting: z.number().int().min(0).max(100),
        afterAttacks: z.number().int().min(0).max(100),
        ending: z.number().int().min(0).max(100),
      })
      .strict(),
    acceptedIncomingAttacks: z.array(IncomingAttackFeedbackSchema),
    ownAttackOutcomes: z.array(OwnAttackOutcomeSchema),
    healedDefectIds: z.array(IdentifierSchema),
    unresolvedDefectIds: z.array(IdentifierSchema),
  })
  .strict()
  .superRefine((feedback, context) => {
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
