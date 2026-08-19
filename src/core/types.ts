import { z } from "zod";
import { BrowserProbeRequestSchema } from "../contracts/browser.js";
import { FailureRecordSchema } from "../contracts/failure.js";
import { BrowserValidationResultSchema } from "../contracts/browser.js";

export const AGENT_IDS = ["codex", "claude", "gemini"] as const;
export const AgentIdSchema = z.enum(AGENT_IDS);
export type AgentId = z.infer<typeof AgentIdSchema>;

export const CONTESTANT_IDS = ["a", "b"] as const;
export const ContestantIdSchema = z.enum(CONTESTANT_IDS);
export type ContestantId = z.infer<typeof ContestantIdSchema>;

export const ContestantRoleSchema = z.enum([
  "solver",
  "attacker",
  "defender",
  "incumbent",
  "challenger",
]);
export type ContestantRole = z.infer<typeof ContestantRoleSchema>;

export const StartingPatchSchema = z.enum(["none", "pull_request"]);
export type StartingPatch = z.infer<typeof StartingPatchSchema>;

export const BattleModeSchema = z.enum(["duel", "siege", "catch_up"]);
export type BattleMode = z.infer<typeof BattleModeSchema>;

export const ContestantConfigSchema = z.object({
  id: ContestantIdSchema,
  provider: AgentIdSchema,
  model: z.string().trim().min(1).optional(),
  role: ContestantRoleSchema,
  startingPatch: StartingPatchSchema.default("none"),
});
export type ContestantConfig = z.infer<typeof ContestantConfigSchema>;

export const SeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof SeveritySchema>;

/** Health and score values are persisted in exact quarter-point increments. */
export const HealthPointSchema = z.number().min(0).max(100).multipleOf(0.25);
export const DamageSchema = z.union([
  z.literal(50),
  z.literal(30),
  z.literal(25),
  z.literal(17.5),
  z.literal(15),
  z.literal(10.5),
  z.literal(7.5),
  z.literal(5),
  z.literal(5.25),
  z.literal(2.5),
  z.literal(1.75),
]);
export type Damage = z.infer<typeof DamageSchema>;

export const BugCategorySchema = z.enum([
  "contract_logic",
  "inputs_errors",
  "state_lifecycle",
  "data_integrity",
  "concurrency_time",
  "integration_configuration",
  "security_privacy",
  "resilience",
  "performance_resources",
  "test_build_integrity",
]);
export type BugCategory = z.infer<typeof BugCategorySchema>;

export const RoundIdSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal("recovery"),
  z.literal("reconciliation"),
]);
export type RoundId = z.infer<typeof RoundIdSchema>;

export const RoundProfileSchema = z.enum([
  "contract_local",
  "systematic_exploration",
  "integration_resilience_security",
  "infrastructure_recovery",
  "reconciliation",
]);
export type RoundProfile = z.infer<typeof RoundProfileSchema>;

export const FailureClassSchema = z.enum([
  "contestant_behavior",
  "agent_submission",
  "arena_infrastructure",
]);
export type FailureClass = z.infer<typeof FailureClassSchema>;

export const StageSchema = z.enum([
  "preflight",
  "resolve_permissions",
  "implement",
  "initial_validate",
  "review_attacks",
  "collect_attacks",
  "validate_attacks",
  "review_infrastructure",
  "revise_evidence",
  "assign_severity",
  "resolve_damage",
  "repair",
  "validate_repairs",
  "recovery_round",
  "reconciliation_round",
  "final_validate",
  "report",
  "complete",
  "inconclusive",
  "failed",
  "cancelled",
]);
export type Stage = z.infer<typeof StageSchema>;

export const CurrentStageSchema = z.enum([
  "preflight",
  "resolve_permissions",
  "implement",
  "initial_validate",
  "review_attacks",
  "collect_attacks",
  "validate_attacks",
  "assign_severity",
  "resolve_damage",
  "repair",
  "validate_repairs",
  "final_validate",
  "report",
  "complete",
  "inconclusive",
  "failed",
  "cancelled",
]);

export const CommandResultSchema = z.object({
  command: z.string(),
  cwd: z.string(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  failureClass: FailureClassSchema.optional(),
  attempts: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  stdoutPath: z.string(),
  stderrPath: z.string(),
  deadline: z
    .object({
      expiredAt: z.string().datetime(),
      graceMs: z.number().int().nonnegative(),
      cleanupDurationMs: z.number().int().nonnegative(),
      cleanupComplete: z.boolean(),
      signalEscalation: z.array(
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
      remainingDescendants: z.array(
        z.object({
          pid: z.number().int().positive(),
          identity: z.string().min(1),
        }),
      ),
    })
    .optional(),
  transportFailures: z
    .array(
      z.object({
        kind: z.enum(["mcp_auth", "reconnect", "transport"]),
        detail: z.string().min(1),
      }),
    )
    .optional(),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

export const CheckResultSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "baseline",
    "required",
    "focused",
    "held_out",
    "service_health",
    "browser",
    "apply",
  ]),
  status: z.enum(["passed", "failed", "infrastructure_error", "skipped"]),
  command: CommandResultSchema.optional(),
  reason: z.string().optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const TaskSourceSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "user_task",
    "issue",
    "pull_request",
    "repo_spec",
    "public_contract",
  ]),
  origin: z.string(),
  retrievedAt: z.string().datetime(),
  contentHash: z.string(),
  snapshotPath: z.string(),
  visibility: z.enum(["shared", "judge_only"]),
  primary: z.boolean().optional(),
  github: z
    .object({
      repository: z.string(),
      number: z.number().int().positive(),
      url: z.string().url(),
      baseBranch: z.string().optional(),
      headBranch: z.string().optional(),
      headRepository: z.string().optional(),
      headCommit: z.string().optional(),
    })
    .optional(),
});
export type TaskSource = z.infer<typeof TaskSourceSchema>;

export const TaskReferenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("github_issue"),
    reference: z.string(),
    primary: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("github_pull_request"),
    reference: z.string(),
    primary: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("repo_spec"),
    path: z.string(),
    primary: z.boolean().optional(),
  }),
]);
export type TaskReference = z.infer<typeof TaskReferenceSchema>;

export const TaskContractSchema = z.object({
  version: z.literal(1),
  task: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)),
  sources: z.array(TaskSourceSchema).min(1),
  createdAt: z.string().datetime(),
  contractHash: z.string(),
});
export type TaskContract = z.infer<typeof TaskContractSchema>;

export const AuthorshipEvidenceSchema = z.object({
  kind: z.enum([
    "bot_author",
    "coauthor_trailer",
    "branch_prefix",
    "title_prefix",
    "generator_marker",
    "statistical_fingerprint",
  ]),
  source: z.string().min(1),
  value: z.string().min(1),
});
export type AuthorshipEvidence = z.infer<typeof AuthorshipEvidenceSchema>;

export const AuthorshipAttributionSchema = z.object({
  provider: AgentIdSchema.optional(),
  confidence: z.enum(["confirmed", "likely", "unknown"]),
  evidence: z.array(AuthorshipEvidenceSchema),
});
export type AuthorshipAttribution = z.infer<typeof AuthorshipAttributionSchema>;

export const PullRequestFixtureSchema = z.object({
  version: z.literal(1),
  retrievedAt: z.string().datetime(),
  repository: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  body: z.string(),
  author: z.string().optional(),
  base: z.object({ branch: z.string().min(1), commit: z.string().min(1) }),
  head: z.object({
    branch: z.string().min(1),
    repository: z.string().min(1),
    commit: z.string().min(1),
  }),
  commits: z.array(
    z.object({
      oid: z.string().min(1),
      messageHeadline: z.string(),
      messageBody: z.string().optional(),
      authors: z.array(z.string()),
    }),
  ),
  linkedIssues: z.array(
    z.object({
      repository: z.string().optional(),
      number: z.number().int().positive(),
      url: z.string().url().optional(),
      title: z.string().optional(),
    }),
  ),
  patchPath: z.string().min(1),
  patchSha256: z.string().length(64),
  metadataSha256: z.string().length(64),
  attribution: AuthorshipAttributionSchema,
});
export type PullRequestFixture = z.infer<typeof PullRequestFixtureSchema>;

export const OracleCitationSchema = z.object({
  expectedBehavior: z.string().trim().min(1),
  sourceId: z.string().trim().min(1).optional(),
  sourceLocation: z.string().trim().min(1).optional(),
  rationale: z.string().trim().min(1),
});
export type OracleCitation = z.infer<typeof OracleCitationSchema>;

export const CapabilityDecisionSchema = z.object({
  id: z.string(),
  reason: z.string(),
  risk: z.enum(["low", "medium", "high", "critical"]),
  requirement: z.enum(["required", "optional"]),
  role: z.enum(["agent", "harness_only", "both"]),
  enforcement: z.enum(["enforced", "brokered", "advisory"]),
  mode: z.enum(["auto", "confirm", "deny"]),
  scopes: z.array(z.string()),
  status: z.enum(["approved", "denied", "unavailable", "provisioning_failed"]),
  expiresAt: z.string().datetime().optional(),
});
export type CapabilityDecision = z.infer<typeof CapabilityDecisionSchema>;

export const PermissionPolicySchema = z.object({
  defaultMode: z.enum(["auto", "confirm", "deny"]),
  capabilities: z.array(CapabilityDecisionSchema),
  reducedValidationAccepted: z.boolean(),
});
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

export const AgentInvocationSchema = z.object({
  agent: AgentIdSchema,
  model: z.string().optional(),
  contestantId: ContestantIdSchema.optional(),
  role: ContestantRoleSchema.optional(),
  stage: StageSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  status: z.enum([
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "infrastructure_error",
  ]),
  command: CommandResultSchema.optional(),
  promptPath: z.string(),
  transcriptPath: z.string(),
  submissionPath: z.string().optional(),
  explanation: z.string().optional(),
});
export type AgentInvocation = z.infer<typeof AgentInvocationSchema>;

export const AttackInvocationRecordSchema = z.object({
  round: RoundIdSchema,
  attacker: ContestantIdSchema,
  target: ContestantIdSchema,
  invocation: AgentInvocationSchema,
  submissionStatus: z.enum([
    "submitted",
    "partially_submitted",
    "invalid_submission",
    "not_submitted",
    "not_run",
  ]),
  attackCount: z.number().int().nonnegative(),
  parseOutcome: z
    .enum(["valid", "valid_empty", "partial", "invalid"])
    .optional(),
  sectionOutcomes: z
    .record(z.string(), z.enum(["valid", "valid_empty", "partial", "invalid"]))
    .optional(),
  rawArtifactPath: z.string().optional(),
  parsedArtifactPath: z.string().optional(),
  detail: z.string().optional(),
});
export type AttackInvocationRecord = z.infer<
  typeof AttackInvocationRecordSchema
>;

export const ReviewFindingSchema = z.object({
  invariant: z.string().min(1),
  codeLocation: z.string().min(1),
  triggerSequence: z.array(z.string().min(1)).min(1),
  expectedBehavior: z.string().min(1),
  confidence: z.number().int().min(0).max(100),
  suggestedMinimalRegressionTest: z.string().min(1),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReconciliationDiagnosticSchema = z.object({
  path: z.string().min(1),
  received: z.string(),
  code: z.string().min(1),
  message: z.string().min(1),
  allowedValues: z.array(z.string()).optional(),
});

export const ReconciliationCandidateSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  lane: z.enum(["contestant", "house"]),
  sourceRound: RoundIdSchema,
  sourceEntryIndex: z.number().int().nonnegative(),
  actor: z.union([ContestantIdSchema, z.literal("house")]),
  target: ContestantIdSchema,
  attemptCount: z.union([z.literal(1), z.literal(2)]),
  rawArtifactPath: z.string().min(1),
  parsedArtifactPath: z.string().min(1),
  correctionRawArtifactPath: z.string().optional(),
  correctionParsedArtifactPath: z.string().optional(),
  diagnostics: z.array(ReconciliationDiagnosticSchema).min(1),
  validatedFields: z.record(z.string(), z.unknown()),
  editablePaths: z.array(z.string()),
  status: z.enum(["pending", "corrected", "discarded"]),
  correctionRound: RoundIdSchema.optional(),
  resultingAttackId: z.string().optional(),
  discardReason: z.string().optional(),
});
export type ReconciliationCandidate = z.infer<
  typeof ReconciliationCandidateSchema
>;

export const SubmissionArtifactRecordSchema = z.object({
  round: RoundIdSchema,
  phase: z.string().min(1),
  actor: z.string().min(1),
  kind: z.enum(["review", "attack", "house", "case", "correction"]),
  outcome: z.enum(["valid", "valid_empty", "partial", "invalid"]),
  rawSha256: z.string().length(64),
  rawArtifactPath: z.string().min(1),
  parsedArtifactPath: z.string().min(1),
});
export type SubmissionArtifactRecord = z.infer<
  typeof SubmissionArtifactRecordSchema
>;

export const ReviewSubmissionSchema = z.object({
  version: z.literal(1),
  findings: z.array(ReviewFindingSchema).max(12),
});
export type ReviewSubmission = z.infer<typeof ReviewSubmissionSchema>;

export const AttackReviewArtifactSchema = z.object({
  version: z.literal(1),
  round: RoundIdSchema,
  reviewer: ContestantIdSchema,
  target: ContestantIdSchema,
  targetPatchSha256: z.string().min(1),
  findings: z.array(ReviewFindingSchema),
});
export type AttackReviewArtifact = z.infer<typeof AttackReviewArtifactSchema>;

export const ReviewInvocationRecordSchema = z.object({
  round: RoundIdSchema,
  reviewer: ContestantIdSchema,
  target: ContestantIdSchema,
  invocation: AgentInvocationSchema,
  submissionStatus: z.enum([
    "submitted",
    "partially_submitted",
    "invalid_submission",
    "not_submitted",
    "not_run",
  ]),
  findingCount: z.number().int().nonnegative(),
  parseOutcome: z
    .enum(["valid", "valid_empty", "partial", "invalid"])
    .optional(),
  sectionOutcomes: z
    .record(z.string(), z.enum(["valid", "valid_empty", "partial", "invalid"]))
    .optional(),
  rawArtifactPath: z.string().optional(),
  parsedArtifactPath: z.string().optional(),
  artifactPath: z.string().optional(),
  detail: z.string().optional(),
});
export type ReviewInvocationRecord = z.infer<
  typeof ReviewInvocationRecordSchema
>;

export const AttackHypothesisSchema = z.object({
  id: z.string(),
  round: RoundIdSchema,
  category: BugCategorySchema,
  invariant: z.string().min(1),
  probe: z.string().min(1),
  requiredCapabilities: z.array(z.string()),
  confidence: z.number().min(0).max(100),
  submittedAttackId: z.string().optional(),
});
export type AttackHypothesis = z.infer<typeof AttackHypothesisSchema>;

export const EvidenceRevisionSchema = z.object({
  attempt: z.literal(1),
  setupChanged: z.boolean(),
  teardownChanged: z.boolean(),
  timeoutChanged: z.boolean(),
  observabilityChanged: z.boolean(),
  focusedCommandChanged: z.boolean(),
  patchPath: z.string(),
  explanation: z.string(),
});
export type EvidenceRevision = z.infer<typeof EvidenceRevisionSchema>;

export const AttackCaseSchema = z.object({
  id: z.string(),
  visibility: z.enum(["visible", "held_out"]),
  category: z.string(),
  patchPath: z.string(),
  focusedCommand: z.string(),
  contentHash: z.string(),
  status: z.enum(["accepted", "rejected", "revealed"]),
});

export const AttackCaseBundleSchema = z.object({
  attackId: z.string(),
  oracle: OracleCitationSchema,
  rootDefectId: z.string(),
  createdBeforeRepairAt: z.string().datetime(),
  cases: z.array(AttackCaseSchema),
});
export type AttackCaseBundle = z.infer<typeof AttackCaseBundleSchema>;

export const AttackOriginSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("contestant"),
    contestant: ContestantIdSchema,
    provider: AgentIdSchema,
  }),
  z.object({ kind: z.literal("house"), methodPackId: z.string() }),
]);
export type AttackOrigin = z.infer<typeof AttackOriginSchema>;

export const AttackStatusSchema = z.enum([
  "submitted",
  "invalid",
  "duplicate",
  "self_defeating",
  "unproven",
  "capability_denied",
  "blocked",
  "landed",
  "provisional_infrastructure",
  "infrastructure_error",
  "execution_inconclusive",
  "judge_rejected",
  "judge_unable",
]);
export type AttackStatus = z.infer<typeof AttackStatusSchema>;

export const EvidenceBasisSchema = z.enum([
  "mechanical",
  "judge",
  "partial_judge",
  "none",
  "legacy_unknown",
]);
export type EvidenceBasis = z.infer<typeof EvidenceBasisSchema>;

export const AdjudicationRecordSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    verdict: z.enum(["valid", "rejected", "unable"]),
    rejectionBasis: z
      .enum(["semantic", "mechanical", "malformed_submission"])
      .optional(),
    canonicalDefectId: z.string().min(1).optional(),
    severity: SeveritySchema.optional(),
    rationale: z.string(),
    evidenceBasis: EvidenceBasisSchema,
    duplicateState: z.enum([
      "unique",
      "duplicate",
      "corroborating",
      "regression",
    ]),
    retryArtifactRefs: z.array(z.string()),
    diagnosticArtifactRefs: z.array(z.string()),
    multiplier: z.union([z.literal(0), z.literal(0.35), z.literal(1)]),
    scoreEffect: z.enum(["damage", "damage_upgrade", "recoil", "none"]),
    exactAmount: z.number().nonnegative().max(50).multipleOf(0.25),
    recoilAmount: z
      .union([z.literal(5), z.literal(10), z.literal(15)])
      .optional(),
    upgradesAdjudicationId: z.string().min(1).optional(),
  })
  .strict()
  .readonly();
export type AdjudicationRecord = z.infer<typeof AdjudicationRecordSchema>;

export const RepairJudgmentRecordSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    round: RoundIdSchema,
    canonicalDefectId: z.string().min(1),
    contestantId: ContestantIdSchema,
    attemptId: z.string().min(1),
    patchDigest: z.string().length(64),
    packetDigest: z.string().length(64),
    decision: z.enum(["repaired", "not_repaired", "unable"]),
    rationale: z.string(),
    adjudicationId: z.string().min(1),
    artifactRefs: z.array(z.string()),
    createdAt: z.string().datetime(),
  })
  .strict()
  .readonly();
export type RepairJudgmentRecord = z.infer<typeof RepairJudgmentRecordSchema>;

export const AttackSchema = z.object({
  id: z.string(),
  round: RoundIdSchema,
  origin: AttackOriginSchema,
  rank: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  targets: z.array(ContestantIdSchema),
  claim: z.string(),
  impact: z.string(),
  oracle: OracleCitationSchema,
  assertionFingerprint: z.string(),
  requiredCapabilities: z.array(z.string()),
  patchPath: z.string(),
  focusedCommand: z.string(),
  evidenceKind: z.enum(["patch", "browser_probe"]).optional(),
  browserProbe: BrowserProbeRequestSchema.optional(),
  status: AttackStatusSchema,
  recoil: z.union([z.literal(5), z.literal(10), z.literal(15)]).optional(),
  proposedSeverity: SeveritySchema.optional(),
  proposedConfidence: z.number().min(0).max(100).optional(),
  rootDefectId: z.string().optional(),
  severity: SeveritySchema.optional(),
  damage: DamageSchema.optional(),
  damageActive: z.boolean().optional(),
  evidenceProvenance: z
    .enum(["mechanical", "judge_confirmed", "judge_partial"])
    .optional(),
  severityRationale: z.string().optional(),
  outcomeReason: z.string().optional(),
  infrastructureReview: z.enum(["accept", "challenge"]).optional(),
  evidenceRevision: EvidenceRevisionSchema.optional(),
  checks: z.array(CheckResultSchema),
  caseBundle: AttackCaseBundleSchema.optional(),
  adjudication: AdjudicationRecordSchema.optional(),
});
export type Attack = z.infer<typeof AttackSchema>;

export const HealthEventSchema = z.object({
  attackId: z.string().optional(),
  adjudicationId: z.string().optional(),
  upgradesAdjudicationId: z.string().optional(),
  round: RoundIdSchema,
  type: z.enum([
    "target_damage",
    "damage_upgrade",
    "recoil",
    "heal",
    "elimination",
  ]),
  amount: z.number().multipleOf(0.25),
  reason: z.string(),
});
export type HealthEvent = z.infer<typeof HealthEventSchema>;

export const HealthLedgerSchema = z.object({
  permanentRecoil: HealthPointSchema,
  activeDefects: z.array(
    z.object({
      rootDefectId: z.string(),
      attackId: z.string(),
      damage: DamageSchema,
      severity: SeveritySchema.optional(),
      multiplier: z.union([z.literal(0.35), z.literal(1)]).optional(),
    }),
  ),
  canonicalDefects: z
    .array(
      z.object({
        rootDefectId: z.string(),
        firstAttackId: z.string(),
        firstAdjudicationId: z.string().optional(),
        baseSeverity: SeveritySchema,
        currentMultiplier: z.union([z.literal(0.35), z.literal(1)]),
        currentDamage: DamageSchema,
        evidenceHistory: z.array(
          z.object({
            attackId: z.string(),
            basis: EvidenceBasisSchema,
            multiplier: z.union([z.literal(0.35), z.literal(1)]),
            rationale: z.string(),
          }),
        ),
        status: z.enum(["active", "healed"]),
        repairAllowance: z.number().int().positive().optional(),
        repairAttemptsUsed: z.number().int().nonnegative().default(0),
        repairAttemptIds: z.array(z.string()).default([]),
        regressionResets: z.number().int().nonnegative().default(0),
      }),
    )
    .optional(),
  eliminatedByRequiredCheck: z.boolean(),
});
export type HealthLedger = z.infer<typeof HealthLedgerSchema>;

export const ReplacementCreditSchema = z.object({
  id: z.string(),
  sourceAttackId: z.string(),
  issuedRound: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  reason: z.enum([
    "accepted_infrastructure",
    "final_infrastructure",
    "inconclusive",
  ]),
  status: z.enum(["available", "spent", "void"]),
  replacementAttackId: z.string().optional(),
});
export type ReplacementCredit = z.infer<typeof ReplacementCreditSchema>;

export const ContestantRoundResultSchema = z.object({
  round: RoundIdSchema,
  startingHealth: HealthPointSchema,
  submittedAttackIds: z.array(z.string()),
  postAttackHealth: HealthPointSchema,
  postAttackStatus: z.enum(["active", "downed"]),
  repair: AgentInvocationSchema.optional(),
  repairAttempts: z.array(AgentInvocationSchema).min(1).max(3).optional(),
  endingHealth: HealthPointSchema,
  endingStatus: z.enum(["active", "eliminated"]),
});
export type ContestantRoundResult = z.infer<typeof ContestantRoundResultSchema>;

export const ContestantResultSchema = z.object({
  id: ContestantIdSchema,
  provider: AgentIdSchema,
  model: z.string().optional(),
  role: ContestantRoleSchema,
  status: z.enum(["pending", "survived", "eliminated", "failed"]),
  initialHealth: z.literal(100),
  finalHealth: HealthPointSchema,
  healthLedger: HealthLedgerSchema,
  healthEvents: z.array(HealthEventSchema),
  initialPatchPath: z.string().optional(),
  currentPatchPath: z.string().optional(),
  finalPatchPath: z.string().optional(),
  patchSize: z.number().int().nonnegative(),
  implementation: AgentInvocationSchema.optional(),
  rounds: z.array(ContestantRoundResultSchema),
  checks: z.array(CheckResultSchema),
  browserValidation: BrowserValidationResultSchema.optional(),
});
export type ContestantResult = z.infer<typeof ContestantResultSchema>;

/** Legacy contestant state retained for V1-V6 artifact readers. */
const LegacyCreditedContestantResultSchema = ContestantResultSchema.extend({
  replacementCredits: z.array(ReplacementCreditSchema).default([]),
});

export const RoundPromptManifestSchema = z.object({
  round: RoundIdSchema,
  profile: RoundProfileSchema,
  commonPromptVersion: z.string(),
  overlayPromptVersion: z.string(),
  methodPackIds: z.array(z.string()),
  probeCardIds: z.array(z.string()),
  toolVersions: z.record(z.string(), z.string()),
  seed: z.string(),
  renderedPromptPath: z.string(),
  promptHash: z.string(),
});
export type RoundPromptManifest = z.infer<typeof RoundPromptManifestSchema>;

export const HarnessOverlaySchema = z.object({
  id: z.string(),
  failureId: z.string(),
  patchPath: z.string(),
  scopes: z.array(z.string()),
  permissionChanges: z.array(z.string()),
  validationChecks: z.array(CheckResultSchema),
  status: z.enum(["proposed", "approved", "applied", "rejected"]),
});
export type HarnessOverlay = z.infer<typeof HarnessOverlaySchema>;

export const IntegrationProfileSchema = z.object({
  setupCommand: z.string(),
  checkCommand: z.string(),
  teardownCommand: z.string(),
  services: z.array(z.string()),
  capabilityIds: z.array(z.string()),
  steadyStateInvariants: z.array(z.string()),
  faultControls: z.array(
    z.enum(["latency", "timeout", "disconnect", "restart", "partial_response"]),
  ),
});
export type IntegrationProfile = z.infer<typeof IntegrationProfileSchema>;

export const BrowserProfileSchema = z
  .object({
    runner: z.enum(["playwright", "cypress", "custom"]),
    startupCommand: z.string().trim().min(1),
    healthUrl: z.string().url(),
    baseUrl: z.string().url(),
    testCommand: z.string().trim().min(1),
    teardownCommand: z.string().trim().min(1).optional(),
    portMode: z.enum(["fixed", "dynamic"]).default("fixed"),
    projects: z.array(z.string().trim().min(1)).default([]),
    allowedOrigins: z.array(z.string().url()).min(1),
  })
  .strict();
export type BrowserProfile = z.infer<typeof BrowserProfileSchema>;

function normalizeBattleConfigInput(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const input = { ...(value as Record<string, unknown>) };
  if (input.contestants === undefined && Array.isArray(input.agents)) {
    input.contestants = input.agents.map((provider: unknown, index) => ({
      id: index === 0 ? "a" : "b",
      provider,
      role: "solver",
      startingPatch: "none",
    }));
  }
  if (input.judge === undefined) {
    input.judge =
      input.attackVerifier ??
      (Array.isArray(input.contestants)
        ? (input.contestants[0] as Record<string, unknown> | undefined)
            ?.provider
        : undefined);
  }
  delete input.agents;
  if (input.mode === undefined) input.mode = "duel";
  return input;
}

const FightConfigBaseSchema = z
  .object({
    task: z.string().min(1),
    mode: BattleModeSchema.default("duel"),
    // Internal, non-persisted slot list. Legacy provider input is normalized
    // into `contestants` before this schema runs.
    agents: z.array(ContestantIdSchema).default([]),
    acceptanceCriteria: z.array(z.string()).default([]),
    specPaths: z.array(z.string()).default([]),
    issueReferences: z.array(z.string()).default([]),
    pullRequestReferences: z.array(z.string()).default([]),
    taskReferences: z.array(TaskReferenceSchema).default([]),
    contestants: z.tuple([ContestantConfigSchema, ContestantConfigSchema]),
    judge: AgentIdSchema,
    /** @deprecated Read-only compatibility alias for pre-v6 run artifacts. */
    attackVerifier: AgentIdSchema.optional(),
    configWarnings: z.array(z.string()).default([]),
    /** @deprecated Ignored for v6 new runs. */
    maxHeldOutCasesPerDefect: z.number().int().min(0).max(2).default(0),
    rounds: z.literal(3),
    maxAttacksPerRound: z.literal(3),
    testCommand: z.string().min(1),
    integrationProfile: IntegrationProfileSchema.optional(),
    browserProfile: BrowserProfileSchema.optional(),
    repositoryRoot: z.string(),
    artifactRoot: z.string(),
    baseCommit: z.string().optional(),
    /** @deprecated Kept for legacy duels; catch-up and siege use PullRequestFixture. */
    baseFromPullRequest: z.string().optional(),
    /**
     * Optional explicit provider for the frozen PR incumbent. When omitted in
     * catch-up mode, the arena resolves a confirmed provider from the frozen
     * PR attribution before any provider invocation is made.
     */
    incumbentProvider: AgentIdSchema.optional(),
    permissionMode: z.enum(["auto", "confirm", "deny"]),
    permissionAllow: z
      .record(
        z.string(),
        z.object({
          mode: z.enum(["auto", "confirm", "deny"]).default("confirm"),
          scopes: z.array(z.string()).default([]),
          role: z.enum(["agent", "harness_only", "both"]).default("both"),
        }),
      )
      .default({}),
    permissionDeny: z.array(z.string()).default([]),
    reducedValidationAccepted: z.boolean().default(false),
    nonInteractiveApproval: z.boolean().default(false),
    keepWorktrees: z.boolean().default(false),
    selectionEnabled: z.boolean().default(true),
    reviewRequiredForApply: z.boolean().default(true),
    deliveryEnabled: z.boolean().default(false),
    mergeEnabled: z.boolean().default(false),
    limits: z.object({
      implementationMs: z.number().int().positive(),
      reviewMs: z
        .number()
        .int()
        .positive()
        .default(8 * 60 * 1000),
      attackMs: z.number().int().positive(),
      verifierMs: z.number().int().positive(),
      repairMs: z.number().int().positive(),
    }),
  })
  .superRefine((value, context) => {
    if (
      value.taskReferences.filter((reference) => reference.primary).length > 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["taskReferences"],
        message: "At most one task reference may be primary",
      });
    }
    if (value.mergeEnabled && !value.deliveryEnabled) {
      context.addIssue({
        code: "custom",
        path: ["mergeEnabled"],
        message: "Merge cannot be enabled while delivery is disabled",
      });
    }
    if (value.baseCommit && value.baseFromPullRequest) {
      context.addIssue({
        code: "custom",
        path: ["baseFromPullRequest"],
        message: "Choose either an explicit base commit or a pull request head",
      });
    }
    const [first, second] = value.contestants;
    if (first.id !== "a" || second.id !== "b") {
      context.addIssue({
        code: "custom",
        path: ["contestants"],
        message: "Contestant slots must be ordered a then b",
      });
    }
    if (value.mode === "catch_up") {
      if (value.pullRequestReferences.length !== 1) {
        context.addIssue({
          code: "custom",
          path: ["pullRequestReferences"],
          message: "Catch-up mode requires exactly one frozen pull request",
        });
      }
      if (
        first.role !== "incumbent" ||
        first.startingPatch !== "pull_request" ||
        second.role !== "challenger"
      ) {
        context.addIssue({
          code: "custom",
          path: ["contestants"],
          message:
            "Catch-up contestants must be an incumbent PR patch and a challenger",
        });
      }
    }
    if (value.mode === "siege") {
      if (value.pullRequestReferences.length !== 1) {
        context.addIssue({
          code: "custom",
          path: ["pullRequestReferences"],
          message: "Siege mode requires exactly one frozen pull request",
        });
      }
      if (
        first.role !== "attacker" ||
        first.startingPatch !== "none" ||
        second.role !== "defender" ||
        second.startingPatch !== "pull_request"
      ) {
        context.addIssue({
          code: "custom",
          path: ["contestants"],
          message:
            "Siege contestants must be an attacker and a defender PR patch",
        });
      }
    }
  });

export const FightConfigSchema = z.preprocess(
  normalizeBattleConfigInput,
  FightConfigBaseSchema.transform((config) => {
    // This compatibility alias is deliberately non-enumerable, so v3 run
    // artifacts persist only the normalized contestant model.
    Object.defineProperty(config, "agents", {
      value: config.contestants.map(({ id }) => id),
      enumerable: false,
    });
    return config;
  }),
);
export type FightConfig = z.infer<typeof FightConfigSchema>;

export const RankingSchema = z.object({
  winner: ContestantIdSchema.nullable(),
  draw: z.boolean(),
  order: z.array(ContestantIdSchema),
  reason: z.string(),
});
export type Ranking = z.infer<typeof RankingSchema>;

export const MarginClassSchema = z.enum([
  "tied",
  "razor_thin",
  "narrow",
  "clear",
]);
export type MarginClass = z.infer<typeof MarginClassSchema>;

export const ArenaContestantOutcomeSchema = z.object({
  contestantId: ContestantIdSchema,
  initialHealth: HealthPointSchema,
  finalHealth: HealthPointSchema,
  grossDamageReceived: HealthPointSchema,
  grossHealing: HealthPointSchema,
  activeDefectDamage: HealthPointSchema,
  permanentRecoil: HealthPointSchema,
  eliminatedByRequiredCheck: z.boolean(),
});

export const ArenaOutcomeSchema = z.object({
  championId: ContestantIdSchema.optional(),
  contestants: z.partialRecord(
    ContestantIdSchema,
    ArenaContestantOutcomeSchema,
  ),
  marginHp: HealthPointSchema,
  marginClass: MarginClassSchema,
  decidingFactors: z.array(
    z.enum(["unresolved_defects", "recoil", "elimination", "tie_breaker"]),
  ),
});
export type ArenaOutcome = z.infer<typeof ArenaOutcomeSchema>;

export const EvidenceValueSchema = z.object({
  status: z.enum(["known", "unknown"]),
  values: z.array(z.string()),
  evidencePaths: z.array(z.string()),
});

export const ManifestDeltaSchema = z.object({
  path: z.string(),
  ecosystem: z.string(),
  status: z.enum(["known", "unknown"]),
  runtimeAdded: z.array(z.string()),
  developmentAdded: z.array(z.string()),
  optionalAdded: z.array(z.string()),
  evidence: z.array(z.string()),
});
export type ManifestDelta = z.infer<typeof ManifestDeltaSchema>;

export const PatchQualityFactsSchema = z.object({
  version: z.literal(1),
  contestantId: ContestantIdSchema,
  patchSha256: z.string().length(64),
  changedPaths: z.array(z.string()),
  binaryPaths: z.array(z.string()),
  productionFilesChanged: z.number().int().nonnegative(),
  testFilesChanged: z.number().int().nonnegative(),
  generatedFilesChanged: z.number().int().nonnegative(),
  vendorFilesChanged: z.number().int().nonnegative(),
  lockfilesChanged: z.number().int().nonnegative(),
  documentationFilesChanged: z.number().int().nonnegative(),
  addedLines: z.number().int().nonnegative(),
  deletedLines: z.number().int().nonnegative(),
  normalizedProductionLines: z.number().int().nonnegative(),
  formattingOnly: z.boolean(),
  manifestDeltas: z.array(ManifestDeltaSchema),
  publicSurfaceChanges: EvidenceValueSchema,
  operationalRequirementsAdded: EvidenceValueSchema,
  verificationEvidence: z.array(z.string()),
  observabilityChanges: z.array(z.string()),
  observabilityRisks: z.array(z.string()),
  evidence: z.array(z.string()),
});
export type PatchQualityFacts = z.infer<typeof PatchQualityFactsSchema>;

export const PatchQualityVerdictSchema = z.object({
  version: z.literal(1),
  verdict: z.enum(["patch_a", "patch_b", "equivalent", "inconclusive"]),
  criteria: z.array(
    z.object({
      name: z.string(),
      verdict: z.enum(["patch_a", "patch_b", "equivalent", "unknown"]),
      evidence: z.array(z.string()),
      rationale: z.string(),
    }),
  ),
  rationale: z.array(z.string()),
});
export type PatchQualityVerdict = z.infer<typeof PatchQualityVerdictSchema>;

export const PatchRecommendationSchema = z.object({
  contestantId: ContestantIdSchema.optional(),
  reason: z.enum([
    "correctness",
    "patch_size",
    "implementation_quality",
    "arena_fallback",
    "draw",
    "inconclusive",
  ]),
  qualityVerdict: z
    .enum(["patch_a", "patch_b", "equivalent", "inconclusive"])
    .optional(),
  rationale: z.array(z.string()),
  comparison: z.array(
    z.object({
      contestantId: ContestantIdSchema,
      eligible: z.boolean(),
      activeDefectDamage: HealthPointSchema,
      requiredValidationPassed: z.boolean(),
      finalApplicabilityPassed: z.boolean(),
    }),
  ),
});
export type PatchRecommendation = z.infer<typeof PatchRecommendationSchema>;

export const PatchChoiceSchema = z.object({
  contestantId: ContestantIdSchema,
  provider: AgentIdSchema,
  role: ContestantRoleSchema,
  label: z.string(),
  eligible: z.boolean(),
  badges: z.array(z.enum(["recommended", "arena_champion"])),
  summary: z.string(),
  patchSha256: z.string().length(64),
  disabledReason: z.string().optional(),
});
export type PatchChoice = z.infer<typeof PatchChoiceSchema>;

export const ReviewPromptSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  promptId: z.string(),
  baseCommit: z.string(),
  choices: z.array(PatchChoiceSchema),
  actions: z.array(
    z.enum(["inspect", "compare", "reject_all", "leave_pending"]),
  ),
});
export type ReviewPrompt = z.infer<typeof ReviewPromptSchema>;

export const CoverageStageNameSchema = z.enum([
  "review",
  "attack_submission",
  "evidence_construction",
  "focused_description",
  "case_construction",
  "execution",
  "semantic_adjudication",
  "repair",
]);
export type CoverageStageName = z.infer<typeof CoverageStageNameSchema>;

export const CoverageAttemptSchema = z.object({
  attempt: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  state: z.enum(["succeeded", "valid_empty", "failed", "not_applicable"]),
  reasonCode: z.string().min(1).optional(),
  evidencePaths: z.array(z.string()),
});
export type CoverageAttempt = z.infer<typeof CoverageAttemptSchema>;

export const CoverageStageAssessmentSchema = z.object({
  stage: CoverageStageNameSchema,
  finalState: z.enum(["completed", "failed", "not_applicable"]),
  attempts: z.array(CoverageAttemptSchema).min(1).max(3),
});

export const CoverageLaneAssessmentSchema = z.object({
  id: z.string().min(1),
  round: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  attacker: ContestantIdSchema,
  target: ContestantIdSchema,
  required: z.literal(true),
  finalState: z.enum(["completed", "degraded", "unresolved"]),
  evidenceBasis: z.enum([
    "mechanical",
    "judge_confirmed",
    "judge_partial",
    "partial_judge",
    "legacy_unknown",
    "judge_rejected",
    "explicit_empty",
    "none",
  ]),
  reasonCodes: z.array(z.string()),
  stages: z.array(CoverageStageAssessmentSchema).length(6),
});
export type CoverageLaneAssessment = z.infer<
  typeof CoverageLaneAssessmentSchema
>;

export const CoverageAssessmentSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  runId: z.string().min(1),
  mode: BattleModeSchema,
  confidence: z.enum(["full_confidence", "reduced_confidence", "provisional"]),
  requiredLanes: z.array(CoverageLaneAssessmentSchema),
  counts: z.object({
    required: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    degraded: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
  }),
  evidenceCounts: z.object({
    mechanical: z.number().int().nonnegative(),
    judgeConfirmed: z.number().int().nonnegative(),
    judgePartial: z.number().int().nonnegative(),
    judgeRejected: z.number().int().nonnegative(),
    explicitEmpty: z.number().int().nonnegative(),
  }),
  reasonCodes: z.array(z.string()),
  retryHistory: z.array(
    z.object({
      laneId: z.string().min(1),
      stage: CoverageStageNameSchema,
      result: z.enum(["succeeded", "failed"]),
      reasonCode: z.string().min(1).optional(),
    }),
  ),
  assessmentDigest: z.string().length(64),
});
export type CoverageAssessment = z.infer<typeof CoverageAssessmentSchema>;

export const CoverageDecisionSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  assessmentDigest: z.string().length(64),
  decision: z.enum(["accept-reduced", "inconclusive"]),
  decidedAt: z.string().datetime(),
  decisionDigest: z.string().length(64),
});
export type CoverageDecision = z.infer<typeof CoverageDecisionSchema>;

/** A disposition reached before attack/review work is eligible to begin. */
export const TerminalOutcomeSchema = z.object({
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
});
export type TerminalOutcome = z.infer<typeof TerminalOutcomeSchema>;

export const DeliveryTargetSchema = z.object({
  kind: z.enum([
    "local_task",
    "github_issue",
    "github_pull_request",
    "repo_spec",
  ]),
  repository: z.string().optional(),
  number: z.number().int().positive().optional(),
  url: z.string().url().optional(),
  baseBranch: z.string().optional(),
  headBranch: z.string().optional(),
  headRepository: z.string().optional(),
  headCommit: z.string().optional(),
  sourceId: z.string().optional(),
});
export type DeliveryTarget = z.infer<typeof DeliveryTargetSchema>;

const RunStateCoreSchema = z.object({
  runId: z.string(),
  harnessVersion: z.string(),
  status: z.enum([
    "running",
    "complete",
    "inconclusive",
    "failed",
    "cancelled",
  ]),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  currentRound: RoundIdSchema.optional(),
  stage: StageSchema,
  config: FightConfigSchema,
  promptManifests: z.array(RoundPromptManifestSchema),
  harnessOverlays: z.array(HarnessOverlaySchema),
  artifacts: z.record(z.string(), z.string()),
  warnings: z.array(z.string()),
  reconciliationQueue: z.array(ReconciliationCandidateSchema).default([]),
  submissionArtifacts: z.array(SubmissionArtifactRecordSchema).default([]),
  repairJudgments: z.array(RepairJudgmentRecordSchema).default([]),
  failureRecords: z.array(FailureRecordSchema).default([]),
  coverageAssessment: CoverageAssessmentSchema.optional(),
  coverageDecision: CoverageDecisionSchema.optional(),
  terminalOutcome: TerminalOutcomeSchema.optional(),
});

export const RunStateV3Schema = RunStateCoreSchema.extend({
  schemaVersion: z.literal(3),
  taskContractHash: z.string(),
  contestants: z.partialRecord(
    ContestantIdSchema,
    LegacyCreditedContestantResultSchema,
  ),
  attacks: z.array(AttackSchema),
  reviewInvocations: z.array(ReviewInvocationRecordSchema).default([]),
  attackInvocations: z.array(AttackInvocationRecordSchema).default([]),
  ranking: RankingSchema.optional(),
  arenaOutcome: ArenaOutcomeSchema.optional(),
  patchQualityFacts: z
    .partialRecord(ContestantIdSchema, PatchQualityFactsSchema)
    .default({}),
  patchQualityVerdict: PatchQualityVerdictSchema.optional(),
  patchRecommendation: PatchRecommendationSchema.optional(),
  reviewPrompt: ReviewPromptSchema.optional(),
  deliveryTarget: DeliveryTargetSchema.optional(),
  pullRequestFixture: PullRequestFixtureSchema.optional(),
});

export const RunStateV4Schema = RunStateCoreSchema.extend({
  schemaVersion: z.literal(4),
  runSpecHash: z.string().length(64),
  contestants: z.partialRecord(
    ContestantIdSchema,
    LegacyCreditedContestantResultSchema,
  ),
  attacks: z.array(AttackSchema),
  reviewInvocations: z.array(ReviewInvocationRecordSchema).default([]),
  attackInvocations: z.array(AttackInvocationRecordSchema).default([]),
  ranking: RankingSchema.optional(),
  arenaOutcome: ArenaOutcomeSchema.optional(),
  patchQualityFacts: z
    .partialRecord(ContestantIdSchema, PatchQualityFactsSchema)
    .default({}),
  patchQualityVerdict: PatchQualityVerdictSchema.optional(),
  patchRecommendation: PatchRecommendationSchema.optional(),
  reviewPrompt: ReviewPromptSchema.optional(),
  deliveryTarget: DeliveryTargetSchema.optional(),
  pullRequestFixture: PullRequestFixtureSchema.optional(),
});
export const RunStateV5Schema = RunStateCoreSchema.extend({
  schemaVersion: z.literal(5),
  runSpecHash: z.string().length(64),
  contestants: z.partialRecord(
    ContestantIdSchema,
    LegacyCreditedContestantResultSchema,
  ),
  attacks: z.array(AttackSchema),
  reviewInvocations: z.array(ReviewInvocationRecordSchema).default([]),
  attackInvocations: z.array(AttackInvocationRecordSchema).default([]),
  ranking: RankingSchema.optional(),
  arenaOutcome: ArenaOutcomeSchema.optional(),
  patchQualityFacts: z
    .partialRecord(ContestantIdSchema, PatchQualityFactsSchema)
    .default({}),
  patchQualityVerdict: PatchQualityVerdictSchema.optional(),
  patchRecommendation: PatchRecommendationSchema.optional(),
  reviewPrompt: ReviewPromptSchema.optional(),
  deliveryTarget: DeliveryTargetSchema.optional(),
  pullRequestFixture: PullRequestFixtureSchema.optional(),
});
export const RunStateV6Schema = RunStateCoreSchema.extend({
  schemaVersion: z.literal(6),
  runSpecHash: z.string().length(64),
  contestants: z.partialRecord(
    ContestantIdSchema,
    LegacyCreditedContestantResultSchema,
  ),
  attacks: z.array(AttackSchema),
  reviewInvocations: z.array(ReviewInvocationRecordSchema).default([]),
  attackInvocations: z.array(AttackInvocationRecordSchema).default([]),
  ranking: RankingSchema.optional(),
  arenaOutcome: ArenaOutcomeSchema.optional(),
  patchQualityFacts: z
    .partialRecord(ContestantIdSchema, PatchQualityFactsSchema)
    .default({}),
  patchQualityVerdict: PatchQualityVerdictSchema.optional(),
  patchRecommendation: PatchRecommendationSchema.optional(),
  reviewPrompt: ReviewPromptSchema.optional(),
  deliveryTarget: DeliveryTargetSchema.optional(),
  pullRequestFixture: PullRequestFixtureSchema.optional(),
});
const RunStateV7CoreSchema = RunStateCoreSchema.omit({
  harnessOverlays: true,
  reconciliationQueue: true,
  stage: true,
  currentRound: true,
}).extend({
  stage: CurrentStageSchema,
  currentRound: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
});

export const RunStateV7Schema = RunStateV7CoreSchema.extend({
  schemaVersion: z.literal(7),
  runSpecHash: z.string().length(64),
  contestants: z.partialRecord(ContestantIdSchema, ContestantResultSchema),
  attacks: z.array(AttackSchema),
  reviewInvocations: z.array(ReviewInvocationRecordSchema).default([]),
  attackInvocations: z.array(AttackInvocationRecordSchema).default([]),
  ranking: RankingSchema.optional(),
  arenaOutcome: ArenaOutcomeSchema.optional(),
  patchQualityFacts: z
    .partialRecord(ContestantIdSchema, PatchQualityFactsSchema)
    .default({}),
  patchQualityVerdict: PatchQualityVerdictSchema.optional(),
  patchRecommendation: PatchRecommendationSchema.optional(),
  reviewPrompt: ReviewPromptSchema.optional(),
  deliveryTarget: DeliveryTargetSchema.optional(),
  pullRequestFixture: PullRequestFixtureSchema.optional(),
});
export const RunStateSchema = RunStateV7Schema;
export type RunStateV3 = z.infer<typeof RunStateV3Schema>;
export type RunStateV4 = z.infer<typeof RunStateV4Schema>;
export type RunStateV5 = z.infer<typeof RunStateV5Schema>;
export type RunStateV6 = z.infer<typeof RunStateV6Schema>;
export type RunStateV7 = z.infer<typeof RunStateV7Schema>;
export type RunState =
  RunStateV3 | RunStateV4 | RunStateV5 | RunStateV6 | RunStateV7;

// --- Legacy readers: in schema versions 1 and 2 the provider was the
// contestant identity. They are migrated to contestant slots at load time. ---

const LegacyContestantResultSchema = LegacyCreditedContestantResultSchema.omit({
  id: true,
  provider: true,
  role: true,
}).extend({ agent: AgentIdSchema });
export type LegacyContestantResult = z.infer<
  typeof LegacyContestantResultSchema
>;

const LegacyAttackSchema = AttackSchema.omit({
  origin: true,
  targets: true,
}).extend({
  origin: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("contestant"), agent: AgentIdSchema }),
    z.object({ kind: z.literal("house"), methodPackId: z.string() }),
  ]),
  targets: z.array(AgentIdSchema),
});

const LegacyRankingSchema = z.object({
  winner: AgentIdSchema.nullable(),
  draw: z.boolean(),
  order: z.array(AgentIdSchema),
  reason: z.string(),
});

const LegacyArenaOutcomeSchema = ArenaOutcomeSchema.omit({
  championId: true,
  contestants: true,
}).extend({
  championId: AgentIdSchema.optional(),
  contestants: z.partialRecord(
    AgentIdSchema,
    ArenaContestantOutcomeSchema.omit({ contestantId: true }).extend({
      contestantId: AgentIdSchema,
    }),
  ),
});

const LegacyPatchQualityFactsSchema = PatchQualityFactsSchema.omit({
  contestantId: true,
}).extend({ contestantId: AgentIdSchema });

const LegacyPatchRecommendationSchema = PatchRecommendationSchema.omit({
  contestantId: true,
  comparison: true,
}).extend({
  contestantId: AgentIdSchema.optional(),
  comparison: z.array(
    z.object({
      contestantId: AgentIdSchema,
      eligible: z.boolean(),
      activeDefectDamage: HealthPointSchema,
      requiredValidationPassed: z.boolean(),
      finalApplicabilityPassed: z.boolean(),
    }),
  ),
});

const LegacyReviewPromptSchema = ReviewPromptSchema.omit({
  choices: true,
}).extend({
  choices: z.array(
    z.object({
      contestantId: AgentIdSchema,
      eligible: z.boolean(),
      badges: z.array(z.enum(["recommended", "arena_champion"])),
      summary: z.string(),
      patchSha256: z.string().length(64),
      disabledReason: z.string().optional(),
    }),
  ),
});

const LegacyRunStateCommonSchema = RunStateCoreSchema.extend({
  taskContractHash: z.string(),
  contestants: z.partialRecord(AgentIdSchema, LegacyContestantResultSchema),
  attacks: z.array(LegacyAttackSchema),
  ranking: LegacyRankingSchema.optional(),
});

export const RunStateV1Schema = LegacyRunStateCommonSchema.extend({
  schemaVersion: z.literal(1),
});
export type RunStateV1 = z.infer<typeof RunStateV1Schema>;

export const RunStateV2Schema = LegacyRunStateCommonSchema.extend({
  schemaVersion: z.literal(2),
  arenaOutcome: LegacyArenaOutcomeSchema.optional(),
  patchQualityFacts: z
    .partialRecord(AgentIdSchema, LegacyPatchQualityFactsSchema)
    .default({}),
  patchQualityVerdict: PatchQualityVerdictSchema.optional(),
  patchRecommendation: LegacyPatchRecommendationSchema.optional(),
  reviewPrompt: LegacyReviewPromptSchema.optional(),
  deliveryTarget: DeliveryTargetSchema.optional(),
});
export type RunStateV2 = z.infer<typeof RunStateV2Schema>;

export const AnyRunStateSchema = z.discriminatedUnion("schemaVersion", [
  RunStateV1Schema,
  RunStateV2Schema,
  RunStateV3Schema,
  RunStateV4Schema,
  RunStateV5Schema,
  RunStateV6Schema,
  RunStateV7Schema,
]);
export type AnyRunState = z.infer<typeof AnyRunStateSchema>;

const AttackSubmissionEntryBaseSchema = z.object({
  rank: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  claim: z.string().min(1),
  impact: z.string().min(1),
  oracle: OracleCitationSchema,
  proposedSeverity: SeveritySchema,
  confidence: z.number().int().min(0).max(100),
  /** @deprecated V1 description retained only for source compatibility. */
  reproduction: z.string().min(1).optional(),
  focusedCommand: z.string().min(1).optional(),
  paths: z.array(z.string().min(1)).default([]),
  requiredCapabilities: z.array(z.string()).default([]),
  browserProbe: BrowserProbeRequestSchema.optional(),
});

export const AttackSubmissionEntrySchema =
  AttackSubmissionEntryBaseSchema.superRefine((attack, context) => {
    if (
      attack.browserProbe &&
      !attack.requiredCapabilities.includes("browser_dom_validation")
    )
      context.addIssue({
        code: "custom",
        path: ["requiredCapabilities"],
        message:
          "A browserProbe must declare browser_dom_validation as a required capability",
      });
    if (
      !attack.browserProbe &&
      (!attack.focusedCommand || !attack.paths.length)
    )
      context.addIssue({
        code: "custom",
        message:
          "An attack needs a focused command and paths, or a browserProbe",
      });
    if (attack.paths.length > 0 && !attack.focusedCommand)
      context.addIssue({
        code: "custom",
        path: ["focusedCommand"],
        message: "Attacks with repository paths need a focused command",
      });
  });

export const LegacyAttackSubmissionEntrySchema =
  AttackSubmissionEntryBaseSchema.omit({
    focusedCommand: true,
    paths: true,
  });

export const AttackSubmissionV2Schema = z
  .object({
    version: z.literal(2),
    sharedSupportPaths: z.array(z.string().min(1)).default([]),
    attacks: z.array(AttackSubmissionEntrySchema).max(3),
  })
  .superRefine((submission, context) => {
    const owners = new Map<string, number>();
    submission.attacks.forEach((attack, index) => {
      for (const attackPath of attack.paths) {
        if (submission.sharedSupportPaths.includes(attackPath)) {
          context.addIssue({
            code: "custom",
            path: ["attacks", index, "paths"],
            message: `Rank-specific path ${attackPath} is also declared as shared support`,
          });
        }
        const previous = owners.get(attackPath);
        if (previous !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["attacks", index, "paths"],
            message: `Rank-specific path ${attackPath} is also owned by attack ${String(previous + 1)}`,
          });
        } else owners.set(attackPath, index);
      }
    });
  });
const LegacyAttackSubmissionSchema = z.object({
  version: z.literal(1),
  attacks: z
    .array(
      LegacyAttackSubmissionEntrySchema.extend({
        reproduction: z.string().min(1),
      }),
    )
    .max(3),
});
/** Reads completed legacy submissions; new-run parsing requires V2. */
export const AttackSubmissionSchema = z.union([
  LegacyAttackSubmissionSchema,
  AttackSubmissionV2Schema,
]);
export type AttackSubmission = z.infer<typeof AttackSubmissionV2Schema>;

export const StageSubmissionSchema = z.object({
  version: z.literal(1),
  explanation: z.string().default(""),
});
export type StageSubmission = z.infer<typeof StageSubmissionSchema>;

export const HouseSubmissionSchema = z.object({
  version: z.literal(1),
  hypotheses: z.array(
    z.object({
      category: BugCategorySchema,
      invariant: z.string(),
      probe: z.string(),
      requiredCapabilities: z.array(z.string()).default([]),
      confidence: z.number().int().min(0).max(100),
    }),
  ),
  attacks: z
    .array(
      AttackSubmissionEntryBaseSchema.omit({ rank: true }).extend({
        focusedCommand: z.string().min(1),
        paths: z.array(z.string().min(1)).min(1),
      }),
    )
    .max(1),
});
export type HouseSubmission = z.infer<typeof HouseSubmissionSchema>;

export const CaseSubmissionSchema = z.object({
  version: z.literal(1),
  cases: z
    .array(
      z.object({
        category: z.string().min(1),
        focusedCommand: z.string().min(1),
        paths: z.array(z.string().min(1)).min(1),
        requiredCapabilities: z.array(z.string()).default([]),
      }),
    )
    .max(2),
});
export type CaseSubmission = z.infer<typeof CaseSubmissionSchema>;

export const InfrastructureReviewSubmissionSchema = z.discriminatedUnion(
  "decision",
  [
    z.object({
      version: z.literal(1),
      decision: z.literal("accept"),
      explanation: z.string().min(1),
    }),
    z.object({
      version: z.literal(1),
      decision: z.literal("challenge"),
      explanation: z.string().min(1),
      focusedCommand: z.string().min(1).optional(),
      setupChanged: z.boolean().default(false),
      teardownChanged: z.boolean().default(false),
      timeoutChanged: z.boolean().default(false),
      observabilityChanged: z.boolean().default(false),
    }),
  ],
);
export type InfrastructureReviewSubmission = z.infer<
  typeof InfrastructureReviewSubmissionSchema
>;
