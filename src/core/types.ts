import { z } from "zod";

export const AGENT_IDS = ["codex", "claude", "gemini"] as const;
export const AgentIdSchema = z.enum(AGENT_IDS);
export type AgentId = z.infer<typeof AgentIdSchema>;

export const SeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof SeveritySchema>;

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
]);
export type RoundId = z.infer<typeof RoundIdSchema>;

export const RoundProfileSchema = z.enum([
  "contract_local",
  "systematic_exploration",
  "integration_resilience_security",
  "infrastructure_recovery",
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
  "collect_attacks",
  "validate_attacks",
  "review_infrastructure",
  "revise_evidence",
  "assign_severity",
  "resolve_damage",
  "repair",
  "validate_repairs",
  "recovery_round",
  "final_validate",
  "report",
  "complete",
  "inconclusive",
  "failed",
  "cancelled",
]);
export type Stage = z.infer<typeof StageSchema>;

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
});
export type TaskSource = z.infer<typeof TaskSourceSchema>;

export const TaskContractSchema = z.object({
  version: z.literal(1),
  task: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  sources: z.array(TaskSourceSchema).min(1),
  createdAt: z.string().datetime(),
  contractHash: z.string(),
});
export type TaskContract = z.infer<typeof TaskContractSchema>;

export const OracleCitationSchema = z.object({
  expectedBehavior: z.string().min(1),
  sourceId: z.string().min(1),
  sourceLocation: z.string().min(1),
  rationale: z.string().min(1),
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

const AttackOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("contestant"), agent: AgentIdSchema }),
  z.object({ kind: z.literal("house"), methodPackId: z.string() }),
]);

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
]);
export type AttackStatus = z.infer<typeof AttackStatusSchema>;

export const AttackSchema = z.object({
  id: z.string(),
  round: RoundIdSchema,
  origin: AttackOriginSchema,
  rank: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  targets: z.array(AgentIdSchema),
  claim: z.string(),
  impact: z.string(),
  oracle: OracleCitationSchema,
  assertionFingerprint: z.string(),
  requiredCapabilities: z.array(z.string()),
  patchPath: z.string(),
  focusedCommand: z.string(),
  status: AttackStatusSchema,
  recoil: z.union([z.literal(5), z.literal(10), z.literal(15)]).optional(),
  proposedSeverity: SeveritySchema.optional(),
  proposedConfidence: z.number().min(0).max(100).optional(),
  rootDefectId: z.string().optional(),
  severity: SeveritySchema.optional(),
  damage: z
    .union([z.literal(50), z.literal(30), z.literal(15), z.literal(5)])
    .optional(),
  damageActive: z.boolean().optional(),
  severityRationale: z.string().optional(),
  outcomeReason: z.string().optional(),
  infrastructureReview: z.enum(["accept", "challenge"]).optional(),
  evidenceRevision: EvidenceRevisionSchema.optional(),
  checks: z.array(CheckResultSchema),
  caseBundle: AttackCaseBundleSchema.optional(),
});
export type Attack = z.infer<typeof AttackSchema>;

export const HealthEventSchema = z.object({
  attackId: z.string().optional(),
  round: RoundIdSchema,
  type: z.enum(["target_damage", "recoil", "heal", "elimination"]),
  amount: z.number().int(),
  reason: z.string(),
});
export type HealthEvent = z.infer<typeof HealthEventSchema>;

export const HealthLedgerSchema = z.object({
  permanentRecoil: z.number().int().nonnegative(),
  activeDefects: z.array(
    z.object({
      rootDefectId: z.string(),
      attackId: z.string(),
      damage: z.union([
        z.literal(50),
        z.literal(30),
        z.literal(15),
        z.literal(5),
      ]),
    }),
  ),
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
  startingHealth: z.number().int(),
  submittedAttackIds: z.array(z.string()),
  postAttackHealth: z.number().int(),
  postAttackStatus: z.enum(["active", "downed"]),
  repair: AgentInvocationSchema.optional(),
  endingHealth: z.number().int(),
  endingStatus: z.enum(["active", "eliminated"]),
});
export type ContestantRoundResult = z.infer<typeof ContestantRoundResultSchema>;

export const ContestantResultSchema = z.object({
  agent: AgentIdSchema,
  status: z.enum(["pending", "survived", "eliminated", "failed"]),
  initialHealth: z.literal(100),
  finalHealth: z.number().int().min(0).max(100),
  replacementCredits: z.array(ReplacementCreditSchema),
  healthLedger: HealthLedgerSchema,
  healthEvents: z.array(HealthEventSchema),
  initialPatchPath: z.string().optional(),
  currentPatchPath: z.string().optional(),
  finalPatchPath: z.string().optional(),
  patchSize: z.number().int().nonnegative(),
  implementation: AgentInvocationSchema.optional(),
  rounds: z.array(ContestantRoundResultSchema),
  checks: z.array(CheckResultSchema),
});
export type ContestantResult = z.infer<typeof ContestantResultSchema>;

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

export const FightConfigSchema = z.object({
  task: z.string().min(1),
  acceptanceCriteria: z.array(z.string()).default([]),
  specPaths: z.array(z.string()).default([]),
  issueReferences: z.array(z.string()).default([]),
  agents: z
    .tuple([AgentIdSchema, AgentIdSchema])
    .refine(([left, right]) => left !== right, {
      message: "Contestants must be different agents",
    }),
  attackVerifier: AgentIdSchema,
  harnessMaintainer: AgentIdSchema,
  rounds: z.literal(3),
  maxAttacksPerRound: z.literal(3),
  infrastructureRecoveryRound: z.literal(true),
  maxHeldOutCasesPerDefect: z.number().int().min(0).max(2),
  testCommand: z.string().min(1),
  integrationProfile: IntegrationProfileSchema.optional(),
  repositoryRoot: z.string(),
  artifactRoot: z.string(),
  baseCommit: z.string().optional(),
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
  limits: z.object({
    implementationMs: z.number().int().positive(),
    attackMs: z.number().int().positive(),
    verifierMs: z.number().int().positive(),
    repairMs: z.number().int().positive(),
  }),
});
export type FightConfig = z.infer<typeof FightConfigSchema>;

export const RankingSchema = z.object({
  winner: AgentIdSchema.nullable(),
  draw: z.boolean(),
  order: z.array(AgentIdSchema),
  reason: z.string(),
});
export type Ranking = z.infer<typeof RankingSchema>;

export const RunStateSchema = z.object({
  schemaVersion: z.literal(1),
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
  taskContractHash: z.string(),
  config: FightConfigSchema,
  contestants: z.partialRecord(AgentIdSchema, ContestantResultSchema),
  attacks: z.array(AttackSchema),
  promptManifests: z.array(RoundPromptManifestSchema),
  harnessOverlays: z.array(HarnessOverlaySchema),
  ranking: RankingSchema.optional(),
  artifacts: z.record(z.string(), z.string()),
  warnings: z.array(z.string()),
});
export type RunState = z.infer<typeof RunStateSchema>;

export const AttackSubmissionEntrySchema = z.object({
  rank: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  claim: z.string().min(1),
  impact: z.string().min(1),
  oracle: OracleCitationSchema,
  proposedSeverity: SeveritySchema,
  confidence: z.number().int().min(0).max(100),
  focusedCommand: z.string().min(1),
  requiredCapabilities: z.array(z.string()).default([]),
  paths: z.array(z.string().min(1)).min(1),
});

export const AttackSubmissionSchema = z.object({
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
  attacks: z.array(AttackSubmissionEntrySchema).max(3),
});
export type AttackSubmission = z.infer<typeof AttackSubmissionSchema>;

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
      AttackSubmissionEntrySchema.omit({ rank: true }).extend({
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
