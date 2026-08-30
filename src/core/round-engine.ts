import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AgentAdapter,
  AttackVerifier,
  CaseBuilder,
  HouseScout,
  IssueResolver,
  PullRequestResolver,
} from "../index-internal.js";
import type {
  HarnessMaintainer,
  InfrastructureReviewer,
} from "../agents/adapter.js";
import {
  anonymizeAttackForVerifier,
  removeSubmission,
} from "../agents/adapter.js";
import {
  agentVisibleRunSpec,
  composeAttackReviewPrompt,
  composeNeutralCasePrompt,
  composePrompt,
  createPromptManifest,
} from "../agents/prompts.js";
import { ArtifactStore } from "../artifacts/store.js";
import {
  browserProbeEvidencePatch,
  materializeAttack,
  materializeHouseAttack,
} from "../attacks/submission.js";
import {
  validateAttack,
  validateHouseAttack,
  validateSiegeAttack,
} from "../attacks/validate.js";
import {
  evidenceFingerprint,
  priorAdjudicationContext,
} from "../attacks/challenges.js";
import { validateSiblingCase } from "../attacks/case-bundle.js";
import {
  parseFaultIsolatedSubmission,
  declaredAttackPaths,
  isCorrectionEligible,
  mergeCorrectionFields,
  type ParsedSubmission,
  type SubmissionKind,
} from "../attacks/fault-isolated-submission.js";
import { assertEvidenceIdentityPreserved } from "../attacks/evidence-revision.js";
import { validateHarnessOverlay } from "../maintenance/overlays.js";
import { selectMethods } from "../methods/catalog.js";
import {
  assertDirectCapabilitiesAllowed,
  discoverCapabilities,
  resolvePermissionPolicy,
} from "../permissions/policy.js";
import {
  assertCleanRepository,
  fetchRemoteCommit,
  readTextAtCommit,
  resolveCommit,
  resolveGitHubRepositoryIdentity,
  resolveRepositoryRoot,
  WorktreeManager,
} from "../repo/git.js";
import { prepareWorktreeWithRetry } from "../repo/retry.js";
import {
  renderConsoleSummary,
  type ConsoleRenderOptions,
} from "../reports/console.js";
import { renderBattleHtml } from "../reports/html.js";
import { renderBattleReport } from "../reports/markdown.js";
import { renderBattleVisual } from "../reports/visual.js";
import { deriveArenaOutcome } from "../outcomes/derive-outcome.js";
import {
  competitiveLandings,
  explicitEmptyLaneCount,
  sharedDefects,
} from "../outcomes/evidence.js";
import { collectPatchQualityFacts } from "../quality/collect-facts.js";
import {
  inconclusiveQualityVerdict,
  type PatchQualityVerifier,
} from "../quality/verifier.js";
import { compareQualityWithRetry } from "../quality/retry.js";
import {
  isCompetitiveQualityTie,
  selectRecommendedPatch,
} from "../recommendation/select-patch.js";
import { buildReviewPrompt } from "../review/prompt.js";
import {
  buildEvidenceHandoffPacket,
  normalizeHandoffBlocker,
  projectResolvedPermissions,
  requireConsumableEvidenceHandoff,
  validateEvidenceHandoffPacket,
  type EvidenceHandoffPacket,
  type HandoffArtifactPointer,
  type HandoffFindingPayload,
  type HandoffLifecycleRecord,
  type HandoffTargetSnapshot,
  type ResolvedPermissionProjection,
} from "../review/evidence-handoff.js";
import {
  persistEvidenceHandoffPacket,
  persistHandoffLifecycleRecord,
  persistHandoffValidationOutcome,
} from "../review/evidence-handoff-store.js";
import { runShellCommand } from "../runner/process-runner.js";
import { provisionIntegrationProfile } from "../runner/integration.js";
import {
  buildRunSpec,
  calculateRunSpecHash,
  collectFightReconnaissance,
  assertReconnaissanceRepositoryInputsCurrent,
  GitHubPullRequestResolver,
  type ResolvedPullRequest,
  type ReconnaissanceSnapshot,
  validateReconnaissance,
} from "../task/task-contract.js";
import type { RunSpec } from "../contracts/round.js";
import {
  resolveEffortProfile,
  decideAdaptiveRound,
  nextLowSignalCount,
  scoreEffort,
  TaskEffortAssessmentV1Schema,
  unavailableTokenTelemetry,
  type EffortProfile,
  type AdaptiveRoundDecision,
  type TaskEffortAssessmentV1,
  type TokenTelemetry,
} from "../effort/policy.js";
import {
  BrowserValidationResultSchema,
  type BrowserValidationResult,
} from "../contracts/browser.js";
import {
  attributeBrowserResult,
  browserRepairEvidencePasses,
  findBrowserProbeResult,
} from "../browser/results.js";
import {
  FailureRecordSchema,
  type FailureCategory,
  type FailureRecord,
  type FailureStage,
} from "../contracts/failure.js";
import {
  freezePullRequest,
  type PullRequestFixtureOptions,
} from "../task/pr-fixture.js";
import { deriveDeliveryTarget } from "../delivery/target.js";
import { createRunId, sha256, stableId } from "./ids.js";
import {
  applyChallengeCorrections,
  calculateHealth,
  challengeCorrectionRecoil,
  DAMAGE_BY_SEVERITY,
  healDefect,
  normalizeAttackAdjudication,
  PARTIAL_DAMAGE_BY_SEVERITY,
  rankContestants,
  resolveRound,
} from "./scoring.js";
import { assertTransition } from "./state-machine.js";
import {
  AdjudicationRecordSchema,
  FightConfigSchema,
  PermissionPolicySchema,
  PatchRecommendationSchema,
  RepairJudgmentRecordSchema,
  type AgentId,
  type AgentInvocation,
  type Attack,
  type AttackSubmission,
  type CaseSubmission,
  type CheckResult,
  type ContestantResult,
  type ContestantConfig,
  type ContestantId,
  type ContestantRoundResult,
  type FightConfig,
  type HouseSubmission,
  type PermissionPolicy,
  type PullRequestFixture,
  type ReconciliationCandidate,
  type RoundId,
  type RunState,
  type Stage,
  type TerminalOutcome,
  TerminalOutcomeSchema,
} from "./types.js";
import {
  calculateCanonicalHash,
  calculateReplayHash,
  calculateSnapshotHash,
  RoundReplaySchema,
  RoundResultSchema,
  validateRoundResult,
  validateRoundSnapshot,
  type ArtifactReference,
  type ContestantFeedback,
  type RoundReplay,
  type RoundResult,
  type RoundSnapshot,
  RunSpecSchema,
} from "../contracts/round.js";
import { projectRoundStateDelta } from "./round-state-delta.js";
import {
  DriftReportSchema,
  FinalizationRecordSchema,
  RoundEnvelopeSchema,
  type AppliedEnvelope,
  type CheckpointDescriptor,
} from "../recovery/contracts.js";
import {
  applyEnvelopeExactlyOnce,
  readBrowserBaseline,
  readContinuationCheckpoint,
  sealRoundEnvelope,
  writeBaseline,
  writeBrowserBaseline,
  writeCheckpoint,
  writeFinalizationRecord,
} from "../recovery/durable.js";
import {
  persistContestantFeedback,
  projectContestantFeedback,
} from "../recovery/feedback.js";
import { writeDependencyManifest } from "../recovery/manifest.js";
import {
  approveDrift,
  captureDependencyManifest,
  createDriftReport,
  readDependencyManifest,
} from "../recovery/manifest.js";
import { appendRecoveryEvent } from "../recovery/events.js";
import { readEnvelopeChain } from "../recovery/durable.js";
import {
  assessBattleCoverage,
  assertTargetedRetryAllowed,
} from "../confidence/assessment.js";
import {
  BrowserInfrastructureError,
  executeBrowserValidation,
  type BrowserAdapter,
  type BrowserNativeSuiteResult,
} from "../browser/executor.js";
import {
  ArenaEventBus,
  EventJournal,
  type ArenaEventInput,
  type ArenaEventSink,
  type ArenaObserver,
} from "../observability/events.js";
import {
  ArenaBattleControl,
  appendSteering,
} from "../observability/control.js";
import {
  mergeMcpPermissionPolicy,
  type FrozenMcpPolicy,
} from "../mcp/policy.js";
import {
  ProviderStageFailureSchema,
  type ProviderStage,
} from "../recovery/provider-policy.js";

export type { ReconnaissanceSnapshot } from "../task/task-contract.js";

export interface ArenaDependencies {
  adapters: Partial<Record<AgentId, AgentAdapter>>;
  contestantAdapters?: Partial<Record<ContestantId, AgentAdapter>>;
  adapterFactory?: (
    contestant: Pick<ContestantConfig, "id" | "provider" | "model">,
  ) => AgentAdapter;
  verifier: AttackVerifier;
  houseScout?: HouseScout;
  caseBuilder?: CaseBuilder;
  issueResolver?: IssueResolver;
  pullRequestResolver?: PullRequestResolver;
  qualityVerifier?: PatchQualityVerifier;
  freezePullRequest?: (
    options: PullRequestFixtureOptions,
  ) => Promise<PullRequestFixture>;
  now?: () => Date;
  onProgress?: (message: string) => void;
  consoleOptions?: ConsoleRenderOptions;
  /** Optional best-effort live display sink. Persistence remains authoritative. */
  observer?: ArenaEventSink;
  battleControl?: ArenaBattleControl;
  /** Transactional executor hook used by isolated RoundEngine tests/adapters. */
  executeRound?: (snapshot: RoundSnapshot) => Promise<RoundResult>;
  browserAdapters?: Partial<
    Record<"playwright" | "cypress" | "custom", BrowserAdapter>
  >;
  /** Frozen before worktree creation and shared by every provider invocation. */
  mcpPolicy?: FrozenMcpPolicy;
  canRecoverProvider?: (provider: AgentId) => boolean;
  /** Returns true when an unrecovered coverage-stage failure must stop the run. */
  recordUnrecoveredProviderFailure?: (
    stage: "review" | "attack_construction",
  ) => boolean;
}

/** Read-only legacy hooks kept out of the public runtime dependency surface. */
interface LegacyArenaDependencies {
  infrastructureReviewer?: InfrastructureReviewer;
  harnessMaintainer?: HarnessMaintainer;
}

export interface FightOutcome {
  state: RunState;
  summary: string;
}

export interface ResumeOptions {
  runId: string;
  repositoryRoot?: string;
  artifactRoot?: string;
  approveDriftHash?: string;
  approvedBy?: string;
  display?: "console" | "json";
}

export interface ReplacementFightOptions {
  parentRunId: string;
  restartOrdinal: 1 | 2;
  runSpec: RunSpec;
  permissions: PermissionPolicy;
  reconnaissance: ReconnaissanceSnapshot;
  pullRequestFixture?: PullRequestFixture;
  /** State reconstructed only from the parent's sealed envelope ledger. */
  inheritedState?: RunState;
  /** First unsealed round; earlier rounds must never be replayed. */
  startRound?: 1 | 2 | 3 | 4 | 5;
  /** Round-one implementation and initial validation were durably retained. */
  resumeAfterInitialization?: boolean;
  /** Last sealed parent boundary that anchors the child's first round. */
  continuationCheckpoint?: CheckpointDescriptor;
}

interface ArenaContext {
  config: FightConfig;
  store: ArtifactStore;
  worktrees: WorktreeManager;
  runSpec: RunSpec;
  permissions: PermissionPolicy;
  state: RunState;
  controller: AbortController;
  observer: ArenaObserver;
  journal: EventJournal;
  control: ArenaBattleControl;
  emittedEvents: Set<string>;
  roundInvocations: RecordedRoundInvocation[];
  priorEnvelopeHash: string | null;
  appliedEnvelopes: AppliedEnvelope[];
  continuationCheckpoint?: CheckpointDescriptor;
  browserBaseline?: BrowserValidationResult;
}

interface EvidenceHandoffLane {
  packet: EvidenceHandoffPacket;
  canonicalBytes: Uint8Array;
  sourceFindings: HandoffFindingPayload[];
  targetSnapshot: Pick<
    HandoffTargetSnapshot,
    "base_commit" | "frozen_patch_sha256" | "frozen_git_tree_id"
  >;
  permissionProjection: ResolvedPermissionProjection;
  packetPointer: HandoffArtifactPointer;
  lifecycle: HandoffLifecycleRecord;
}

interface RecordedRoundInvocation {
  id: string;
  kind: "case_generation" | "verification" | "house";
  actor: "verifier" | "harness";
  status:
    "succeeded" | "failed" | "timed_out" | "cancelled" | "infrastructure_error";
  startedAt: string;
  finishedAt: string;
  artifactPaths: string[];
  tokenTelemetry?: TokenTelemetry;
}

type DashboardLink = NonNullable<
  Extract<ArenaEventInput, { type: "battle_started" }>["links"]
>[number];

function dashboardLinks(
  runSpec: RunSpec,
  store: ArtifactStore,
): DashboardLink[] {
  const links: DashboardLink[] = [];
  for (const source of runSpec.task.sources) {
    if (source.github?.url) {
      links.push({
        kind: source.kind === "pull_request" ? "pull_request" : "issue",
        label: `${source.kind === "pull_request" ? "PR" : "Issue"} ${source.github.repository}#${String(source.github.number)}`,
        url: source.github.url,
      });
    } else if (source.kind === "repo_spec") {
      links.push({
        kind: "spec",
        label: `Spec ${path.basename(source.origin)}`,
        url: pathToFileURL(source.snapshotPath).href,
      });
    }
  }
  links.push({
    kind: "artifacts",
    label: "Run artifacts",
    url: pathToFileURL(store.runDirectory).href,
  });
  return links.filter(
    (link, index) =>
      links.findIndex((candidate) => candidate.url === link.url) === index,
  );
}

interface RoundExecutionRuntime {
  context: ArenaContext;
  before: RunState;
  options: {
    initialize?: boolean;
    pullRequestFixture?: PullRequestFixture;
  };
}

function initialContestant(config: ContestantConfig): ContestantResult {
  return {
    id: config.id,
    provider: config.provider,
    ...(config.model ? { model: config.model } : {}),
    role: config.role,
    status: "pending",
    initialHealth: 100,
    finalHealth: 100,
    healthLedger: {
      permanentRecoil: 0,
      activeDefects: [],
      canonicalDefects: [],
      eliminatedByRequiredCheck: false,
    },
    healthEvents: [],
    patchSize: 0,
    rounds: [],
    checks: [],
  };
}

function getContestant(
  state: RunState,
  contestantId: ContestantId,
): ContestantResult {
  const contestant = state.contestants[contestantId];
  if (!contestant)
    throw new Error(`Missing contestant state for ${contestantId}`);
  return contestant;
}

function priorCanonicalDefects(
  state: RunState,
  targets: readonly ContestantId[],
) {
  return targets.flatMap((target) =>
    (getContestant(state, target).healthLedger.canonicalDefects ?? [])
      .filter((defect) => defect.status !== "superseded")
      .map((defect) => ({
        canonicalDefectId: defect.rootDefectId,
        severity: defect.baseSeverity,
        multiplier: defect.currentMultiplier,
        effectiveDamage: defect.currentDamage,
        status:
          defect.status === "active"
            ? ("active" as const)
            : ("healed" as const),
        evidenceBasis:
          defect.evidenceHistory.at(-1)?.basis ?? ("legacy_unknown" as const),
      })),
  );
}

function getAdapter(
  adapters: Partial<Record<AgentId, AgentAdapter>>,
  agent: AgentId,
): AgentAdapter {
  const adapter = adapters[agent];
  if (!adapter) throw new Error(`No adapter configured for ${agent}`);
  return adapter;
}

function requiredCheck(
  id: string,
  command: Awaited<ReturnType<typeof runShellCommand>>,
): CheckResult {
  return {
    id,
    kind: "required",
    status:
      command.failureClass === "arena_infrastructure"
        ? "infrastructure_error"
        : command.exitCode === 0
          ? "passed"
          : "failed",
    command,
  };
}

function latestRequiredPass(contestant: ContestantResult): boolean {
  return (
    [...contestant.checks].reverse().find((check) => check.kind === "required")
      ?.status === "passed"
  );
}

function preReviewArtifactPaths(contestant: ContestantResult): string[] {
  return [
    contestant.implementation?.promptPath,
    contestant.implementation?.transcriptPath,
    contestant.implementation?.submissionPath,
    ...contestant.checks.flatMap((check) => [
      check.command?.stdoutPath,
      check.command?.stderrPath,
    ]),
  ].filter((path): path is string => Boolean(path));
}

function opponentOf(
  config: FightConfig,
  contestantId: ContestantId,
): ContestantId {
  const opponent = config.agents.find(
    (candidate) => candidate !== contestantId,
  );
  if (!opponent) throw new Error(`No opponent found for ${contestantId}`);
  return opponent;
}

async function repositoryFacts(repositoryRoot: string): Promise<string[]> {
  const facts: string[] = [];
  for (const [file, fact] of [
    ["package.json", "typescript"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["docker-compose.yml", "compose"],
    ["compose.yaml", "compose"],
  ] as const) {
    try {
      await access(path.join(repositoryRoot, file));
      facts.push(fact);
    } catch {
      // Fact absent.
    }
  }
  return [...new Set(facts)];
}

/**
 * Owns the operational mechanics for a battle, including initialization and
 * every attack/repair round. Arena deliberately delegates through this class
 * so it cannot acquire mechanism dependencies again.
 */
export class RoundEngine {
  private readonly now: () => Date;
  private readonly progress: (message: string) => void;
  private readonly generatedContestantAdapters: Partial<
    Record<ContestantId, AgentAdapter>
  > = {};
  private readonly browserNativeSuiteCache = new Map<
    string,
    BrowserNativeSuiteResult
  >();
  private readonly browserProbeInvocationCounts = new Map<string, number>();

  constructor(
    private readonly dependencies: ArenaDependencies,
    private readonly runtime?: RoundExecutionRuntime,
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.progress = dependencies.onProgress ?? (() => undefined);
  }

  private deadlineAfter(durationMs: number): string {
    return new Date(this.now().getTime() + durationMs).toISOString();
  }

  private extensionScope(
    context: ArenaContext,
    round: RoundId,
  ): string | undefined {
    if (typeof round !== "number" || round < 4) return undefined;
    const previous = context.state.adaptiveDecisions.find(
      (decision) => decision.round === round - 1,
    );
    return JSON.stringify(
      {
        triggeringDefectIds: previous?.extensionTriggerDefectIds ?? [],
        scoringBoundary:
          "Only the triggering defect or an adjacent invariant explicitly linked to its prior adjudication may change score. Other findings are recorded without damage or recoil.",
      },
      null,
      2,
    );
  }

  private lowSignalPivotInstruction(
    context: ArenaContext,
    round: RoundId,
  ): string | undefined {
    if (typeof round !== "number" || round <= 1) return undefined;
    const previous = context.state.adaptiveDecisions.find(
      (decision) => decision.round === round - 1,
    );
    if (
      !previous ||
      previous.action !== "continue" ||
      !("signal" in previous) ||
      !previous.signal.lowSignal
    )
      return undefined;
    return `Round ${String(round - 1)} completed with low signal. Use this round's distinct investigation theme as a deliberate pivot. Do not repeat a prior claim, cited invariant, input family, or probe shape unless new concrete evidence changes the hypothesis.`;
  }

  private profileWithOverrides(
    config: FightConfig,
    tier: EffortProfile["tier"],
  ): EffortProfile {
    return resolveEffortProfile(tier, {
      ...(config.phaseOverrides.implementation
        ? { implementationMs: config.limits.implementationMs }
        : {}),
      ...(config.phaseOverrides.review
        ? { reviewMs: config.limits.reviewMs }
        : {}),
      ...(config.phaseOverrides.attack
        ? { attackMs: config.limits.attackMs }
        : {}),
      ...(config.phaseOverrides.judge
        ? { judgeMs: config.limits.verifierMs }
        : {}),
      ...(config.phaseOverrides.repair
        ? { repairMs: config.limits.repairMs }
        : {}),
    });
  }

  private async resolveInitialEffort(options: {
    config: FightConfig;
    reconnaissance: ReconnaissanceSnapshot;
    store: ArtifactStore;
    worktrees: WorktreeManager;
    controller: AbortController;
    observer: ArenaObserver;
  }): Promise<FightConfig> {
    const { config } = options;
    if (config.effortMode !== "auto") {
      const profile = this.profileWithOverrides(config, config.effortMode);
      const plannedRounds = config.fixedRounds
        ? config.rounds
        : profile.plannedRounds;
      const maxRounds = config.fixedRounds ? config.rounds : profile.maxRounds;
      this.progress(
        `Effort: ${profile.tier} (${String(plannedRounds)} planned round${plannedRounds === 1 ? "" : "s"}, cap ${String(maxRounds)}, assessment skipped)`,
      );
      await options.observer.publish({
        type: "effort_resolved",
        tier: profile.tier,
        plannedRounds,
        maxRounds,
      });
      return FightConfigSchema.parse({
        ...config,
        resolvedEffortProfile: profile,
        rounds: plannedRounds,
        limits: {
          implementationMs: profile.implementationMs,
          reviewMs: profile.reviewMs,
          attackMs: profile.attackMs,
          verifierMs: profile.judgeMs,
          repairMs: profile.repairMs,
        },
      });
    }

    const attempts: TaskEffortAssessmentV1["attempts"] = [];
    let selected:
      | Awaited<ReturnType<NonNullable<AttackVerifier["assessEffort"]>>>
      | undefined;
    let fallbackReason: string | undefined;
    const assessor = this.dependencies.verifier.assessEffort?.bind(
      this.dependencies.verifier,
    );
    await options.store.writeText("initialization/.keep", "");
    if (assessor) {
      let worktree = await options.worktrees.create("effort-assessment");
      try {
        for (const attempt of [1, 2] as const) {
          const started = this.now();
          const promptPath = options.store.resolve(
            `initialization/effort-attempt-${String(attempt)}.prompt.md`,
          );
          const transcriptPrefix = options.store.resolve(
            `initialization/effort-attempt-${String(attempt)}`,
          );
          try {
            selected = await assessor({
              task: config.task,
              acceptanceCriteria: config.acceptanceCriteria,
              repositoryEvidence: options.reconnaissance.repositoryEvidence.map(
                (entry) =>
                  `${entry.path} (${String(entry.byteLength)} bytes)\n${entry.content.slice(0, 4_000)}`,
              ),
              worktree,
              promptPath,
              transcriptPrefix,
              timeoutMs: 2 * 60_000,
              signal: options.controller.signal,
              ...(attempt === 2 && fallbackReason
                ? { retryReason: fallbackReason }
                : {}),
              observer: options.observer,
            });
            const finished = this.now();
            attempts.push({
              attempt,
              startedAt: started.toISOString(),
              finishedAt: finished.toISOString(),
              durationMs: Math.max(0, finished.getTime() - started.getTime()),
              status: "succeeded",
              promptPath,
              transcriptPrefix,
              dimensions: selected.dimensions,
              confidence: selected.confidence,
              rationale: selected.rationale,
              tokenTelemetry: selected.tokenTelemetry,
            });
            break;
          } catch (error) {
            const finished = this.now();
            fallbackReason =
              error instanceof Error ? error.message : String(error);
            attempts.push({
              attempt,
              startedAt: started.toISOString(),
              finishedAt: finished.toISOString(),
              durationMs: Math.max(0, finished.getTime() - started.getTime()),
              status: "failed",
              promptPath,
              transcriptPrefix,
              error: fallbackReason,
              tokenTelemetry: unavailableTokenTelemetry(),
            });
            await options.store.replaceDerivedJson(
              "initialization/effort-attempts.json",
              attempts,
            );
            if (attempt === 1) {
              await options.worktrees.remove(worktree);
              worktree = await options.worktrees.create(
                "effort-assessment-retry",
              );
            }
          }
        }
      } finally {
        await options.worktrees.remove(worktree);
      }
    } else {
      fallbackReason = "Configured judge does not implement effort assessment";
    }

    const dimensions = selected?.dimensions ?? {
      changeSurface: 1,
      behavioralComplexity: 1,
      validationBurden: 1,
      operationalRisk: 1,
    };
    const confidence = selected?.confidence ?? 1;
    const scored = scoreEffort(dimensions, confidence);
    const assessment = TaskEffortAssessmentV1Schema.parse({
      version: 1,
      mode: "auto",
      dimensions,
      rawScore: scored.score,
      confidence,
      selectedTier: selected ? scored.tier : "medium",
      promotedForConfidence: selected ? scored.promotedForConfidence : false,
      riskFloorApplied: selected ? scored.riskFloorApplied : false,
      fallback: !selected,
      ...(!selected
        ? { fallbackReason: fallbackReason ?? "Assessment attempts exhausted" }
        : {}),
      attempts,
      assessedAt: this.now().toISOString(),
    });
    await options.store.writeImmutableJson(
      "initialization/effort-assessment.json",
      assessment,
    );
    const profile = this.profileWithOverrides(config, assessment.selectedTier);
    this.progress(
      `Effort: ${assessment.selectedTier} (score ${String(assessment.rawScore)}/8, ${String(profile.plannedRounds)} planned round${profile.plannedRounds === 1 ? "" : "s"}${assessment.fallback ? ", medium fallback" : ""})`,
    );
    await options.observer.publish({
      type: "effort_assessed",
      tier: assessment.selectedTier,
      score: assessment.rawScore,
      plannedRounds: profile.plannedRounds,
      maxRounds: profile.maxRounds,
      fallback: assessment.fallback,
    });
    return FightConfigSchema.parse({
      ...config,
      effortAssessment: assessment,
      resolvedEffortProfile: profile,
      rounds: profile.plannedRounds,
      limits: {
        implementationMs: profile.implementationMs,
        reviewMs: profile.reviewMs,
        attackMs: profile.attackMs,
        verifierMs: profile.judgeMs,
        repairMs: profile.repairMs,
      },
    });
  }

  /**
   * Execute and validate exactly one immutable round transaction. Runtime
   * services are constructor-injected and never enter the serialized input.
   */
  async run(snapshotValue: RoundSnapshot): Promise<RoundResult> {
    const snapshot = validateRoundSnapshot(snapshotValue);
    const execute = this.runtime
      ? (accepted: RoundSnapshot) =>
          this.executeAcceptedRound(accepted, this.runtime!)
      : this.dependencies.executeRound;
    if (!execute)
      throw new Error("RoundEngine.run requires an injected round executor");
    return validateRoundResult(await execute(snapshot), snapshot);
  }

  async fight(
    rawConfig: FightConfig,
    externalSignal?: AbortSignal,
    suppliedReconnaissance?: ReconnaissanceSnapshot,
    replacement?: ReplacementFightOptions,
  ): Promise<FightOutcome> {
    this.browserNativeSuiteCache.clear();
    this.browserProbeInvocationCounts.clear();
    for (const contestantId of Object.keys(
      this.generatedContestantAdapters,
    ) as ContestantId[])
      delete this.generatedContestantAdapters[contestantId];
    let config = FightConfigSchema.parse({
      ...rawConfig,
      repositoryRoot: path.resolve(rawConfig.repositoryRoot),
    });
    const reconnaissance = validateReconnaissance(
      replacement?.reconnaissance ??
        suppliedReconnaissance ??
        (await collectFightReconnaissance(config, {
          ...(this.dependencies.issueResolver
            ? { issueResolver: this.dependencies.issueResolver }
            : {}),
          ...(this.dependencies.pullRequestResolver
            ? { pullRequestResolver: this.dependencies.pullRequestResolver }
            : {}),
          now: this.now(),
        })),
      config,
    );
    let permissions = replacement
      ? PermissionPolicySchema.parse(replacement.permissions)
      : resolvePermissionPolicy(
          config,
          discoverCapabilities(config, reconnaissance),
        );
    if (this.dependencies.mcpPolicy)
      permissions = mergeMcpPermissionPolicy(
        permissions,
        this.dependencies.mcpPolicy,
      );
    await assertReconnaissanceRepositoryInputsCurrent(reconnaissance);
    const runId = createRunId(this.now());
    const store = new ArtifactStore(config.artifactRoot, runId, {
      durableV5: true,
    });
    await store.initialize();
    await store.writeImmutableJson("reconnaissance.json", reconnaissance);
    await store.writeJson("permissions.json", permissions);
    const repositoryRoot = await resolveRepositoryRoot(config.repositoryRoot);
    await assertCleanRepository(repositoryRoot);
    config = FightConfigSchema.parse({ ...config, repositoryRoot });
    let pullRequestFixture: PullRequestFixture | undefined;
    let frozenBasePullRequest: ResolvedPullRequest | undefined;
    let frozenModePullRequest: ResolvedPullRequest | undefined;
    let baseCommit: string;
    if (replacement) {
      baseCommit = replacement.runSpec.baseCommit;
      config = FightConfigSchema.parse({ ...config, baseCommit });
      if (replacement.pullRequestFixture) {
        const patchBytes = await readFile(
          replacement.pullRequestFixture.patchPath,
        );
        const patchPath = await store.writeImmutableBytes(
          "pull-request/frozen.patch",
          patchBytes,
        );
        pullRequestFixture = {
          ...replacement.pullRequestFixture,
          patchPath,
        };
      }
    } else if (config.mode === "catch_up" || config.mode === "siege") {
      const reference = config.pullRequestReferences[0];
      if (!reference)
        throw new Error(`${config.mode} mode requires a pull request`);
      frozenModePullRequest = reconnaissance.resolvedPullRequests[reference];
      if (!frozenModePullRequest)
        throw new Error(
          `Approved reconnaissance is missing pull request ${reference}`,
        );
      pullRequestFixture = await (
        this.dependencies.freezePullRequest ?? freezePullRequest
      )({
        reference,
        repositoryRoot,
        artifactDirectory: store.resolve("pull-request"),
        resolver: { resolve: () => Promise.resolve(frozenModePullRequest!) },
        now: this.now,
      });
      const incumbentProvider =
        config.incumbentProvider ?? pullRequestFixture.attribution.provider;
      if (config.mode === "catch_up" && !incumbentProvider) {
        throw new Error(
          "The frozen PR has unknown authorship; pass --incumbent <agent> to choose the provider that will attack and repair the incumbent patch",
        );
      }
      config = FightConfigSchema.parse({
        ...config,
        baseCommit: pullRequestFixture.base.commit,
        contestants: config.contestants.map((contestant) =>
          contestant.role === "incumbent" && incumbentProvider
            ? { ...contestant, provider: incumbentProvider }
            : contestant,
        ),
      });
      baseCommit = pullRequestFixture.base.commit;
    } else if (rawConfig.baseFromPullRequest) {
      frozenBasePullRequest =
        reconnaissance.resolvedPullRequests[rawConfig.baseFromPullRequest];
      if (!frozenBasePullRequest)
        throw new Error(
          `Approved reconnaissance is missing pull request ${rawConfig.baseFromPullRequest}`,
        );
      baseCommit = await fetchRemoteCommit(
        repositoryRoot,
        frozenBasePullRequest.headRepository,
        frozenBasePullRequest.headCommit,
      );
    } else {
      baseCommit = await resolveCommit(
        repositoryRoot,
        rawConfig.baseCommit ?? "HEAD",
      );
    }
    config = FightConfigSchema.parse({
      ...config,
      repositoryRoot,
      baseCommit,
    });
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), `agent-arena-${runId}-`),
    );
    const worktrees = new WorktreeManager(
      repositoryRoot,
      temporaryRoot,
      baseCommit,
    );
    await worktrees.initialize();
    const controller = new AbortController();
    const abort = (): void => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", abort, { once: true });
    const journal = new EventJournal(store.resolve("events.ndjson"), this.now);
    const observer = new ArenaEventBus(
      journal,
      this.dependencies.observer ? [this.dependencies.observer] : [],
      this.now,
    );
    const control =
      this.dependencies.battleControl ??
      new ArenaBattleControl(controller, this.now);

    let context: ArenaContext | undefined;
    try {
      if (replacement) {
        const profile = replacement.runSpec.effort.profile;
        config = FightConfigSchema.parse({
          ...config,
          effortMode: replacement.runSpec.effort.mode,
          fixedRounds: replacement.runSpec.effort.fixedRounds,
          rounds:
            replacement.runSpec.effort.exactRounds ?? profile.plannedRounds,
          ...(replacement.runSpec.effort.assessment
            ? { effortAssessment: replacement.runSpec.effort.assessment }
            : {}),
          resolvedEffortProfile: profile,
          limits: {
            implementationMs: profile.implementationMs,
            reviewMs: profile.reviewMs,
            attackMs: profile.attackMs,
            verifierMs: profile.judgeMs,
            repairMs: profile.repairMs,
          },
        });
      } else {
        config = await this.resolveInitialEffort({
          config,
          reconnaissance,
          store,
          worktrees,
          controller,
          observer,
        });
      }
      this.progress("Preflight: snapshotting run specification");
      const contractWarnings: string[] = [];
      const runSpec = replacement
        ? await this.copyReplacementRunSpec({
            source: replacement.runSpec,
            runId,
            store,
          })
        : await buildRunSpec({
            runId,
            baseCommit,
            config,
            permissions,
            ...(this.dependencies.mcpPolicy
              ? { mcpPolicyHash: this.dependencies.mcpPolicy.policyHash }
              : {}),
            repositoryRoot,
            sourceDirectory: store.resolve("sources"),
            ...(this.dependencies.issueResolver
              ? { issueResolver: this.dependencies.issueResolver }
              : {}),
            ...(frozenBasePullRequest || frozenModePullRequest
              ? {
                  pullRequestResolver: {
                    resolve: (reference: string) => {
                      if (
                        frozenBasePullRequest &&
                        reference === rawConfig.baseFromPullRequest
                      )
                        return Promise.resolve(frozenBasePullRequest);
                      if (
                        frozenModePullRequest &&
                        reference === String(config.pullRequestReferences[0])
                      )
                        return Promise.resolve(frozenModePullRequest);
                      return (
                        this.dependencies.pullRequestResolver ??
                        new GitHubPullRequestResolver()
                      ).resolve(reference, repositoryRoot);
                    },
                  },
                }
              : this.dependencies.pullRequestResolver
                ? { pullRequestResolver: this.dependencies.pullRequestResolver }
                : {}),
            now: this.now(),
            warnings: contractWarnings,
            reconnaissance,
          });
      await store.writeImmutableJson("run-spec.json", runSpec);
      const continuationCheckpointPath = replacement?.continuationCheckpoint
        ? await store.writeImmutableJson(
            "continuation-checkpoint.json",
            replacement.continuationCheckpoint,
          )
        : undefined;
      if (replacement?.continuationCheckpoint) {
        if (
          replacement.continuationCheckpoint.runId !== replacement.parentRunId
        )
          throw new Error("Provider continuation checkpoint parent mismatch");
        if (
          typeof replacement.continuationCheckpoint.roundId !== "number" ||
          replacement.continuationCheckpoint.roundId !==
            (replacement.startRound ?? 1) - 1
        )
          throw new Error(
            "Provider continuation checkpoint does not precede the resumed round",
          );
      }
      const mcpPolicyPath = this.dependencies.mcpPolicy
        ? await store.writeImmutableJson(
            "mcp-policy.json",
            this.dependencies.mcpPolicy,
          )
        : undefined;
      if (
        this.dependencies.mcpPolicy &&
        runSpec.mcpPolicyHash !== this.dependencies.mcpPolicy.policyHash
      )
        throw new Error("Frozen MCP policy does not match the RunSpec");
      const repositoryIdentity =
        await resolveGitHubRepositoryIdentity(repositoryRoot);
      const targetResolution = deriveDeliveryTarget(
        runSpec,
        repositoryIdentity,
      );
      if (targetResolution.ambiguous && targetResolution.reason)
        contractWarnings.push(targetResolution.reason);
      const startedAt = this.now().toISOString();
      let state: RunState = {
        schemaVersion: 9,
        runId,
        harnessVersion: "0.1.0",
        status: "running",
        startedAt,
        updatedAt: startedAt,
        stage: "preflight",
        runSpecHash: runSpec.contentHash,
        config,
        contestants: Object.fromEntries(
          config.contestants.map((contestant) => [
            contestant.id,
            initialContestant(contestant),
          ]),
        ),
        attacks: [],
        reviewInvocations: [],
        attackInvocations: [],
        promptManifests: [],
        submissionArtifacts: [],
        repairJudgments: [],
        failureRecords: [],
        integrity: "competitive",
        operatorInterventions: [],
        adaptiveDecisions: [],
        patchQualityFacts: {},
        ...(targetResolution.target
          ? { deliveryTarget: targetResolution.target }
          : {}),
        artifacts: {
          runDirectory: store.runDirectory,
          runSpec: store.resolve("run-spec.json"),
          permissions: store.resolve("permissions.json"),
          ...(mcpPolicyPath ? { mcpPolicy: mcpPolicyPath } : {}),
          ...(continuationCheckpointPath
            ? { continuationCheckpoint: continuationCheckpointPath }
            : {}),
          result: store.resolve("result.json"),
          battle: store.resolve("BATTLE.md"),
          battleHtml: store.resolve("BATTLE.html"),
          battleVisual: store.resolve("BATTLE.svg"),
          events: store.resolve("events.ndjson"),
          operatorInterventions: store.resolve(
            "operations/operator-interventions.json",
          ),
        },
        warnings: [
          "Worktrees isolate accidental changes; they are not a hostile-code security sandbox.",
          ...config.configWarnings,
          ...contractWarnings,
        ],
        ...(pullRequestFixture ? { pullRequestFixture } : {}),
      };
      if (replacement?.inheritedState) {
        const inherited = structuredClone(replacement.inheritedState);
        if (inherited.schemaVersion !== 9)
          throw new Error("Provider recovery requires durable V9 parent state");
        delete inherited.terminalOutcome;
        delete inherited.providerFailure;
        delete inherited.completedAt;
        delete inherited.currentRound;
        state = {
          ...inherited,
          runId,
          status: "running",
          startedAt,
          updatedAt: startedAt,
          stage: "preflight",
          runSpecHash: runSpec.contentHash,
          config,
          artifacts: state.artifacts,
          warnings: [
            ...inherited.warnings,
            `Provider recovery continued from sealed parent run ${replacement.parentRunId}; sealed rounds were retained and not replayed.`,
          ],
          ...(pullRequestFixture ? { pullRequestFixture } : {}),
        };
      }
      context = {
        config,
        store,
        worktrees,
        runSpec,
        permissions,
        state,
        controller,
        observer,
        journal,
        control,
        emittedEvents: new Set(),
        roundInvocations: [],
        priorEnvelopeHash: null,
        appliedEnvelopes: [],
        ...(replacement?.continuationCheckpoint
          ? {
              priorEnvelopeHash:
                replacement.continuationCheckpoint.envelopeHash,
              continuationCheckpoint: replacement.continuationCheckpoint,
            }
          : {}),
      };
      control.onQueue((note) => {
        void observer.publish({
          type: "steering_queued",
          interventionId: note.id,
          contestantId: note.contestantId,
        });
      });
      control.onCancel((reason) => {
        controller.abort(reason);
        void observer.publish({
          type: "cancellation_requested",
          reason: reason instanceof Error ? reason.message : String(reason),
        });
      });
      await observer.publish({
        type: "battle_started",
        runId,
        task: config.task,
        contestants: config.contestants.map((contestant) => ({
          id: contestant.id,
          provider: contestant.provider,
          ...(contestant.model ? { model: contestant.model } : {}),
        })),
        links: dashboardLinks(runSpec, store),
      });
      await this.persist(context);
      if (replacement) {
        const summary = await store.readSummary();
        if (!summary) throw new Error("Replacement result summary is missing");
        await store.replaceDerivedJson("result.json", {
          ...summary,
          provenance: {
            ...summary.provenance,
            parentRunId: replacement.parentRunId,
            transportRestartOrdinal: replacement.restartOrdinal,
            ...(replacement.continuationCheckpoint
              ? {
                  parentCheckpointHash:
                    replacement.continuationCheckpoint.checkpointHash,
                }
              : {}),
          },
        });
      }

      await this.preflight(context);
      if (
        replacement?.resumeAfterInitialization ||
        (replacement?.startRound ?? 1) > 1
      )
        await this.transition(context, "initial_validate");
      await writeDependencyManifest({
        store,
        runSpec,
        config,
        permissions,
        now: this.now(),
      });
      await writeBaseline({
        store,
        state: context.state,
        repositoryIdentity:
          repositoryIdentity?.repository ?? `local:${runSpec.baseCommit}`,
        now: this.now(),
      });
      await this.persist(context);
      let priorReplayHash: string | null =
        replacement?.continuationCheckpoint?.replayHash ?? null;
      for (const round of [1, 2, 3, 4, 5] as const) {
        if (replacement?.startRound && round < replacement.startRound) continue;
        if (
          context.runSpec.effort.fixedRounds &&
          round > (context.runSpec.effort.exactRounds ?? context.config.rounds)
        )
          break;
        if (this.shouldStop(context)) break;
        const beforeRound = structuredClone(context.state);
        const snapshot = await this.createRoundSnapshot(
          context,
          round,
          priorReplayHash,
        );
        const transaction = await this.executeLiveRound(
          context,
          snapshot,
          beforeRound,
          {
            initialize: round === 1 && !replacement?.resumeAfterInitialization,
            ...(pullRequestFixture ? { pullRequestFixture } : {}),
          },
        );
        const { result } = transaction;
        if (transaction.state.providerFailure)
          context.state.providerFailure = transaction.state.providerFailure;
        if (result.status !== "completed" || result.terminalOutcome) {
          return this.finishTerminalRound(context, result);
        }
        await this.applyRoundTransaction(context, result);
        priorReplayHash = result.replay.replayHash;
        if (result.replay.adaptiveDecision?.action === "stop") {
          if (!context.runSpec.effort.fixedRounds) {
            context.state.adaptiveCompletion = {
              kind: "adaptive_coverage",
              reason: result.replay.adaptiveDecision.reason,
              skippedBriefs: result.replay.adaptiveDecision.skippedBriefs,
            };
          }
          break;
        }
      }

      await this.finalValidation(context);
      await this.finalizeRecommendation(context);
      await writeFinalizationRecord({
        store,
        state: context.state,
        appliedEnvelopeHash:
          context.appliedEnvelopes.at(-1)?.envelopeHash ??
          (() => {
            throw new Error(
              "Cannot finalize without an applied round envelope",
            );
          })(),
        now: this.now(),
      });
      await this.transition(context, "report");
      const report = renderBattleReport(context.state);
      await store.writeText("BATTLE.md", report);
      await store.writeText("BATTLE.html", renderBattleHtml(context.state));
      await store.writeText("BATTLE.svg", renderBattleVisual(context.state));
      context.state.status = "complete";
      context.state.completedAt = this.now().toISOString();
      await this.transition(context, "complete");
      await this.expireSteering(context);
      await this.emitBattleCompleted(context, "complete");
      return {
        state: context.state,
        summary: renderConsoleSummary(
          context.state,
          this.dependencies.consoleOptions,
        ),
      };
    } catch (error) {
      if (context) {
        const cancelled = controller.signal.aborted;
        context.state.status = cancelled ? "cancelled" : "inconclusive";
        context.state.stage = cancelled ? "cancelled" : "inconclusive";
        context.state.updatedAt = this.now().toISOString();
        context.state.warnings.push(
          error instanceof Error ? error.message : String(error),
        );
        await context.store.writeState(context.state).catch(() => undefined);
        await context.store
          .writeText("BATTLE.md", renderBattleReport(context.state))
          .catch(() => undefined);
        await context.store
          .writeText("BATTLE.html", renderBattleHtml(context.state))
          .catch(() => undefined);
        await context.store
          .writeText("BATTLE.svg", renderBattleVisual(context.state))
          .catch(() => undefined);
        await this.emitNewStateEvents(context).catch(() => undefined);
        if (cancelled)
          await this.emit(context, { type: "cancellation_completed" }).catch(
            () => undefined,
          );
        await this.emitBattleCompleted(
          context,
          cancelled ? "cancelled" : "inconclusive",
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      externalSignal?.removeEventListener("abort", abort);
      if (!config.keepWorktrees)
        await worktrees.cleanup().catch(() => undefined);
      await journal.flush().catch(() => undefined);
    }
  }

  async resume(
    options: ResumeOptions,
    externalSignal?: AbortSignal,
  ): Promise<FightOutcome> {
    this.browserNativeSuiteCache.clear();
    this.browserProbeInvocationCounts.clear();
    const repositoryRoot = await resolveRepositoryRoot(
      options.repositoryRoot ?? process.cwd(),
    );
    await assertCleanRepository(repositoryRoot);
    const artifactRoot = path.resolve(
      options.artifactRoot ?? path.join(repositoryRoot, ".agent-arena", "runs"),
    );
    const store = new ArtifactStore(artifactRoot, options.runId, {
      durableV5: true,
    });
    await store.initialize();
    const summary = await store.readSummary();
    if (!summary || summary.schemaVersion !== 10)
      throw new Error(
        "Interrupted runs older than outcome schema v10 cannot resume; restart the fight. Completed legacy artifacts remain readable.",
      );
    await appendRecoveryEvent({
      store,
      type: "resume_started",
      now: this.now(),
    });
    let state = await store.readState();
    if (state.schemaVersion !== 9)
      throw new Error(
        "Interrupted pre-V9 runs are read-only legacy artifacts and cannot continue; restart the fight to create a V9 run",
      );
    const config = FightConfigSchema.parse({
      ...state.config,
      repositoryRoot,
      artifactRoot,
    });
    const runSpec = RunSpecSchema.parse(
      JSON.parse(await readFile(store.resolve("run-spec.json"), "utf8")),
    );
    const { contentHash: persistedRunSpecHash, ...runSpecBody } = runSpec;
    if (
      persistedRunSpecHash !== calculateRunSpecHash(runSpecBody) ||
      persistedRunSpecHash !== summary.runSpecHash
    )
      throw new Error("RunSpec hash mismatch");
    const browserBaseline = runSpec.browserValidation
      ? await readBrowserBaseline(store, {
          runId: runSpec.runId,
          baseCommit: runSpec.baseCommit,
          runSpecHash: runSpec.contentHash,
          browserValidation: runSpec.browserValidation,
        })
      : undefined;
    const permissions = PermissionPolicySchema.parse(
      JSON.parse(await readFile(store.resolve("permissions.json"), "utf8")),
    );
    const originalManifest = await readDependencyManifest(store);
    const currentManifest = await captureDependencyManifest({
      store,
      runSpec,
      config,
      permissions,
      ...(options.display ? { display: options.display } : {}),
      now: this.now(),
    });
    let drift = await createDriftReport({
      original: originalManifest,
      current: currentManifest,
      repositoryRoot,
      now: this.now(),
    });
    const driftPath = `drift/reports/${drift.reportHash}.json`;
    const existingDrift = await store.readOptionalJson(
      driftPath,
      DriftReportSchema,
    );
    if (existingDrift) drift = existingDrift;
    else await store.writeImmutableJson(driftPath, drift);
    if (drift.entries.length)
      await appendRecoveryEvent({
        store,
        type: "drift_detected",
        detail: { reportHash: drift.reportHash, entries: drift.entries },
        now: this.now(),
      });
    const hardStops = drift.entries.filter(
      (entry) => entry.severity === "hard_stop",
    );
    if (hardStops.length)
      throw new Error(
        `Resume stopped by hard drift: ${hardStops.map((entry) => entry.code).join(", ")}`,
      );
    const approvalRequired = drift.entries.filter(
      (entry) => entry.severity === "approval_required",
    );
    if (approvalRequired.length) {
      if (options.approveDriftHash !== drift.reportHash)
        throw new Error(
          `Resume requires manual drift approval bound to report ${drift.reportHash}`,
        );
      const approval = await approveDrift({
        store,
        report: drift,
        reportHash: options.approveDriftHash,
        approvedBy: options.approvedBy ?? "cli-user",
        now: this.now(),
      });
      const meaningful = approvalRequired.some((entry) =>
        ["provider_changed", "toolchain_changed"].includes(entry.code),
      );
      await store.replaceDerivedJson("result.json", {
        ...summary,
        provenance: {
          ...summary.provenance,
          assisted: summary.provenance.assisted || meaningful,
          driftApprovalHashes: [
            ...summary.provenance.driftApprovalHashes,
            approval.approvalHash,
          ],
        },
      });
      await appendRecoveryEvent({
        store,
        type: "drift_approved",
        detail: {
          reportHash: drift.reportHash,
          approvalHash: approval.approvalHash,
        },
        now: this.now(),
      });
    }

    const envelopes = await readEnvelopeChain(store);
    const continuationCheckpoint = await readContinuationCheckpoint(store);
    const continuationRound =
      typeof continuationCheckpoint?.roundId === "number"
        ? continuationCheckpoint.roundId
        : 0;
    let ledger = [...summary.appliedEnvelopes];
    if (summary.terminalOutcome) {
      state.terminalOutcome = TerminalOutcomeSchema.parse(
        summary.terminalOutcome,
      );
      state.status =
        state.terminalOutcome.kind === "forfeit"
          ? "complete"
          : state.terminalOutcome.kind;
      state.stage = state.status === "complete" ? "report" : state.status;
      state.completedAt ??= this.now().toISOString();
      state.updatedAt = this.now().toISOString();
      await store.writeState(state, ledger);
      return {
        state,
        summary:
          options.display === "json"
            ? JSON.stringify(await store.readSummary(), null, 2)
            : renderConsoleSummary(state, this.dependencies.consoleOptions),
      };
    }
    for (const envelope of envelopes.slice(ledger.length)) {
      if (envelope.result.terminalOutcome) {
        if (envelope.result.status === "completed") {
          const application = await applyEnvelopeExactlyOnce({
            store,
            state,
            envelope,
            ledger,
          });
          ledger = application.ledger;
        }
        state.terminalOutcome = TerminalOutcomeSchema.parse(
          envelope.result.terminalOutcome,
        );
        const terminalStatus =
          envelope.result.status === "completed"
            ? "complete"
            : envelope.result.status;
        state.status = terminalStatus;
        state.stage = terminalStatus === "complete" ? "report" : terminalStatus;
        state.completedAt = this.now().toISOString();
        state.updatedAt = state.completedAt;
        await store.writeState(state, ledger);
        await store.writeText("BATTLE.md", renderBattleReport(state));
        await store.writeText("BATTLE.html", renderBattleHtml(state));
        await store.writeText("BATTLE.svg", renderBattleVisual(state));
        return {
          state,
          summary: renderConsoleSummary(
            state,
            this.dependencies.consoleOptions,
          ),
        };
      }
      if (envelope.result.status !== "completed") {
        const completedAt = this.now().toISOString();
        state.status = envelope.result.status;
        state.stage = envelope.result.status;
        state.completedAt = completedAt;
        state.updatedAt = completedAt;
        state.warnings.push(
          ...("diagnostics" in envelope.result
            ? envelope.result.diagnostics.map((entry) => entry.message)
            : []),
        );
        await store.writeState(state, ledger);
        return {
          state,
          summary: renderConsoleSummary(
            state,
            this.dependencies.consoleOptions,
          ),
        };
      }
      const application = await applyEnvelopeExactlyOnce({
        store,
        state,
        envelope,
        ledger,
      });
      ledger = application.ledger;
      await writeCheckpoint({ store, state, envelope, now: this.now() });
      await store.writeState(state, ledger);
      await appendRecoveryEvent({
        store,
        type: "sealed_envelope_applied",
        detail: {
          roundId: envelope.roundId,
          envelopeHash: envelope.envelopeHash,
        },
        now: this.now(),
      });
    }

    if (
      state.status === "complete" &&
      ledger.length ===
        envelopes.filter((envelope) => envelope.result.status === "completed")
          .length
    ) {
      await appendRecoveryEvent({
        store,
        type: "resume_stopped",
        detail: { reason: "already_complete" },
        now: this.now(),
      });
      return {
        state,
        summary:
          options.display === "json"
            ? JSON.stringify(await store.readSummary(), null, 2)
            : renderConsoleSummary(state, this.dependencies.consoleOptions),
      };
    }

    const savedFinalization = await store.readOptionalJson(
      "finalization.json",
      FinalizationRecordSchema,
    );
    if (
      savedFinalization &&
      savedFinalization.appliedEnvelopeHash !== ledger.at(-1)?.envelopeHash
    )
      throw new Error("Saved finalization does not match envelope history");
    if (savedFinalization && !summary.finalization) {
      await store.writeState(state, ledger);
      state = await store.readState();
    }

    const lastAdaptiveDecision = envelopes
      .filter((envelope) => typeof envelope.roundId === "number")
      .at(-1)?.result.replay.adaptiveDecision;
    const roundLimit = runSpec.effort.fixedRounds
      ? (runSpec.effort.exactRounds ?? config.rounds)
      : runSpec.effort.profile.maxRounds;
    const nextRound = ([1, 2, 3, 4, 5] as const).find(
      (roundId) =>
        roundId <= roundLimit &&
        roundId > continuationRound &&
        !envelopes.some((envelope) => envelope.roundId === roundId),
    );
    if (nextRound && lastAdaptiveDecision?.action !== "stop") {
      try {
        await access(
          store.resolve(`rounds/${String(nextRound)}/snapshot.json`),
        );
        state.status = "inconclusive";
        state.stage = "inconclusive";
        state.completedAt = this.now().toISOString();
        state.updatedAt = state.completedAt;
        state.warnings.push(
          `Round ${String(nextRound)} was interrupted before sealing; fork from the latest checkpoint to run it again`,
        );
        await store.writeState(state, ledger);
        await appendRecoveryEvent({
          store,
          type: "unsealed_round_expired",
          detail: { roundId: nextRound },
          now: this.now(),
        });
        return {
          state,
          summary: renderConsoleSummary(
            state,
            this.dependencies.consoleOptions,
          ),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), `agent-arena-resume-${options.runId}-`),
    );
    const worktrees = new WorktreeManager(
      repositoryRoot,
      temporaryRoot,
      runSpec.baseCommit,
    );
    await worktrees.initialize();
    const controller = new AbortController();
    const abort = (): void => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", abort, { once: true });
    const journal = new EventJournal(store.resolve("events.ndjson"), this.now);
    const observer = new ArenaEventBus(
      journal,
      this.dependencies.observer ? [this.dependencies.observer] : [],
      this.now,
    );
    const control =
      this.dependencies.battleControl ??
      new ArenaBattleControl(
        controller,
        this.now,
        undefined,
        state.operatorInterventions,
      );
    const context: ArenaContext = {
      config,
      store,
      worktrees,
      runSpec,
      permissions,
      state,
      controller,
      observer,
      journal,
      control,
      emittedEvents: this.projectedStateEventKeys(state),
      roundInvocations: [],
      priorEnvelopeHash:
        envelopes.at(-1)?.envelopeHash ??
        continuationCheckpoint?.envelopeHash ??
        null,
      appliedEnvelopes: ledger,
      ...(continuationCheckpoint ? { continuationCheckpoint } : {}),
      ...(browserBaseline ? { browserBaseline } : {}),
    };
    control.onQueue((note) => {
      void observer.publish({
        type: "steering_queued",
        interventionId: note.id,
        contestantId: note.contestantId,
      });
    });
    control.onCancel((reason) => {
      controller.abort(reason);
      void observer.publish({
        type: "cancellation_requested",
        reason: reason instanceof Error ? reason.message : String(reason),
      });
    });
    try {
      let priorReplayHash =
        envelopes.at(-1)?.replayHash ??
        continuationCheckpoint?.replayHash ??
        null;
      for (const round of [1, 2, 3, 4, 5] as const) {
        if (round > roundLimit) break;
        if (round <= continuationRound) continue;
        if (envelopes.some((envelope) => envelope.roundId === round)) continue;
        if (lastAdaptiveDecision?.action === "stop") break;
        if (this.shouldStop(context)) break;
        const beforeRound = structuredClone(context.state);
        const snapshot = await this.createRoundSnapshot(
          context,
          round,
          priorReplayHash,
        );
        const transaction = await this.executeLiveRound(
          context,
          snapshot,
          beforeRound,
          {
            initialize: round === 1,
            ...(round === 1 && context.state.pullRequestFixture
              ? { pullRequestFixture: context.state.pullRequestFixture }
              : {}),
          },
        );
        if (
          transaction.result.status !== "completed" ||
          transaction.result.terminalOutcome
        ) {
          return this.finishTerminalRound(context, transaction.result);
        }
        await this.applyRoundTransaction(context, transaction.result);
        priorReplayHash = transaction.result.replay.replayHash;
        if (transaction.result.replay.adaptiveDecision?.action === "stop") {
          if (!context.runSpec.effort.fixedRounds) {
            context.state.adaptiveCompletion = {
              kind: "adaptive_coverage",
              reason: transaction.result.replay.adaptiveDecision.reason,
              skippedBriefs:
                transaction.result.replay.adaptiveDecision.skippedBriefs,
            };
          }
          break;
        }
      }
      if (!savedFinalization) {
        await this.finalValidation(context);
        await this.finalizeRecommendation(context);
        await writeFinalizationRecord({
          store,
          state: context.state,
          appliedEnvelopeHash:
            context.appliedEnvelopes.at(-1)?.envelopeHash ??
            (() => {
              throw new Error(
                "Cannot finalize without an applied round envelope",
              );
            })(),
          now: this.now(),
        });
      }
      if (context.state.stage !== "report")
        await this.transition(context, "report");
      await store.writeText("BATTLE.md", renderBattleReport(context.state));
      await store.writeText("BATTLE.html", renderBattleHtml(context.state));
      await store.writeText("BATTLE.svg", renderBattleVisual(context.state));
      context.state.status = "complete";
      context.state.completedAt = this.now().toISOString();
      await this.transition(context, "complete");
      await this.expireSteering(context);
      await this.emitBattleCompleted(context, "complete");
      await appendRecoveryEvent({
        store,
        type: "resume_continued",
        detail: { completed: true },
        now: this.now(),
      });
      return {
        state: context.state,
        summary:
          options.display === "json"
            ? JSON.stringify(await store.readSummary(), null, 2)
            : renderConsoleSummary(
                context.state,
                this.dependencies.consoleOptions,
              ),
      };
    } finally {
      externalSignal?.removeEventListener("abort", abort);
      if (!config.keepWorktrees)
        await worktrees.cleanup().catch(() => undefined);
      await journal.flush().catch(() => undefined);
    }
  }

  private async copyReplacementRunSpec(options: {
    source: RunSpec;
    runId: string;
    store: ArtifactStore;
  }): Promise<RunSpec> {
    const sources = await Promise.all(
      options.source.task.sources.map(async (source, index) => {
        const bytes = await readFile(source.snapshotPath);
        if (sha256(bytes) !== source.contentHash)
          throw new Error(`Frozen source ${source.id} failed its digest`);
        const snapshotPath = await options.store.writeImmutableBytes(
          `sources/${String(index + 1).padStart(2, "0")}-${path.basename(source.snapshotPath)}`,
          bytes,
        );
        return { ...source, snapshotPath };
      }),
    );
    const withoutHash: Omit<RunSpec, "contentHash"> = {
      version: options.source.version,
      runId: options.runId,
      task: { ...options.source.task, sources },
      baseCommit: options.source.baseCommit,
      topology: options.source.topology,
      commands: options.source.commands,
      budgets: options.source.budgets,
      effort: options.source.effort,
      permissions: options.source.permissions,
      ...(options.source.browserValidation
        ? { browserValidation: options.source.browserValidation }
        : {}),
      ...(options.source.mcpPolicyHash
        ? { mcpPolicyHash: options.source.mcpPolicyHash }
        : {}),
    };
    return RunSpecSchema.parse({
      ...withoutHash,
      contentHash: calculateRunSpecHash(withoutHash),
    });
  }

  private async executeLiveRound(
    coordinator: ArenaContext,
    snapshot: RoundSnapshot,
    before: RunState,
    options: {
      initialize?: boolean;
      pullRequestFixture?: PullRequestFixture;
    },
  ): Promise<{ result: RoundResult; state: RunState }> {
    const transactionContext: ArenaContext = {
      ...coordinator,
      state: structuredClone(coordinator.state),
      roundInvocations: [],
    };
    const executor = new RoundEngine(this.dependencies, {
      context: transactionContext,
      before,
      options,
    });
    return {
      result: await executor.run(snapshot),
      state: transactionContext.state,
    };
  }

  private async executeAcceptedRound(
    snapshot: RoundSnapshot,
    runtime: RoundExecutionRuntime,
  ): Promise<RoundResult> {
    const { context, before, options } = runtime;
    try {
      if (options.initialize) {
        if (options.pullRequestFixture) {
          await this.initializePullRequestContestant(
            context,
            options.pullRequestFixture,
          );
          const protectedContestant = context.config.contestants.find(
            (contestant) => contestant.startingPatch === "pull_request",
          );
          if (!protectedContestant)
            throw new Error(
              "PR battle topology is missing its frozen-patch contestant",
            );
          await this.initialValidation(context, [protectedContestant.id]);
          const protectedState = getContestant(
            context.state,
            protectedContestant.id,
          );
          if (!latestRequiredPass(protectedState)) {
            const disposition = this.preReviewDisposition(context);
            return this.persistRoundBoundary(
              context,
              snapshot,
              before,
              "inconclusive",
              new Error("Frozen incumbent patch failed initial validation"),
              disposition?.kind === "inconclusive" &&
                (disposition.reasonCode === "provider_transport_failure" ||
                  disposition.reasonCode === "harness_infrastructure_failure")
                ? disposition
                : this.preReviewDisposition(
                    context,
                    "frozen_incumbent_invalid",
                  ),
            );
          }
        }
        if (context.config.mode !== "siege") {
          await this.implement(context);
          await this.initialValidation(
            context,
            context.config.agents.filter(
              (agent) =>
                getContestant(context.state, agent).role !== "incumbent",
            ),
          );
        }
        const disposition = this.preReviewDisposition(context);
        if (disposition) {
          if (disposition.kind === "forfeit") {
            const winner = disposition.eligibleContestantIds[0];
            if (!winner)
              throw new Error("Forfeit result has no eligible contestant");
            getContestant(context.state, winner).status = "survived";
            for (const affected of disposition.affectedContestantIds) {
              const failed = getContestant(context.state, affected);
              failed.status = "failed";
              failed.healthLedger.eliminatedByRequiredCheck = true;
              failed.finalHealth = calculateHealth(failed.healthLedger);
            }
          }
          return this.persistRoundBoundary(
            context,
            snapshot,
            before,
            disposition.kind === "forfeit" ? "completed" : disposition.kind,
            new Error(disposition.reason),
            disposition,
          );
        }
        await context.store.writeJson(
          "provider-recovery-checkpoint.json",
          context.state,
        );
      }
      const roundStartedAt = this.now();
      await this.runRound(context, snapshot.roundId);
      if (typeof snapshot.roundId === "number") {
        const decision = await this.makeAdaptiveDecision(
          context,
          before,
          snapshot.roundId,
          roundStartedAt,
        );
        context.state.adaptiveDecisions.push(decision);
        await context.store.writeImmutableJson(
          `rounds/${String(snapshot.roundId)}/adaptive-decision.json`,
          decision,
        );
      }
      return this.persistRoundBoundary(context, snapshot, before);
    } catch (error) {
      if (this.isRoundInvariantError(error)) throw error;
      const implementationInfrastructure = Object.values(
        context.state.contestants,
      ).some(
        (contestant) =>
          contestant.implementation?.status === "infrastructure_error",
      );
      const status = context.controller.signal.aborted
        ? "cancelled"
        : implementationInfrastructure || this.isInfrastructureError(error)
          ? "inconclusive"
          : "failed";
      const terminalOutcome = options.initialize
        ? context.controller.signal.aborted || implementationInfrastructure
          ? this.preReviewDisposition(context)
          : this.isInfrastructureError(error)
            ? this.preReviewDisposition(
                context,
                "harness_infrastructure_failure",
              )
            : undefined
        : undefined;
      return this.persistRoundBoundary(
        context,
        snapshot,
        before,
        status,
        error,
        terminalOutcome,
      );
    }
  }

  /** Resolve production-patch eligibility before any attack, repair, or quality work. */
  private preReviewDisposition(
    context: ArenaContext,
    forcedReason?: TerminalOutcome["reasonCode"],
  ): TerminalOutcome | undefined {
    const production = context.config.agents.filter(
      (id) => getContestant(context.state, id).role !== "attacker",
    );
    const contestants = production.map((id) =>
      getContestant(context.state, id),
    );
    const artifactPaths = contestants.flatMap(preReviewArtifactPaths);
    const eligible = contestants
      .filter(
        (contestant) =>
          contestant.status !== "failed" &&
          contestant.patchSize > 0 &&
          Boolean(contestant.currentPatchPath) &&
          latestRequiredPass(contestant),
      )
      .map((contestant) => contestant.id);
    const contestantReason = (
      contestant: ContestantResult,
    ):
      | Exclude<
          NonNullable<
            Extract<
              TerminalOutcome,
              { version: 2 }
            >["contestants"][number]["reasonCode"]
          >,
          "test_only_role"
        >
      | undefined => {
      if (eligible.includes(contestant.id)) return undefined;
      if (
        contestant.implementation?.status === "cancelled" &&
        !context.controller.signal.aborted
      )
        return "peer_cancelled_due_to_transport";
      if (
        contestant.implementation?.status === "infrastructure_error" &&
        contestant.implementation.command?.failureClass ===
          "arena_infrastructure"
      )
        return "harness_infrastructure_failure";
      if (contestant.implementation?.command?.transportFailures?.length)
        return "provider_transport_failure";
      if (contestant.implementation?.status === "infrastructure_error")
        return "harness_infrastructure_failure";
      if (contestant.implementation?.status === "timed_out")
        return "implementation_timeout";
      if (contestant.implementation?.status === "failed")
        return "implementation_failed";
      if (
        contestant.checks.some(
          (check) => check.kind === "apply" && check.status === "failed",
        )
      )
        return "implementation_unapplicable_patch";
      if (!contestant.currentPatchPath || contestant.patchSize === 0)
        return "implementation_empty_patch";
      if (
        contestant.checks.some(
          (check) => check.kind === "required" && check.status === "failed",
        )
      )
        return "initial_validation_failed";
      return "implementation_failed";
    };
    const dispositions: Extract<
      TerminalOutcome,
      { version: 2 }
    >["contestants"] = context.config.agents.map((id) => {
      const contestant = getContestant(context.state, id);
      if (contestant.role === "attacker")
        return {
          contestantId: id,
          eligible: false,
          reasonCode: "test_only_role" as const,
          artifactPaths: preReviewArtifactPaths(contestant),
        };
      const reasonCode = contestantReason(contestant);
      return {
        contestantId: id,
        eligible: eligible.includes(id),
        ...(reasonCode ? { reasonCode } : {}),
        artifactPaths: preReviewArtifactPaths(contestant),
      };
    });
    const makeOutcome = (options: {
      kind: "forfeit" | "inconclusive" | "cancelled";
      reasonCode: Extract<TerminalOutcome, { version: 2 }>["reasonCode"];
      affectedContestantIds: ContestantId[];
      reason: string;
    }): TerminalOutcome => ({
      version: 2,
      phase: "pre_review",
      kind: options.kind,
      status:
        options.kind === "forfeit"
          ? "completed"
          : options.kind === "cancelled"
            ? "cancelled"
            : "inconclusive",
      reasonCode: options.reasonCode,
      affectedContestantIds: options.affectedContestantIds,
      eligibleContestantIds: eligible,
      artifactPaths,
      contestants: dispositions,
      reason: options.reason,
    });
    if (context.controller.signal.aborted) {
      return makeOutcome({
        kind: "cancelled",
        reasonCode: "external_cancellation",
        affectedContestantIds: production,
        reason:
          "The run was cancelled during implementation or initial validation.",
      });
    }
    const harnessAffected = contestants
      .filter(
        (contestant) =>
          contestantReason(contestant) === "harness_infrastructure_failure" ||
          contestant.checks.some(
            (check) => check.status === "infrastructure_error",
          ),
      )
      .map((contestant) => contestant.id);
    if (
      forcedReason === "harness_infrastructure_failure" ||
      harnessAffected.length
    ) {
      return makeOutcome({
        kind: "inconclusive",
        reasonCode: "harness_infrastructure_failure",
        affectedContestantIds: harnessAffected.length
          ? harnessAffected
          : production,
        reason:
          "Harness infrastructure failed before review eligibility could be sealed.",
      });
    }
    const providerInfrastructure = contestants.some(
      (contestant) =>
        contestantReason(contestant) === "provider_transport_failure",
    );
    if (providerInfrastructure) {
      return makeOutcome({
        kind: "inconclusive",
        reasonCode: "provider_transport_failure",
        affectedContestantIds: contestants
          .filter(
            (contestant) =>
              contestantReason(contestant) === "provider_transport_failure",
          )
          .map((contestant) => contestant.id),
        reason: "Provider transport failed during implementation.",
      });
    }
    if (forcedReason) {
      const reason =
        forcedReason === "frozen_incumbent_invalid"
          ? "The frozen incumbent patch is not eligible, so the challenger is not run."
          : "Harness infrastructure failed before review eligibility could be sealed.";
      return makeOutcome({
        kind: "inconclusive",
        reasonCode: forcedReason,
        affectedContestantIds: contestants
          .filter((contestant) => !eligible.includes(contestant.id))
          .map((contestant) => contestant.id),
        reason,
      });
    }
    if (eligible.length === production.length) return undefined;
    const failed = contestants.find(
      (contestant) => !eligible.includes(contestant.id),
    );
    const failedReason = failed ? contestantReason(failed) : undefined;
    const reasonCode =
      failedReason === "peer_cancelled_due_to_transport"
        ? "provider_transport_failure"
        : (failedReason ?? "implementation_failed");
    const isForfeit = eligible.length === 1 && context.config.mode === "duel";
    return makeOutcome({
      kind: isForfeit ? "forfeit" : "inconclusive",
      reasonCode,
      affectedContestantIds: contestants
        .filter((contestant) => !eligible.includes(contestant.id))
        .map((contestant) => contestant.id),
      reason: isForfeit
        ? "Exactly one production patch passed initial validation; it wins by forfeit before review."
        : "No eligible production patch is available for a pre-review comparison.",
    });
  }

  private async applyRoundTransaction(
    context: ArenaContext,
    result: Extract<RoundResult, { status: "completed" }>,
  ): Promise<void> {
    const envelope = await context.store.readOptionalJson(
      `rounds/${String(result.roundId)}/envelope.json`,
      RoundEnvelopeSchema,
    );
    if (!envelope) throw new Error("Completed round envelope is missing");
    const application = await applyEnvelopeExactlyOnce({
      store: context.store,
      state: context.state,
      envelope,
      ledger: context.appliedEnvelopes,
      ...(context.continuationCheckpoint
        ? {
            initialPriorEnvelopeHash:
              context.continuationCheckpoint.envelopeHash,
          }
        : {}),
    });
    context.appliedEnvelopes = application.ledger;
    context.priorEnvelopeHash = envelope.envelopeHash;
    await writeCheckpoint({
      store: context.store,
      state: context.state,
      envelope,
      now: this.now(),
    });
    await this.persist(context);
  }

  private async makeAdaptiveDecision(
    context: ArenaContext,
    before: RunState,
    round: 1 | 2 | 3 | 4 | 5,
    startedAt: Date,
  ): Promise<AdaptiveRoundDecision> {
    const profile = context.runSpec.effort.profile;
    const finishedAt = this.now();
    const wallTimeMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
    const invocations: AgentInvocation[] = [];
    for (const contestantId of ["a", "b"] as const) {
      const previous = before.contestants[contestantId];
      const current = context.state.contestants[contestantId];
      if (!current) continue;
      if (!previous?.implementation && current.implementation)
        invocations.push(current.implementation);
      const summary = current.rounds.find((entry) => entry.round === round);
      if (summary?.repairAttempts?.length)
        invocations.push(...summary.repairAttempts);
      else if (summary?.repair) invocations.push(summary.repair);
    }
    invocations.push(
      ...context.state.reviewInvocations
        .slice(before.reviewInvocations.length)
        .map((entry) => entry.invocation),
      ...context.state.attackInvocations
        .slice(before.attackInvocations.length)
        .map((entry) => entry.invocation),
    );
    const providerCalls = invocations.length + context.roundInvocations.length;
    const invocationTelemetry: TokenTelemetry[] = invocations.map(
      (invocation) => {
        const usage = invocation.command?.providerDiagnostics?.tokenUsage;
        if (
          !usage ||
          Object.values(usage).every((value) => value === undefined)
        )
          return unavailableTokenTelemetry();
        const complete = [
          usage.uncachedInputTokens,
          usage.cacheReadTokens,
          usage.cacheWriteTokens,
          usage.outputTokens,
        ].every((value) => value !== undefined);
        return {
          state: complete ? "complete" : "partial",
          ...usage,
          totalTokens:
            (usage.uncachedInputTokens ?? 0) +
            (usage.cacheReadTokens ?? 0) +
            (usage.cacheWriteTokens ?? 0) +
            (usage.outputTokens ?? 0),
        };
      },
    );
    const allTelemetry = [
      ...invocationTelemetry,
      ...context.roundInvocations.map(
        (invocation) =>
          invocation.tokenTelemetry ?? unavailableTokenTelemetry(),
      ),
    ];
    const availableTelemetry = allTelemetry.filter(
      (telemetry) => telemetry.state !== "unavailable",
    );
    const tokenFields = {
      uncachedInputTokens: availableTelemetry.reduce(
        (sum, telemetry) => sum + (telemetry.uncachedInputTokens ?? 0),
        0,
      ),
      cacheReadTokens: availableTelemetry.reduce(
        (sum, telemetry) => sum + (telemetry.cacheReadTokens ?? 0),
        0,
      ),
      cacheWriteTokens: availableTelemetry.reduce(
        (sum, telemetry) => sum + (telemetry.cacheWriteTokens ?? 0),
        0,
      ),
      outputTokens: availableTelemetry.reduce(
        (sum, telemetry) => sum + (telemetry.outputTokens ?? 0),
        0,
      ),
    };
    const totalTokens = Object.values(tokenFields).reduce(
      (sum, value) => sum + value,
      0,
    );
    const completeTelemetry =
      providerCalls > 0 &&
      allTelemetry.length === providerCalls &&
      allTelemetry.every((telemetry) => telemetry.state === "complete");
    const tokenTelemetry = {
      state:
        availableTelemetry.length === 0
          ? ("unavailable" as const)
          : completeTelemetry
            ? ("complete" as const)
            : ("partial" as const),
      ...(availableTelemetry.length ? { ...tokenFields, totalTokens } : {}),
    };
    const roundAttacks = context.state.attacks.filter(
      (attack) => attack.round === round,
    );
    const newHealthEvents = (["a", "b"] as const).flatMap((id) =>
      (context.state.contestants[id]?.healthEvents ?? []).slice(
        before.contestants[id]?.healthEvents.length ?? 0,
      ),
    );
    const unresolved = roundAttacks.some((attack) =>
      [
        "submitted",
        "provisional_infrastructure",
        "execution_inconclusive",
        "judge_unable",
      ].includes(attack.status),
    );
    const zeroActiveDamage = Object.values(context.state.contestants).every(
      (contestant) => !contestant?.healthLedger.activeDefects.length,
    );
    const requiredLanes =
      context.config.mode === "siege"
        ? [["a", "b"] as const]
        : [["a", "b"] as const, ["b", "a"] as const];
    const intactExecutedLaneCoverage = requiredLanes.every(
      ([attacker, target]) => {
        const review = context.state.reviewInvocations
          .filter(
            (entry) =>
              entry.round === round &&
              entry.reviewer === attacker &&
              entry.target === target,
          )
          .at(-1);
        const attackInvocation = context.state.attackInvocations
          .filter(
            (entry) =>
              entry.round === round &&
              entry.attacker === attacker &&
              entry.target === target,
          )
          .at(-1);
        return Boolean(
          review?.submissionStatus === "submitted" &&
          attackInvocation?.submissionStatus === "submitted" &&
          ["valid", "valid_empty", "partial"].includes(
            attackInvocation.parseOutcome ?? "",
          ),
        );
      },
    );
    const allLanesExplicitlyEmpty = requiredLanes.every(
      ([attacker, target]) =>
        context.state.attackInvocations
          .filter(
            (entry) =>
              entry.round === round &&
              entry.attacker === attacker &&
              entry.target === target,
          )
          .at(-1)?.parseOutcome === "valid_empty",
    );
    const patchStatistics = async (patchPath: string | undefined) => {
      if (!patchPath) return { lines: 0, files: new Set<string>() };
      const patch = await readFile(patchPath, "utf8");
      const files = new Set<string>();
      let currentProduction = false;
      let lines = 0;
      for (const line of patch.split("\n")) {
        if (line.startsWith("+++ b/")) {
          const file = line.slice(6);
          currentProduction =
            !/(^|\/)(?:test|tests|__tests__|fixtures)(\/|$)|\.(?:test|spec)\.[^.]+$/iu.test(
              file,
            );
          if (currentProduction) files.add(file);
        } else if (
          currentProduction &&
          /^[+-]/u.test(line) &&
          !/^(?:\+\+\+|---)/u.test(line)
        )
          lines += 1;
      }
      return { lines, files };
    };
    const stableByContestant = await Promise.all(
      (["a", "b"] as const).map(async (id) => {
        const current = context.state.contestants[id];
        const previous = before.contestants[id];
        if (!current || current.role === "attacker") return true;
        const [nowStats, priorStats] = await Promise.all([
          patchStatistics(current.currentPatchPath),
          patchStatistics(previous?.currentPatchPath),
        ]);
        const churn = previous?.currentPatchPath
          ? Math.abs(nowStats.lines - priorStats.lines)
          : 0;
        const addedFiles = [...nowStats.files].filter(
          (file) => !priorStats.files.has(file),
        ).length;
        const currentChecks = current.checks.filter((check) =>
          ["required", "focused", "browser"].includes(check.kind),
        );
        return (
          nowStats.lines <= 120 &&
          nowStats.files.size <= 6 &&
          churn <= 12 &&
          addedFiles <= 1 &&
          currentChecks.length > 0 &&
          currentChecks.every((check) => check.status === "passed")
        );
      }),
    );
    const knownCheckOutcomes = (["a", "b"] as const).map((id) =>
      (context.state.contestants[id]?.checks ?? [])
        .filter((check) =>
          ["required", "focused", "browser"].includes(check.kind),
        )
        .map((check) => `${check.id}:${check.status}`)
        .sort()
        .join("\n"),
    );
    const patchesSmallAndStable =
      stableByContestant.every(Boolean) &&
      knownCheckOutcomes[0] === knownCheckOutcomes[1];
    const noNewCanonicalDefectOrScoreCorrection =
      !roundAttacks.some(
        (attack) => attack.status === "landed" && Boolean(attack.damage),
      ) &&
      !newHealthEvents.some((event) =>
        ["target_damage", "damage_upgrade", "score_correction"].includes(
          event.type,
        ),
      );
    const acceptedDefectsHealedWithRegressionPasses =
      zeroActiveDamage &&
      Object.values(context.state.contestants).every((contestant) =>
        (contestant?.checks ?? [])
          .filter((check) => ["required", "focused"].includes(check.kind))
          .every((check) => check.status === "passed"),
      );
    const competitiveLandingCount = competitiveLandings(
      context.state,
      round,
    ).length;
    const sharedDefectCount = sharedDefects(context.state, round).length;
    const explicitEmptyLanes = explicitEmptyLaneCount(context.state, round);
    const lowSignal =
      intactExecutedLaneCoverage &&
      !unresolved &&
      competitiveLandingCount === 0 &&
      zeroActiveDamage;
    const priorDecision = context.state.adaptiveDecisions
      .filter((decision) => decision.round < round)
      .sort((left, right) => right.round - left.round)[0];
    const consecutiveLowSignalCount = nextLowSignalCount(
      lowSignal,
      priorDecision,
    );
    const convergence = {
      intactExecutedLaneCoverage,
      noUnresolvedAdjudication: !unresolved,
      zeroActiveDamage,
      acceptedDefectsHealedWithRegressionPasses,
      noNewCanonicalDefectOrScoreCorrection,
      allLanesExplicitlyEmpty,
      patchesSmallAndStable,
      passed:
        intactExecutedLaneCoverage &&
        !unresolved &&
        zeroActiveDamage &&
        acceptedDefectsHealedWithRegressionPasses &&
        noNewCanonicalDefectOrScoreCorrection &&
        (allLanesExplicitlyEmpty || patchesSmallAndStable),
    };
    const extensionTriggerDefectIds = [
      ...new Set([
        ...roundAttacks.flatMap((attack) =>
          attack.status === "landed" && attack.damage && attack.rootDefectId
            ? [attack.rootDefectId]
            : [],
        ),
        ...Object.values(context.state.contestants).flatMap((contestant) =>
          (contestant?.healthLedger.canonicalDefects ?? []).flatMap((defect) =>
            defect.status === "active" &&
            defect.repairAttemptsUsed < (defect.repairAllowance ?? 2)
              ? [defect.rootDefectId]
              : [],
          ),
        ),
      ]),
    ];
    const extensionQualified = extensionTriggerDefectIds.length > 0;
    const consumption = {
      wallTimeMs,
      providerCalls,
      tokenTelemetry,
      wallTimePressure: wallTimeMs >= profile.roundEnvelopeMs,
      invocationPressure: providerCalls >= profile.maxProviderCallsPerRound,
      tokenPressure:
        completeTelemetry && totalTokens >= profile.maxTokensPerRound,
      overrunMs: Math.max(0, wallTimeMs - profile.roundEnvelopeMs),
    };
    const pressureReason = consumption.wallTimePressure
      ? ("round_time_budget_exhausted" as const)
      : consumption.invocationPressure
        ? ("round_invocation_budget_exhausted" as const)
        : consumption.tokenPressure
          ? ("round_token_budget_exhausted" as const)
          : undefined;
    const { action, reason } = decideAdaptiveRound({
      round,
      profile,
      convergencePassed: convergence.passed,
      extensionQualified,
      lowSignal,
      consecutiveLowSignalCount,
      terminalCondition: this.shouldStop(context),
      ...(pressureReason ? { pressureReason } : {}),
      ...(context.runSpec.effort.fixedRounds
        ? {
            fixedRounds:
              context.runSpec.effort.exactRounds ?? context.config.rounds,
          }
        : {}),
    });
    const briefs = [
      "contract and local correctness",
      "systematic exploration",
      "integration, resilience, and security",
      "extension generalization",
      "extension durability",
    ];
    const skippedBriefs =
      action === "stop" ? briefs.slice(round, profile.maxRounds) : [];
    const decision: AdaptiveRoundDecision = {
      version: 2,
      round,
      consumption,
      convergence,
      extensionQualified,
      extensionTriggerDefectIds,
      action,
      reason,
      signal: {
        competitiveLandings: competitiveLandingCount,
        sharedDefects: sharedDefectCount,
        explicitEmptyLanes,
        lowSignal,
        consecutiveLowSignalCount,
      },
      skippedBriefs,
      decidedAt: finishedAt.toISOString(),
    };
    if (
      consumption.wallTimePressure ||
      consumption.invocationPressure ||
      consumption.tokenPressure
    )
      await context.observer.publish({
        type: "budget_pressure",
        round,
        wallTime: consumption.wallTimePressure,
        invocations: consumption.invocationPressure,
        tokens: consumption.tokenPressure,
      });
    await context.observer.publish({
      type: "convergence_evaluated",
      round,
      passed: convergence.passed,
    });
    await context.observer.publish({
      type: extensionQualified ? "extension_qualified" : "extension_declined",
      round,
      defectIds: extensionTriggerDefectIds,
    });
    if (action === "stop")
      await context.observer.publish({
        type: "adaptive_stop",
        round,
        reason,
        skippedBriefs,
      });
    return decision;
  }

  private async createRoundSnapshot(
    context: ArenaContext,
    roundId: RoundId,
    priorReplayHash: string | null,
  ): Promise<RoundSnapshot> {
    const contestants = await Promise.all(
      (["a", "b"] as const).map(async (contestantId) => {
        const contestant = getContestant(context.state, contestantId);
        const topology = context.runSpec.topology.contestants.find(
          (entry) => entry.id === contestantId,
        );
        const ownsProductionPatch = topology?.role !== "attacker";
        const patch =
          ownsProductionPatch && contestant.currentPatchPath
            ? {
                path: contestant.currentPatchPath,
                sha256: sha256(await readFile(contestant.currentPatchPath)),
              }
            : null;
        return {
          contestantId,
          patch,
          health: contestant.finalHealth,
          permanentRecoil: contestant.healthLedger.permanentRecoil,
          activeDefects: contestant.healthLedger.activeDefects.map((defect) => {
            const attack = context.state.attacks.find(
              (entry) => entry.id === defect.attackId,
            );
            return {
              defectId: defect.rootDefectId,
              attackId: defect.attackId,
              severity: defect.severity ?? attack?.severity ?? ("low" as const),
              damage: defect.damage,
              ...(defect.multiplier ? { multiplier: defect.multiplier } : {}),
            };
          }),
          canonicalDefects: (
            contestant.healthLedger.canonicalDefects ?? []
          ).map((defect) => ({
            defectId: defect.rootDefectId,
            firstAttackId: defect.firstAttackId,
            ...(defect.firstAdjudicationId
              ? { firstAdjudicationId: defect.firstAdjudicationId }
              : {}),
            baseSeverity: defect.baseSeverity,
            currentMultiplier: defect.currentMultiplier,
            currentDamage: defect.currentDamage,
            evidenceHistory: structuredClone(defect.evidenceHistory),
            status: defect.status,
            ...(defect.supersededByAdjudicationId
              ? {
                  supersededByAdjudicationId: defect.supersededByAdjudicationId,
                }
              : {}),
            repairAllowance: defect.repairAllowance,
            repairAttemptsUsed: defect.repairAttemptsUsed,
            repairAttemptIds: structuredClone(defect.repairAttemptIds),
            regressionResets: defect.regressionResets,
          })),
          status:
            contestant.status === "eliminated" || contestant.status === "failed"
              ? ("eliminated" as const)
              : roundId === 1 && !patch && ownsProductionPatch
                ? ("pending" as const)
                : contestant.finalHealth === 0
                  ? ("downed" as const)
                  : ("active" as const),
        };
      }),
    );
    const knownDefects = (["a", "b"] as const).flatMap((target) => {
      const contestant = getContestant(context.state, target);
      return (contestant.healthLedger.canonicalDefects ?? []).map((defect) => {
        const evidence = defect.evidenceHistory.at(-1);
        const firstAttack = context.state.attacks.find(
          (attack) => attack.id === defect.firstAttackId,
        );
        return {
          defectId: defect.rootDefectId,
          attackId: defect.firstAttackId,
          target,
          severity: defect.baseSeverity,
          damage: defect.currentDamage,
          multiplier: defect.currentMultiplier,
          evidenceBasis: evidence?.basis ?? ("legacy_unknown" as const),
          status: defect.status,
          ...(defect.supersededByAdjudicationId
            ? {
                supersededByAdjudicationId: defect.supersededByAdjudicationId,
              }
            : {}),
          visibleReproducerArtifactIds: firstAttack
            ? [stableId("artifact", firstAttack.patchPath)]
            : [],
        };
      });
    });
    const draft = {
      version: 5 as const,
      runId: context.state.runId,
      roundId,
      snapshotHash: "0".repeat(64),
      runSpec: context.runSpec,
      contestants: [contestants[0]!, contestants[1]!] as const,
      knownDefects,
      failureRecords: structuredClone(context.state.failureRecords),
      priorReplayHash,
    };
    draft.snapshotHash = calculateSnapshotHash(draft);
    const snapshot = validateRoundSnapshot(draft);
    await context.store.writeImmutableJson(
      `rounds/${String(roundId)}/snapshot.json`,
      snapshot,
    );
    return snapshot;
  }

  private async collectRoundArtifacts(
    context: ArenaContext,
    value: unknown,
  ): Promise<ArtifactReference[]> {
    const candidates = new Map<string, string>();
    const visit = (entry: unknown, key = ""): void => {
      if (typeof entry === "string" && path.isAbsolute(entry)) {
        const relative = path.relative(context.store.runDirectory, entry);
        if (!relative.startsWith("..") && !path.isAbsolute(relative))
          candidates.set(entry, key);
        return;
      }
      if (Array.isArray(entry)) {
        entry.forEach((child) => visit(child, key));
        return;
      }
      if (entry && typeof entry === "object") {
        for (const [childKey, child] of Object.entries(entry))
          visit(child, childKey);
      }
    };
    visit(value);
    const artifacts: ArtifactReference[] = [];
    for (const [artifactPath, key] of candidates) {
      try {
        const bytes = await readFile(artifactPath);
        const relative = path.relative(
          context.store.runDirectory,
          artifactPath,
        );
        const kind = relative.startsWith("prompts/")
          ? "prompt"
          : relative.startsWith("submissions/")
            ? "submission"
            : key.toLowerCase().includes("transcript")
              ? "transcript"
              : relative.startsWith("patches/")
                ? "patch"
                : relative.startsWith("attacks/")
                  ? "attack"
                  : relative.startsWith("cases/")
                    ? "case"
                    : relative.startsWith("logs/")
                      ? "check_log"
                      : "diagnostic";
        artifacts.push({
          id: stableId("artifact", relative),
          kind,
          path: artifactPath,
          sha256: sha256(bytes),
        });
      } catch {
        // Optional or not-yet-materialized path; the delta still preserves it.
      }
    }
    return artifacts;
  }

  private async persistProviderSubmission(
    context: ArenaContext,
    options: {
      worktree: string;
      sourceName: string;
      round: RoundId;
      phase: string;
      actor: string;
      kind: SubmissionKind;
    },
  ): Promise<{
    parsed: ParsedSubmission<unknown>;
    rawPath: string;
    parsedPath: string;
  }> {
    const sourcePath = path.join(options.worktree, options.sourceName);
    const raw = await readFile(sourcePath);
    const prefix = `submissions/${String(options.round)}/${options.phase}/${options.actor}`;
    const rawPath = await context.store.writeImmutableBytes(
      `${prefix}/raw.txt`,
      raw,
    );
    const parsed = parseFaultIsolatedSubmission(
      options.kind as "review",
      raw.toString("utf8"),
    ) as ParsedSubmission<unknown>;
    parsed.rawSha256 = sha256(raw);
    const parsedPath = await context.store.writeImmutableJson(
      `${prefix}/parsed.json`,
      parsed,
    );
    context.state.submissionArtifacts.push({
      round: options.round,
      phase: options.phase,
      actor: options.actor,
      kind: options.kind,
      outcome: parsed.outcome,
      rawSha256: sha256(raw),
      rawArtifactPath: rawPath,
      parsedArtifactPath: parsedPath,
    });
    return { parsed, rawPath, parsedPath };
  }

  private submissionWarning(
    label: string,
    parsed: ParsedSubmission<unknown>,
    rawPath: string,
    parsedPath: string,
  ): string {
    const detail = parsed.rejections
      .slice(0, 4)
      .map(
        (entry) =>
          `${entry.path}: ${entry.code} (received ${entry.received}${entry.allowedValues ? `; allowed ${entry.allowedValues.join(", ")}` : ""})`,
      )
      .join("; ");
    return `${label}: ${detail || parsed.outcome}. Raw: ${rawPath}. Parsed: ${parsedPath}`;
  }

  private async persistFailureRecord(
    context: ArenaContext,
    record: FailureRecord,
  ): Promise<void> {
    const existing = context.state.failureRecords.findIndex(
      (candidate) => candidate.failureId === record.failureId,
    );
    if (existing >= 0) context.state.failureRecords[existing] = record;
    else context.state.failureRecords.push(record);
    await context.store.writeJson(`failures/${record.failureId}.json`, record);
    await this.persist(context);
  }

  private prepareWorktree(
    context: ArenaContext,
    options: {
      name: string;
      subject: string;
      patches?: readonly string[];
      contestantId?: ContestantId;
      attackId?: string;
      laneId?: string;
      runLevel?: boolean;
    },
  ): Promise<string> {
    return prepareWorktreeWithRetry({
      worktrees: context.worktrees,
      name: options.name,
      subject: options.subject,
      patches: options.patches ?? [],
      persistFailureRecord: (record) =>
        this.persistFailureRecord(context, record),
      terminalDisposition: options.runLevel
        ? "run_level_coverage_lost"
        : "coverage_lost",
      now: this.now,
      ...(options.contestantId ? { contestantId: options.contestantId } : {}),
      ...(options.attackId ? { attackId: options.attackId } : {}),
      ...(options.laneId ? { laneId: options.laneId } : {}),
    });
  }

  private async recordFailureAttempt(
    context: ArenaContext,
    options: {
      stage: FailureStage;
      subject: string;
      category: FailureCategory;
      attempt: 1 | 2;
      startedAt: string;
      finishedAt: string;
      status: "failed" | "succeeded";
      diagnosticArtifactRefs: string[];
      reusedArtifactRefs?: string[];
      contestantId?: ContestantId;
      laneId?: string;
      attackId?: string;
      existing?: FailureRecord;
      terminalDisposition?:
        | "recovered"
        | "coverage_lost"
        | "run_level_coverage_lost"
        | "judge_unable";
    },
  ): Promise<FailureRecord> {
    const causalDigest =
      options.existing?.causalDigest ??
      calculateCanonicalHash({
        stage: options.stage,
        subject: options.subject,
        category: options.category,
      });
    const failureId = stableId(
      "failure",
      options.stage,
      options.subject,
      causalDigest,
    );
    const diagnosticArtifactRefs = [
      ...new Set([
        ...(options.existing?.diagnosticArtifactRefs ?? []),
        ...options.diagnosticArtifactRefs,
      ]),
    ];
    const record = FailureRecordSchema.parse({
      version: 1,
      failureId,
      stage: options.stage,
      subject: options.subject,
      category: options.category,
      causalDigest,
      attempts: [
        ...(options.existing?.attempts ?? []),
        {
          attempt: options.attempt,
          startedAt: options.startedAt,
          finishedAt: options.finishedAt,
          status: options.status,
          diagnosticArtifactRefs: options.diagnosticArtifactRefs,
        },
      ],
      reusedArtifactRefs:
        options.existing?.reusedArtifactRefs ??
        options.reusedArtifactRefs ??
        [],
      diagnosticArtifactRefs,
      ...(options.contestantId ? { contestantId: options.contestantId } : {}),
      ...(options.laneId ? { laneId: options.laneId } : {}),
      ...(options.attackId ? { attackId: options.attackId } : {}),
      ...(options.terminalDisposition
        ? { terminalDisposition: options.terminalDisposition }
        : {}),
    });
    await this.persistFailureRecord(context, record);
    return record;
  }

  private async recordSubmissionAttempt(
    context: ArenaContext,
    options: {
      round: RoundId;
      actor: ContestantId;
      target: ContestantId;
      phase: "review" | "attack";
      attempt: 1 | 2;
      startedAt: string;
      finishedAt: string;
      status: "failed" | "succeeded";
      diagnosticArtifactRefs: string[];
      cause: string;
      existing?: FailureRecord;
      terminalDisposition?: "recovered" | "coverage_lost";
    },
  ): Promise<FailureRecord> {
    const subject = `${options.phase}-submission:${String(options.round)}:${options.actor}->${options.target}`;
    const causalDigest =
      options.existing?.causalDigest ??
      calculateCanonicalHash({ subject, cause: options.cause });
    const failureId = stableId("failure", subject, causalDigest);
    const attempts = [
      ...(options.existing?.attempts ?? []),
      {
        attempt: options.attempt,
        startedAt: options.startedAt,
        finishedAt: options.finishedAt,
        status: options.status,
        diagnosticArtifactRefs: options.diagnosticArtifactRefs,
      },
    ];
    const diagnosticArtifactRefs = [
      ...new Set([
        ...(options.existing?.diagnosticArtifactRefs ?? []),
        ...options.diagnosticArtifactRefs,
      ]),
    ];
    const record = FailureRecordSchema.parse({
      version: 1,
      failureId,
      stage: "parsing",
      subject,
      laneId: `round-${String(options.round)}:${options.actor}->${options.target}`,
      contestantId: options.actor,
      category: "invalid_output",
      causalDigest,
      attempts,
      reusedArtifactRefs: [],
      diagnosticArtifactRefs,
      ...(options.terminalDisposition
        ? { terminalDisposition: options.terminalDisposition }
        : {}),
    });
    await this.persistFailureRecord(context, record);
    return record;
  }

  private async persistReturnedSubmission(
    context: ArenaContext,
    options: {
      submission: object;
      round: RoundId;
      phase: string;
      actor: string;
      kind: "house" | "case";
    },
  ): Promise<{
    parsed: ParsedSubmission<unknown>;
    rawPath: string;
    parsedPath: string;
  }> {
    const rawSource =
      "rawSource" in options.submission &&
      typeof options.submission.rawSource === "string"
        ? options.submission.rawSource
        : JSON.stringify(options.submission);
    const raw = Buffer.from(rawSource, "utf8");
    const prefix = `submissions/${String(options.round)}/${options.phase}/${options.actor}`;
    const rawPath = await context.store.writeImmutableBytes(
      `${prefix}/raw.txt`,
      raw,
    );
    const parsed =
      options.kind === "house"
        ? parseFaultIsolatedSubmission("house", raw.toString("utf8"))
        : parseFaultIsolatedSubmission("case", raw.toString("utf8"));
    parsed.rawSha256 = sha256(raw);
    const parsedPath = await context.store.writeImmutableJson(
      `${prefix}/parsed.json`,
      parsed,
    );
    context.state.submissionArtifacts.push({
      round: options.round,
      phase: options.phase,
      actor: options.actor,
      kind: options.kind,
      outcome: parsed.outcome,
      rawSha256: sha256(raw),
      rawArtifactPath: rawPath,
      parsedArtifactPath: parsedPath,
    });
    return { parsed, rawPath, parsedPath };
  }

  private enqueueRejectedAttacks(
    context: ArenaContext,
    options: {
      parsed: ParsedSubmission<unknown>;
      rawPath: string;
      parsedPath: string;
      round: RoundId;
      lane: "contestant" | "house";
      actor: ContestantId | "house";
      target: ContestantId;
    },
  ): void {
    if (!("reconciliationQueue" in context.state)) return;
    const section = options.parsed.sections.attacks;
    if (
      !section ||
      (options.parsed.outcome === "invalid" && !section.entries.length)
    )
      return;
    for (const entry of section.entries) {
      if (!isCorrectionEligible(entry)) continue;
      const id = stableId(
        "reconciliation",
        String(options.round),
        options.lane,
        options.actor,
        options.target,
        String(entry.index),
        options.parsed.rawSha256 ?? "no-raw-hash",
      );
      if (
        context.state.reconciliationQueue.some(
          (candidate) => candidate.id === id,
        )
      )
        continue;
      const candidate: ReconciliationCandidate = {
        version: 1,
        id,
        lane: options.lane,
        sourceRound: options.round,
        sourceEntryIndex: entry.index,
        actor: options.actor,
        target: options.target,
        attemptCount: 1,
        rawArtifactPath: options.rawPath,
        parsedArtifactPath: options.parsedPath,
        diagnostics: structuredClone(entry.rejections),
        validatedFields: structuredClone(entry.validatedFields),
        editablePaths: structuredClone(entry.editablePaths),
        status: "pending",
      };
      context.state.reconciliationQueue.push(candidate);
    }
  }

  private async persistRoundBoundary(
    context: ArenaContext,
    snapshot: RoundSnapshot,
    before: RunState,
    status: "completed" | "inconclusive" | "cancelled" | "failed" = "completed",
    error?: unknown,
    terminalOutcome?: TerminalOutcome,
  ): Promise<RoundResult> {
    const roundId = snapshot.roundId;
    const delta = projectRoundStateDelta(before, context.state, roundId);
    const deltaRelativePath = `rounds/${String(roundId)}/state-delta.json`;
    const deltaPath = await context.store.writeImmutableJson(
      deltaRelativePath,
      delta,
    );
    const deltaArtifact: ArtifactReference = {
      id: stableId("artifact", deltaRelativePath),
      kind: "round_state_delta",
      path: deltaPath,
      sha256: sha256(await readFile(deltaPath)),
    };
    const artifacts = [
      ...(await this.collectRoundArtifacts(context, delta)),
      ...(await this.collectRoundArtifacts(context, context.roundInvocations)),
      deltaArtifact,
    ];
    const artifactIdFor = (artifactPath: string): string[] =>
      artifacts
        .filter((artifact) => artifact.path === artifactPath)
        .map((artifact) => artifact.id);
    const invocationEntries = delta.invocations as Array<{
      contestantId?: ContestantId;
      kind: "implementation" | "review" | "attack" | "repair";
      value: AgentInvocation | { invocation?: AgentInvocation };
    }>;
    const invocations: RoundReplay["invocations"] = [
      ...invocationEntries.flatMap((entry, index) => {
        const invocation =
          "invocation" in entry.value && entry.value.invocation
            ? entry.value.invocation
            : (entry.value as AgentInvocation);
        if (!invocation?.startedAt || !invocation.finishedAt) return [];
        return [
          {
            id: stableId(
              "invocation",
              String(roundId),
              entry.kind,
              entry.contestantId ?? String(index),
            ),
            kind: entry.kind,
            actor:
              entry.contestantId === "a"
                ? ("contestant_a" as const)
                : entry.contestantId === "b"
                  ? ("contestant_b" as const)
                  : ("harness" as const),
            status: invocation.status,
            startedAt: invocation.startedAt,
            finishedAt: invocation.finishedAt,
            artifactIds: [
              ...artifactIdFor(invocation.promptPath),
              ...artifactIdFor(invocation.transcriptPath),
            ],
          },
        ];
      }),
      ...context.roundInvocations.map((invocation) => ({
        id: invocation.id,
        kind: invocation.kind,
        actor: invocation.actor,
        status: invocation.status,
        startedAt: invocation.startedAt,
        finishedAt: invocation.finishedAt,
        artifactIds: invocation.artifactPaths.flatMap(artifactIdFor),
      })),
    ];
    const attacks = (delta.attacks as Attack[]).flatMap((attack) =>
      attack.targets.map((target) => ({
        attackId: attack.id,
        origin:
          attack.origin.kind === "house"
            ? ("house" as const)
            : attack.origin.contestant === "a"
              ? ("contestant_a" as const)
              : ("contestant_b" as const),
        target,
        status:
          attack.status === "landed"
            ? ("landed" as const)
            : attack.status === "judge_unable"
              ? ("execution_inconclusive" as const)
              : attack.status === "capability_denied" ||
                  attack.status === "infrastructure_error" ||
                  attack.status === "execution_inconclusive"
                ? attack.status
                : ("missed" as const),
        ...(attack.rootDefectId ? { defectId: attack.rootDefectId } : {}),
        ...(attack.adjudication ? { adjudication: attack.adjudication } : {}),
        artifactIds: [
          ...artifactIdFor(attack.patchPath),
          ...(attack.browserArtifactRefs ?? []).flatMap(artifactIdFor),
        ],
      })),
    );
    const checks = (
      delta.checks as Array<{ contestantId?: ContestantId; value: CheckResult }>
    ).map((entry) => ({
      checkId: entry.value.id,
      ...(entry.contestantId ? { contestantId: entry.contestantId } : {}),
      status: entry.value.status,
      artifactIds: entry.value.command
        ? [
            ...artifactIdFor(entry.value.command.stdoutPath),
            ...artifactIdFor(entry.value.command.stderrPath),
          ]
        : [],
    }));
    const repairs = (["a", "b"] as const).map((contestantId) => {
      const contestant = getContestant(context.state, contestantId);
      const summary = contestant.rounds.find(
        (entry) => entry.round === roundId,
      );
      const active = contestant.healthLedger.activeDefects.map(
        (defect) => defect.rootDefectId,
      );
      const priorActive =
        before.contestants[contestantId]?.healthLedger.activeDefects.map(
          (defect) => defect.rootDefectId,
        ) ?? [];
      const roundHealthEvents = contestant.healthEvents.slice(
        before.contestants[contestantId]?.healthEvents.length ?? 0,
      );
      const healed = [
        ...new Set([
          ...priorActive.filter((defectId) => !active.includes(defectId)),
          ...roundHealthEvents.flatMap((event) => {
            if (event.type !== "heal" || !event.attackId) return [];
            const defectId = context.state.attacks.find(
              (attack) => attack.id === event.attackId,
            )?.rootDefectId;
            return defectId ? [defectId] : [];
          }),
        ]),
      ];
      return {
        contestantId,
        status: summary?.repair
          ? healed.length > 0
            ? ("repaired" as const)
            : ("unresolved" as const)
          : ("not_attempted" as const),
        healedDefectIds: healed,
        unresolvedDefectIds: active,
        ...(summary?.repair
          ? {
              invocationId: stableId(
                "invocation",
                String(roundId),
                "repair",
                contestantId,
              ),
              artifactIds: [
                ...artifactIdFor(summary.repair.promptPath),
                ...artifactIdFor(summary.repair.transcriptPath),
              ],
            }
          : { artifactIds: [] }),
      };
    });
    const replayDraft = {
      version: 5 as const,
      runId: snapshot.runId,
      roundId,
      snapshotHash: snapshot.snapshotHash,
      priorReplayHash: snapshot.priorReplayHash,
      invocations,
      attacks,
      checks,
      repairs,
      scoreEvents: (["a", "b"] as const).flatMap((contestantId) => {
        let healthAfter =
          snapshot.contestants.find(
            (contestant) => contestant.contestantId === contestantId,
          )?.health ?? 100;
        return getContestant(context.state, contestantId)
          .healthEvents.slice(
            before.contestants[contestantId]?.healthEvents.length ?? 0,
          )
          .map((event) => {
            healthAfter = Math.max(
              0,
              Math.min(100, healthAfter + event.amount),
            );
            return {
              contestantId,
              type:
                event.type === "target_damage"
                  ? ("damage" as const)
                  : event.type,
              amount: event.amount,
              healthAfter,
              ...(event.adjudicationId
                ? { adjudicationId: event.adjudicationId }
                : {}),
              ...(event.upgradesAdjudicationId
                ? { upgradesAdjudicationId: event.upgradesAdjudicationId }
                : {}),
              ...(event.attackId
                ? {
                    defectId: context.state.attacks.find(
                      (attack) => attack.id === event.attackId,
                    )?.rootDefectId,
                  }
                : {}),
            };
          });
      }),
      diagnostics:
        status === "completed"
          ? []
          : [
              {
                code: `round-${status}`,
                severity: "error" as const,
                message: error instanceof Error ? error.message : String(error),
                artifactIds: artifacts
                  .filter((artifact) => artifact.kind === "diagnostic")
                  .map((artifact) => artifact.id),
              },
            ],
      failureRecords: structuredClone(context.state.failureRecords),
      artifacts,
      stateDeltaArtifactId: deltaArtifact.id,
      ...(context.state.adaptiveDecisions.find(
        (entry) => entry.round === roundId,
      )
        ? {
            adaptiveDecision: context.state.adaptiveDecisions.find(
              (entry) => entry.round === roundId,
            ),
          }
        : {}),
      replayHash: "0".repeat(64),
    };
    replayDraft.replayHash = calculateReplayHash(replayDraft);
    const replay: RoundReplay = RoundReplaySchema.parse(replayDraft);
    await context.store.writeImmutableJson(
      `rounds/${String(roundId)}/replay.json`,
      replay,
    );
    const resultingContestants = await Promise.all(
      (["a", "b"] as const).map(async (contestantId) => {
        const contestant = getContestant(context.state, contestantId);
        const topology = context.runSpec.topology.contestants.find(
          (entry) => entry.id === contestantId,
        );
        return {
          contestantId,
          patch:
            topology?.role !== "attacker" && contestant.currentPatchPath
              ? {
                  path: contestant.currentPatchPath,
                  sha256: sha256(await readFile(contestant.currentPatchPath)),
                }
              : null,
          health: contestant.finalHealth,
          permanentRecoil: contestant.healthLedger.permanentRecoil,
          activeDefects: contestant.healthLedger.activeDefects.map((defect) => {
            const attack = context.state.attacks.find(
              (entry) => entry.id === defect.attackId,
            );
            return {
              defectId: defect.rootDefectId,
              attackId: defect.attackId,
              severity: defect.severity ?? attack?.severity ?? ("low" as const),
              damage: defect.damage,
              ...(defect.multiplier ? { multiplier: defect.multiplier } : {}),
            };
          }),
          canonicalDefects: (
            contestant.healthLedger.canonicalDefects ?? []
          ).map((defect) => ({
            defectId: defect.rootDefectId,
            firstAttackId: defect.firstAttackId,
            ...(defect.firstAdjudicationId
              ? { firstAdjudicationId: defect.firstAdjudicationId }
              : {}),
            baseSeverity: defect.baseSeverity,
            currentMultiplier: defect.currentMultiplier,
            currentDamage: defect.currentDamage,
            evidenceHistory: structuredClone(defect.evidenceHistory),
            status: defect.status,
            ...(defect.supersededByAdjudicationId
              ? {
                  supersededByAdjudicationId: defect.supersededByAdjudicationId,
                }
              : {}),
            repairAllowance: defect.repairAllowance,
            repairAttemptsUsed: defect.repairAttemptsUsed,
            repairAttemptIds: structuredClone(defect.repairAttemptIds),
            regressionResets: defect.regressionResets,
          })),
          status:
            contestant.status === "eliminated" || contestant.status === "failed"
              ? ("eliminated" as const)
              : contestant.finalHealth === 0
                ? ("downed" as const)
                : ("active" as const),
        };
      }),
    );
    const baseResult = {
      version: 5,
      runId: snapshot.runId,
      roundId,
      resultingContestants: [
        resultingContestants[0]!,
        resultingContestants[1]!,
      ],
      failureRecords: structuredClone(context.state.failureRecords),
      replay,
    } as const;
    const result = RoundResultSchema.parse(
      status === "completed"
        ? {
            ...baseResult,
            status,
            ...(terminalOutcome ? { terminalOutcome } : {}),
          }
        : {
            ...baseResult,
            status,
            diagnostics: replay.diagnostics,
            ...(terminalOutcome ? { terminalOutcome } : {}),
          },
    );
    const envelope = await sealRoundEnvelope({
      store: context.store,
      result,
      priorEnvelopeHash: context.priorEnvelopeHash,
      now: this.now(),
    });
    context.priorEnvelopeHash = envelope.envelopeHash;
    return result;
  }

  private isInfrastructureError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /infrastructure|could not start|inconclusive/i.test(message);
  }

  private isRoundInvariantError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /Frozen PR patch is empty|missing .*configuration|topology is missing|RoundEngine\.run requires/i.test(
      message,
    );
  }

  private async finishTerminalRound(
    context: ArenaContext,
    result: RoundResult,
  ): Promise<FightOutcome> {
    if (result.status === "completed" && !result.terminalOutcome)
      throw new Error("Only terminal round results may finish a run");
    if (result.status === "completed")
      await this.applyRoundTransaction(context, result);
    const completedAt = this.now().toISOString();
    if (result.terminalOutcome)
      context.state.terminalOutcome = TerminalOutcomeSchema.parse(
        result.terminalOutcome,
      );
    const forfeit = result.terminalOutcome?.kind === "forfeit";
    if (forfeit) {
      const winner = result.terminalOutcome.eligibleContestantIds[0];
      if (!winner) throw new Error("Forfeit result has no eligible contestant");
      const contestant = getContestant(context.state, winner);
      contestant.finalPatchPath = contestant.currentPatchPath;
      contestant.status = "survived";
      for (const affected of result.terminalOutcome.affectedContestantIds) {
        const failed = getContestant(context.state, affected);
        failed.status = "failed";
        failed.healthLedger.eliminatedByRequiredCheck = true;
        failed.finalHealth = calculateHealth(failed.healthLedger);
      }
      if (!contestant.finalPatchPath)
        throw new Error("Forfeit winner has no final patch");
      const patchBytes = await readFile(contestant.finalPatchPath);
      context.state.patchQualityFacts[winner] = collectPatchQualityFacts({
        contestantId: winner,
        patch: patchBytes.toString("utf8"),
        patchBytes,
      });
      context.state.ranking = rankContestants(
        context.config.agents.map((agent) =>
          getContestant(context.state, agent),
        ),
        { patchSizeTieBreaker: context.config.mode !== "siege" },
      );
      context.state.arenaOutcome = deriveArenaOutcome(context.state);
      context.state.patchRecommendation = PatchRecommendationSchema.parse({
        contestantId: winner,
        reason: "forfeit",
        rationale: [
          "This was the only production patch that applied and passed required initial validation.",
        ],
        comparison: context.config.agents.map((id) => {
          const candidate = getContestant(context.state, id);
          return {
            contestantId: id,
            eligible: id === winner,
            activeDefectDamage: 0,
            requiredValidationPassed: latestRequiredPass(candidate),
            finalApplicabilityPassed: Boolean(candidate.finalPatchPath),
          };
        }),
      });
      context.state.reviewPrompt = buildReviewPrompt(context.state);
      await context.store.writeImmutableJson(
        "review-prompt.json",
        context.state.reviewPrompt,
      );
      const appliedEnvelopeHash = context.appliedEnvelopes.at(-1)?.envelopeHash;
      if (!appliedEnvelopeHash)
        throw new Error(
          "Cannot finalize a forfeit without an applied envelope",
        );
      await writeFinalizationRecord({
        store: context.store,
        state: context.state,
        appliedEnvelopeHash,
        now: this.now(),
      });
    }
    const terminalStatus =
      result.status === "completed" ? "complete" : result.status;
    context.state.status = forfeit ? "complete" : terminalStatus;
    context.state.stage = forfeit ? "report" : terminalStatus;
    context.state.completedAt = completedAt;
    context.state.updatedAt = completedAt;
    context.state.failureRecords = structuredClone(result.failureRecords);
    if ("diagnostics" in result)
      context.state.warnings.push(
        ...result.diagnostics.map((entry) => entry.message),
      );
    await this.expireSteering(context);
    await this.persist(context);
    await context.store.writeText(
      "BATTLE.md",
      renderBattleReport(context.state),
    );
    await context.store.writeText(
      "BATTLE.html",
      renderBattleHtml(context.state),
    );
    await context.store.writeText(
      "BATTLE.svg",
      renderBattleVisual(context.state),
    );
    if (context.state.status === "cancelled")
      await this.emit(context, { type: "cancellation_completed" });
    await this.emitBattleCompleted(context, context.state.status);
    return {
      state: context.state,
      summary: renderConsoleSummary(
        context.state,
        this.dependencies.consoleOptions,
      ),
    };
  }

  private async persist(context: ArenaContext): Promise<void> {
    context.state.updatedAt = this.now().toISOString();
    this.syncSteeringLedger(context);
    await this.emitNewStateEvents(context);
    await context.store.writeJson("operations/operator-interventions.json", {
      version: 1,
      runId: context.state.runId,
      interventions: context.state.operatorInterventions,
    });
    if (this.runtime) return;
    await context.store.writeState(context.state, context.appliedEnvelopes);
  }

  private syncSteeringLedger(context: ArenaContext): void {
    context.state.operatorInterventions = structuredClone([
      ...context.control.all(),
    ]);
    if (
      context.state.operatorInterventions.some(
        (intervention) => intervention.status === "applied",
      )
    )
      context.state.integrity = "assisted";
  }

  private emit(context: ArenaContext, event: ArenaEventInput): Promise<void> {
    return Promise.resolve(context.observer.publish(event));
  }

  private projectedStateEventKeys(state: RunState): Set<string> {
    const keys = new Set<string>();
    state.warnings.forEach((_warning, index) =>
      keys.add(`warning:${String(index)}`),
    );
    for (const contestant of Object.values(state.contestants)) {
      contestant.checks.forEach((check) =>
        keys.add(`check:${contestant.id}:${check.id}:${check.status}`),
      );
      contestant.healthEvents.forEach((_event, index) =>
        keys.add(`health:${contestant.id}:${String(index)}`),
      );
    }
    for (const attack of state.attacks) {
      keys.add(`attack:${attack.id}:${attack.status}`);
      if (attack.evidenceRevision) keys.add(`attack:${attack.id}:revision`);
    }
    for (const failure of state.failureRecords)
      keys.add(
        `failure:${failure.failureId}:${String(failure.attempts.length)}:${failure.terminalDisposition ?? "retrying"}`,
      );
    return keys;
  }

  /** Project only authoritative persisted state changes into live telemetry. */
  private async emitNewStateEvents(context: ArenaContext): Promise<void> {
    const emitted = context.emittedEvents;
    for (const [index, message] of context.state.warnings.entries()) {
      const key = `warning:${String(index)}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      await this.emit(context, { type: "warning", message });
    }
    for (const contestant of Object.values(context.state.contestants)) {
      for (const check of contestant.checks) {
        const key = `check:${contestant.id}:${check.id}:${check.status}`;
        if (emitted.has(key)) continue;
        emitted.add(key);
        await this.emit(context, {
          type: "check_completed",
          checkId: check.id,
          status: check.status,
          contestantId: contestant.id,
        });
      }
      let health = 100;
      for (const [index, healthEvent] of contestant.healthEvents.entries()) {
        health = Math.max(0, Math.min(100, health + healthEvent.amount));
        const key = `health:${contestant.id}:${String(index)}`;
        if (emitted.has(key)) continue;
        emitted.add(key);
        await this.emit(context, {
          type: "health_changed",
          contestantId: contestant.id,
          health,
          amount: healthEvent.amount,
          reason: healthEvent.reason,
          round: healthEvent.round,
          ...(healthEvent.attackId ? { attackId: healthEvent.attackId } : {}),
        });
      }
    }
    for (const attack of context.state.attacks) {
      const participants = {
        ...(attack.origin.kind === "contestant"
          ? { attackerId: attack.origin.contestant }
          : {}),
        ...(attack.targets[0] ? { targetId: attack.targets[0] } : {}),
        evidenceClass:
          attack.origin.kind === "contestant"
            ? ("competitive" as const)
            : ("shared" as const),
      };
      const key = `attack:${attack.id}:${attack.status}`;
      if (!emitted.has(key)) {
        emitted.add(key);
        await this.emit(
          context,
          attack.status === "submitted"
            ? {
                type: "attack_mounted",
                attackId: attack.id,
                round: attack.round,
                claim: attack.claim,
                ...participants,
              }
            : {
                type: "attack_resolved",
                attackId: attack.id,
                round: attack.round,
                status: attack.status,
                ...participants,
                ...(attack.severity ? { severity: attack.severity } : {}),
                ...(attack.damage === undefined
                  ? {}
                  : { damage: attack.damage }),
              },
        );
      }
      const revisionKey = `attack:${attack.id}:revision`;
      if (attack.evidenceRevision && !emitted.has(revisionKey)) {
        emitted.add(revisionKey);
        await this.emit(context, {
          type: "attack_revised",
          attackId: attack.id,
          round: attack.round,
          explanation: attack.evidenceRevision.explanation,
          ...participants,
        });
      }
    }
    for (const failure of context.state.failureRecords) {
      const attempt = failure.attempts.at(-1)!;
      const key = `failure:${failure.failureId}:${String(failure.attempts.length)}:${failure.terminalDisposition ?? "retrying"}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      await this.emit(context, {
        type: "failure_updated",
        failureId: failure.failureId,
        stage: failure.stage,
        subject: failure.subject,
        attempt: attempt.attempt,
        attemptStatus: attempt.status,
        state:
          failure.terminalDisposition === "recovered"
            ? "recovered"
            : failure.terminalDisposition
              ? "resolved"
              : "retrying",
        ...(failure.terminalDisposition
          ? { terminalDisposition: failure.terminalDisposition }
          : {}),
        ...(failure.contestantId ? { contestantId: failure.contestantId } : {}),
        ...(failure.laneId ? { laneId: failure.laneId } : {}),
        ...(failure.attackId ? { attackId: failure.attackId } : {}),
        diagnosticArtifactRefs: [...attempt.diagnosticArtifactRefs],
      });
    }
  }

  private applyQueuedSteering(
    context: ArenaContext,
    contestantId: ContestantId,
    stage: Stage,
    prompt: string,
    round?: RoundId,
  ): string {
    const intervention = context.control.consume(contestantId);
    if (!intervention) return prompt;
    const steeredPrompt = appendSteering(prompt, intervention.note);
    intervention.status = "applied";
    intervention.appliedStage = stage;
    if (round !== undefined) intervention.appliedRound = round;
    intervention.promptHash = sha256(steeredPrompt);
    void this.emit(context, {
      type: "steering_applied",
      interventionId: intervention.id,
      contestantId,
      stage,
      ...(round === undefined ? {} : { round }),
      promptHash: intervention.promptHash,
    });
    return steeredPrompt;
  }

  private async expireSteering(context: ArenaContext): Promise<void> {
    for (const intervention of context.control.all()) {
      if (intervention.status !== "queued") continue;
      intervention.status = "expired";
      await this.emit(context, {
        type: "steering_expired",
        interventionId: intervention.id,
        contestantId: intervention.contestantId,
      });
    }
    await this.persist(context);
  }

  private async emitBattleCompleted(
    context: ArenaContext,
    status: "complete" | "inconclusive" | "failed" | "cancelled",
  ): Promise<void> {
    await this.emit(context, {
      type: "battle_completed",
      status,
      roundsCompleted: Math.max(
        0,
        ...Object.values(context.state.contestants).flatMap((contestant) =>
          contestant.rounds
            .filter((round) => typeof round.round === "number")
            .map((round) => Number(round.round)),
        ),
      ),
      ...(context.state.arenaOutcome?.championId
        ? { championId: context.state.arenaOutcome.championId }
        : {}),
      ...(context.state.arenaOutcome && "kind" in context.state.arenaOutcome
        ? {
            outcomeKind: context.state.arenaOutcome.kind,
            decisionBasis: context.state.arenaOutcome.decisionBasis,
            competitiveLandingCount:
              context.state.arenaOutcome.competitiveLandingCount,
            sharedDefectCount: context.state.arenaOutcome.sharedDefectCount,
            explicitEmptyLaneCount:
              context.state.arenaOutcome.explicitEmptyLaneCount,
          }
        : {}),
      ...(context.state.patchRecommendation?.contestantId
        ? { recommendedId: context.state.patchRecommendation.contestantId }
        : {}),
      ...(context.state.patchRecommendation?.rationale.length
        ? {
            recommendationReason:
              context.state.patchRecommendation.rationale.join(" "),
          }
        : {}),
      ...(context.state.coverageAssessment
        ? { coverageConfidence: context.state.coverageAssessment.confidence }
        : {}),
      ...(context.state.terminalOutcome
        ? { terminalOutcome: context.state.terminalOutcome }
        : {}),
      contestants: Object.values(context.state.contestants).map(
        (contestant) => ({
          id: contestant.id,
          health: contestant.finalHealth,
          status: contestant.status,
          checksPassed: contestant.checks.filter(
            (check) => check.status === "passed",
          ).length,
          checksTotal: contestant.checks.length,
        }),
      ),
    });
  }

  private adapterFor(
    context: ArenaContext,
    contestantId: ContestantId,
  ): AgentAdapter {
    const contestantAdapter =
      this.dependencies.contestantAdapters?.[contestantId];
    if (contestantAdapter) return contestantAdapter;
    const generatedAdapter = this.generatedContestantAdapters[contestantId];
    if (generatedAdapter) return generatedAdapter;
    const contestant = getContestant(context.state, contestantId);
    if (this.dependencies.adapterFactory) {
      const adapter = this.dependencies.adapterFactory(contestant);
      this.generatedContestantAdapters[contestantId] = adapter;
      return adapter;
    }
    return getAdapter(this.dependencies.adapters, contestant.provider);
  }

  private recordProviderFailure(
    context: ArenaContext,
    options: {
      contestantId: ContestantId;
      stage: ProviderStage;
      invocation: AgentInvocation;
      round?: 1 | 2 | 3 | 4 | 5;
      reason: string;
    },
  ): boolean {
    const evidence = options.invocation.command?.transportFailures ?? [];
    if (
      !evidence.length ||
      options.invocation.status !== "infrastructure_error"
    )
      return false;
    const contestant = getContestant(context.state, options.contestantId);
    const recoveryAvailable =
      this.dependencies.canRecoverProvider?.(contestant.provider) ?? true;
    if (
      !recoveryAvailable &&
      (options.stage === "review" || options.stage === "attack_construction") &&
      !(
        this.dependencies.recordUnrecoveredProviderFailure?.(options.stage) ??
        false
      )
    )
      return false;
    context.state.providerFailure = ProviderStageFailureSchema.parse({
      version: 1,
      provider: contestant.provider,
      stage: options.stage,
      ...(options.round ? { round: options.round } : {}),
      contestantId: options.contestantId,
      reason: options.reason,
      causalEvidence: evidence.map((entry) => `${entry.kind}: ${entry.detail}`),
      artifactRefs: [
        options.invocation.promptPath,
        options.invocation.transcriptPath,
        options.invocation.command?.stdoutPath,
        options.invocation.command?.stderrPath,
      ].filter((entry): entry is string => Boolean(entry)),
      usableTerminalResult: false,
    });
    return true;
  }

  private recordVerifierProviderFailure(
    context: ArenaContext,
    round: RoundId,
  ): boolean {
    const failure = this.dependencies.verifier.consumeProviderFailure?.();
    if (!failure) return false;
    context.state.providerFailure = ProviderStageFailureSchema.parse({
      ...failure,
      ...(typeof round === "number" ? { round } : {}),
    });
    return true;
  }

  private async laneFeedback(
    context: ArenaContext,
    contestantId: ContestantId,
    roundId: RoundId,
    phase: "review" | "attack" | "repair",
  ) {
    const feedback = projectContestantFeedback({
      state: context.state,
      contestantId,
      roundId,
      phase,
      permissions: context.permissions,
    });
    await persistContestantFeedback({ store: context.store, feedback });
    return feedback;
  }

  private async transition(
    context: ArenaContext,
    stage: Stage,
    round?: RoundId,
  ): Promise<void> {
    assertTransition(context.state.stage, stage);
    context.state.stage = stage;
    if (round !== undefined) context.state.currentRound = round;
    this.progress(
      `${round === undefined ? "" : `Round ${String(round)} — `}${stage}`,
    );
    await this.emit(context, {
      type: "stage_changed",
      stage,
      ...(round === undefined ? {} : { round }),
    });
    if (round !== undefined && stage === "review_attacks")
      await this.emit(context, { type: "round_started", round });
    await this.persist(context);
  }

  private async preflight(context: ArenaContext): Promise<void> {
    await this.transition(context, "resolve_permissions");
    const unavailable: string[] = [];
    for (const agent of context.config.agents) {
      let availability!: Awaited<ReturnType<AgentAdapter["checkAvailability"]>>;
      let availabilityFailure: FailureRecord | undefined;
      for (const attempt of [1, 2] as const) {
        const startedAt = this.now().toISOString();
        availability = await this.adapterFor(
          context,
          agent,
        ).checkAvailability();
        const finishedAt = this.now().toISOString();
        if (availability.available) {
          if (availabilityFailure) {
            await this.recordFailureAttempt(context, {
              stage: "capability_provisioning",
              subject: `availability:${agent}`,
              category: availabilityFailure.category,
              attempt: 2,
              startedAt,
              finishedAt,
              status: "succeeded",
              diagnosticArtifactRefs: [],
              contestantId: agent,
              existing: availabilityFailure,
              terminalDisposition: "recovered",
            });
          }
          break;
        }
        availabilityFailure = await this.recordFailureAttempt(context, {
          stage: "capability_provisioning",
          subject: `availability:${agent}`,
          category: "capability_unavailable",
          attempt,
          startedAt,
          finishedAt,
          status: "failed",
          diagnosticArtifactRefs: [],
          contestantId: agent,
          ...(availabilityFailure ? { existing: availabilityFailure } : {}),
          ...(attempt === 2
            ? { terminalDisposition: "run_level_coverage_lost" as const }
            : {}),
        });
      }
      if (!availability.available)
        unavailable.push(`${agent}: ${availability.reason ?? "unavailable"}`);
    }
    if (unavailable.length > 0)
      throw new Error(`Agent availability failed:\n${unavailable.join("\n")}`);
    const baseline = await this.prepareWorktree(context, {
      name: "preflight-baseline",
      subject: "preflight-baseline-worktree",
      runLevel: true,
    });
    try {
      let command!: Awaited<ReturnType<typeof runShellCommand>>;
      let baselineFailure: FailureRecord | undefined;
      for (const attempt of [1, 2] as const) {
        const startedAt = this.now().toISOString();
        const logPrefix = context.store.resolve(
          `logs/preflight-baseline-attempt-${String(attempt)}`,
        );
        command = await runShellCommand(context.config.testCommand, {
          cwd: baseline,
          timeoutMs: context.config.limits.attackMs,
          logPrefix,
          signal: context.controller.signal,
        });
        const finishedAt = this.now().toISOString();
        const diagnosticArtifactRefs = [command.stdoutPath, command.stderrPath];
        if (command.failureClass !== "arena_infrastructure") {
          if (baselineFailure) {
            await this.recordFailureAttempt(context, {
              stage: "required_validation",
              subject: "preflight-baseline",
              category: baselineFailure.category,
              attempt: 2,
              startedAt,
              finishedAt,
              status: "succeeded",
              diagnosticArtifactRefs,
              existing: baselineFailure,
              terminalDisposition: "recovered",
            });
          }
          break;
        }
        baselineFailure = await this.recordFailureAttempt(context, {
          stage: "required_validation",
          subject: "preflight-baseline",
          category: "command_execution",
          attempt,
          startedAt,
          finishedAt,
          status: "failed",
          diagnosticArtifactRefs,
          ...(baselineFailure ? { existing: baselineFailure } : {}),
          ...(attempt === 2
            ? { terminalDisposition: "run_level_coverage_lost" as const }
            : {}),
        });
      }
      if (command.failureClass === "arena_infrastructure") {
        throw new Error("Baseline validation could not start");
      }
      if (command.exitCode !== 0)
        throw new Error(
          "Baseline validation failed; pre-existing failures are unsupported",
        );
      const browser = context.runSpec.browserValidation;
      if (browser) {
        const adapter = browser.profile
          ? this.dependencies.browserAdapters?.[browser.profile.runner]
          : undefined;
        const browserBaseline = await executeBrowserValidation({
          plan: { ...browser, requirement: "optional" },
          decision: browser.decision,
          ...(adapter ? { adapter } : {}),
          worktree: baseline,
          artifactDirectory: context.store.resolve("browser/baseline"),
          selectedProbes: [],
          nativeSuiteCache: this.browserNativeSuiteCache,
          nativeSuiteCacheKey: sha256(
            `${browser.profile?.testCommand ?? "unavailable"}\0base:${context.runSpec.baseCommit}`,
          ),
          approvedOrigins: browser.approvedScopes
            .filter((scope) => scope.startsWith("origin:"))
            .map((scope) => scope.slice("origin:".length)),
          dynamicLoopbackApproved: browser.approvedScopes.some(
            (scope) =>
              scope.startsWith("loopback:") && scope.endsWith(":dynamic"),
          ),
          timeoutMs: context.config.limits.attackMs,
          ...this.browserSessionObserver(context, "Baseline validation"),
          signal: context.controller.signal,
        });
        context.browserBaseline = browserBaseline;
        const artifactPath = context.store.resolve(
          "browser/baseline-result.json",
        );
        await writeBrowserBaseline({
          store: context.store,
          identity: {
            runId: context.runSpec.runId,
            baseCommit: context.runSpec.baseCommit,
            runSpecHash: context.runSpec.contentHash,
            browserValidation: browser,
          },
          result: browserBaseline,
        });
        context.state.artifacts["browser-baseline"] = artifactPath;
        if (
          browser.requirement === "required" &&
          browser.decision === "approved" &&
          browserBaseline.status !== "verified"
        )
          throw new Error(
            `Baseline browser validation ${browserBaseline.status}; configuration or harness failure prevents fair attribution`,
          );
      }
    } finally {
      await context.worktrees.remove(baseline);
    }
  }

  private async implement(context: ArenaContext): Promise<void> {
    await this.transition(context, "implement");
    const worktrees = new Map<ContestantId, string>();
    const phaseController = new AbortController();
    let transportFailure = false;
    const cancelPhase = (): void =>
      phaseController.abort(context.controller.signal.reason);
    if (context.controller.signal.aborted) cancelPhase();
    else
      context.controller.signal.addEventListener("abort", cancelPhase, {
        once: true,
      });
    const implementationAgents = context.config.agents.filter(
      (agent) =>
        context.config.contestants.find((contestant) => contestant.id === agent)
          ?.startingPatch !== "pull_request",
    );
    for (const agent of implementationAgents) {
      worktrees.set(
        agent,
        await this.prepareWorktree(context, {
          name: `implement-${agent}`,
          subject: `implementation-worktree:${agent}`,
          contestantId: agent,
          runLevel: true,
        }),
      );
    }
    try {
      const results = await Promise.allSettled(
        implementationAgents.map(async (agent) => {
          const worktree = worktrees.get(agent);
          if (!worktree)
            throw new Error(`Missing implementation worktree for ${agent}`);
          const prompt = this.applyQueuedSteering(
            context,
            agent,
            "implement",
            composePrompt({
              agent,
              stage: "implement",
              runSpec: context.runSpec,
              config: context.config,
              permissions: context.permissions,
              deadlineAt: this.deadlineAfter(
                context.config.limits.implementationMs,
              ),
            }),
          );
          const promptPath = await context.store.writeText(
            `prompts/implementation-${agent}.md`,
            prompt,
          );
          await this.persist(context);
          const contestant = getContestant(context.state, agent);
          let invocation!: AgentInvocation;
          let implementationFailure: FailureRecord | undefined;
          for (const attempt of [1, 2] as const) {
            const startedAt = this.now().toISOString();
            const transcriptPrefix = context.store.resolve(
              `logs/implementation-${agent}-attempt-${String(attempt)}`,
            );
            invocation = await this.adapterFor(context, agent).implement({
              worktree,
              contestantId: agent,
              prompt,
              promptPath,
              transcriptPrefix,
              timeoutMs: context.config.limits.implementationMs,
              signal: phaseController.signal,
              observer: context.observer,
            });
            const finishedAt = this.now().toISOString();
            invocation.contestantId = agent;
            invocation.role = contestant.role;
            contestant.implementation = invocation;
            if (invocation.status === "succeeded") {
              if (implementationFailure) {
                await this.recordFailureAttempt(context, {
                  stage: "implementation",
                  subject: `implementation:${agent}`,
                  category: implementationFailure.category,
                  attempt: 2,
                  startedAt,
                  finishedAt,
                  status: "succeeded",
                  diagnosticArtifactRefs: [promptPath, transcriptPrefix],
                  contestantId: agent,
                  existing: implementationFailure,
                  terminalDisposition: "recovered",
                });
              }
              break;
            }
            if (invocation.status === "cancelled") {
              if (context.controller.signal.aborted)
                throw new Error(`Implementation cancelled for ${agent}`);
              if (!transportFailure) {
                context.controller.abort(
                  new Error(`Implementation cancelled for ${agent}`),
                );
                throw new Error(`Implementation cancelled for ${agent}`);
              }
              contestant.status = "failed";
              return;
            }
            const category = invocation.command?.transportFailures?.length
              ? ("transport" as const)
              : invocation.status === "timed_out"
                ? ("timeout" as const)
                : invocation.status === "infrastructure_error"
                  ? ("process_launch" as const)
                  : ("invalid_output" as const);
            implementationFailure = await this.recordFailureAttempt(context, {
              stage: "implementation",
              subject: `implementation:${agent}`,
              category: implementationFailure?.category ?? category,
              attempt,
              startedAt,
              finishedAt,
              status: "failed",
              diagnosticArtifactRefs: [promptPath, transcriptPrefix],
              contestantId: agent,
              ...(implementationFailure
                ? { existing: implementationFailure }
                : {}),
              ...(attempt === 2
                ? { terminalDisposition: "run_level_coverage_lost" as const }
                : {}),
            });
            if (
              attempt === 2 &&
              invocation.status === "infrastructure_error" &&
              invocation.command?.transportFailures?.length
            ) {
              this.recordProviderFailure(context, {
                contestantId: agent,
                stage: "implementation",
                invocation,
                reason: `Implementation provider failure persisted after the targeted retry for ${agent}`,
              });
              transportFailure = true;
              phaseController.abort(
                new Error(`Provider transport failed for ${agent}`),
              );
              throw new Error(`Implementation transport failed for ${agent}`);
            }
            if (attempt === 1) continue;
            if (invocation.status === "infrastructure_error") {
              throw new Error(
                `Implementation infrastructure failed for ${agent}`,
              );
            }
            contestant.status = "failed";
            return;
          }
          if (invocation.status !== "succeeded") return;
          await removeSubmission(worktree);
          const patchPath = context.store.resolve(
            `patches/${agent}-initial.diff`,
          );
          const patchSize = await context.worktrees.capturePatch(
            worktree,
            patchPath,
          );
          contestant.initialPatchPath = patchPath;
          contestant.currentPatchPath = patchPath;
          contestant.patchSize = patchSize;
          if (patchSize === 0) contestant.status = "failed";
        }),
      );
      const rejected = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (rejected) throw rejected.reason;
    } finally {
      context.controller.signal.removeEventListener("abort", cancelPhase);
      for (const worktree of worktrees.values()) {
        await context.worktrees.remove(worktree);
      }
    }
    await this.persist(context);
  }

  private async initializePullRequestContestant(
    context: ArenaContext,
    fixture: PullRequestFixture,
  ): Promise<void> {
    const contestant = context.config.contestants.find(
      (candidate) => candidate.startingPatch === "pull_request",
    );
    if (!contestant)
      throw new Error("Missing frozen PR contestant configuration");
    const state = getContestant(context.state, contestant.id);
    const patch = await stat(fixture.patchPath);
    if (patch.size === 0)
      throw new Error("Frozen PR patch is empty; preflight cannot continue");
    state.initialPatchPath = fixture.patchPath;
    state.currentPatchPath = fixture.patchPath;
    state.patchSize = patch.size;
    await this.persist(context);
  }

  private async initialValidation(
    context: ArenaContext,
    contestantIds: readonly ContestantId[] = context.config.agents,
  ): Promise<void> {
    await this.transition(context, "initial_validate");
    for (const agent of contestantIds) {
      const contestant = getContestant(context.state, agent);
      if (!contestant.currentPatchPath || contestant.patchSize === 0) {
        contestant.checks.push({
          id: "initial-required",
          kind: "required",
          status: "failed",
          reason: "Implementation patch is empty",
        });
        continue;
      }
      const worktree = await this.prepareWorktree(context, {
        name: `initial-validate-${agent}`,
        subject: `initial-validation-worktree:${agent}`,
        contestantId: agent,
        runLevel: true,
      });
      try {
        try {
          await context.worktrees.applyPatch(
            worktree,
            contestant.currentPatchPath,
          );
        } catch (error) {
          contestant.checks.push({
            id: "initial-apply",
            kind: "apply",
            status: "failed",
            reason: error instanceof Error ? error.message : String(error),
          });
          contestant.status = "failed";
          continue;
        }
        let command!: Awaited<ReturnType<typeof runShellCommand>>;
        let validationFailure: FailureRecord | undefined;
        for (const attempt of [1, 2] as const) {
          const startedAt = this.now().toISOString();
          const logPrefix = context.store.resolve(
            `logs/initial-validation-${agent}-attempt-${String(attempt)}`,
          );
          command = await runShellCommand(context.config.testCommand, {
            cwd: worktree,
            timeoutMs: context.config.limits.attackMs,
            logPrefix,
            signal: context.controller.signal,
          });
          const finishedAt = this.now().toISOString();
          const diagnosticArtifactRefs = [
            command.stdoutPath,
            command.stderrPath,
          ];
          if (command.failureClass !== "arena_infrastructure") {
            if (validationFailure) {
              validationFailure = await this.recordFailureAttempt(context, {
                stage: "required_validation",
                subject: `initial-required:${agent}`,
                category: validationFailure.category,
                attempt: 2,
                startedAt,
                finishedAt,
                status: "succeeded",
                diagnosticArtifactRefs,
                contestantId: agent,
                existing: validationFailure,
                reusedArtifactRefs: [contestant.currentPatchPath],
                terminalDisposition: "recovered",
              });
            }
            break;
          }
          validationFailure = await this.recordFailureAttempt(context, {
            stage: "required_validation",
            subject: `initial-required:${agent}`,
            category: "command_execution",
            attempt,
            startedAt,
            finishedAt,
            status: "failed",
            diagnosticArtifactRefs,
            contestantId: agent,
            ...(validationFailure ? { existing: validationFailure } : {}),
            reusedArtifactRefs: [contestant.currentPatchPath],
            ...(attempt === 2
              ? { terminalDisposition: "run_level_coverage_lost" as const }
              : {}),
          });
          if (attempt === 2) break;
        }
        contestant.checks.push(requiredCheck("initial-required", command));
        if (command.failureClass === "arena_infrastructure")
          throw new Error(
            `Initial required validation infrastructure failed for ${agent}`,
          );
        await this.validateBrowserForContestant(
          context,
          contestant,
          worktree,
          "initial",
        );
      } finally {
        await context.worktrees.remove(worktree);
      }
    }
    await this.persist(context);
  }

  private async validateBrowserForContestant(
    context: ArenaContext,
    contestant: ContestantResult,
    worktree: string,
    phase: "initial" | "final",
  ): Promise<void> {
    const validation = context.runSpec.browserValidation;
    if (!validation) return;
    const adapter = validation.profile
      ? this.dependencies.browserAdapters?.[validation.profile.runner]
      : undefined;
    const patchDigest = contestant.currentPatchPath
      ? sha256(await readFile(contestant.currentPatchPath))
      : `contestant:${contestant.id}:${phase}`;
    const result = this.attributeBrowserResult(
      context,
      await executeBrowserValidation({
        plan: validation,
        decision: validation.decision,
        ...(adapter ? { adapter } : {}),
        worktree,
        artifactDirectory: context.store.resolve(
          `browser/${contestant.id}/${phase}`,
        ),
        selectedProbes: [],
        nativeSuiteCache: this.browserNativeSuiteCache,
        nativeSuiteCacheKey: sha256(
          `${validation.profile?.testCommand ?? "unavailable"}\0${patchDigest}`,
        ),
        approvedOrigins: validation.approvedScopes
          .filter((scope) => scope.startsWith("origin:"))
          .map((scope) => scope.slice("origin:".length)),
        dynamicLoopbackApproved: validation.approvedScopes.some(
          (scope) =>
            scope.startsWith("loopback:") && scope.endsWith(":dynamic"),
        ),
        timeoutMs: context.config.limits.attackMs,
        ...this.browserSessionObserver(
          context,
          `${contestant.id.toUpperCase()} · ${phase} validation`,
          contestant.id,
        ),
        signal: context.controller.signal,
      }),
    );
    contestant.browserValidation = result;
    const artifactPath = await context.store.writeJson(
      `browser/${contestant.id}/${phase}-result.json`,
      result,
    );
    context.state.artifacts[`browser-${contestant.id}-${phase}`] = artifactPath;
    contestant.checks.push({
      id: `${phase}-browser`,
      kind: "browser",
      status:
        result.status === "verified"
          ? "passed"
          : result.status === "failed"
            ? "failed"
            : "skipped",
      ...(result.reason ? { reason: result.reason } : {}),
    });
    if (
      validation.requirement === "required" &&
      validation.decision === "approved"
    ) {
      const gateStatus =
        result.status === "verified"
          ? "passed"
          : result.status === "failed"
            ? "failed"
            : "infrastructure_error";
      contestant.checks.push({
        id: `${phase}-browser-required`,
        kind: "required",
        status: gateStatus,
        ...(result.reason ? { reason: result.reason } : {}),
      });
      if (phase === "final" && gateStatus === "failed") {
        contestant.status = "eliminated";
        contestant.healthLedger.eliminatedByRequiredCheck = true;
      }
      if (phase === "final" && gateStatus === "infrastructure_error")
        throw new Error(
          `Final required browser validation infrastructure failed for ${contestant.id}`,
        );
    }
    if (validation.decision === "approved" && result.status === "unverified") {
      const capability = context.permissions.capabilities.find(
        (entry) => entry.id === "browser_dom_validation",
      );
      if (capability) capability.status = "provisioning_failed";
      await context.store.writeJson("permissions.json", context.permissions);
    }
  }

  private attributeBrowserResult(
    context: ArenaContext,
    result: BrowserValidationResult,
  ): BrowserValidationResult {
    return attributeBrowserResult(context.browserBaseline, result);
  }

  private browserSessionObserver(
    context: ArenaContext,
    label: string,
    contestantId?: ContestantId,
  ): Pick<
    Parameters<typeof executeBrowserValidation>[0],
    "onSessionStarted" | "onSessionFinished"
  > {
    return {
      onSessionStarted: (activity) =>
        this.emit(context, {
          type: "browser_session_started",
          ...activity,
          label,
          ...(contestantId ? { contestantId } : {}),
        }),
      onSessionFinished: ({ sessionId }) =>
        this.emit(context, {
          type: "browser_session_finished",
          sessionId,
        }),
    };
  }

  /** Spreadable `validateAttack` option, so the closure is built exactly once. */
  private browserValidatorOption(
    context: ArenaContext,
    attack: Attack,
  ): Pick<Parameters<typeof validateAttack>[0], "validateBrowser"> {
    const validateBrowser = this.browserProbeValidator(context, attack.id, {
      ...(attack.origin.kind === "contestant"
        ? { author: attack.origin.contestant }
        : {}),
      ...(attack.targets[0] ? { target: attack.targets[0] } : {}),
    });
    return validateBrowser ? { validateBrowser } : {};
  }

  private browserProbeValidator(
    context: ArenaContext,
    attackId: string,
    contestantsBySubject: Partial<
      Record<"author" | "target", ContestantId>
    > = {},
  ):
    | ((
        worktree: string,
        probe: NonNullable<Attack["browserProbe"]>,
        subject: "baseline" | "author" | "target",
        nativeSuiteIdentityPaths: string[],
      ) => Promise<BrowserValidationResult>)
    | undefined {
    const validation = context.runSpec.browserValidation;
    if (!validation) return undefined;
    const adapter = validation.profile
      ? this.dependencies.browserAdapters?.[validation.profile.runner]
      : undefined;
    return async (worktree, probe, subject, nativeSuiteIdentityPaths) => {
      const invocationKey = `${attackId}:${subject}`;
      const invocation =
        (this.browserProbeInvocationCounts.get(invocationKey) ?? 0) + 1;
      this.browserProbeInvocationCounts.set(invocationKey, invocation);
      const patchDigest = sha256(
        (
          await Promise.all(
            nativeSuiteIdentityPaths.map(async (patchPath) =>
              sha256(await readFile(patchPath)),
            ),
          )
        ).join("\0"),
      );
      const result = this.attributeBrowserResult(
        context,
        await executeBrowserValidation({
          plan: validation,
          decision: validation.decision,
          ...(adapter ? { adapter } : {}),
          worktree,
          artifactDirectory: context.store.resolve(
            `browser/attacks/${attackId}/${subject}-${String(invocation)}`,
          ),
          selectedProbes: [probe],
          nativeSuiteCache: this.browserNativeSuiteCache,
          nativeSuiteCacheKey: sha256(
            `${validation.profile?.testCommand ?? "unavailable"}\0${patchDigest}`,
          ),
          approvedOrigins: validation.approvedScopes
            .filter((scope) => scope.startsWith("origin:"))
            .map((scope) => scope.slice("origin:".length)),
          dynamicLoopbackApproved: validation.approvedScopes.some(
            (scope) =>
              scope.startsWith("loopback:") && scope.endsWith(":dynamic"),
          ),
          timeoutMs: context.config.limits.attackMs,
          ...this.browserSessionObserver(
            context,
            `Attack ${attackId} · ${subject}`,
            subject === "baseline" ? undefined : contestantsBySubject[subject],
          ),
          signal: context.controller.signal,
        }),
      );
      const resultManifestPath = await context.store.writeJson(
        `browser/attacks/${attackId}/${subject}-${String(invocation)}-result.json`,
        result,
      );
      return BrowserValidationResultSchema.parse({
        ...result,
        artifacts: [
          ...result.artifacts,
          {
            kind: "result_manifest",
            path: resultManifestPath,
            failureOnly: false,
          },
        ],
      });
    };
  }

  private shouldStop(context: ArenaContext): boolean {
    const active = context.config.agents.filter(
      (agent) => getContestant(context.state, agent).status !== "eliminated",
    );
    return active.length <= 1;
  }

  private resolvedHandoffPermissions(
    context: ArenaContext,
  ): ResolvedPermissionProjection {
    return projectResolvedPermissions({
      policy: context.permissions,
      now: this.now(),
      ...(context.permissions.reducedValidationAccepted
        ? {
            reducedValidation: {
              accepted: true,
              assessmentDigest: sha256(
                `${context.state.runId}:reduced-validation`,
              ),
              omittedCheckIds: [],
            },
          }
        : {}),
    });
  }

  private async runTargetedHandoffReview(
    context: ArenaContext,
    options: {
      agent: ContestantId;
      target: ContestantId;
      round: RoundId;
      selection: ReturnType<typeof selectMethods>;
      worktree: string;
      targetSnapshot: string;
      contestantFeedback: ContestantFeedback;
      reason: unknown;
      promptSuffix: string;
    },
  ): Promise<{
    invocation: AgentInvocation;
    findings: HandoffFindingPayload[];
    outcome: "valid" | "valid_empty";
    sectionOutcomes: Record<
      string,
      "valid" | "valid_empty" | "partial" | "invalid"
    >;
    rawArtifactPath: string;
    parsedArtifactPath: string;
    startedAt: string;
    finishedAt: string;
    salvagedAtDeadline: boolean;
  }> {
    await removeSubmission(options.worktree);
    const prompt = `${composeAttackReviewPrompt({
      agent: options.agent,
      target: options.target,
      round: options.round,
      ...(this.lowSignalPivotInstruction(context, options.round)
        ? {
            roundPivotInstruction: this.lowSignalPivotInstruction(
              context,
              options.round,
            )!,
          }
        : {}),
      runSpec: context.runSpec,
      config: context.config,
      permissions: context.permissions,
      methodSelection: options.selection,
      contestantFeedback: options.contestantFeedback,
      ...(this.extensionScope(context, options.round)
        ? { priorOutcomes: this.extensionScope(context, options.round)! }
        : {}),
      deadlineAt: this.deadlineAfter(context.config.limits.reviewMs),
    })}\n\n${options.promptSuffix}\n${JSON.stringify(options.reason)}`;
    const promptPath = await context.store.writeText(
      `prompts/round-${String(options.round)}-review-${options.agent}-${options.promptSuffix.includes("blocker") ? "blocker" : "validation"}-refresh.md`,
      prompt,
    );
    const startedAt = this.now().toISOString();
    const invocation = await this.adapterFor(context, options.agent).review({
      worktree: options.worktree,
      contestantId: options.agent,
      prompt,
      promptPath,
      transcriptPrefix: context.store.resolve(
        `logs/round-${String(options.round)}-review-${options.agent}-${options.promptSuffix.includes("blocker") ? "blocker" : "validation"}-refresh`,
      ),
      timeoutMs: context.config.limits.reviewMs,
      signal: context.controller.signal,
      round: options.round,
      opponent: options.target,
      observer: context.observer,
    });
    const finishedAt = this.now().toISOString();
    if (invocation.status !== "succeeded" && invocation.status !== "timed_out")
      throw new Error(`Targeted handoff review refresh ${invocation.status}`);
    const captured = await this.persistProviderSubmission(context, {
      worktree: options.worktree,
      sourceName: ".agent-arena-submission.json",
      round: options.round,
      phase: "review",
      actor: `${options.agent}-${options.promptSuffix.includes("blocker") ? "blocker" : "validation"}-refresh`,
      kind: "review",
    });
    invocation.submissionPath = captured.parsedPath;
    if (
      captured.parsed.outcome !== "valid" &&
      captured.parsed.outcome !== "valid_empty"
    )
      throw new Error("Targeted handoff review refresh was invalid");
    if (invocation.status === "timed_out") {
      await this.recordFailureAttempt(context, {
        stage: "model_invocation",
        subject: `targeted-review-deadline:${String(options.round)}:${options.agent}->${options.target}`,
        category: "timeout",
        attempt: 1,
        startedAt,
        finishedAt,
        status: "succeeded",
        contestantId: options.agent,
        laneId: `round-${String(options.round)}:${options.agent}->${options.target}`,
        terminalDisposition: "recovered",
        diagnosticArtifactRefs: [
          captured.rawPath,
          captured.parsedPath,
          ...(invocation.command
            ? [
                invocation.command.stdoutPath,
                invocation.command.stderrPath,
                ...(invocation.command.providerDiagnostics?.eventLogPath
                  ? [invocation.command.providerDiagnostics.eventLogPath]
                  : []),
              ]
            : []),
        ],
      });
    }
    const submission = captured.parsed.value as {
      version: 2;
      findings: HandoffFindingPayload[];
    };
    await removeSubmission(options.worktree);
    const changedPaths = await context.worktrees.changedPathsSinceSnapshot(
      options.worktree,
      options.targetSnapshot,
    );
    if (changedPaths.length > 0)
      throw new Error(
        `Read-only targeted refresh changed worktree paths: ${changedPaths.join(", ")}`,
      );
    return {
      invocation,
      findings: submission.findings,
      outcome: captured.parsed.outcome,
      sectionOutcomes: Object.fromEntries(
        Object.entries(captured.parsed.sections).map(([key, section]) => [
          key,
          section.outcome,
        ]),
      ),
      rawArtifactPath: captured.rawPath,
      parsedArtifactPath: captured.parsedPath,
      startedAt,
      finishedAt,
      salvagedAtDeadline: invocation.status === "timed_out",
    };
  }

  private async refreshOversizedHandoff(
    context: ArenaContext,
    options: {
      reviewer: ContestantId;
      target: ContestantId;
      round: RoundId;
      selection: ReturnType<typeof selectMethods>;
      worktree: string;
      targetSnapshot: string;
      targetIdentity: EvidenceHandoffLane["targetSnapshot"];
      contestantFeedback: ContestantFeedback;
      blocker: Extract<
        ReturnType<typeof buildEvidenceHandoffPacket>,
        { status: "handoff_blocked" }
      >["blocker"];
    },
  ): Promise<EvidenceHandoffLane | undefined> {
    const roundId = `round_${String(options.round)}`;
    const laneId = `${options.reviewer}-to-${options.target}`;
    const blockerPath = `rounds/${roundId}/handoffs/${laneId}/blockers/${options.blocker.packet_id}.json`;
    await context.store.writeImmutableJson(blockerPath, options.blocker);
    const refreshRequired = {
      version: 2 as const,
      record_id: stableId(
        "handoff-packet-size-blocked",
        options.blocker.packet_id,
      ),
      previous_record_id: null,
      run_id: context.state.runId,
      round_id: roundId,
      lane_id: laneId,
      reviewer_slot: options.reviewer,
      target_slot: options.target,
      packet_id: options.blocker.packet_id,
      packet_digest: null,
      state: "refresh_required" as const,
      event: "blocking" as const,
      reason_code: "packet_size",
      attempt: 1 as const,
      artifact_pointers: [],
      diagnostic_pointer: null,
      recorded_at: this.now().toISOString(),
    } satisfies HandoffLifecycleRecord;
    await persistHandoffLifecycleRecord(context.store, refreshRequired);

    let refreshedReview: Awaited<
      ReturnType<RoundEngine["runTargetedHandoffReview"]>
    >;
    try {
      refreshedReview = await this.runTargetedHandoffReview(context, {
        agent: options.reviewer,
        target: options.target,
        round: options.round,
        selection: options.selection,
        worktree: options.worktree,
        targetSnapshot: options.targetSnapshot,
        contestantFeedback: options.contestantFeedback,
        reason: options.blocker,
        promptSuffix:
          "# Targeted packet-size blocker refresh\nThe prior valid review could not fit in a nonempty packet. Return a smaller focused v2 review for the same frozen target and policy.",
      });
    } catch (error) {
      const coverageLoss = {
        ...refreshRequired,
        record_id: stableId(
          "handoff-packet-size-refresh-failed",
          options.blocker.packet_id,
        ),
        previous_record_id: refreshRequired.record_id,
        state: "coverage_loss" as const,
        event: "coverage_loss" as const,
        reason_code: "packet_size_refresh_failed",
        attempt: 2 as const,
        recorded_at: this.now().toISOString(),
      } satisfies HandoffLifecycleRecord;
      await persistHandoffLifecycleRecord(context.store, coverageLoss);
      context.state.warnings.push(
        `Trusted handoff packet-size refresh failed for ${options.reviewer} against ${options.target}; lane lost coverage without a score effect: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }

    const permissionProjection = this.resolvedHandoffPermissions(context);
    const refreshed = buildEvidenceHandoffPacket({
      runId: context.state.runId,
      roundId,
      reviewerSlot: options.reviewer,
      targetSlot: options.target,
      targetSnapshot: options.targetIdentity,
      permissionProjection,
      findings: refreshedReview.findings,
      taskSourceIds: context.runSpec.task.sources.map((source) => source.id),
      capabilityIds: context.permissions.capabilities.map(
        (capability) => capability.id,
      ),
    });
    if (refreshed.status !== "packet_created") {
      await context.store.writeImmutableJson(
        `rounds/${roundId}/handoffs/${laneId}/blockers/${refreshed.blocker.packet_id}.json`,
        refreshed.blocker,
      );
      const coverageLoss = {
        ...refreshRequired,
        record_id: stableId(
          "handoff-packet-size-refresh-oversized",
          options.blocker.packet_id,
        ),
        previous_record_id: refreshRequired.record_id,
        state: "coverage_loss" as const,
        event: "coverage_loss" as const,
        reason_code: "refresh_packet_oversized",
        attempt: 2 as const,
        recorded_at: this.now().toISOString(),
      } satisfies HandoffLifecycleRecord;
      await persistHandoffLifecycleRecord(context.store, coverageLoss);
      context.state.warnings.push(
        `Trusted handoff packet-size refresh remained oversized for ${options.reviewer} against ${options.target}; lane lost coverage without a score effect`,
      );
      return undefined;
    }

    const packetPointer = await persistEvidenceHandoffPacket(
      context.store,
      roundId,
      laneId,
      refreshed.packet,
    );
    const validation = validateEvidenceHandoffPacket({
      packet: refreshed.packet,
      canonicalBytes: refreshed.canonicalBytes,
      expected: {
        runId: context.state.runId,
        roundId,
        reviewerSlot: options.reviewer,
        targetSlot: options.target,
        targetSnapshot: options.targetIdentity,
        permissionProjection,
      },
      sourceFindings: refreshedReview.findings,
      taskSourceIds: context.runSpec.task.sources.map((source) => source.id),
      capabilityIds: context.permissions.capabilities.map(
        (capability) => capability.id,
      ),
    });
    await persistHandoffValidationOutcome(
      context.store,
      roundId,
      laneId,
      stableId("packet-size-refresh-validation", refreshed.packet.packet_id),
      validation,
    );
    if (
      validation.status !== "packet_valid" &&
      validation.status !== "packet_valid_empty"
    ) {
      const coverageLoss = {
        ...refreshRequired,
        record_id: stableId(
          "handoff-packet-size-refresh-invalid",
          options.blocker.packet_id,
        ),
        previous_record_id: refreshRequired.record_id,
        state: "coverage_loss" as const,
        event: "coverage_loss" as const,
        reason_code:
          "diagnostic_code" in validation
            ? validation.diagnostic_code
            : validation.status,
        attempt: 2 as const,
        recorded_at: this.now().toISOString(),
      } satisfies HandoffLifecycleRecord;
      await persistHandoffLifecycleRecord(context.store, coverageLoss);
      context.state.warnings.push(
        `Trusted handoff packet-size refresh remained invalid for ${options.reviewer} against ${options.target}; lane lost coverage without a score effect`,
      );
      return undefined;
    }

    const packet = requireConsumableEvidenceHandoff(
      refreshed.packet,
      validation,
    );
    const lifecycle = {
      ...refreshRequired,
      record_id: stableId(
        "handoff-packet-size-refreshed",
        refreshed.packet.packet_id,
      ),
      previous_record_id: refreshRequired.record_id,
      packet_id: refreshed.packet.packet_id,
      packet_digest: refreshed.packet.packet_digest,
      state: "validated" as const,
      event: "refresh" as const,
      reason_code: "packet_size_refreshed",
      attempt: 2 as const,
      artifact_pointers: [packetPointer],
      recorded_at: this.now().toISOString(),
    } satisfies HandoffLifecycleRecord;
    await persistHandoffLifecycleRecord(context.store, lifecycle);
    context.state.reviewInvocations.push({
      round: options.round,
      reviewer: options.reviewer,
      target: options.target,
      invocation: refreshedReview.invocation,
      submissionStatus: "submitted",
      findingCount: refreshed.packet.findings.length,
      artifactPath: context.store.resolve(packetPointer.path),
      parseOutcome: refreshedReview.outcome,
      sectionOutcomes: refreshedReview.sectionOutcomes,
      rawArtifactPath: refreshedReview.rawArtifactPath,
      parsedArtifactPath: refreshedReview.parsedArtifactPath,
      ...(refreshedReview.salvagedAtDeadline
        ? { salvagedAtDeadline: true }
        : {}),
      diagnosticArtifactRefs: [
        refreshedReview.rawArtifactPath,
        refreshedReview.parsedArtifactPath,
        ...(refreshedReview.invocation.command
          ? [
              refreshedReview.invocation.command.stdoutPath,
              refreshedReview.invocation.command.stderrPath,
              ...(refreshedReview.invocation.command.providerDiagnostics
                ?.eventLogPath
                ? [
                    refreshedReview.invocation.command.providerDiagnostics
                      .eventLogPath,
                  ]
                : []),
            ]
          : []),
      ],
      detail: `Targeted packet-size refresh completed from ${refreshedReview.startedAt} to ${refreshedReview.finishedAt}`,
    });
    return {
      packet,
      canonicalBytes: refreshed.canonicalBytes,
      sourceFindings: refreshedReview.findings,
      targetSnapshot: options.targetIdentity,
      permissionProjection,
      packetPointer,
      lifecycle,
    };
  }

  private async collectAttackReviews(
    context: ArenaContext,
    round: RoundId,
    selection: ReturnType<typeof selectMethods>,
    reviewers: readonly ContestantId[],
    siegeDefender: ContestantId | undefined,
  ): Promise<Map<ContestantId, EvidenceHandoffLane>> {
    const packets = new Map<ContestantId, EvidenceHandoffLane>();
    for (const reviewer of reviewers) {
      const contestant = getContestant(context.state, reviewer);
      const isSiegeAttacker =
        context.config.mode === "siege" && contestant.role === "attacker";
      if (
        !isSiegeAttacker &&
        (contestant.patchSize === 0 ||
          !latestRequiredPass(contestant) ||
          contestant.status === "eliminated" ||
          contestant.status === "failed")
      )
        continue;
      const target = isSiegeAttacker
        ? siegeDefender
        : opponentOf(context.config, reviewer);
      if (!target) throw new Error("Siege is missing its defender");
      const targetContestant = getContestant(context.state, target);
      const targetPatchPath = targetContestant.currentPatchPath;
      if (
        !targetPatchPath ||
        targetContestant.patchSize === 0 ||
        targetContestant.status === "failed"
      )
        continue;
      const targetPatch = await readFile(targetPatchPath);
      const worktree = await this.prepareWorktree(context, {
        name: `round-${String(round)}-review-${reviewer}`,
        subject: `review-worktree:${String(round)}:${reviewer}`,
        patches: [targetPatchPath],
        contestantId: reviewer,
        laneId: `review-${String(round)}-${reviewer}`,
      });
      try {
        const targetSnapshot = await context.worktrees.snapshot(worktree);
        const contestantFeedback = await this.laneFeedback(
          context,
          reviewer,
          round,
          "review",
        );
        const prompt = composeAttackReviewPrompt({
          agent: reviewer,
          target,
          round,
          ...(this.lowSignalPivotInstruction(context, round)
            ? {
                roundPivotInstruction: this.lowSignalPivotInstruction(
                  context,
                  round,
                )!,
              }
            : {}),
          runSpec: context.runSpec,
          config: context.config,
          permissions: context.permissions,
          methodSelection: selection,
          contestantFeedback,
          ...(this.extensionScope(context, round)
            ? { priorOutcomes: this.extensionScope(context, round)! }
            : {}),
          deadlineAt: this.deadlineAfter(context.config.limits.reviewMs),
        });
        const promptPath = await context.store.writeText(
          `prompts/round-${String(round)}-review-${reviewer}.md`,
          prompt,
        );
        let invocation!: AgentInvocation;
        let submissionFailure: FailureRecord | undefined;
        let salvagedAtDeadline = false;
        let finalAttemptStartedAt = this.now().toISOString();
        let finalAttemptFinishedAt = finalAttemptStartedAt;
        for (const attemptNumber of [1, 2] as const) {
          const attemptStartedAt = this.now().toISOString();
          const candidate = await this.adapterFor(context, reviewer).review({
            worktree,
            contestantId: reviewer,
            prompt,
            promptPath,
            transcriptPrefix: context.store.resolve(
              `logs/round-${String(round)}-review-${reviewer}-attempt-${String(attemptNumber)}`,
            ),
            timeoutMs: context.config.limits.reviewMs,
            signal: context.controller.signal,
            round,
            opponent: target,
            observer: context.observer,
          });
          const attemptFinishedAt = this.now().toISOString();
          finalAttemptStartedAt = attemptStartedAt;
          finalAttemptFinishedAt = attemptFinishedAt;
          invocation = candidate;
          let usableSubmission = false;
          if (
            candidate.status === "succeeded" ||
            candidate.status === "timed_out"
          ) {
            try {
              const raw = await readFile(
                path.join(worktree, ".agent-arena-submission.json"),
                "utf8",
              );
              const outcome = parseFaultIsolatedSubmission(
                "review",
                raw,
              ).outcome;
              usableSubmission =
                outcome === "valid" || outcome === "valid_empty";
              salvagedAtDeadline =
                candidate.status === "timed_out" && usableSubmission;
            } catch {
              usableSubmission = false;
            }
          }
          if (usableSubmission || attemptNumber === 2) break;

          let failedCapture:
            | {
                parsed: ParsedSubmission<unknown>;
                rawPath: string;
                parsedPath: string;
              }
            | undefined;
          try {
            failedCapture = await this.persistProviderSubmission(context, {
              worktree,
              sourceName: ".agent-arena-submission.json",
              round,
              phase: "review",
              actor: `${reviewer}-attempt-1`,
              kind: "review",
            });
            candidate.submissionPath = failedCapture.parsedPath;
          } catch {
            // Missing output is represented by the invocation record below.
          }
          context.state.reviewInvocations.push({
            round,
            reviewer,
            target,
            invocation: candidate,
            submissionStatus: failedCapture ? "invalid_submission" : "not_run",
            findingCount: 0,
            ...(failedCapture
              ? {
                  parseOutcome: failedCapture.parsed.outcome,
                  rawArtifactPath: failedCapture.rawPath,
                  parsedArtifactPath: failedCapture.parsedPath,
                }
              : {}),
            detail: `Review generation ${candidate.status}; targeted retry followed`,
          });
          submissionFailure = await this.recordSubmissionAttempt(context, {
            round,
            actor: reviewer,
            target,
            phase: "review",
            attempt: 1,
            startedAt: attemptStartedAt,
            finishedAt: attemptFinishedAt,
            status: "failed",
            diagnosticArtifactRefs: [
              ...(failedCapture
                ? [failedCapture.rawPath, failedCapture.parsedPath]
                : []),
              ...(candidate.command
                ? [
                    candidate.command.stdoutPath,
                    candidate.command.stderrPath,
                    ...(candidate.command.providerDiagnostics?.eventLogPath
                      ? [candidate.command.providerDiagnostics.eventLogPath]
                      : []),
                  ]
                : []),
            ],
            cause: failedCapture
              ? JSON.stringify(failedCapture.parsed.rejections)
              : candidate.status,
          });
          await removeSubmission(worktree);
          assertTargetedRetryAllowed(attemptNumber);
        }
        invocation.contestantId = reviewer;
        invocation.role = contestant.role;
        if (invocation.status !== "succeeded" && !salvagedAtDeadline) {
          if (submissionFailure) {
            await this.recordSubmissionAttempt(context, {
              round,
              actor: reviewer,
              target,
              phase: "review",
              attempt: 2,
              startedAt: finalAttemptStartedAt,
              finishedAt: finalAttemptFinishedAt,
              status: "failed",
              diagnosticArtifactRefs: [
                ...(invocation.command
                  ? [
                      invocation.command.stdoutPath,
                      invocation.command.stderrPath,
                      ...(invocation.command.providerDiagnostics?.eventLogPath
                        ? [invocation.command.providerDiagnostics.eventLogPath]
                        : []),
                    ]
                  : []),
              ],
              cause: invocation.status,
              existing: submissionFailure,
              terminalDisposition: "coverage_lost",
            });
          }
          context.state.reviewInvocations.push({
            round,
            reviewer,
            target,
            invocation,
            submissionStatus: "not_run",
            findingCount: 0,
            diagnosticArtifactRefs: [
              ...(invocation.command
                ? [
                    invocation.command.stdoutPath,
                    invocation.command.stderrPath,
                    ...(invocation.command.providerDiagnostics?.eventLogPath
                      ? [invocation.command.providerDiagnostics.eventLogPath]
                      : []),
                  ]
                : []),
            ],
            detail: `Review generation ${invocation.status}`,
          });
          context.state.warnings.push(
            `Review generation ${invocation.status} for ${reviewer} against ${target}; test generation received an empty review packet`,
          );
          if (
            this.recordProviderFailure(context, {
              contestantId: reviewer,
              stage: "review",
              ...(typeof round === "number" ? { round } : {}),
              invocation,
              reason: `Review provider failure persisted after the targeted retry for ${reviewer} against ${target}`,
            })
          )
            throw new Error(context.state.providerFailure?.reason);
          continue;
        }
        try {
          const captured = await this.persistProviderSubmission(context, {
            worktree,
            sourceName: ".agent-arena-submission.json",
            round,
            phase: "review",
            actor: reviewer,
            kind: "review",
          });
          invocation.submissionPath = captured.parsedPath;
          if (submissionFailure) {
            const recovered =
              captured.parsed.outcome === "valid" ||
              captured.parsed.outcome === "valid_empty";
            submissionFailure = await this.recordSubmissionAttempt(context, {
              round,
              actor: reviewer,
              target,
              phase: "review",
              attempt: 2,
              startedAt: finalAttemptStartedAt,
              finishedAt: finalAttemptFinishedAt,
              status: recovered ? "succeeded" : "failed",
              diagnosticArtifactRefs: [
                captured.rawPath,
                captured.parsedPath,
                ...(invocation.command
                  ? [
                      invocation.command.stdoutPath,
                      invocation.command.stderrPath,
                      ...(invocation.command.providerDiagnostics?.eventLogPath
                        ? [invocation.command.providerDiagnostics.eventLogPath]
                        : []),
                    ]
                  : []),
              ],
              cause: JSON.stringify(captured.parsed.rejections),
              existing: submissionFailure,
              terminalDisposition: recovered ? "recovered" : "coverage_lost",
            });
          }
          if (
            captured.parsed.outcome !== "valid" &&
            captured.parsed.outcome !== "valid_empty"
          ) {
            await removeSubmission(worktree);
            context.state.reviewInvocations.push({
              round,
              reviewer,
              target,
              invocation,
              submissionStatus:
                captured.parsed.outcome === "partial"
                  ? "partially_submitted"
                  : "invalid_submission",
              findingCount: 0,
              parseOutcome: captured.parsed.outcome,
              sectionOutcomes: Object.fromEntries(
                Object.entries(captured.parsed.sections).map(
                  ([key, section]) => [key, section.outcome],
                ),
              ),
              rawArtifactPath: captured.rawPath,
              parsedArtifactPath: captured.parsedPath,
              detail: "Review submission remained invalid after targeted retry",
            });
            context.state.warnings.push(
              `Review submission from ${reviewer} against ${target} remained invalid after targeted retry; lane lost coverage without creating a handoff packet`,
            );
            continue;
          }
          if (salvagedAtDeadline) {
            await this.recordFailureAttempt(context, {
              stage: "model_invocation",
              subject: `review-deadline:${String(round)}:${reviewer}->${target}`,
              category: "timeout",
              attempt: 1,
              startedAt: finalAttemptStartedAt,
              finishedAt: finalAttemptFinishedAt,
              status: "succeeded",
              contestantId: reviewer,
              laneId: `round-${String(round)}:${reviewer}->${target}`,
              terminalDisposition: "recovered",
              diagnosticArtifactRefs: [
                captured.rawPath,
                captured.parsedPath,
                ...(invocation.command
                  ? [
                      invocation.command.stdoutPath,
                      invocation.command.stderrPath,
                      ...(invocation.command.providerDiagnostics?.eventLogPath
                        ? [invocation.command.providerDiagnostics.eventLogPath]
                        : []),
                    ]
                  : []),
              ],
            });
          }
          const submission = captured.parsed.value as {
            version: 2;
            findings: HandoffFindingPayload[];
          };
          await removeSubmission(worktree);
          const changedPaths =
            await context.worktrees.changedPathsSinceSnapshot(
              worktree,
              targetSnapshot,
            );
          if (changedPaths.length > 0) {
            throw new Error(
              `Read-only review changed worktree paths: ${changedPaths.join(", ")}`,
            );
          }
          const roundId = `round_${String(round)}`;
          const laneId = `${reviewer}-to-${target}`;
          const targetIdentity = {
            base_commit: context.runSpec.baseCommit,
            frozen_patch_sha256: sha256(targetPatch),
            frozen_git_tree_id: targetSnapshot,
          };
          const permissionProjection = this.resolvedHandoffPermissions(context);
          const built = buildEvidenceHandoffPacket({
            runId: context.state.runId,
            roundId,
            reviewerSlot: reviewer,
            targetSlot: target,
            targetSnapshot: targetIdentity,
            permissionProjection,
            findings: submission.findings,
            taskSourceIds: context.runSpec.task.sources.map(
              (source) => source.id,
            ),
            capabilityIds: context.permissions.capabilities.map(
              (capability) => capability.id,
            ),
          });
          if (built.status !== "packet_created") {
            context.state.reviewInvocations.push({
              round,
              reviewer,
              target,
              invocation,
              submissionStatus: "submitted",
              findingCount: submission.findings.length,
              parseOutcome: captured.parsed.outcome,
              sectionOutcomes: Object.fromEntries(
                Object.entries(captured.parsed.sections).map(
                  ([key, section]) => [key, section.outcome],
                ),
              ),
              rawArtifactPath: captured.rawPath,
              parsedArtifactPath: captured.parsedPath,
              detail:
                "Valid review exceeded the packet ceiling; targeted packet-size refresh followed",
            });
            const refreshedLane = await this.refreshOversizedHandoff(context, {
              reviewer,
              target,
              round,
              selection,
              worktree,
              targetSnapshot,
              targetIdentity,
              contestantFeedback,
              blocker: built.blocker,
            });
            if (refreshedLane) packets.set(reviewer, refreshedLane);
            continue;
          }
          const packetPointer = await persistEvidenceHandoffPacket(
            context.store,
            roundId,
            laneId,
            built.packet,
          );
          const createdLifecycle = {
            version: 2 as const,
            record_id: stableId("handoff-created", built.packet.packet_id),
            previous_record_id: null,
            run_id: context.state.runId,
            round_id: roundId,
            lane_id: laneId,
            reviewer_slot: reviewer,
            target_slot: target,
            packet_id: built.packet.packet_id,
            packet_digest: built.packet.packet_digest,
            state: "created" as const,
            event: "creation" as const,
            reason_code: "review_valid",
            attempt: 1 as const,
            artifact_pointers: [packetPointer],
            diagnostic_pointer: null,
            recorded_at: this.now().toISOString(),
          };
          await persistHandoffLifecycleRecord(context.store, createdLifecycle);
          packets.set(reviewer, {
            packet: built.packet,
            canonicalBytes: built.canonicalBytes,
            sourceFindings: submission.findings,
            targetSnapshot: targetIdentity,
            permissionProjection,
            packetPointer,
            lifecycle: createdLifecycle,
          });
          const artifactPath = context.store.resolve(packetPointer.path);
          context.state.reviewInvocations.push({
            round,
            reviewer,
            target,
            invocation,
            submissionStatus: "submitted",
            findingCount: built.packet.findings.length,
            artifactPath,
            parseOutcome: captured.parsed.outcome,
            sectionOutcomes: Object.fromEntries(
              Object.entries(captured.parsed.sections).map(([key, section]) => [
                key,
                section.outcome,
              ]),
            ),
            rawArtifactPath: captured.rawPath,
            parsedArtifactPath: captured.parsedPath,
            ...(salvagedAtDeadline ? { salvagedAtDeadline: true } : {}),
            diagnosticArtifactRefs: [
              captured.rawPath,
              captured.parsedPath,
              ...(invocation.command
                ? [
                    invocation.command.stdoutPath,
                    invocation.command.stderrPath,
                    ...(invocation.command.providerDiagnostics?.eventLogPath
                      ? [invocation.command.providerDiagnostics.eventLogPath]
                      : []),
                  ]
                : []),
            ],
          });
          if (captured.parsed.rejections.length) {
            const warning = this.submissionWarning(
              `Review submission from ${reviewer} against ${target} was partially usable`,
              captured.parsed,
              captured.rawPath,
              captured.parsedPath,
            );
            context.state.warnings.push(warning);
            this.progress(warning);
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          if (submissionFailure?.attempts.length === 1) {
            await this.recordSubmissionAttempt(context, {
              round,
              actor: reviewer,
              target,
              phase: "review",
              attempt: 2,
              startedAt: finalAttemptStartedAt,
              finishedAt: finalAttemptFinishedAt,
              status: "failed",
              diagnosticArtifactRefs: [],
              cause: detail,
              existing: submissionFailure,
              terminalDisposition: "coverage_lost",
            });
          }
          context.state.reviewInvocations.push({
            round,
            reviewer,
            target,
            invocation,
            submissionStatus:
              (error as NodeJS.ErrnoException).code === "ENOENT"
                ? "not_submitted"
                : "invalid_submission",
            findingCount: 0,
            detail,
          });
          context.state.warnings.push(
            `Review submission from ${reviewer} against ${target} was not usable: ${detail}; test generation received an empty review packet`,
          );
        }
      } catch (error) {
        if (context.state.providerFailure) throw error;
        context.state.warnings.push(
          `Review collection failed for ${reviewer}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await context.worktrees.remove(worktree);
      }
    }
    await this.persist(context);
    return packets;
  }

  private recordingVerifier(
    context: ArenaContext,
    round: RoundId,
  ): AttackVerifier {
    const verifier = this.dependencies.verifier;
    return {
      id: verifier.id,
      assess: async (input) => {
        const startedAt = this.now().toISOString();
        const id = stableId(
          "invocation",
          String(round),
          "verification",
          String(context.roundInvocations.length),
        );
        try {
          const verdict = await verifier.assess({
            ...input,
            observer: context.observer,
          });
          context.roundInvocations.push({
            id,
            kind: "verification",
            actor: "verifier",
            status: "succeeded",
            startedAt,
            finishedAt: this.now().toISOString(),
            artifactPaths: [input.promptPath, input.transcriptPrefix],
            ...(verdict.tokenTelemetry
              ? { tokenTelemetry: verdict.tokenTelemetry }
              : {}),
          });
          return verdict;
        } catch (error) {
          context.roundInvocations.push({
            id,
            kind: "verification",
            actor: "verifier",
            status: context.controller.signal.aborted
              ? "cancelled"
              : this.isInfrastructureError(error)
                ? "infrastructure_error"
                : "failed",
            startedAt,
            finishedAt: this.now().toISOString(),
            artifactPaths: [input.promptPath, input.transcriptPrefix],
          });
          throw error;
        }
      },
      ...(verifier.adjudicate
        ? {
            adjudicate: async (input) => {
              const startedAt = this.now().toISOString();
              const id = stableId(
                "invocation",
                String(round),
                "judge-fallback",
                String(context.roundInvocations.length),
              );
              try {
                const verdict = await verifier.adjudicate!({
                  ...input,
                  observer: context.observer,
                });
                context.roundInvocations.push({
                  id,
                  kind: "verification",
                  actor: "verifier",
                  status: "succeeded",
                  startedAt,
                  finishedAt: this.now().toISOString(),
                  artifactPaths: [input.promptPath, input.transcriptPrefix],
                  ...(verdict.tokenTelemetry
                    ? { tokenTelemetry: verdict.tokenTelemetry }
                    : {}),
                });
                return verdict;
              } catch (error) {
                context.roundInvocations.push({
                  id,
                  kind: "verification",
                  actor: "verifier",
                  status: context.controller.signal.aborted
                    ? "cancelled"
                    : this.isInfrastructureError(error)
                      ? "infrastructure_error"
                      : "failed",
                  startedAt,
                  finishedAt: this.now().toISOString(),
                  artifactPaths: [input.promptPath, input.transcriptPrefix],
                });
                throw error;
              }
            },
          }
        : {}),
      ...(verifier.assessRepair
        ? {
            assessRepair: async (input) => {
              const startedAt = this.now().toISOString();
              const id = stableId(
                "invocation",
                String(round),
                "repair-judgment",
                String(context.roundInvocations.length),
              );
              try {
                const verdict = await verifier.assessRepair!({
                  ...input,
                  observer: context.observer,
                });
                context.roundInvocations.push({
                  id,
                  kind: "verification",
                  actor: "verifier",
                  status: "succeeded",
                  startedAt,
                  finishedAt: this.now().toISOString(),
                  artifactPaths: [input.promptPath, input.transcriptPrefix],
                  ...(verdict.tokenTelemetry
                    ? { tokenTelemetry: verdict.tokenTelemetry }
                    : {}),
                });
                return verdict;
              } catch (error) {
                context.roundInvocations.push({
                  id,
                  kind: "verification",
                  actor: "verifier",
                  status: context.controller.signal.aborted
                    ? "cancelled"
                    : this.isInfrastructureError(error)
                      ? "infrastructure_error"
                      : "failed",
                  startedAt,
                  finishedAt: this.now().toISOString(),
                  artifactPaths: [input.promptPath, input.transcriptPrefix],
                });
                throw error;
              }
            },
          }
        : {}),
    };
  }

  private async recordCaseGeneration<T>(
    context: ArenaContext,
    round: RoundId,
    artifactPaths: string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = this.now().toISOString();
    const id = stableId(
      "invocation",
      String(round),
      "case-generation",
      String(context.roundInvocations.length),
    );
    try {
      const value = await operation();
      context.roundInvocations.push({
        id,
        kind: "case_generation",
        actor: "verifier",
        status: "succeeded",
        startedAt,
        finishedAt: this.now().toISOString(),
        artifactPaths,
      });
      return value;
    } catch (error) {
      context.roundInvocations.push({
        id,
        kind: "case_generation",
        actor: "verifier",
        status: context.controller.signal.aborted
          ? "cancelled"
          : this.isInfrastructureError(error)
            ? "infrastructure_error"
            : "failed",
        startedAt,
        finishedAt: this.now().toISOString(),
        artifactPaths,
      });
      throw error;
    }
  }

  private async buildNeutralCase(
    context: ArenaContext,
    entry: AttackSubmission["attacks"][number],
    round: RoundId,
    attacker: ContestantId,
    artifactKey?: string,
    attemptNumber: 1 | 2 = 1,
    failureRecord?: FailureRecord,
  ): Promise<
    | {
        focusedCommand: string;
        patchPath: string;
        requiredCapabilities: string[];
      }
    | undefined
  > {
    if (!this.dependencies.caseBuilder) {
      context.state.warnings.push(
        `No neutral case judge is configured; description from ${attacker} was not executed`,
      );
      return undefined;
    }
    const startedAt = this.now().toISOString();
    let worktree: string | undefined;
    let shouldRetry: boolean;
    try {
      worktree = await this.prepareWorktree(context, {
        name: `case-judge-${String(round)}-${attacker}-${String(entry.rank)}${artifactKey ? `-${artifactKey}` : ""}-attempt-${String(attemptNumber)}`,
        subject: `case-judge-worktree:${String(round)}:${attacker}:${String(entry.rank)}${artifactKey ? `:${artifactKey}` : ""}:attempt-${String(attemptNumber)}`,
        contestantId: attacker,
      });
      const snapshot = await context.worktrees.snapshot(worktree);
      const prompt = composeNeutralCasePrompt({
        runSpec: context.runSpec,
        permissions: context.permissions,
        failure: entry,
        outputPath: path.join(worktree, ".agent-arena-cases.json"),
      });
      const transcriptPrefix = context.store.resolve(
        `logs/case-judge-${String(round)}-${attacker}-${String(entry.rank)}${artifactKey ? `-${artifactKey}` : ""}-attempt-${String(attemptNumber)}`,
      );
      const caseArtifactPaths = [transcriptPrefix];
      const submission = await this.recordCaseGeneration(
        context,
        round,
        caseArtifactPaths,
        () =>
          this.dependencies.caseBuilder!.build({
            worktree: worktree!,
            prompt,
            timeoutMs: context.config.limits.attackMs,
            transcriptPrefix,
            signal: context.controller.signal,
            round: typeof round === "number" ? round : 3,
          }),
      );
      const captured = await this.persistReturnedSubmission(context, {
        submission,
        round,
        phase: "case-generation",
        actor: `${attacker}-rank-${String(entry.rank)}${artifactKey ? `-${artifactKey}` : ""}-attempt-${String(attemptNumber)}`,
        kind: "case",
      });
      caseArtifactPaths.push(captured.rawPath, captured.parsedPath);
      if (captured.parsed.rejections.length) {
        const warning = this.submissionWarning(
          `Neutral case output for ${attacker}'s rank ${String(entry.rank)} was partially usable`,
          captured.parsed,
          captured.rawPath,
          captured.parsedPath,
        );
        context.state.warnings.push(warning);
        this.progress(warning);
      }
      const proposal = (captured.parsed.value as CaseSubmission).cases[0];
      if (!proposal) throw new Error("Neutral case submission was not usable");
      assertDirectCapabilitiesAllowed(
        context.permissions,
        entry.requiredCapabilities,
        proposal.requiredCapabilities,
      );
      const patchPath = context.store.resolve(
        `cases/round-${String(round)}/${attacker}/${String(entry.rank)}${artifactKey ? `-${artifactKey}` : ""}.diff`,
      );
      await context.worktrees.capturePatchAgainstSnapshot(
        worktree,
        patchPath,
        snapshot,
        proposal.paths,
      );
      if (failureRecord) {
        await this.recordFailureAttempt(context, {
          stage: "model_invocation",
          subject: `case-generation:${String(round)}:${attacker}:${String(entry.rank)}${artifactKey ? `:${artifactKey}` : ""}`,
          category: failureRecord.category,
          attempt: 2,
          startedAt,
          finishedAt: this.now().toISOString(),
          status: "succeeded",
          diagnosticArtifactRefs: caseArtifactPaths,
          contestantId: attacker,
          existing: failureRecord,
          terminalDisposition: "recovered",
        });
      }
      return {
        focusedCommand: proposal.focusedCommand,
        patchPath,
        requiredCapabilities: [
          ...new Set([
            ...entry.requiredCapabilities,
            ...proposal.requiredCapabilities,
          ]),
        ],
      };
    } catch (error) {
      failureRecord = await this.recordFailureAttempt(context, {
        stage: "model_invocation",
        subject: `case-generation:${String(round)}:${attacker}:${String(entry.rank)}${artifactKey ? `:${artifactKey}` : ""}`,
        category:
          failureRecord?.category ??
          (this.isInfrastructureError(error) ? "transport" : "invalid_output"),
        attempt: attemptNumber,
        startedAt,
        finishedAt: this.now().toISOString(),
        status: "failed",
        diagnosticArtifactRefs: [],
        contestantId: attacker,
        ...(failureRecord ? { existing: failureRecord } : {}),
        ...(attemptNumber === 2
          ? { terminalDisposition: "coverage_lost" as const }
          : {}),
      });
      context.state.warnings.push(
        `Neutral case judge could not verify ${attacker}'s rank ${String(entry.rank)} description: ${error instanceof Error ? error.message : String(error)}`,
      );
      shouldRetry = attemptNumber === 1;
    } finally {
      if (worktree) await context.worktrees.remove(worktree);
    }
    if (shouldRetry) {
      assertTargetedRetryAllowed(attemptNumber);
      return this.buildNeutralCase(
        context,
        entry,
        round,
        attacker,
        artifactKey,
        2,
        failureRecord,
      );
    }
    return undefined;
  }

  protected async collectReconciledAttacks(
    context: ArenaContext,
    round: RoundId,
  ): Promise<Attack[]> {
    if (!("reconciliationQueue" in context.state)) return [];
    const pending = context.state.reconciliationQueue.filter(
      (candidate) => candidate.status === "pending",
    );
    if (!pending.length) return [];
    const collected: Attack[] = [];
    const groups = new Map<string, ReconciliationCandidate[]>();
    for (const candidate of pending) {
      const key = candidate.lane === "house" ? "house" : candidate.actor;
      groups.set(key, [...(groups.get(key) ?? []), candidate]);
    }
    for (const [actor, candidates] of groups) {
      const contestantId =
        actor === "house" ? undefined : (actor as ContestantId);
      const target = candidates[0]!.target;
      const targetPatch = contestantId
        ? getContestant(context.state, target).currentPatchPath
        : undefined;
      const worktree = await this.prepareWorktree(context, {
        name: `round-${String(round)}-correction-${actor}`,
        subject: `correction-worktree:${String(round)}:${actor}`,
        patches: targetPatch ? [targetPatch] : [],
        ...(contestantId ? { contestantId } : {}),
        laneId: `correction-${String(round)}-${actor}`,
      });
      let invocation: AgentInvocation | undefined;
      try {
        const outputName =
          actor === "house"
            ? ".agent-arena-house.json"
            : ".agent-arena-submission.json";
        const outputPath = path.join(worktree, outputName);
        const prompt = [
          "# Correction-only reconciliation",
          "This is the second and final attempt for the listed malformed attack entries.",
          "Return one object per candidate ID. Put only missing or previously rejected fields in fields. Previously valid fields are frozen; changing one discards the candidate.",
          "Do not submit new attacks, reviews, or hypotheses.",
          "",
          JSON.stringify(
            candidates.map((candidate) => ({
              candidateId: candidate.id,
              validatedFields: candidate.validatedFields,
              editablePaths: candidate.editablePaths,
              diagnostics: candidate.diagnostics,
            })),
            null,
            2,
          ),
          "",
          `Write {"version":1,"corrections":[{"candidateId":"...","fields":{}}]} to ${outputPath}.`,
        ].join("\n");
        const promptPath = await context.store.writeText(
          `prompts/round-${String(round)}-correction-${actor}.md`,
          prompt,
        );
        if (actor === "house") {
          if (!this.dependencies.houseScout)
            throw new Error("No neutral house lane is configured");
          const startedAt = this.now().toISOString();
          // The house scout's normal return schema is intentionally ignored:
          // its exact correction bytes are parsed below.
          await this.dependencies.houseScout
            .scout({
              worktree,
              prompt,
              timeoutMs: context.config.limits.attackMs,
              transcriptPrefix: context.store.resolve(
                `logs/round-${String(round)}-correction-house`,
              ),
              signal: context.controller.signal,
              round: 3,
            })
            .catch((error) => {
              throw error;
            });
          context.roundInvocations.push({
            id: stableId("invocation", String(round), "correction", "house"),
            kind: "case_generation",
            actor: "verifier",
            status: "succeeded",
            startedAt,
            finishedAt: this.now().toISOString(),
            artifactPaths: [promptPath],
          });
        } else {
          invocation = await this.adapterFor(context, contestantId!).attack({
            worktree,
            contestantId: contestantId!,
            prompt,
            promptPath,
            transcriptPrefix: context.store.resolve(
              `logs/round-${String(round)}-correction-${actor}`,
            ),
            timeoutMs: context.config.limits.attackMs,
            signal: context.controller.signal,
            round,
            opponent: target,
            observer: context.observer,
          });
          if (invocation.status !== "succeeded")
            throw new Error(`Correction invocation ${invocation.status}`);
        }
        const raw = await readFile(outputPath);
        const prefix = `submissions/${String(round)}/correction/${actor}`;
        const rawPath = await context.store.writeImmutableBytes(
          `${prefix}/raw.txt`,
          raw,
        );
        let decoded: unknown;
        try {
          decoded = JSON.parse(raw.toString("utf8"));
        } catch {
          decoded = undefined;
        }
        const corrections =
          decoded &&
          typeof decoded === "object" &&
          !Array.isArray(decoded) &&
          (decoded as Record<string, unknown>).version === 1 &&
          Array.isArray((decoded as Record<string, unknown>).corrections)
            ? ((decoded as Record<string, unknown>).corrections as unknown[])
            : [];
        const correctedRankCounts = new Map<number, number>();
        for (const candidate of candidates.filter(
          (entry) => entry.lane === "contestant",
        )) {
          const match = corrections.find(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              !Array.isArray(entry) &&
              (entry as Record<string, unknown>).candidateId === candidate.id,
          );
          const fields =
            match && typeof match === "object" && !Array.isArray(match)
              ? (match as Record<string, unknown>).fields
              : undefined;
          if (!fields || typeof fields !== "object" || Array.isArray(fields))
            continue;
          const rank =
            (fields as Record<string, unknown>).rank ??
            candidate.validatedFields.rank;
          if (typeof rank === "number")
            correctedRankCounts.set(
              rank,
              (correctedRankCounts.get(rank) ?? 0) + 1,
            );
        }
        const outcomes: Array<Record<string, unknown>> = [];
        for (const candidate of candidates) {
          candidate.attemptCount = 2;
          candidate.correctionRound = round;
          const matches = corrections.filter(
            (entry) =>
              entry &&
              typeof entry === "object" &&
              !Array.isArray(entry) &&
              (entry as Record<string, unknown>).candidateId === candidate.id,
          );
          if (matches.length !== 1) {
            candidate.status = "discarded";
            candidate.discardReason = matches.length
              ? "duplicate_correction"
              : "missing_correction";
            outcomes.push({
              candidateId: candidate.id,
              outcome: "rejected",
              reason: candidate.discardReason,
            });
            continue;
          }
          const fields = (matches[0] as Record<string, unknown>).fields;
          const mergedCorrection = mergeCorrectionFields(
            candidate.validatedFields,
            fields,
          );
          if (!mergedCorrection.accepted) {
            candidate.status = "discarded";
            candidate.discardReason = mergedCorrection.code;
            outcomes.push({
              candidateId: candidate.id,
              outcome: "rejected",
              reason: candidate.discardReason,
            });
            continue;
          }
          const merged = mergedCorrection.value;
          if (
            candidate.lane === "contestant" &&
            typeof merged.rank === "number" &&
            (correctedRankCounts.get(merged.rank) ?? 0) > 1
          ) {
            candidate.status = "discarded";
            candidate.discardReason = "duplicate_rank";
            outcomes.push({
              candidateId: candidate.id,
              outcome: "rejected",
              reason: candidate.discardReason,
            });
            continue;
          }
          const parsed =
            candidate.lane === "house"
              ? parseFaultIsolatedSubmission(
                  "house",
                  JSON.stringify({
                    version: 1,
                    hypotheses: [],
                    attacks: [merged],
                  }),
                )
              : parseFaultIsolatedSubmission(
                  "attack",
                  JSON.stringify({ version: 1, attacks: [merged] }),
                );
          const corrected = parsed.sections.attacks?.accepted[0];
          if (!corrected) {
            candidate.status = "discarded";
            candidate.discardReason = "still_malformed";
            outcomes.push({
              candidateId: candidate.id,
              outcome: "rejected",
              reason: candidate.discardReason,
              diagnostics: parsed.rejections,
            });
            continue;
          }
          const attackEntry =
            candidate.lane === "house"
              ? {
                  ...(corrected as HouseSubmission["attacks"][number]),
                  rank: 1 as const,
                }
              : (corrected as AttackSubmission["attacks"][number]);
          const neutralCase = await this.buildNeutralCase(
            context,
            attackEntry,
            round,
            contestantId ?? "a",
            candidate.id,
          );
          if (!neutralCase) {
            candidate.status = "discarded";
            candidate.discardReason = "case_generation_failed";
            outcomes.push({
              candidateId: candidate.id,
              outcome: "rejected",
              reason: candidate.discardReason,
            });
            continue;
          }
          const attack =
            candidate.lane === "house"
              ? await materializeHouseAttack(
                  {
                    ...(corrected as HouseSubmission["attacks"][number]),
                    focusedCommand: neutralCase.focusedCommand,
                    requiredCapabilities: neutralCase.requiredCapabilities,
                  },
                  {
                    targets: [candidate.target],
                    round,
                    patchPath: neutralCase.patchPath,
                    methodPackId: "reconciliation@1",
                  },
                )
              : await materializeAttack(
                  {
                    ...(corrected as AttackSubmission["attacks"][number]),
                    focusedCommand: neutralCase.focusedCommand,
                    requiredCapabilities: neutralCase.requiredCapabilities,
                  },
                  {
                    author: contestantId!,
                    authorProvider: getContestant(context.state, contestantId!)
                      .provider,
                    target: candidate.target,
                    round,
                    patchPath: neutralCase.patchPath,
                  },
                );
          candidate.status = "corrected";
          candidate.resultingAttackId = attack.id;
          collected.push(attack);
          outcomes.push({
            candidateId: candidate.id,
            outcome: "accepted",
            attackId: attack.id,
          });
        }
        const parsedPath = await context.store.writeImmutableJson(
          `${prefix}/parsed.json`,
          { version: 1, rawSha256: sha256(raw), outcomes },
        );
        for (const candidate of candidates) {
          candidate.correctionRawArtifactPath = rawPath;
          candidate.correctionParsedArtifactPath = parsedPath;
        }
        const correctionOutcome = outcomes.some(
          (outcome) => outcome.outcome === "accepted",
        )
          ? outcomes.some((outcome) => outcome.outcome === "rejected")
            ? "partial"
            : "valid"
          : "invalid";
        context.state.submissionArtifacts.push({
          round,
          phase: "correction",
          actor,
          kind: "correction",
          outcome: correctionOutcome,
          rawSha256: sha256(raw),
          rawArtifactPath: rawPath,
          parsedArtifactPath: parsedPath,
        });
        if (invocation) {
          invocation.submissionPath = parsedPath;
          context.state.attackInvocations.push({
            round,
            attacker: contestantId!,
            target,
            invocation,
            submissionStatus: outcomes.some(
              (outcome) => outcome.outcome === "accepted",
            )
              ? outcomes.some((outcome) => outcome.outcome === "rejected")
                ? "partially_submitted"
                : "submitted"
              : "invalid_submission",
            attackCount: outcomes.filter(
              (outcome) => outcome.outcome === "accepted",
            ).length,
            parseOutcome: outcomes.some(
              (outcome) => outcome.outcome === "accepted",
            )
              ? outcomes.some((outcome) => outcome.outcome === "rejected")
                ? "partial"
                : "valid"
              : "invalid",
            rawArtifactPath: rawPath,
            parsedArtifactPath: parsedPath,
            detail: "Correction-only reconciliation lane",
          });
        }
      } catch (error) {
        for (const candidate of candidates) {
          candidate.attemptCount = 2;
          candidate.correctionRound = round;
          candidate.status = "discarded";
          candidate.discardReason =
            error instanceof Error && error.message.includes("timed_out")
              ? "correction_timeout"
              : "correction_failed";
        }
        context.state.warnings.push(
          `Correction lane ${actor} failed; ${String(candidates.length)} candidate(s) were permanently discarded: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await context.worktrees.remove(worktree);
      }
    }
    return collected;
  }

  private async runRound(context: ArenaContext, round: RoundId): Promise<void> {
    await this.transition(context, "review_attacks", round);
    if (round === 3) {
      const integrationCapabilities =
        context.config.integrationProfile?.capabilityIds ?? [];
      const approved = integrationCapabilities.every(
        (id) =>
          context.permissions.capabilities.find(
            (capability) => capability.id === id,
          )?.status === "approved",
      );
      if (context.config.integrationProfile && approved) {
        const provisioned = await provisionIntegrationProfile({
          config: context.config,
          patches: Object.fromEntries(
            context.config.agents.flatMap((agent) => {
              const patch = getContestant(
                context.state,
                agent,
              ).currentPatchPath;
              return patch ? [[agent, patch]] : [];
            }),
          ),
          worktrees: context.worktrees,
          logRoot: context.store.resolve("logs/integration"),
          signal: context.controller.signal,
          observer: context.observer,
          now: this.now,
          persistFailureRecord: (record) =>
            this.persistFailureRecord(context, record),
          persistFailureAttempt: async (failure) => {
            const subject = `integration-${failure.agent}-${failure.subject}`;
            const existing = context.state.failureRecords.find(
              (record) =>
                record.stage === "service" && record.subject === subject,
            );
            await this.recordFailureAttempt(context, {
              stage: "service",
              subject,
              category: "service_unavailable",
              attempt: failure.attempt,
              startedAt: failure.startedAt,
              finishedAt: failure.finishedAt,
              status: failure.status,
              diagnosticArtifactRefs: failure.diagnosticArtifactRefs,
              contestantId: failure.agent,
              laneId: `integration-${failure.agent}`,
              ...(existing ? { existing } : {}),
              ...(failure.terminalDisposition
                ? { terminalDisposition: failure.terminalDisposition }
                : {}),
            });
          },
        });
        for (const agent of context.config.agents) {
          getContestant(context.state, agent).checks.push(
            ...structuredClone(provisioned.checks),
          );
        }
        if (!provisioned.ready) {
          context.state.warnings.push(
            `${provisioned.reason ?? "Integration profile unavailable"}; round 3 degraded to local probes`,
          );
        }
      } else if (context.config.integrationProfile) {
        context.state.warnings.push(
          "Integration profile capability was denied; round 3 degraded to local probes without a health event",
        );
      }
    }
    const roundStarts = new Map<ContestantId, number>();
    for (const agent of context.config.agents) {
      roundStarts.set(agent, getContestant(context.state, agent).finalHealth);
    }
    const selection = selectMethods(
      round,
      await repositoryFacts(context.config.repositoryRoot),
      context.permissions.capabilities
        .filter((capability) => capability.status === "approved")
        .map((capability) => capability.id),
    );
    const seed = sha256(`${context.state.runId}:${String(round)}`).slice(0, 16);
    const sharedPrompt = composePrompt({
      agent: context.config.agents[0] ?? "a",
      stage: "attack",
      round,
      ...(this.lowSignalPivotInstruction(context, round)
        ? {
            roundPivotInstruction: this.lowSignalPivotInstruction(
              context,
              round,
            )!,
          }
        : {}),
      runSpec: context.runSpec,
      config: context.config,
      permissions: context.permissions,
      methodSelection: selection,
      allowMissingReviewPacket: true,
      deadlineAt: this.deadlineAfter(context.config.limits.attackMs),
    });
    const sharedPromptPath = await context.store.writeText(
      `prompts/round-${String(round)}-common.md`,
      sharedPrompt,
    );
    context.state.promptManifests.push(
      createPromptManifest(
        round,
        selection,
        seed,
        sharedPromptPath,
        sharedPrompt,
      ),
    );

    const collected: Attack[] = [];
    let collectedLegacySubmission = false;
    const siegeAttacker = context.config.contestants.find(
      (contestant) => contestant.role === "attacker",
    );
    const siegeDefender = context.config.contestants.find(
      (contestant) => contestant.role === "defender",
    );
    const collectingAgents =
      round === "reconciliation"
        ? []
        : context.config.mode === "siege" && siegeAttacker
          ? [siegeAttacker.id]
          : context.config.agents;
    const reviewPackets =
      round === "reconciliation"
        ? new Map<ContestantId, EvidenceHandoffLane>()
        : await this.collectAttackReviews(
            context,
            round,
            selection,
            collectingAgents,
            siegeDefender?.id,
          );
    await this.transition(context, "collect_attacks", round);
    for (const agent of collectingAgents) {
      const contestant = getContestant(context.state, agent);
      const isSiegeAttacker =
        context.config.mode === "siege" && contestant.role === "attacker";
      if (
        !isSiegeAttacker &&
        (contestant.patchSize === 0 ||
          !latestRequiredPass(contestant) ||
          contestant.status === "eliminated" ||
          contestant.status === "failed")
      )
        continue;
      const target = isSiegeAttacker
        ? siegeDefender?.id
        : opponentOf(context.config, agent);
      if (!target) throw new Error("Siege is missing its defender");
      const targetContestant = getContestant(context.state, target);
      const targetPatchPath = targetContestant.currentPatchPath;
      if (
        targetContestant.patchSize === 0 ||
        targetContestant.status === "failed"
      )
        continue;
      if (
        (!isSiegeAttacker && !contestant.currentPatchPath) ||
        !targetPatchPath
      )
        continue;
      let worktree = await this.prepareWorktree(context, {
        name: `round-${String(round)}-attack-${agent}`,
        subject: `attack-generation-worktree:${String(round)}:${agent}`,
        patches: [targetPatchPath],
        contestantId: agent,
        laneId: `attack-${String(round)}-${agent}`,
      });
      try {
        let targetSnapshot = await context.worktrees.snapshot(worktree);
        const handoff = reviewPackets.get(agent);
        if (!handoff) {
          context.state.warnings.push(
            `Trusted evidence handoff is missing for ${agent} against ${target}; lane lost coverage without a score effect`,
          );
          continue;
        }
        let currentPermissionProjection =
          this.resolvedHandoffPermissions(context);
        let handoffValidation = validateEvidenceHandoffPacket({
          packet: handoff.packet,
          canonicalBytes: handoff.canonicalBytes,
          expected: {
            runId: context.state.runId,
            roundId: `round_${String(round)}`,
            reviewerSlot: agent,
            targetSlot: target,
            targetSnapshot: {
              base_commit: context.runSpec.baseCommit,
              frozen_patch_sha256: sha256(await readFile(targetPatchPath)),
              frozen_git_tree_id: targetSnapshot,
            },
            permissionProjection: currentPermissionProjection,
          },
          sourceFindings: handoff.sourceFindings,
          taskSourceIds: context.runSpec.task.sources.map(
            (source) => source.id,
          ),
          capabilityIds: context.permissions.capabilities.map(
            (capability) => capability.id,
          ),
        });
        await persistHandoffValidationOutcome(
          context.store,
          `round_${String(round)}`,
          `${agent}-to-${target}`,
          stableId("pre-invocation", handoff.packet.packet_id),
          handoffValidation,
        );
        const validationReason =
          "diagnostic_code" in handoffValidation
            ? handoffValidation.diagnostic_code
            : handoffValidation.status;
        if (
          handoffValidation.status !== "packet_valid" &&
          handoffValidation.status !== "packet_valid_empty"
        ) {
          const refreshRequired = {
            ...handoff.lifecycle,
            record_id: stableId(
              "handoff-refresh-required",
              handoff.packet.packet_id,
            ),
            previous_record_id: handoff.lifecycle.record_id,
            state: "refresh_required" as const,
            event: "validation" as const,
            reason_code: validationReason,
            attempt: 1 as const,
            artifact_pointers: [handoff.packetPointer],
            recorded_at: this.now().toISOString(),
          } satisfies HandoffLifecycleRecord;
          await persistHandoffLifecycleRecord(context.store, refreshRequired);
          handoff.lifecycle = refreshRequired;
          let refreshedReview: Awaited<
            ReturnType<RoundEngine["runTargetedHandoffReview"]>
          >;
          try {
            refreshedReview = await this.runTargetedHandoffReview(context, {
              agent,
              target,
              round,
              selection,
              worktree,
              targetSnapshot,
              contestantFeedback: await this.laneFeedback(
                context,
                agent,
                round,
                "review",
              ),
              reason: {
                status: handoffValidation.status,
                diagnostic_code: validationReason,
              },
              promptSuffix:
                "# Targeted validation refresh\nThe prior packet failed immediate pre-invocation validation. Re-review the current target and policy; do not use attacker output.",
            });
          } catch (error) {
            const coverageLoss = {
              ...refreshRequired,
              record_id: stableId(
                "handoff-validation-refresh-failed",
                handoff.packet.packet_id,
              ),
              previous_record_id: refreshRequired.record_id,
              state: "coverage_loss" as const,
              event: "coverage_loss" as const,
              reason_code: "validation_refresh_failed",
              attempt: 2 as const,
              recorded_at: this.now().toISOString(),
            } satisfies HandoffLifecycleRecord;
            await persistHandoffLifecycleRecord(context.store, coverageLoss);
            handoff.lifecycle = coverageLoss;
            context.state.warnings.push(
              `Trusted handoff validation refresh failed for ${agent} against ${target}; lane lost coverage without a score effect: ${error instanceof Error ? error.message : String(error)}`,
            );
            continue;
          }
          const refreshedPermissionProjection =
            this.resolvedHandoffPermissions(context);
          const refreshed = buildEvidenceHandoffPacket({
            runId: context.state.runId,
            roundId: `round_${String(round)}`,
            reviewerSlot: agent,
            targetSlot: target,
            targetSnapshot: {
              base_commit: context.runSpec.baseCommit,
              frozen_patch_sha256: sha256(await readFile(targetPatchPath)),
              frozen_git_tree_id: targetSnapshot,
            },
            permissionProjection: refreshedPermissionProjection,
            findings: refreshedReview.findings,
            taskSourceIds: context.runSpec.task.sources.map(
              (source) => source.id,
            ),
            capabilityIds: context.permissions.capabilities.map(
              (capability) => capability.id,
            ),
          });
          if (refreshed.status !== "packet_created") {
            const coverageLoss = {
              ...refreshRequired,
              record_id: stableId(
                "handoff-validation-refresh-oversized",
                handoff.packet.packet_id,
              ),
              previous_record_id: refreshRequired.record_id,
              state: "coverage_loss" as const,
              event: "coverage_loss" as const,
              reason_code: "refresh_packet_oversized",
              attempt: 2 as const,
              recorded_at: this.now().toISOString(),
            } satisfies HandoffLifecycleRecord;
            await persistHandoffLifecycleRecord(context.store, coverageLoss);
            handoff.lifecycle = coverageLoss;
            context.state.warnings.push(
              `Trusted handoff validation refresh remained oversized for ${agent} against ${target}; lane lost coverage without a score effect`,
            );
            continue;
          }
          const refreshedPointer = await persistEvidenceHandoffPacket(
            context.store,
            `round_${String(round)}`,
            `${agent}-to-${target}`,
            refreshed.packet,
          );
          const refreshedValidation = validateEvidenceHandoffPacket({
            packet: refreshed.packet,
            canonicalBytes: refreshed.canonicalBytes,
            expected: {
              runId: context.state.runId,
              roundId: `round_${String(round)}`,
              reviewerSlot: agent,
              targetSlot: target,
              targetSnapshot: {
                base_commit: context.runSpec.baseCommit,
                frozen_patch_sha256: sha256(await readFile(targetPatchPath)),
                frozen_git_tree_id: targetSnapshot,
              },
              permissionProjection: refreshedPermissionProjection,
            },
            sourceFindings: refreshedReview.findings,
            taskSourceIds: context.runSpec.task.sources.map(
              (source) => source.id,
            ),
            capabilityIds: context.permissions.capabilities.map(
              (capability) => capability.id,
            ),
          });
          await persistHandoffValidationOutcome(
            context.store,
            `round_${String(round)}`,
            `${agent}-to-${target}`,
            stableId("refresh-validation", refreshed.packet.packet_id),
            refreshedValidation,
          );
          if (
            refreshedValidation.status !== "packet_valid" &&
            refreshedValidation.status !== "packet_valid_empty"
          ) {
            const refreshedReason =
              "diagnostic_code" in refreshedValidation
                ? refreshedValidation.diagnostic_code
                : refreshedValidation.status;
            const coverageLoss = {
              ...refreshRequired,
              record_id: stableId(
                "handoff-validation-refresh-invalid",
                refreshed.packet.packet_id,
              ),
              previous_record_id: refreshRequired.record_id,
              state: "coverage_loss" as const,
              event: "coverage_loss" as const,
              reason_code: refreshedReason,
              attempt: 2 as const,
              recorded_at: this.now().toISOString(),
            } satisfies HandoffLifecycleRecord;
            await persistHandoffLifecycleRecord(context.store, coverageLoss);
            handoff.lifecycle = coverageLoss;
            context.state.warnings.push(
              `Trusted handoff validation refresh remained invalid for ${agent} against ${target}; lane lost coverage without a score effect: ${refreshedReason}`,
            );
            continue;
          }
          const refreshedPacket = requireConsumableEvidenceHandoff(
            refreshed.packet,
            refreshedValidation,
          );
          const refreshedLifecycle = {
            ...refreshRequired,
            record_id: stableId(
              "handoff-refreshed",
              refreshed.packet.packet_id,
            ),
            previous_record_id: refreshRequired.record_id,
            packet_id: refreshed.packet.packet_id,
            packet_digest: refreshed.packet.packet_digest,
            state: "validated" as const,
            event: "refresh" as const,
            reason_code: "refresh_valid",
            attempt: 2 as const,
            artifact_pointers: [refreshedPointer],
            recorded_at: this.now().toISOString(),
          } satisfies HandoffLifecycleRecord;
          await persistHandoffLifecycleRecord(
            context.store,
            refreshedLifecycle,
          );
          context.state.reviewInvocations.push({
            round,
            reviewer: agent,
            target,
            invocation: refreshedReview.invocation,
            submissionStatus: "submitted",
            findingCount: refreshed.packet.findings.length,
            artifactPath: context.store.resolve(refreshedPointer.path),
            parseOutcome: refreshedReview.outcome,
            sectionOutcomes: refreshedReview.sectionOutcomes,
            rawArtifactPath: refreshedReview.rawArtifactPath,
            parsedArtifactPath: refreshedReview.parsedArtifactPath,
            detail: `Targeted validation refresh completed from ${refreshedReview.startedAt} to ${refreshedReview.finishedAt}`,
          });
          handoff.packet = refreshedPacket;
          handoff.canonicalBytes = refreshed.canonicalBytes;
          handoff.sourceFindings = refreshedReview.findings;
          handoff.targetSnapshot = {
            base_commit: context.runSpec.baseCommit,
            frozen_patch_sha256: sha256(await readFile(targetPatchPath)),
            frozen_git_tree_id: targetSnapshot,
          };
          handoff.permissionProjection = refreshedPermissionProjection;
          handoff.packetPointer = refreshedPointer;
          handoff.lifecycle = refreshedLifecycle;
          handoffValidation = refreshedValidation;
          currentPermissionProjection = refreshedPermissionProjection;
        } else if (handoff.lifecycle.state === "created") {
          const validatedLifecycle = {
            ...handoff.lifecycle,
            record_id: stableId("handoff-validated", handoff.packet.packet_id),
            previous_record_id: handoff.lifecycle.record_id,
            state: "validated" as const,
            event: "validation" as const,
            reason_code: "fingerprints_match",
            artifact_pointers: [handoff.packetPointer],
            recorded_at: this.now().toISOString(),
          } satisfies HandoffLifecycleRecord;
          await persistHandoffLifecycleRecord(
            context.store,
            validatedLifecycle,
          );
          handoff.lifecycle = validatedLifecycle;
        }
        const consumablePacket = requireConsumableEvidenceHandoff(
          handoff.packet,
          handoffValidation,
        );
        const contestantFeedback = await this.laneFeedback(
          context,
          agent,
          round,
          "attack",
        );
        let prompt = this.applyQueuedSteering(
          context,
          agent,
          "collect_attacks",
          composePrompt({
            agent,
            target,
            stage: "attack",
            round,
            ...(this.lowSignalPivotInstruction(context, round)
              ? {
                  roundPivotInstruction: this.lowSignalPivotInstruction(
                    context,
                    round,
                  )!,
                }
              : {}),
            runSpec: context.runSpec,
            config: context.config,
            permissions: context.permissions,
            methodSelection: selection,
            reviewPacket: consumablePacket,
            currentHealth: contestant.finalHealth,
            contestantFeedback,
            ...(this.extensionScope(context, round)
              ? { priorOutcomes: this.extensionScope(context, round)! }
              : {}),
            deadlineAt: this.deadlineAfter(context.config.limits.attackMs),
          }),
          round,
        );
        let promptPath = await context.store.writeText(
          `prompts/round-${String(round)}-${agent}.md`,
          prompt,
        );
        await this.persist(context);
        let invocation!: AgentInvocation;
        let submissionFailure: FailureRecord | undefined;
        let finalAttemptStartedAt = this.now().toISOString();
        let finalAttemptFinishedAt = finalAttemptStartedAt;
        let submissionAttempt: 1 | 2 = 1;
        let blockerRefreshUsed = false;
        let handoffCoverageLost = false;
        const handoffInvocationMetadata = () => ({
          handoffPacketId: handoff.packet.packet_id,
          handoffPacketDigest: handoff.packet.packet_digest,
          handoffTargetFingerprint: handoff.packet.target_snapshot.fingerprint,
        });
        for (const invocationSequence of [1, 2, 3] as const) {
          const attemptStartedAt = this.now().toISOString();
          const candidate = await this.adapterFor(context, agent).attack({
            worktree,
            contestantId: agent,
            prompt,
            promptPath,
            transcriptPrefix: context.store.resolve(
              `logs/round-${String(round)}-attack-${agent}-attempt-${String(invocationSequence)}`,
            ),
            timeoutMs: context.config.limits.attackMs,
            signal: context.controller.signal,
            round,
            opponent: target,
          });
          const attemptFinishedAt = this.now().toISOString();
          finalAttemptStartedAt = attemptStartedAt;
          finalAttemptFinishedAt = attemptFinishedAt;
          invocation = candidate;
          let usableSubmission = false;
          let blockerEnvelopeDetected = false;
          if (
            candidate.status === "succeeded" ||
            candidate.status === "timed_out"
          ) {
            try {
              const raw = await readFile(
                path.join(worktree, ".agent-arena-submission.json"),
                "utf8",
              );
              const decoded = JSON.parse(raw) as unknown;
              if (
                decoded &&
                typeof decoded === "object" &&
                !Array.isArray(decoded) &&
                "handoff_blocker" in decoded
              ) {
                blockerEnvelopeDetected = true;
                const blocker = normalizeHandoffBlocker(
                  decoded,
                  handoff.packet,
                  currentPermissionProjection,
                  context.runSpec.task.sources.map((source) => source.id),
                );
                const blockedLifecycle = {
                  ...handoff.lifecycle,
                  record_id: stableId(
                    "handoff-blocked",
                    handoff.packet.packet_id,
                  ),
                  previous_record_id: handoff.lifecycle.record_id,
                  state: "refresh_required" as const,
                  event: "blocking" as const,
                  reason_code: blocker.handoff_blocker.category,
                  attempt: 1 as const,
                  artifact_pointers: [handoff.packetPointer],
                  recorded_at: this.now().toISOString(),
                } satisfies HandoffLifecycleRecord;
                await context.store.writeImmutableJson(
                  `rounds/round_${String(round)}/handoffs/${agent}-to-${target}/blockers/${stableId("blocker", handoff.packet.packet_id)}.json`,
                  blocker,
                );
                await persistHandoffLifecycleRecord(
                  context.store,
                  blockedLifecycle,
                );
                handoff.lifecycle = blockedLifecycle;
                context.state.attackInvocations.push({
                  round,
                  attacker: agent,
                  target,
                  invocation: candidate,
                  ...handoffInvocationMetadata(),
                  submissionStatus: "not_submitted",
                  attackCount: 0,
                  detail: "Attacker returned a valid trusted-handoff blocker",
                });
                if (blockerRefreshUsed) {
                  const coverageLoss = {
                    ...blockedLifecycle,
                    record_id: stableId(
                      "handoff-coverage-loss",
                      handoff.packet.packet_id,
                    ),
                    previous_record_id: blockedLifecycle.record_id,
                    state: "coverage_loss" as const,
                    event: "coverage_loss" as const,
                    reason_code: "blocker_persisted",
                    attempt: 2 as const,
                    recorded_at: this.now().toISOString(),
                  } satisfies HandoffLifecycleRecord;
                  await persistHandoffLifecycleRecord(
                    context.store,
                    coverageLoss,
                  );
                  handoff.lifecycle = coverageLoss;
                  handoffCoverageLost = true;
                  await removeSubmission(worktree);
                  break;
                }
                blockerRefreshUsed = true;
                await removeSubmission(worktree);
                await context.worktrees.remove(worktree);
                worktree = await this.prepareWorktree(context, {
                  name: `round-${String(round)}-attack-${agent}`,
                  subject: `blocker-refresh-worktree:${String(round)}:${agent}`,
                  patches: [targetPatchPath],
                  contestantId: agent,
                  laneId: `attack-${String(round)}-${agent}`,
                });
                targetSnapshot = await context.worktrees.snapshot(worktree);
                if (
                  targetSnapshot !== handoff.targetSnapshot.frozen_git_tree_id
                )
                  throw new Error(
                    "Blocker refresh worktree does not match the frozen target",
                  );
                const refreshPrompt = `${composeAttackReviewPrompt({
                  agent,
                  target,
                  round,
                  ...(this.lowSignalPivotInstruction(context, round)
                    ? {
                        roundPivotInstruction: this.lowSignalPivotInstruction(
                          context,
                          round,
                        )!,
                      }
                    : {}),
                  runSpec: context.runSpec,
                  config: context.config,
                  permissions: context.permissions,
                  methodSelection: selection,
                  contestantFeedback,
                  ...(this.extensionScope(context, round)
                    ? { priorOutcomes: this.extensionScope(context, round)! }
                    : {}),
                  deadlineAt: this.deadlineAfter(
                    context.config.limits.attackMs,
                  ),
                })}\n\n# Targeted blocker refresh\nThe prior handoff was blocked. Re-review the current target and return a fresh v2 review submission. The blocker record is context only; do not copy secrets or provider-identifying content into findings.\n${JSON.stringify(blocker)}`;
                const refreshPromptPath = await context.store.writeText(
                  `prompts/round-${String(round)}-review-${agent}-blocker-refresh.md`,
                  refreshPrompt,
                );
                const refreshStartedAt = this.now().toISOString();
                const refreshInvocation = await this.adapterFor(
                  context,
                  agent,
                ).review({
                  worktree,
                  contestantId: agent,
                  prompt: refreshPrompt,
                  promptPath: refreshPromptPath,
                  transcriptPrefix: context.store.resolve(
                    `logs/round-${String(round)}-review-${agent}-blocker-refresh`,
                  ),
                  timeoutMs: context.config.limits.reviewMs,
                  signal: context.controller.signal,
                  round,
                  opponent: target,
                  observer: context.observer,
                });
                const refreshFinishedAt = this.now().toISOString();
                if (refreshInvocation.status !== "succeeded")
                  throw new Error(
                    `Targeted blocker review refresh ${refreshInvocation.status}`,
                  );
                const refreshCapture = await this.persistProviderSubmission(
                  context,
                  {
                    worktree,
                    sourceName: ".agent-arena-submission.json",
                    round,
                    phase: "review",
                    actor: `${agent}-blocker-refresh`,
                    kind: "review",
                  },
                );
                refreshInvocation.submissionPath = refreshCapture.parsedPath;
                const refreshSubmission = refreshCapture.parsed.value as {
                  version: 2;
                  findings: HandoffFindingPayload[];
                };
                if (
                  refreshCapture.parsed.outcome !== "valid" &&
                  refreshCapture.parsed.outcome !== "valid_empty"
                )
                  throw new Error(
                    "Targeted blocker review refresh was invalid",
                  );
                await removeSubmission(worktree);
                const refreshChangedPaths =
                  await context.worktrees.changedPathsSinceSnapshot(
                    worktree,
                    targetSnapshot,
                  );
                if (refreshChangedPaths.length > 0)
                  throw new Error(
                    `Read-only blocker refresh changed worktree paths: ${refreshChangedPaths.join(", ")}`,
                  );
                const blockerRefreshPermissionProjection =
                  this.resolvedHandoffPermissions(context);
                const refreshed = buildEvidenceHandoffPacket({
                  runId: context.state.runId,
                  roundId: `round_${String(round)}`,
                  reviewerSlot: agent,
                  targetSlot: target,
                  targetSnapshot: handoff.targetSnapshot,
                  permissionProjection: blockerRefreshPermissionProjection,
                  findings: refreshSubmission.findings,
                  taskSourceIds: context.runSpec.task.sources.map(
                    (source) => source.id,
                  ),
                  capabilityIds: context.permissions.capabilities.map(
                    (capability) => capability.id,
                  ),
                });
                if (refreshed.status !== "packet_created")
                  throw new Error("Blocker refresh could not create a packet");
                const refreshedPointer = await persistEvidenceHandoffPacket(
                  context.store,
                  `round_${String(round)}`,
                  `${agent}-to-${target}`,
                  refreshed.packet,
                );
                const blockerRefreshValidation = validateEvidenceHandoffPacket({
                  packet: refreshed.packet,
                  canonicalBytes: refreshed.canonicalBytes,
                  expected: {
                    runId: context.state.runId,
                    roundId: `round_${String(round)}`,
                    reviewerSlot: agent,
                    targetSlot: target,
                    targetSnapshot: handoff.targetSnapshot,
                    permissionProjection: blockerRefreshPermissionProjection,
                  },
                  sourceFindings: refreshSubmission.findings,
                  taskSourceIds: context.runSpec.task.sources.map(
                    (source) => source.id,
                  ),
                  capabilityIds: context.permissions.capabilities.map(
                    (capability) => capability.id,
                  ),
                });
                await persistHandoffValidationOutcome(
                  context.store,
                  `round_${String(round)}`,
                  `${agent}-to-${target}`,
                  stableId(
                    "blocker-refresh-validation",
                    refreshed.packet.packet_id,
                  ),
                  blockerRefreshValidation,
                );
                const refreshedPacket = requireConsumableEvidenceHandoff(
                  refreshed.packet,
                  blockerRefreshValidation,
                );
                const refreshedLifecycle = {
                  ...blockedLifecycle,
                  record_id: stableId(
                    "handoff-refreshed",
                    refreshed.packet.packet_id,
                  ),
                  previous_record_id: blockedLifecycle.record_id,
                  packet_id: refreshed.packet.packet_id,
                  packet_digest: refreshed.packet.packet_digest,
                  state: "validated" as const,
                  event: "refresh" as const,
                  reason_code: "blocker_refreshed",
                  attempt: 2 as const,
                  artifact_pointers: [refreshedPointer],
                  recorded_at: this.now().toISOString(),
                } satisfies HandoffLifecycleRecord;
                await persistHandoffLifecycleRecord(
                  context.store,
                  refreshedLifecycle,
                );
                context.state.reviewInvocations.push({
                  round,
                  reviewer: agent,
                  target,
                  invocation: refreshInvocation,
                  submissionStatus: "submitted",
                  findingCount: refreshed.packet.findings.length,
                  artifactPath: context.store.resolve(refreshedPointer.path),
                  parseOutcome: refreshCapture.parsed.outcome,
                  sectionOutcomes: Object.fromEntries(
                    Object.entries(refreshCapture.parsed.sections).map(
                      ([key, section]) => [key, section.outcome],
                    ),
                  ),
                  rawArtifactPath: refreshCapture.rawPath,
                  parsedArtifactPath: refreshCapture.parsedPath,
                  detail: `Targeted blocker refresh completed from ${refreshStartedAt} to ${refreshFinishedAt}`,
                });
                handoff.packet = refreshedPacket;
                handoff.canonicalBytes = refreshed.canonicalBytes;
                handoff.sourceFindings = refreshSubmission.findings;
                handoff.packetPointer = refreshedPointer;
                handoff.lifecycle = refreshedLifecycle;
                currentPermissionProjection =
                  blockerRefreshPermissionProjection;
                prompt = composePrompt({
                  agent,
                  target,
                  stage: "attack",
                  round,
                  ...(this.lowSignalPivotInstruction(context, round)
                    ? {
                        roundPivotInstruction: this.lowSignalPivotInstruction(
                          context,
                          round,
                        )!,
                      }
                    : {}),
                  runSpec: context.runSpec,
                  config: context.config,
                  permissions: context.permissions,
                  methodSelection: selection,
                  reviewPacket: refreshed.packet,
                  currentHealth: contestant.finalHealth,
                  contestantFeedback,
                });
                promptPath = await context.store.writeText(
                  `prompts/round-${String(round)}-${agent}-blocker-refresh.md`,
                  prompt,
                );
                await removeSubmission(worktree);
                continue;
              }
              const outcome = parseFaultIsolatedSubmission(
                "attack",
                raw,
              ).outcome;
              usableSubmission =
                outcome === "valid" || outcome === "valid_empty";
            } catch (error) {
              if (handoff.lifecycle.state === "refresh_required") {
                const coverageLoss = {
                  ...handoff.lifecycle,
                  record_id: stableId(
                    "handoff-refresh-failed",
                    handoff.packet.packet_id,
                  ),
                  previous_record_id: handoff.lifecycle.record_id,
                  state: "coverage_loss" as const,
                  event: "coverage_loss" as const,
                  reason_code: "blocker_refresh_failed",
                  attempt: 2 as const,
                  recorded_at: this.now().toISOString(),
                } satisfies HandoffLifecycleRecord;
                await persistHandoffLifecycleRecord(
                  context.store,
                  coverageLoss,
                );
                handoff.lifecycle = coverageLoss;
                handoffCoverageLost = true;
                context.state.warnings.push(
                  `Trusted handoff refresh failed for ${agent} against ${target}; lane lost coverage without a score effect: ${error instanceof Error ? error.message : String(error)}`,
                );
                await removeSubmission(worktree);
                break;
              }
              if (blockerEnvelopeDetected) {
                let failedCapture:
                  | {
                      parsed: ParsedSubmission<unknown>;
                      rawPath: string;
                      parsedPath: string;
                    }
                  | undefined;
                try {
                  failedCapture = await this.persistProviderSubmission(
                    context,
                    {
                      worktree,
                      sourceName: ".agent-arena-submission.json",
                      round,
                      phase: "attack",
                      actor: `${agent}-invalid-blocker`,
                      kind: "attack",
                    },
                  );
                  candidate.submissionPath = failedCapture.parsedPath;
                } catch {
                  // Missing output is represented by the invocation record.
                }
                const coverageLoss = {
                  ...handoff.lifecycle,
                  record_id: stableId(
                    "handoff-invalid-blocker",
                    handoff.packet.packet_id,
                  ),
                  previous_record_id: handoff.lifecycle.record_id,
                  state: "coverage_loss" as const,
                  event: "coverage_loss" as const,
                  reason_code: "invalid_blocker",
                  recorded_at: this.now().toISOString(),
                } satisfies HandoffLifecycleRecord;
                await persistHandoffLifecycleRecord(
                  context.store,
                  coverageLoss,
                );
                handoff.lifecycle = coverageLoss;
                handoffCoverageLost = true;
                const detail = `Invalid trusted-handoff blocker caused coverage loss: ${error instanceof Error ? error.message : String(error)}`;
                context.state.attackInvocations.push({
                  round,
                  attacker: agent,
                  target,
                  invocation: candidate,
                  ...handoffInvocationMetadata(),
                  submissionStatus: failedCapture
                    ? "invalid_submission"
                    : "not_submitted",
                  attackCount: 0,
                  ...(failedCapture
                    ? {
                        parseOutcome: failedCapture.parsed.outcome,
                        rawArtifactPath: failedCapture.rawPath,
                        parsedArtifactPath: failedCapture.parsedPath,
                      }
                    : {}),
                  detail,
                });
                context.state.warnings.push(detail);
                await removeSubmission(worktree);
                break;
              }
              usableSubmission = false;
            }
          }
          if (usableSubmission || submissionAttempt === 2) break;

          let failedCapture:
            | {
                parsed: ParsedSubmission<unknown>;
                rawPath: string;
                parsedPath: string;
              }
            | undefined;
          try {
            failedCapture = await this.persistProviderSubmission(context, {
              worktree,
              sourceName: ".agent-arena-submission.json",
              round,
              phase: "attack",
              actor: `${agent}-attempt-${String(submissionAttempt)}`,
              kind: "attack",
            });
            candidate.submissionPath = failedCapture.parsedPath;
          } catch {
            // Missing output is represented by the invocation record below.
          }
          context.state.attackInvocations.push({
            round,
            attacker: agent,
            target,
            invocation: candidate,
            ...handoffInvocationMetadata(),
            submissionStatus: failedCapture ? "invalid_submission" : "not_run",
            attackCount: 0,
            ...(failedCapture
              ? {
                  parseOutcome: failedCapture.parsed.outcome,
                  rawArtifactPath: failedCapture.rawPath,
                  parsedArtifactPath: failedCapture.parsedPath,
                }
              : {}),
            detail: `Attack generation ${candidate.status}; targeted retry followed`,
          });
          submissionFailure = await this.recordSubmissionAttempt(context, {
            round,
            actor: agent,
            target,
            phase: "attack",
            attempt: 1,
            startedAt: attemptStartedAt,
            finishedAt: attemptFinishedAt,
            status: "failed",
            diagnosticArtifactRefs: failedCapture
              ? [failedCapture.rawPath, failedCapture.parsedPath]
              : [],
            cause: failedCapture
              ? JSON.stringify(failedCapture.parsed.rejections)
              : candidate.status,
          });
          await removeSubmission(worktree);
          assertTargetedRetryAllowed(submissionAttempt);
          submissionAttempt = 2;
        }
        if (handoffCoverageLost) continue;
        // A timed-out model can still have written a complete, schema-valid
        // submission before its CLI wrapper finishes shutting down. Preserve
        // that work; failed/infrastructure invocations remain ineligible.
        const salvagingTimedOutSubmission = invocation.status === "timed_out";
        if (invocation.status !== "succeeded" && !salvagingTimedOutSubmission) {
          if (submissionFailure) {
            await this.recordSubmissionAttempt(context, {
              round,
              actor: agent,
              target,
              phase: "attack",
              attempt: 2,
              startedAt: finalAttemptStartedAt,
              finishedAt: finalAttemptFinishedAt,
              status: "failed",
              diagnosticArtifactRefs: [],
              cause: invocation.status,
              existing: submissionFailure,
              terminalDisposition: "coverage_lost",
            });
          }
          context.state.attackInvocations.push({
            round,
            attacker: agent,
            target,
            invocation,
            ...handoffInvocationMetadata(),
            submissionStatus: "not_run",
            attackCount: 0,
            detail: `Attack generation ${invocation.status}`,
          });
          context.state.warnings.push(
            `Attack generation ${invocation.status} for ${agent} against ${target}; no submission was collected`,
          );
          if (
            this.recordProviderFailure(context, {
              contestantId: agent,
              stage: "attack_construction",
              ...(typeof round === "number" ? { round } : {}),
              invocation,
              reason: `Attack-construction provider failure persisted after the targeted retry for ${agent} against ${target}`,
            })
          )
            throw new Error(context.state.providerFailure?.reason);
          continue;
        }
        try {
          const captured = await this.persistProviderSubmission(context, {
            worktree,
            sourceName: ".agent-arena-submission.json",
            round,
            phase: "attack",
            actor: agent,
            kind: "attack",
          });
          invocation.submissionPath = captured.parsedPath;
          if (submissionFailure) {
            const recovered =
              captured.parsed.outcome === "valid" ||
              captured.parsed.outcome === "valid_empty";
            submissionFailure = await this.recordSubmissionAttempt(context, {
              round,
              actor: agent,
              target,
              phase: "attack",
              attempt: 2,
              startedAt: finalAttemptStartedAt,
              finishedAt: finalAttemptFinishedAt,
              status: recovered ? "succeeded" : "failed",
              diagnosticArtifactRefs: [captured.rawPath, captured.parsedPath],
              cause: JSON.stringify(captured.parsed.rejections),
              existing: submissionFailure,
              terminalDisposition: recovered ? "recovered" : "coverage_lost",
            });
          }
          if (captured.parsed.outcome === "invalid") {
            await removeSubmission(worktree);
            context.state.attackInvocations.push({
              round,
              attacker: agent,
              target,
              invocation,
              ...handoffInvocationMetadata(),
              submissionStatus: "invalid_submission",
              attackCount: 0,
              parseOutcome: captured.parsed.outcome,
              sectionOutcomes: Object.fromEntries(
                Object.entries(captured.parsed.sections).map(
                  ([key, section]) => [key, section.outcome],
                ),
              ),
              rawArtifactPath: captured.rawPath,
              parsedArtifactPath: captured.parsedPath,
              detail: "Attack submission remained invalid after targeted retry",
            });
            context.state.warnings.push(
              `Attack submission from ${agent} against ${target} remained invalid after targeted retry; handoff was not consumed`,
            );
            continue;
          }
          const submission = captured.parsed.value as AttackSubmission;
          const completedEmpty = captured.parsed.outcome === "valid_empty";
          const terminalLifecycle = {
            ...handoff.lifecycle,
            record_id: stableId(
              completedEmpty ? "handoff-empty" : "handoff-consumed",
              handoff.packet.packet_id,
            ),
            previous_record_id: handoff.lifecycle.record_id,
            state: completedEmpty
              ? ("completed_empty" as const)
              : ("consumed" as const),
            event: completedEmpty
              ? ("empty_completion" as const)
              : ("consumption" as const),
            reason_code: completedEmpty ? "attacks_empty" : "attacks_submitted",
            artifact_pointers: [handoff.packetPointer],
            recorded_at: this.now().toISOString(),
          } satisfies HandoffLifecycleRecord;
          await persistHandoffLifecycleRecord(context.store, terminalLifecycle);
          handoff.lifecycle = terminalLifecycle;
          this.enqueueRejectedAttacks(context, {
            parsed: captured.parsed,
            rawPath: captured.rawPath,
            parsedPath: captured.parsedPath,
            round,
            lane: "contestant",
            actor: agent,
            target,
          });
          const accepted = submission.attacks.slice(0, 3);
          let legacySubmission = false;
          try {
            legacySubmission =
              (
                JSON.parse(await readFile(captured.rawPath, "utf8")) as {
                  version?: unknown;
                }
              ).version === 1;
          } catch {
            // The fault-isolated parser already records malformed raw bytes.
          }
          collectedLegacySubmission ||= legacySubmission;
          const declaredPaths = new Set([
            ...declaredAttackPaths(
              captured.parsed as ParsedSubmission<AttackSubmission>,
            ),
            ".agent-arena-submission.json",
          ]);
          const undeclaredPaths = legacySubmission
            ? []
            : (
                await context.worktrees.changedPathsSinceSnapshot(
                  worktree,
                  targetSnapshot,
                )
              ).filter((changedPath) => !declaredPaths.has(changedPath));
          if (undeclaredPaths.length) {
            context.state.warnings.push(
              `Attack submission from ${agent} rejected undeclared paths: ${undeclaredPaths.join(", ")}`,
            );
          }
          const materializable = undeclaredPaths.length ? [] : accepted;
          for (const entry of materializable) {
            try {
              if (legacySubmission) {
                const neutralCase = await this.buildNeutralCase(
                  context,
                  entry,
                  round,
                  agent,
                );
                if (!neutralCase)
                  throw new Error("legacy neutral case was not produced");
                collected.push(
                  await materializeAttack(
                    {
                      ...entry,
                      focusedCommand: neutralCase.focusedCommand,
                      requiredCapabilities: neutralCase.requiredCapabilities,
                    },
                    {
                      author: agent,
                      authorProvider: contestant.provider,
                      target,
                      round,
                      patchPath: neutralCase.patchPath,
                    },
                  ),
                );
                continue;
              }
              const overlayPath = context.store.resolve(
                `attacks/round-${String(round)}/${agent}/${String(entry.rank)}.diff`,
              );
              if (entry.browserProbe && entry.paths.length === 0) {
                await context.store.writeText(
                  `attacks/round-${String(round)}/${agent}/${String(entry.rank)}.diff`,
                  browserProbeEvidencePatch(entry, round, agent),
                );
                collected.push(
                  await materializeAttack(entry, {
                    author: agent,
                    authorProvider: contestant.provider,
                    target,
                    round,
                    patchPath: overlayPath,
                  }),
                );
                continue;
              }
              const overlayPaths = [
                ...new Set([...submission.sharedSupportPaths, ...entry.paths]),
              ];
              const patchSize =
                await context.worktrees.capturePatchAgainstSnapshot(
                  worktree,
                  overlayPath,
                  targetSnapshot,
                  overlayPaths,
                );
              if (patchSize === 0)
                throw new Error(
                  "declared attack paths produced an empty overlay",
                );
              collected.push(
                await materializeAttack(entry, {
                  author: agent,
                  authorProvider: contestant.provider,
                  target,
                  round,
                  patchPath: overlayPath,
                }),
              );
            } catch (error) {
              context.state.warnings.push(
                `Attack rank ${String(entry.rank)} from ${agent} was rejected without suppressing siblings: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          await removeSubmission(worktree);
          context.state.attackInvocations.push({
            round,
            attacker: agent,
            target,
            invocation,
            ...handoffInvocationMetadata(),
            submissionStatus:
              captured.parsed.outcome === "partial"
                ? "partially_submitted"
                : "submitted",
            attackCount: materializable.length,
            parseOutcome: captured.parsed.outcome,
            sectionOutcomes: Object.fromEntries(
              Object.entries(captured.parsed.sections).map(([key, section]) => [
                key,
                section.outcome,
              ]),
            ),
            rawArtifactPath: captured.rawPath,
            parsedArtifactPath: captured.parsedPath,
            ...(salvagingTimedOutSubmission
              ? { detail: "Valid submission salvaged after timeout" }
              : {}),
          });
          if (captured.parsed.rejections.length) {
            const warning = this.submissionWarning(
              `Attack submission from ${agent} against ${target} was partially usable`,
              captured.parsed,
              captured.rawPath,
              captured.parsedPath,
            );
            context.state.warnings.push(warning);
            this.progress(warning);
          }
          if (salvagingTimedOutSubmission) {
            context.state.warnings.push(
              `Attack submission from ${agent} against ${target} was salvaged after timeout; inspect the invocation duration before relying on the configured limit`,
            );
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          if (submissionFailure?.attempts.length === 1) {
            await this.recordSubmissionAttempt(context, {
              round,
              actor: agent,
              target,
              phase: "attack",
              attempt: 2,
              startedAt: finalAttemptStartedAt,
              finishedAt: finalAttemptFinishedAt,
              status: "failed",
              diagnosticArtifactRefs: [],
              cause: detail,
              existing: submissionFailure,
              terminalDisposition: "coverage_lost",
            });
          }
          context.state.attackInvocations.push({
            round,
            attacker: agent,
            target,
            invocation,
            ...handoffInvocationMetadata(),
            submissionStatus:
              (error as NodeJS.ErrnoException).code === "ENOENT"
                ? "not_submitted"
                : "invalid_submission",
            attackCount: 0,
            detail,
          });
          context.state.warnings.push(
            `Attack submission from ${agent} against ${target} was not usable: ${detail}`,
          );
        }
      } catch (error) {
        if (context.state.providerFailure) throw error;
        context.state.warnings.push(
          `Attack collection failed for ${agent}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await context.worktrees.remove(worktree);
      }
    }
    if (
      context.config.mode !== "siege" &&
      (context.state.schemaVersion < 6 || collectedLegacySubmission) &&
      (round === 2 || round === 3) &&
      this.dependencies.houseScout
    ) {
      for (const [candidateIndex, target] of context.config.agents.entries()) {
        const targetContestant = getContestant(context.state, target);
        const targetPatchPath = targetContestant.currentPatchPath;
        if (
          targetContestant.patchSize === 0 ||
          targetContestant.status === "failed" ||
          !targetPatchPath
        )
          continue;
        let worktree = await this.prepareWorktree(context, {
          name: `round-${String(round)}-attack-house-${target}`,
          subject: `house-generation-worktree:${String(round)}:${target}`,
          patches: [targetPatchPath],
          contestantId: target,
          laneId: `house-${String(round)}-${target}`,
        });
        this.dependencies.onProgress?.(
          `Round ${String(round)}: house scout ${String(candidateIndex + 1)}/2 started for ${target}`,
        );
        await this.persist(context);
        try {
          let targetSnapshot = await context.worktrees.snapshot(worktree);
          const patch = await readFile(targetPatchPath, "utf8");
          let prompt = [
            "# Neutral house scout",
            `Inspect Candidate ${String(candidateIndex + 1)}'s anonymized frozen patch for one task defect.`,
            "You may submit zero or one unranked executable test-only attack. You have no health, recoil, or replacement credits.",
            "Use the ordinary oracle and determinism rules. The assigned worktree contains this candidate patch; execute every probe against it. Do not infer contestant identity.",
            "",
            "# Immutable run specification",
            JSON.stringify(agentVisibleRunSpec(context.runSpec, true), null, 2),
            "",
            "# Method pack",
            JSON.stringify(selection, null, 2),
            "",
            "# Candidate patch",
            patch,
            "",
            `Write {"version":1,"hypotheses":[],"attacks":[]} to ${path.join(worktree, ".agent-arena-house.json")}. Each attack uses the normal attack schema without rank.`,
          ].join("\n");
          const houseStartedAt = this.now().toISOString();
          let houseTranscript = "";
          let captured!: Awaited<
            ReturnType<typeof this.persistReturnedSubmission>
          >;
          let houseFailure: FailureRecord | undefined;
          for (const attempt of [1, 2] as const) {
            const startedAt = this.now().toISOString();
            houseTranscript = context.store.resolve(
              `logs/round-${String(round)}-attack-house-${target}-attempt-${String(attempt)}`,
            );
            try {
              const submission = await this.dependencies.houseScout.scout({
                worktree,
                prompt,
                timeoutMs: context.config.limits.attackMs,
                transcriptPrefix: houseTranscript,
                signal: context.controller.signal,
                round,
              });
              captured = await this.persistReturnedSubmission(context, {
                submission,
                round,
                phase: "house",
                actor: `house-${target}-attempt-${String(attempt)}`,
                kind: "house",
              });
              if (captured.parsed.outcome === "invalid")
                throw new Error("House scout submission was invalid");
              if (houseFailure) {
                houseFailure = await this.recordFailureAttempt(context, {
                  stage: houseFailure.stage,
                  subject: `house-scout:${String(round)}:${target}`,
                  category: houseFailure.category,
                  attempt: 2,
                  startedAt,
                  finishedAt: this.now().toISOString(),
                  status: "succeeded",
                  diagnosticArtifactRefs: [
                    houseTranscript,
                    captured.rawPath,
                    captured.parsedPath,
                  ],
                  contestantId: target,
                  laneId: `house-${String(round)}-${target}`,
                  existing: houseFailure,
                  terminalDisposition: "recovered",
                });
              }
              break;
            } catch (error) {
              const invalidOutput =
                error instanceof Error &&
                error.message === "House scout submission was invalid";
              const diagnosticArtifactRefs = [
                houseTranscript,
                ...(captured ? [captured.rawPath, captured.parsedPath] : []),
              ];
              houseFailure = await this.recordFailureAttempt(context, {
                stage:
                  houseFailure?.stage ??
                  (invalidOutput ? "parsing" : "model_invocation"),
                subject: `house-scout:${String(round)}:${target}`,
                category:
                  houseFailure?.category ??
                  (invalidOutput ? "invalid_output" : "transport"),
                attempt,
                startedAt,
                finishedAt: this.now().toISOString(),
                status: "failed",
                diagnosticArtifactRefs,
                contestantId: target,
                laneId: `house-${String(round)}-${target}`,
                ...(houseFailure ? { existing: houseFailure } : {}),
                ...(attempt === 2
                  ? { terminalDisposition: "coverage_lost" as const }
                  : {}),
              });
              if (attempt === 2) throw error;
              const previousWorktree = worktree;
              await context.worktrees.remove(worktree);
              worktree = await this.prepareWorktree(context, {
                name: `round-${String(round)}-attack-house-${target}`,
                subject: `house-retry-worktree:${String(round)}:${target}`,
                patches: [targetPatchPath],
                contestantId: target,
                laneId: `house-${String(round)}-${target}`,
              });
              prompt = prompt.replaceAll(previousWorktree, worktree);
              targetSnapshot = await context.worktrees.snapshot(worktree);
              captured = undefined!;
            }
          }
          context.roundInvocations.push({
            id: stableId("invocation", String(round), "house", target),
            kind: "house",
            actor: "harness",
            status: "succeeded",
            startedAt: houseStartedAt,
            finishedAt: this.now().toISOString(),
            artifactPaths: [
              houseTranscript,
              captured.rawPath,
              captured.parsedPath,
            ],
          });
          const parsedSubmission = captured.parsed.value as HouseSubmission;
          this.enqueueRejectedAttacks(context, {
            parsed: captured.parsed,
            rawPath: captured.rawPath,
            parsedPath: captured.parsedPath,
            round,
            lane: "house",
            actor: "house",
            target,
          });
          await context.store.writeJson(
            `hypotheses/round-${String(round)}/house-${target}.json`,
            parsedSubmission.hypotheses,
          );
          if (captured.parsed.rejections.length) {
            const warning = this.submissionWarning(
              `House scout output for Candidate ${String(candidateIndex + 1)} was partially usable`,
              captured.parsed,
              captured.rawPath,
              captured.parsedPath,
            );
            context.state.warnings.push(warning);
            this.progress(warning);
          }
          const entry = parsedSubmission.attacks[0];
          if (entry) {
            await rm(path.join(worktree, ".agent-arena-house.json"), {
              force: true,
            });
            const patchPath = context.store.resolve(
              `attacks/round-${String(round)}/house-${target}.diff`,
            );
            await context.worktrees.capturePatchAgainstSnapshot(
              worktree,
              patchPath,
              targetSnapshot,
              entry.paths,
            );
            collected.push(
              await materializeHouseAttack(entry, {
                targets: [target],
                round,
                patchPath,
                methodPackId:
                  selection.methodPackIds[0] ?? `${selection.profile}@1`,
              }),
            );
          }
        } catch (error) {
          context.state.warnings.push(
            `House scout failed for Candidate ${String(candidateIndex + 1)} without health effect: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          await context.worktrees.remove(worktree);
          this.dependencies.onProgress?.(
            `Round ${String(round)}: house scout ${String(candidateIndex + 1)}/2 finished for ${target}`,
          );
          await this.persist(context);
        }
      }
    }
    await this.persist(context);

    await this.transition(context, "validate_attacks", round);
    const knownRoots = new Set(
      Object.values(context.state.contestants).flatMap((contestant) =>
        (contestant.healthLedger.canonicalDefects ?? [])
          .filter((defect) => defect.status !== "superseded")
          .map((defect) => defect.rootDefectId),
      ),
    );
    const validated: Attack[] = [];
    const ordered = [...collected].sort(
      (left, right) =>
        (left.origin.kind === "house" ? 1 : 0) -
          (right.origin.kind === "house" ? 1 : 0) ||
        (left.rank ?? 0) - (right.rank ?? 0) ||
        (left.origin.kind === "contestant"
          ? left.origin.contestant
          : ""
        ).localeCompare(
          right.origin.kind === "contestant" ? right.origin.contestant : "",
        ),
    );
    for (const attack of ordered) {
      attack.evidenceFingerprint = evidenceFingerprint(attack);
      const adjudicationHistory = [...context.state.attacks, ...validated];
      const priorAdjudications = priorAdjudicationContext(
        attack,
        adjudicationHistory,
      );
      if (attack.origin.kind === "house") {
        const result = await validateHouseAttack({
          attack,
          targetPatches: Object.fromEntries(
            context.config.agents.flatMap((agent) => {
              const patchPath = getContestant(
                context.state,
                agent,
              ).currentPatchPath;
              return patchPath ? [[agent, patchPath]] : [];
            }),
          ),
          runSpec: context.runSpec,
          permissionPolicy: context.permissions,
          config: context.config,
          worktrees: context.worktrees,
          verifier: this.recordingVerifier(context, round),
          logRoot: context.store.resolve(
            `logs/round-${String(round)}/attack-${attack.id}`,
          ),
          signal: context.controller.signal,
          knownRootDefects: knownRoots,
          priorCanonicalDefects: priorCanonicalDefects(
            context.state,
            attack.targets,
          ),
          priorAdjudications,
          persistFailureRecord: (record) =>
            this.persistFailureRecord(context, record),
        });
        if (this.recordVerifierProviderFailure(context, round))
          throw new Error(context.state.providerFailure?.reason);
        if (result.status === "landed" && result.rootDefectId)
          knownRoots.add(result.rootDefectId);
        if (
          result.status === "landed" &&
          result.evidenceKind !== "browser_probe" &&
          typeof round === "number"
        ) {
          if (
            context.state.schemaVersion < 6 ||
            result.patchPath.includes(`${path.sep}cases${path.sep}round-`)
          )
            await this.buildCaseBundle(context, result, round);
        }
        await this.finalizeAttackAdjudication(
          context,
          result,
          round,
          adjudicationHistory,
        );
        validated.push(result);
        continue;
      }
      const author = attack.origin.contestant;
      const target = attack.targets[0];
      if (!target) continue;
      const targetPatch = getContestant(context.state, target).currentPatchPath;
      if (!targetPatch) continue;
      attack.targetPatchDigest = sha256(await readFile(targetPatch));
      const authorPatch = getContestant(context.state, author).currentPatchPath;
      const result =
        context.config.mode === "siege"
          ? await validateSiegeAttack({
              attack,
              targetPatch,
              runSpec: context.runSpec,
              permissionPolicy: context.permissions,
              config: context.config,
              worktrees: context.worktrees,
              verifier: this.recordingVerifier(context, round),
              logRoot: context.store.resolve(
                `logs/round-${String(round)}/attack-${attack.id}`,
              ),
              signal: context.controller.signal,
              knownRootDefects: knownRoots,
              priorCanonicalDefects: priorCanonicalDefects(
                context.state,
                attack.targets,
              ),
              priorAdjudications,
              ...this.browserValidatorOption(context, attack),
              persistFailureRecord: (record) =>
                this.persistFailureRecord(context, record),
            })
          : authorPatch
            ? await validateAttack({
                attack,
                authorPatch,
                targetPatch,
                runSpec: context.runSpec,
                permissionPolicy: context.permissions,
                config: context.config,
                worktrees: context.worktrees,
                verifier: this.recordingVerifier(context, round),
                logRoot: context.store.resolve(
                  `logs/round-${String(round)}/attack-${attack.id}`,
                ),
                signal: context.controller.signal,
                knownRootDefects: knownRoots,
                priorCanonicalDefects: priorCanonicalDefects(
                  context.state,
                  attack.targets,
                ),
                priorAdjudications,
                ...this.browserValidatorOption(context, attack),
                persistFailureRecord: (record) =>
                  this.persistFailureRecord(context, record),
              })
            : undefined;
      if (!result) continue;
      if (this.recordVerifierProviderFailure(context, round))
        throw new Error(context.state.providerFailure?.reason);
      if (result.status === "landed" && result.rootDefectId)
        knownRoots.add(result.rootDefectId);
      if (
        result.status === "landed" &&
        result.evidenceKind !== "browser_probe" &&
        typeof round === "number"
      ) {
        if (
          context.state.schemaVersion < 6 ||
          result.patchPath.includes(`${path.sep}cases${path.sep}round-`)
        )
          await this.buildCaseBundle(context, result, round);
      }
      const failureDisposition =
        result.evidenceProvenance === "judge_confirmed"
          ? ("judge_confirmed" as const)
          : result.evidenceProvenance === "judge_partial"
            ? ("judge_partial" as const)
            : result.status === "judge_rejected"
              ? ("judge_rejected" as const)
              : result.status === "judge_unable"
                ? ("judge_unable" as const)
                : result.status === "infrastructure_error" ||
                    result.status === "execution_inconclusive"
                  ? ("coverage_lost" as const)
                  : undefined;
      if (failureDisposition) {
        const exhaustedRecords = context.state.failureRecords.filter(
          (record) =>
            record.attackId === result.id &&
            record.terminalDisposition === "coverage_lost",
        );
        for (const record of exhaustedRecords) {
          await this.persistFailureRecord(context, {
            ...record,
            terminalDisposition: failureDisposition,
          });
        }
      }
      await this.finalizeAttackAdjudication(
        context,
        result,
        round,
        adjudicationHistory,
      );
      validated.push(result);
    }
    context.state.attacks.push(...validated);
    await this.persist(context);

    await this.transition(context, "assign_severity", round);
    await this.transition(context, "resolve_damage", round);
    context.state.contestants = applyChallengeCorrections(
      context.state.contestants,
      context.state.attacks,
      validated,
      round,
    );
    const resolved = resolveRound(context.state.contestants, validated, round);
    context.state.contestants = resolved.contestants;
    for (const attack of validated) {
      const correctionRecoil = challengeCorrectionRecoil(
        context.state.attacks,
        attack,
      );
      if (correctionRecoil) {
        attack.recoil = correctionRecoil;
        continue;
      }
      if (
        attack.origin.kind === "contestant" &&
        attack.adjudication?.relationship !== "overturn" &&
        [
          "invalid",
          "duplicate",
          "self_defeating",
          "unproven",
          "blocked",
          "judge_rejected",
        ].includes(attack.status) &&
        attack.rank
      ) {
        attack.recoil = ({ 1: 5, 2: 10, 3: 15 } as const)[attack.rank];
      }
    }
    const postAttack = new Map(
      context.config.agents.map((agent) => [
        agent,
        getContestant(context.state, agent).finalHealth,
      ]),
    );
    await this.persist(context);

    for (const handoff of reviewPackets.values()) {
      if (
        handoff.lifecycle.state !== "created" &&
        handoff.lifecycle.state !== "validated"
      )
        continue;
      const invalidatedLifecycle = {
        ...handoff.lifecycle,
        record_id: stableId(
          "handoff-invalidated-repair",
          handoff.packet.packet_id,
        ),
        previous_record_id: handoff.lifecycle.record_id,
        state: "invalidated" as const,
        event: "invalidation" as const,
        reason_code: "repair_started",
        artifact_pointers: [handoff.packetPointer],
        recorded_at: this.now().toISOString(),
      } satisfies HandoffLifecycleRecord;
      await persistHandoffLifecycleRecord(context.store, invalidatedLifecycle);
      handoff.lifecycle = invalidatedLifecycle;
    }

    await this.transition(context, "repair", round);
    const repairs = new Map<ContestantId, AgentInvocation>();
    const repairAttempts = new Map<ContestantId, AgentInvocation[]>();
    const judgeRepairedDefects = new Map<ContestantId, Set<string>>();
    for (const agent of context.config.agents) {
      const contestant = getContestant(context.state, agent);
      const currentPatch = contestant.currentPatchPath;
      const activeAttackCandidates = context.state.attacks.filter(
        (attack) =>
          attack.status === "landed" &&
          attack.targets.includes(agent) &&
          attack.rootDefectId !== undefined &&
          contestant.healthLedger.activeDefects.some((defect) => {
            if (defect.rootDefectId !== attack.rootDefectId) return false;
            const canonical = contestant.healthLedger.canonicalDefects?.find(
              (entry) => entry.rootDefectId === defect.rootDefectId,
            );
            return (
              (canonical?.repairAttemptsUsed ?? 0) <
              (canonical?.repairAllowance ??
                (defect.severity === "critical" || defect.severity === "high"
                  ? 3
                  : 2))
            );
          }),
      );
      const activeAttacks = [
        ...new Map(
          activeAttackCandidates.map((attack) => [attack.rootDefectId, attack]),
        ).values(),
      ];
      if (
        !currentPatch ||
        contestant.patchSize === 0 ||
        contestant.status === "failed" ||
        contestant.status === "eliminated" ||
        (latestRequiredPass(contestant) && activeAttacks.length === 0)
      ) {
        continue;
      }
      const worktree = await this.prepareWorktree(context, {
        name: `round-${String(round)}-repair-${agent}`,
        subject: `repair-worktree:${String(round)}:${agent}`,
        patches: [currentPatch],
        contestantId: agent,
        runLevel: true,
      });
      try {
        const contestantFeedback = await this.laneFeedback(
          context,
          agent,
          round,
          "repair",
        );
        const prompt = composePrompt({
          agent,
          stage: "repair",
          round,
          ...(this.lowSignalPivotInstruction(context, round)
            ? {
                roundPivotInstruction: this.lowSignalPivotInstruction(
                  context,
                  round,
                )!,
              }
            : {}),
          runSpec: context.runSpec,
          config: context.config,
          permissions: context.permissions,
          currentHealth: contestant.finalHealth,
          contestantFeedback,
          deadlineAt: this.deadlineAfter(context.config.limits.repairMs),
        });
        await context.store.writeText(
          `prompts/round-${String(round)}-repair-${agent}.md`,
          prompt,
        );
        const attempts: AgentInvocation[] = [];
        let invocation!: AgentInvocation;
        let mechanicalFallback:
          | {
              attemptId: string;
              candidatePath: string;
              attacks: Attack[];
              reason: string;
            }
          | undefined;
        for (const attemptNumber of [1, 2, 3] as const) {
          const remainingAttacks = activeAttacks.filter((attack) => {
            const canonical = contestant.healthLedger.canonicalDefects?.find(
              (entry) => entry.rootDefectId === attack.rootDefectId,
            );
            return (
              (canonical?.repairAttemptsUsed ?? 0) <
              (canonical?.repairAllowance ??
                (attack.severity === "critical" || attack.severity === "high"
                  ? 3
                  : 2))
            );
          });
          if (remainingAttacks.length === 0 && latestRequiredPass(contestant))
            break;
          let attemptPrompt = [
            prompt,
            "",
            "# Remaining failures for this attempt",
            JSON.stringify(
              remainingAttacks.map((attack) => ({
                canonicalDefectId: attack.rootDefectId,
                claim: attack.claim,
                focusedCommand: attack.focusedCommand,
                evidenceKind: attack.evidenceKind ?? "patch",
                ...(attack.browserProbe
                  ? { browserProbe: attack.browserProbe }
                  : {}),
                outcomeReason: attack.outcomeReason,
              })),
              null,
              2,
            ),
            "Fix only the remaining failures above. Previously healed defects are regression checks, not permission to rewrite their evidence.",
          ].join("\n");
          attemptPrompt = this.applyQueuedSteering(
            context,
            agent,
            "repair",
            attemptPrompt,
            round,
          );
          const attemptPromptPath = await context.store.writeText(
            `prompts/round-${String(round)}-repair-${agent}-attempt-${String(attemptNumber)}.md`,
            attemptPrompt,
          );
          await this.persist(context);
          const attemptId = stableId(
            "repair-attempt",
            context.state.runId,
            String(round),
            agent,
            String(attemptNumber),
          );
          let invocationFailure: FailureRecord | undefined;
          for (const retry of [1, 2] as const) {
            const startedAt = this.now().toISOString();
            const transcriptPrefix = context.store.resolve(
              `logs/round-${String(round)}-repair-${agent}-attempt-${String(attemptNumber)}-invocation-${String(retry)}`,
            );
            invocation = await this.adapterFor(context, agent).repair({
              worktree,
              contestantId: agent,
              prompt: attemptPrompt,
              promptPath: attemptPromptPath,
              transcriptPrefix,
              timeoutMs: context.config.limits.repairMs,
              signal: context.controller.signal,
              round,
              activeAttacks: remainingAttacks,
              observer: context.observer,
            });
            attempts.push(invocation);
            const finishedAt = this.now().toISOString();
            if (invocation.status !== "infrastructure_error") {
              if (invocationFailure) {
                await this.recordFailureAttempt(context, {
                  stage: "model_invocation",
                  subject: `round-${String(round)}-repair:${agent}:${String(attemptNumber)}`,
                  category: invocationFailure.category,
                  attempt: 2,
                  startedAt,
                  finishedAt,
                  status: "succeeded",
                  diagnosticArtifactRefs: [attemptPromptPath, transcriptPrefix],
                  contestantId: agent,
                  existing: invocationFailure,
                  terminalDisposition: "recovered",
                });
              }
              break;
            }
            invocationFailure = await this.recordFailureAttempt(context, {
              stage: "model_invocation",
              subject: `round-${String(round)}-repair:${agent}:${String(attemptNumber)}`,
              category: "process_launch",
              attempt: retry,
              startedAt,
              finishedAt,
              status: "failed",
              diagnosticArtifactRefs: [attemptPromptPath, transcriptPrefix],
              contestantId: agent,
              ...(invocationFailure ? { existing: invocationFailure } : {}),
              ...(retry === 2
                ? { terminalDisposition: "run_level_coverage_lost" as const }
                : {}),
            });
          }
          if (invocation.status === "infrastructure_error") {
            if (
              this.recordProviderFailure(context, {
                contestantId: agent,
                stage: "repair",
                ...(typeof round === "number" ? { round } : {}),
                invocation,
                reason: `Repair provider failure persisted after the targeted retry for ${agent}`,
              })
            )
              throw new Error(context.state.providerFailure?.reason);
            throw new Error(
              `Repair invocation infrastructure failed for ${agent}`,
            );
          }
          for (const attack of remainingAttacks) {
            const canonical = contestant.healthLedger.canonicalDefects?.find(
              (entry) => entry.rootDefectId === attack.rootDefectId,
            );
            if (!canonical) continue;
            canonical.repairAllowance ??=
              canonical.baseSeverity === "critical" ||
              canonical.baseSeverity === "high"
                ? 3
                : 2;
            canonical.repairAttemptsUsed =
              (canonical.repairAttemptsUsed ?? 0) + 1;
            canonical.repairAttemptIds ??= [];
            canonical.repairAttemptIds.push(attemptId);
          }
          await removeSubmission(worktree);
          const candidatePath = context.store.resolve(
            `patches/${agent}-round-${String(round)}-repair-attempt-${String(attemptNumber)}.diff`,
          );
          await context.worktrees.capturePatch(
            worktree,
            candidatePath,
            undefined,
            true,
          );
          const regressionAttacks = context.state.attacks.filter((attack) => {
            if (
              attack.status !== "landed" ||
              !attack.targets.includes(agent) ||
              !attack.rootDefectId
            )
              return false;
            return contestant.healthLedger.canonicalDefects?.some(
              (defect) =>
                defect.rootDefectId === attack.rootDefectId &&
                defect.status === "healed",
            );
          });
          const checksToRun = [
            ...new Map(
              [...remainingAttacks, ...regressionAttacks].map((attack) => [
                attack.id,
                attack,
              ]),
            ).values(),
          ];
          let mechanicsPassed = true;
          let infrastructureFailure = false;
          let mechanicalValidationFailure: FailureRecord | undefined;
          for (const validationAttempt of [1, 2] as const) {
            const validationStartedAt = this.now().toISOString();
            const diagnosticArtifactRefs: string[] = [];
            mechanicsPassed = true;
            infrastructureFailure = false;
            const requiredTree = await this.prepareWorktree(context, {
              name: `round-${String(round)}-repair-attempt-${agent}-${String(attemptNumber)}-validation-${String(validationAttempt)}-required`,
              subject: `repair-attempt-required-worktree:${String(round)}:${agent}:${String(attemptNumber)}:${String(validationAttempt)}`,
              patches: [candidatePath],
              contestantId: agent,
              runLevel: true,
            });
            try {
              const required = await runShellCommand(
                context.config.testCommand,
                {
                  cwd: requiredTree,
                  timeoutMs: context.config.limits.attackMs,
                  logPrefix: context.store.resolve(
                    `logs/round-${String(round)}-repair-attempt-${agent}-${String(attemptNumber)}-validation-${String(validationAttempt)}-required`,
                  ),
                  signal: context.controller.signal,
                },
              );
              infrastructureFailure =
                required.failureClass === "arena_infrastructure";
              mechanicsPassed = required.exitCode === 0 && !required.timedOut;
              diagnosticArtifactRefs.push(
                required.stdoutPath,
                required.stderrPath,
              );
            } finally {
              await context.worktrees.remove(requiredTree);
            }
            for (const attack of checksToRun) {
              if (!mechanicsPassed || infrastructureFailure) break;
              const checkTree = await this.prepareWorktree(context, {
                name: `round-${String(round)}-repair-attempt-${agent}-${String(attemptNumber)}-validation-${String(validationAttempt)}-${attack.id}`,
                subject: `repair-attempt-case-worktree:${String(round)}:${agent}:${String(attemptNumber)}:${String(validationAttempt)}:${attack.id}`,
                patches: [candidatePath, attack.patchPath],
                contestantId: agent,
                attackId: attack.id,
                runLevel: true,
              });
              try {
                if (attack.browserProbe) {
                  const validateBrowser = this.browserProbeValidator(
                    context,
                    attack.id,
                    { target: agent },
                  );
                  if (!validateBrowser) {
                    infrastructureFailure = true;
                    mechanicsPassed = false;
                  } else {
                    const check = await validateBrowser(
                      checkTree,
                      attack.browserProbe,
                      "target",
                      [
                        candidatePath,
                        ...(attack.evidenceKind === "browser_probe"
                          ? []
                          : [attack.patchPath]),
                      ],
                    );
                    const probeResult = findBrowserProbeResult(
                      check,
                      attack.browserProbe.id,
                    );
                    infrastructureFailure =
                      !probeResult || probeResult.status === "unverified";
                    mechanicsPassed = probeResult?.status === "verified";
                    diagnosticArtifactRefs.push(
                      ...check.artifacts.map((artifact) => artifact.path),
                    );
                    if (
                      mechanicsPassed &&
                      attack.evidenceKind !== "browser_probe"
                    ) {
                      const focused = await runShellCommand(
                        attack.focusedCommand,
                        {
                          cwd: checkTree,
                          timeoutMs: context.config.limits.attackMs,
                          logPrefix: context.store.resolve(
                            `logs/round-${String(round)}-repair-attempt-${agent}-${String(attemptNumber)}-validation-${String(validationAttempt)}-${attack.id}-focused`,
                          ),
                          signal: context.controller.signal,
                        },
                      );
                      infrastructureFailure =
                        focused.failureClass === "arena_infrastructure";
                      mechanicsPassed =
                        focused.exitCode === 0 && !focused.timedOut;
                      diagnosticArtifactRefs.push(
                        focused.stdoutPath,
                        focused.stderrPath,
                      );
                    }
                  }
                } else {
                  const check = await runShellCommand(attack.focusedCommand, {
                    cwd: checkTree,
                    timeoutMs: context.config.limits.attackMs,
                    logPrefix: context.store.resolve(
                      `logs/round-${String(round)}-repair-attempt-${agent}-${String(attemptNumber)}-validation-${String(validationAttempt)}-${attack.id}`,
                    ),
                    signal: context.controller.signal,
                  });
                  infrastructureFailure =
                    check.failureClass === "arena_infrastructure";
                  mechanicsPassed = check.exitCode === 0 && !check.timedOut;
                  diagnosticArtifactRefs.push(
                    check.stdoutPath,
                    check.stderrPath,
                  );
                }
              } finally {
                await context.worktrees.remove(checkTree);
              }
            }
            if (!infrastructureFailure) {
              if (mechanicalValidationFailure) {
                await this.recordFailureAttempt(context, {
                  stage: "repair_validation",
                  subject: `round-${String(round)}-repair-mechanics:${agent}:${String(attemptNumber)}`,
                  category: mechanicalValidationFailure.category,
                  attempt: 2,
                  startedAt: validationStartedAt,
                  finishedAt: this.now().toISOString(),
                  status: "succeeded",
                  diagnosticArtifactRefs,
                  contestantId: agent,
                  existing: mechanicalValidationFailure,
                  reusedArtifactRefs: [candidatePath],
                  terminalDisposition: "recovered",
                });
              }
              break;
            }
            mechanicalValidationFailure = await this.recordFailureAttempt(
              context,
              {
                stage: "repair_validation",
                subject: `round-${String(round)}-repair-mechanics:${agent}:${String(attemptNumber)}`,
                category: "command_execution",
                attempt: validationAttempt,
                startedAt: validationStartedAt,
                finishedAt: this.now().toISOString(),
                status: "failed",
                diagnosticArtifactRefs,
                contestantId: agent,
                ...(mechanicalValidationFailure
                  ? { existing: mechanicalValidationFailure }
                  : {}),
                reusedArtifactRefs: [candidatePath],
                ...(validationAttempt === 2
                  ? { terminalDisposition: "coverage_lost" as const }
                  : {}),
              },
            );
            if (validationAttempt === 1)
              assertTargetedRetryAllowed(validationAttempt);
          }
          if (infrastructureFailure) {
            mechanicalFallback = {
              attemptId,
              candidatePath,
              attacks: remainingAttacks,
              reason:
                "Mechanical repair validation remained unavailable after the targeted retry",
            };
            break;
          }
          mechanicalFallback = undefined;
          if (mechanicsPassed) break;
        }
        if (mechanicalFallback) {
          const patchBytes = await readFile(mechanicalFallback.candidatePath);
          const patchDigest = sha256(patchBytes);
          const verifier = this.recordingVerifier(context, round);
          for (const attack of mechanicalFallback.attacks) {
            if (!attack.rootDefectId || !attack.adjudication) continue;
            const promptPath = context.store.resolve(
              `prompts/round-${String(round)}-repair-judgment-${agent}-${attack.rootDefectId}.md`,
            );
            const transcriptPrefix = context.store.resolve(
              `logs/round-${String(round)}-repair-judgment-${agent}-${attack.rootDefectId}`,
            );
            let verdict:
              | Awaited<ReturnType<NonNullable<AttackVerifier["assessRepair"]>>>
              | undefined;
            let judgeFailure: FailureRecord | undefined;
            let judgeRetryReason: string | undefined;
            if (verifier.assessRepair) {
              for (const retry of [1, 2] as const) {
                const startedAt = this.now().toISOString();
                const attemptTranscriptPrefix = `${transcriptPrefix}-attempt-${String(retry)}`;
                let failureReason: string | undefined;
                try {
                  verdict = await verifier.assessRepair({
                    attack: anonymizeAttackForVerifier(attack),
                    runSpec: context.runSpec,
                    canonicalDefectId: attack.rootDefectId,
                    adjudicationId: attack.adjudication.id,
                    candidatePatchPath: mechanicalFallback.candidatePath,
                    mechanicalFailureReason: mechanicalFallback.reason,
                    worktree,
                    promptPath,
                    transcriptPrefix: attemptTranscriptPrefix,
                    timeoutMs: context.config.limits.verifierMs,
                    signal: context.controller.signal,
                    ...(judgeRetryReason
                      ? { retryReason: judgeRetryReason }
                      : {}),
                  });
                  if (verdict.decision !== "unable") {
                    if (judgeFailure) {
                      await this.recordFailureAttempt(context, {
                        stage: "model_invocation",
                        subject: `repair-judge:${attack.rootDefectId}`,
                        category: judgeFailure.category,
                        attempt: 2,
                        startedAt,
                        finishedAt: this.now().toISOString(),
                        status: "succeeded",
                        diagnosticArtifactRefs: [
                          promptPath,
                          attemptTranscriptPrefix,
                        ],
                        contestantId: agent,
                        attackId: attack.id,
                        existing: judgeFailure,
                        terminalDisposition: "recovered",
                      });
                    }
                    break;
                  }
                  failureReason = verdict.rationale;
                } catch (error) {
                  failureReason =
                    error instanceof Error ? error.message : String(error);
                }
                judgeRetryReason = failureReason;
                judgeFailure = await this.recordFailureAttempt(context, {
                  stage: "model_invocation",
                  subject: `repair-judge:${attack.rootDefectId}`,
                  category: "transport",
                  attempt: retry,
                  startedAt,
                  finishedAt: this.now().toISOString(),
                  status: "failed",
                  diagnosticArtifactRefs: [promptPath, attemptTranscriptPrefix],
                  contestantId: agent,
                  attackId: attack.id,
                  ...(judgeFailure ? { existing: judgeFailure } : {}),
                  ...(retry === 2
                    ? { terminalDisposition: "judge_unable" as const }
                    : {}),
                });
                if (retry === 2) {
                  context.state.warnings.push(
                    `Repair judge was unable to assess ${attack.rootDefectId}: ${failureReason ?? "unable"}`,
                  );
                }
              }
            }
            if (this.recordVerifierProviderFailure(context, round))
              throw new Error(context.state.providerFailure?.reason);
            const decision = verdict?.decision ?? "unable";
            const rationale =
              verdict?.rationale ??
              "No repair judge result was available after mechanical validation failed";
            const record = RepairJudgmentRecordSchema.parse({
              version: 1,
              id: stableId(
                "repair-judgment",
                context.state.runId,
                String(round),
                agent,
                attack.rootDefectId,
                patchDigest,
              ),
              round,
              canonicalDefectId: attack.rootDefectId,
              contestantId: agent,
              attemptId: mechanicalFallback.attemptId,
              patchDigest,
              packetDigest:
                verdict?.packetDigest ??
                sha256(
                  `${attack.adjudication.id}:${patchDigest}:${mechanicalFallback.reason}`,
                ),
              decision,
              rationale,
              adjudicationId: attack.adjudication.id,
              artifactRefs: [
                attack.patchPath,
                mechanicalFallback.candidatePath,
                promptPath,
              ],
              createdAt: this.now().toISOString(),
            });
            context.state.repairJudgments.push(record);
            await context.store.writeImmutableJson(
              `rounds/${String(round)}/repair-judgments/${record.id}.json`,
              record,
            );
            if (decision === "repaired") {
              const repaired = judgeRepairedDefects.get(agent) ?? new Set();
              repaired.add(attack.rootDefectId);
              judgeRepairedDefects.set(agent, repaired);
            }
          }
        }
        invocation = attempts.at(-1)!;
        invocation.contestantId = agent;
        invocation.role = contestant.role;
        for (const attempt of attempts) {
          attempt.contestantId = agent;
          attempt.role = contestant.role;
        }
        repairs.set(agent, invocation);
        repairAttempts.set(agent, attempts);
        await removeSubmission(worktree);
        const patchPath = context.store.resolve(
          `patches/${agent}-round-${String(round)}.diff`,
        );
        const patchSize = await context.worktrees.capturePatch(
          worktree,
          patchPath,
          undefined,
          true,
        );
        if (patchSize > 0) {
          contestant.currentPatchPath = patchPath;
          contestant.patchSize = patchSize;
        }
      } finally {
        await context.worktrees.remove(worktree);
      }
    }
    await this.persist(context);

    await this.transition(context, "validate_repairs", round);
    for (const agent of context.config.agents) {
      let contestant = getContestant(context.state, agent);
      if (context.config.mode === "siege" && contestant.role === "attacker") {
        continue;
      }
      const currentPatch = contestant.currentPatchPath;
      if (
        !currentPatch ||
        contestant.patchSize === 0 ||
        contestant.status === "failed"
      ) {
        if (contestant.status !== "failed") contestant.status = "eliminated";
        contestant.healthLedger.eliminatedByRequiredCheck = true;
        contestant.finalHealth = 0;
        continue;
      }
      const validateTree = await this.prepareWorktree(context, {
        name: `round-${String(round)}-validate-repair-${agent}`,
        subject: `repair-validation-worktree:${String(round)}:${agent}`,
        patches: [currentPatch],
        contestantId: agent,
        runLevel: true,
      });
      try {
        let command!: Awaited<ReturnType<typeof runShellCommand>>;
        let validationFailure: FailureRecord | undefined;
        for (const attempt of [1, 2] as const) {
          const startedAt = this.now().toISOString();
          const logPrefix = context.store.resolve(
            `logs/round-${String(round)}-repair-required-${agent}-attempt-${String(attempt)}`,
          );
          command = await runShellCommand(context.config.testCommand, {
            cwd: validateTree,
            timeoutMs: context.config.limits.attackMs,
            logPrefix,
            signal: context.controller.signal,
          });
          const finishedAt = this.now().toISOString();
          const diagnosticArtifactRefs = [
            command.stdoutPath,
            command.stderrPath,
          ];
          if (command.failureClass !== "arena_infrastructure") {
            if (validationFailure) {
              validationFailure = await this.recordFailureAttempt(context, {
                stage: "repair_validation",
                subject: `round-${String(round)}-repair-required:${agent}`,
                category: validationFailure.category,
                attempt: 2,
                startedAt,
                finishedAt,
                status: "succeeded",
                diagnosticArtifactRefs,
                contestantId: agent,
                existing: validationFailure,
                reusedArtifactRefs: [currentPatch],
                terminalDisposition: "recovered",
              });
            }
            break;
          }
          validationFailure = await this.recordFailureAttempt(context, {
            stage: "repair_validation",
            subject: `round-${String(round)}-repair-required:${agent}`,
            category: "command_execution",
            attempt,
            startedAt,
            finishedAt,
            status: "failed",
            diagnosticArtifactRefs,
            contestantId: agent,
            ...(validationFailure ? { existing: validationFailure } : {}),
            reusedArtifactRefs: [currentPatch],
            ...(attempt === 2
              ? { terminalDisposition: "run_level_coverage_lost" as const }
              : {}),
          });
          if (attempt === 2) break;
        }
        const check = requiredCheck(`round-${String(round)}-required`, command);
        contestant.checks.push(check);
        if (check.status === "infrastructure_error") {
          throw new Error(
            `Required repair validation infrastructure failed for ${agent}`,
          );
        }
        if (check.status !== "passed") {
          contestant.healthLedger.eliminatedByRequiredCheck = true;
          contestant.finalHealth = 0;
          contestant.status = "eliminated";
          contestant.healthEvents.push({
            round,
            type: "elimination",
            amount: -calculateHealth(contestant.healthLedger),
            reason: "Required validation failed after repair opportunity",
          });
        }
      } finally {
        await context.worktrees.remove(validateTree);
      }

      if (contestant.status !== "eliminated") {
        for (const defect of [...contestant.healthLedger.activeDefects]) {
          if (judgeRepairedDefects.get(agent)?.has(defect.rootDefectId)) {
            contestant = healDefect(
              contestant,
              defect.rootDefectId,
              round,
              `Identity-blind judge confirmed repair for ${defect.rootDefectId} after mechanical validation remained unavailable`,
            );
            context.state.contestants[agent] = contestant;
            continue;
          }
          const attack = context.state.attacks.find(
            (candidate) =>
              candidate.rootDefectId === defect.rootDefectId &&
              candidate.targets.includes(agent) &&
              candidate.status === "landed",
          );
          if (!attack) continue;
          const acceptedCases = attack.caseBundle?.cases.filter(
            (caseEntry) => caseEntry.status !== "rejected",
          ) ?? [
            {
              id: `${attack.id}-visible`,
              visibility: "visible" as const,
              category: "visible_reproducer",
              patchPath: attack.patchPath,
              focusedCommand: attack.focusedCommand,
              contentHash: "",
              status: "accepted" as const,
            },
          ];
          let allCasesPass = true;
          for (const caseEntry of acceptedCases) {
            const caseTree = await this.prepareWorktree(context, {
              name: `round-${String(round)}-heal-${agent}-${caseEntry.id}`,
              subject: `heal-case-worktree:${String(round)}:${agent}:${caseEntry.id}`,
              patches: [currentPatch, caseEntry.patchPath],
              contestantId: agent,
              attackId: attack.id,
              runLevel: true,
            });
            try {
              const isVisibleBrowserReproducer =
                Boolean(attack.browserProbe) &&
                caseEntry.visibility === "visible";
              if (isVisibleBrowserReproducer && attack.browserProbe) {
                const validateBrowser = this.browserProbeValidator(
                  context,
                  attack.id,
                  { target: agent },
                );
                if (!validateBrowser)
                  throw new Error(
                    `Browser repair evidence is unavailable for ${agent} on ${caseEntry.id}`,
                  );
                const browserResult = await validateBrowser(
                  caseTree,
                  attack.browserProbe,
                  "target",
                  [
                    currentPatch,
                    ...(attack.evidenceKind === "browser_probe"
                      ? []
                      : [caseEntry.patchPath]),
                  ],
                );
                const browserEvidencePasses = browserRepairEvidencePasses(
                  browserResult,
                  attack.browserProbe.id,
                );
                if (browserEvidencePasses === undefined)
                  throw new BrowserInfrastructureError(
                    `Browser repair evidence was unverified for ${agent} on ${caseEntry.id}`,
                    browserResult.reason ?? "launch_failure",
                    browserResult.failureAttribution === "harness_configuration"
                      ? "harness_configuration"
                      : "harness_transport",
                  );
                if (!browserEvidencePasses) allCasesPass = false;
                if (attack.evidenceKind === "browser_probe") continue;
              }
              const checks = [];
              for (const sample of [1, 2] as const) {
                let infrastructureFailure: FailureRecord | undefined;
                for (const attempt of [1, 2] as const) {
                  const startedAt = this.now().toISOString();
                  const command = await runShellCommand(
                    caseEntry.focusedCommand,
                    {
                      cwd: caseTree,
                      timeoutMs: context.config.limits.attackMs,
                      logPrefix: context.store.resolve(
                        `logs/round-${String(round)}-heal-${agent}-${caseEntry.id}-sample-${String(sample)}-attempt-${String(attempt)}`,
                      ),
                      signal: context.controller.signal,
                    },
                  );
                  const finishedAt = this.now().toISOString();
                  const diagnosticArtifactRefs = [
                    command.stdoutPath,
                    command.stderrPath,
                  ];
                  if (command.failureClass !== "arena_infrastructure") {
                    if (infrastructureFailure) {
                      infrastructureFailure = await this.recordFailureAttempt(
                        context,
                        {
                          stage: "repair_validation",
                          subject: `heal-case:${agent}:${caseEntry.id}:sample-${String(sample)}`,
                          category: infrastructureFailure.category,
                          attempt: 2,
                          startedAt,
                          finishedAt,
                          status: "succeeded",
                          diagnosticArtifactRefs,
                          contestantId: agent,
                          attackId: attack.id,
                          existing: infrastructureFailure,
                          reusedArtifactRefs: [
                            currentPatch,
                            caseEntry.patchPath,
                          ],
                          terminalDisposition: "recovered",
                        },
                      );
                    }
                    checks.push(command);
                    break;
                  }
                  infrastructureFailure = await this.recordFailureAttempt(
                    context,
                    {
                      stage: "repair_validation",
                      subject: `heal-case:${agent}:${caseEntry.id}:sample-${String(sample)}`,
                      category:
                        infrastructureFailure?.category ??
                        (command.timedOut ? "timeout" : "command_execution"),
                      attempt,
                      startedAt,
                      finishedAt,
                      status: "failed",
                      diagnosticArtifactRefs,
                      contestantId: agent,
                      attackId: attack.id,
                      ...(infrastructureFailure
                        ? { existing: infrastructureFailure }
                        : {}),
                      reusedArtifactRefs: [currentPatch, caseEntry.patchPath],
                      ...(attempt === 2
                        ? {
                            terminalDisposition:
                              "run_level_coverage_lost" as const,
                          }
                        : {}),
                    },
                  );
                  if (attempt === 2) {
                    throw new Error(
                      `Repair evidence infrastructure failed for ${agent} on ${caseEntry.id}`,
                    );
                  }
                }
              }
              if (!checks.every((check) => check.exitCode === 0)) {
                allCasesPass = false;
                if (caseEntry.visibility === "held_out")
                  caseEntry.status = "revealed";
              }
            } finally {
              await context.worktrees.remove(caseTree);
            }
          }
          if (allCasesPass) {
            contestant = healDefect(contestant, defect.rootDefectId, round);
            context.state.contestants[agent] = contestant;
          }
        }
      }
      contestant.finalHealth = calculateHealth(contestant.healthLedger);
      if (contestant.finalHealth === 0) contestant.status = "eliminated";
    }

    for (const attack of context.state.attacks) {
      if (!attack.rootDefectId || attack.status !== "landed") continue;
      attack.damageActive = attack.targets.some((target) =>
        getContestant(context.state, target).healthLedger.activeDefects.some(
          (defect) => defect.rootDefectId === attack.rootDefectId,
        ),
      );
    }

    for (const agent of context.config.agents) {
      const contestant = getContestant(context.state, agent);
      const roundResult: ContestantRoundResult = {
        round,
        startingHealth: roundStarts.get(agent) ?? 100,
        submittedAttackIds: validated
          .filter(
            (attack) =>
              attack.origin.kind === "contestant" &&
              attack.origin.contestant === agent,
          )
          .map((attack) => attack.id),
        postAttackHealth: postAttack.get(agent) ?? contestant.finalHealth,
        postAttackStatus:
          (postAttack.get(agent) ?? 1) <= 0 ? "downed" : "active",
        endingHealth: contestant.finalHealth,
        endingStatus:
          contestant.status === "eliminated" ? "eliminated" : "active",
        ...(repairs.has(agent) ? { repair: repairs.get(agent) } : {}),
        ...(repairAttempts.has(agent)
          ? { repairAttempts: repairAttempts.get(agent) }
          : {}),
      };
      contestant.rounds.push(roundResult);
    }
    await Promise.all(
      context.state.attacks.flatMap((attack) =>
        attack.caseBundle
          ? [
              context.store.writeJson(
                `cases/${attack.id}/manifest.json`,
                attack.caseBundle,
              ),
            ]
          : [],
      ),
    );
    await this.persist(context);
  }

  protected async reviewInfrastructure(
    context: ArenaContext,
    provisional: Attack,
    authorPatch: string,
    targetPatch: string,
    knownRoots: ReadonlySet<string>,
    round: 1 | 2 | 3 | 4 | 5,
  ): Promise<Attack> {
    const legacyDependencies = this.dependencies as ArenaDependencies &
      LegacyArenaDependencies;
    const author =
      provisional.origin.kind === "contestant"
        ? provisional.origin.contestant
        : undefined;
    if (!author) return { ...provisional, status: "infrastructure_error" };
    await this.proposeHarnessOverlay(context, provisional, round);
    if (!legacyDependencies.infrastructureReviewer) {
      return {
        ...provisional,
        status: "infrastructure_error",
        infrastructureReview: "accept",
        outcomeReason: `${provisional.outcomeReason ?? ""}; no reviewer configured, conservatively accepted as infrastructure`,
      };
    }
    const worktree = await this.prepareWorktree(context, {
      name: `infrastructure-review-${provisional.id}`,
      subject: `legacy-infrastructure-review-worktree:${provisional.id}`,
      patches: [provisional.patchPath],
      attackId: provisional.id,
    });
    try {
      const prompt = [
        "# Review your provisionally infrastructural attack",
        "Choose accept to withdraw with no-fault confirmation, or challenge once.",
        "A challenge may alter only setup, teardown, isolation, bounded timeout, observability, and the focused command.",
        "It must preserve claim, oracle, assertion, target, rank, and root defect.",
        "",
        JSON.stringify(
          {
            attack: {
              id: provisional.id,
              claim: provisional.claim,
              oracle: provisional.oracle,
              assertionFingerprint: provisional.assertionFingerprint,
              targets: provisional.targets,
              rank: provisional.rank,
              rootDefectId: provisional.rootDefectId,
            },
            redactedOutcome: provisional.outcomeReason,
            checks: provisional.checks,
          },
          null,
          2,
        ),
        "",
        `Write an accept/challenge response to ${path.join(worktree, ".agent-arena-infrastructure-review.json")}.`,
      ].join("\n");
      const review = await legacyDependencies.infrastructureReviewer.review({
        agent: getContestant(context.state, author).provider,
        attack: provisional,
        redactedEvidence:
          provisional.outcomeReason ?? "ambiguous infrastructure",
        worktree,
        prompt,
        timeoutMs: context.config.limits.attackMs,
        transcriptPrefix: context.store.resolve(
          `logs/infrastructure-review-${provisional.id}`,
        ),
        signal: context.controller.signal,
        round,
      });
      await rm(path.join(worktree, ".agent-arena-infrastructure-review.json"), {
        force: true,
      });
      if (review.decision === "accept") {
        return {
          ...provisional,
          status: "infrastructure_error",
          infrastructureReview: "accept",
          outcomeReason: `${provisional.outcomeReason ?? ""}; author accepted infrastructure: ${review.explanation}`,
        };
      }
      const patchPath = context.store.resolve(
        `revisions/round-${String(round)}/${author}/${String(provisional.rank ?? 1)}.diff`,
      );
      await context.worktrees.capturePatch(
        worktree,
        patchPath,
        undefined,
        true,
      );
      const revised: Attack = {
        ...provisional,
        status: "submitted",
        patchPath,
        focusedCommand: review.focusedCommand ?? provisional.focusedCommand,
        checks: [],
        infrastructureReview: "challenge",
        evidenceRevision: {
          attempt: 1,
          setupChanged: review.setupChanged,
          teardownChanged: review.teardownChanged,
          timeoutChanged: review.timeoutChanged,
          observabilityChanged: review.observabilityChanged,
          focusedCommandChanged: review.focusedCommand !== undefined,
          patchPath,
          explanation: review.explanation,
        },
      };
      assertEvidenceIdentityPreserved(provisional, revised);
      const replay = await validateAttack({
        attack: revised,
        authorPatch,
        targetPatch,
        runSpec: context.runSpec,
        permissionPolicy: context.permissions,
        config: context.config,
        worktrees: context.worktrees,
        verifier: this.recordingVerifier(context, round),
        logRoot: context.store.resolve(
          `logs/infrastructure-revision-${provisional.id}`,
        ),
        signal: context.controller.signal,
        knownRootDefects: knownRoots,
        priorCanonicalDefects: priorCanonicalDefects(
          context.state,
          provisional.targets,
        ),
        ...this.browserValidatorOption(context, provisional),
      });
      if (this.recordVerifierProviderFailure(context, round))
        throw new Error(context.state.providerFailure?.reason);
      if (replay.status === "provisional_infrastructure") {
        replay.status = "execution_inconclusive";
        replay.outcomeReason =
          "Single bounded evidence revision could not establish causality";
      }
      replay.infrastructureReview = "challenge";
      replay.evidenceRevision = revised.evidenceRevision;
      return replay;
    } catch (error) {
      context.state.warnings.push(
        `Infrastructure review failed for ${provisional.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        ...provisional,
        status: "infrastructure_error",
        infrastructureReview: "accept",
        outcomeReason:
          "Infrastructure review provider failed; no health effect",
      };
    } finally {
      await context.worktrees.remove(worktree);
    }
  }

  protected async proposeHarnessOverlay(
    context: ArenaContext,
    provisional: Attack,
    round: 1 | 2 | 3 | 4 | 5,
  ): Promise<void> {
    const legacyDependencies = this.dependencies as ArenaDependencies &
      LegacyArenaDependencies;
    if (!("harnessOverlays" in context.state)) return;
    if (!legacyDependencies.harnessMaintainer) return;
    const worktree = await this.prepareWorktree(context, {
      name: `harness-overlay-${provisional.id}`,
      subject: `legacy-harness-overlay-worktree:${provisional.id}`,
      attackId: provisional.id,
    });
    try {
      const redactedEvidence = JSON.stringify(
        {
          failureId: provisional.id,
          reason: provisional.outcomeReason,
          checks: provisional.checks,
        },
        null,
        2,
      )
        .replaceAll(context.config.agents[0] ?? "a", "[CONTESTANT]")
        .replaceAll(context.config.agents[1] ?? "b", "[CONTESTANT]")
        .replaceAll(context.config.repositoryRoot, "[REPOSITORY]");
      const prompt = [
        "# Anonymized Agent Arena harness-maintainer packet",
        "Propose only a symmetric run overlay for service orchestration, worktree setup, environment construction, broker wiring, timeout, resource limits, retries, or diagnostics.",
        "Never modify contestant patches, attack assertions, claims, oracles, severity, health, or ranking.",
        "",
        redactedEvidence,
        "",
        `Write {"version":1,"explanation":"...","scopes":["diagnostic"],"permissionChanges":[]} to ${path.join(worktree, ".agent-arena-overlay.json")}.`,
      ].join("\n");
      const proposal =
        await legacyDependencies.harnessMaintainer.proposeOverlay(
          {
            failureId: provisional.id,
            redactedEvidence,
            policy: context.permissions,
            worktree,
            prompt,
            timeoutMs: context.config.limits.attackMs,
            transcriptPrefix: context.store.resolve(
              `logs/harness-overlay-${provisional.id}`,
            ),
            round,
          },
          context.controller.signal,
        );
      await rm(path.join(worktree, ".agent-arena-overlay.json"), {
        force: true,
      });
      const proposalPath = await context.store.writeJson(
        `harness-overlays/${provisional.id}-proposal.json`,
        proposal,
      );
      const materialPermissionApproved = proposal.permissionChanges.every(
        (id) =>
          context.permissions.capabilities.find(
            (capability) => capability.id === id,
          )?.status === "approved",
      );
      const overlay = validateHarnessOverlay(
        {
          failureId: provisional.id,
          patchPath: proposalPath,
          scopes: proposal.scopes,
          permissionChanges: proposal.permissionChanges,
        },
        {
          symmetric: true,
          validationChecks: [
            {
              id: `${provisional.id}-symmetric-controls`,
              kind: "service_health",
              status: provisional.checks.some(
                (check) => check.status === "infrastructure_error",
              )
                ? "failed"
                : "passed",
            },
          ],
          materialPermissionApproved,
        },
      );
      context.state.harnessOverlays.push(overlay);
      await context.store.writeJson(
        `harness-overlays/${overlay.id}.json`,
        overlay,
      );
    } catch (error) {
      context.state.warnings.push(
        `Harness maintainer could not produce a validated overlay for ${provisional.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await context.worktrees.remove(worktree);
    }
  }

  private async finalizeAttackAdjudication(
    context: ArenaContext,
    result: Attack,
    round: RoundId,
    history: readonly Attack[] = context.state.attacks,
  ): Promise<void> {
    result.adjudication = normalizeAttackAdjudication(result);
    const priorCanonicals = result.targets.map((target) =>
      getContestant(context.state, target).healthLedger.canonicalDefects?.find(
        (defect) =>
          defect.rootDefectId === result.adjudication?.canonicalDefectId,
      ),
    );
    const priorCanonical = priorCanonicals.find(Boolean);
    const hasUnscoredTarget = priorCanonicals.some((canonical) => !canonical);
    if (
      priorCanonical &&
      result.adjudication.verdict === "valid" &&
      result.challengeRelationship !== "overturn"
    ) {
      result.adjudication = AdjudicationRecordSchema.parse({
        ...result.adjudication,
        severity: priorCanonical.baseSeverity,
      });
    }
    if (
      result.adjudication.verdict === "valid" &&
      result.adjudication.duplicateState !== "unique" &&
      result.adjudication.severity &&
      hasUnscoredTarget
    ) {
      result.adjudication = AdjudicationRecordSchema.parse({
        ...result.adjudication,
        scoreEffect: "damage",
        exactAmount:
          result.adjudication.multiplier === 0.35
            ? PARTIAL_DAMAGE_BY_SEVERITY[result.adjudication.severity]
            : DAMAGE_BY_SEVERITY[result.adjudication.severity],
      });
    }
    if (
      priorCanonical?.status === "healed" &&
      result.status === "duplicate" &&
      result.adjudication.verdict === "valid" &&
      result.adjudication.multiplier === 1
    ) {
      result.adjudication = AdjudicationRecordSchema.parse({
        ...result.adjudication,
        severity: priorCanonical.baseSeverity,
        duplicateState: "regression",
        scoreEffect: "damage",
        exactAmount: DAMAGE_BY_SEVERITY[priorCanonical.baseSeverity],
      });
    }
    if (
      priorCanonical &&
      result.adjudication.verdict === "valid" &&
      result.adjudication.multiplier > priorCanonical.currentMultiplier
    ) {
      const delta =
        DAMAGE_BY_SEVERITY[priorCanonical.baseSeverity] -
        priorCanonical.currentDamage;
      const regression = result.adjudication.duplicateState === "regression";
      result.adjudication = AdjudicationRecordSchema.parse({
        ...result.adjudication,
        severity: priorCanonical.baseSeverity,
        scoreEffect: regression
          ? "damage"
          : hasUnscoredTarget
            ? "damage"
            : priorCanonical.status === "active" && delta > 0
              ? "damage_upgrade"
              : "none",
        exactAmount: regression
          ? DAMAGE_BY_SEVERITY[priorCanonical.baseSeverity]
          : hasUnscoredTarget
            ? DAMAGE_BY_SEVERITY[priorCanonical.baseSeverity]
            : priorCanonical.status === "active"
              ? Math.max(0, delta)
              : 0,
        ...(priorCanonical.firstAdjudicationId
          ? {
              upgradesAdjudicationId: priorCanonical.firstAdjudicationId,
            }
          : {}),
      });
    }
    const challengeContext = priorAdjudicationContext(result, history);
    const requestedPriorId =
      result.relatedAdjudicationId ?? result.challengeAdjudicationId;
    const referencedPrior = requestedPriorId
      ? challengeContext.find(
          (entry) => entry.adjudicationId === requestedPriorId,
        )
      : undefined;
    let relationship =
      result.challengeRelationship ??
      (result.challengeAdjudicationId ? "unresolved" : "independent");
    if (
      (relationship !== "independent" && !referencedPrior) ||
      (result.challengeAdjudicationId &&
        requestedPriorId !== result.challengeAdjudicationId)
    )
      relationship = "unresolved";
    if (relationship === "overturn" && result.adjudication.verdict === "unable")
      relationship = "unresolved";
    if (relationship === "affirm") {
      result.damageActive = false;
      result.adjudication = AdjudicationRecordSchema.parse({
        ...result.adjudication,
        relationship,
        priorAdjudicationId: referencedPrior!.adjudicationId,
        duplicateState: "unique",
        scoreEffect: "none",
        exactAmount: 0,
        recoilAmount: undefined,
      });
    } else if (relationship === "unresolved") {
      result.status = "judge_unable";
      result.damageActive = false;
      result.outcomeReason =
        "Challenge relationship could not be resolved against a valid prior adjudication";
      result.adjudication = AdjudicationRecordSchema.parse({
        ...result.adjudication,
        verdict: "unable",
        relationship,
        ...(requestedPriorId ? { priorAdjudicationId: requestedPriorId } : {}),
        rejectionBasis: undefined,
        canonicalDefectId: undefined,
        severity: undefined,
        duplicateState: "unique",
        evidenceBasis: "none",
        multiplier: 0,
        scoreEffect: "none",
        exactAmount: 0,
        recoilAmount: undefined,
      });
    } else if (relationship === "overturn") {
      const supersededAttack = referencedPrior
        ? history.find(
            (attack) =>
              attack.adjudication?.id === referencedPrior.adjudicationId,
          )
        : undefined;
      const adjustsExistingDefect =
        supersededAttack?.adjudication?.verdict === "valid" &&
        result.adjudication.verdict === "valid" &&
        supersededAttack.adjudication.canonicalDefectId ===
          result.adjudication.canonicalDefectId;
      if (
        result.adjudication.verdict === "valid" &&
        result.adjudication.severity
      ) {
        result.status = "landed";
        result.damageActive = true;
        result.adjudication = AdjudicationRecordSchema.parse({
          ...result.adjudication,
          duplicateState: "unique",
          scoreEffect: "damage",
          exactAmount:
            result.adjudication.multiplier === 0.35
              ? PARTIAL_DAMAGE_BY_SEVERITY[result.adjudication.severity]
              : DAMAGE_BY_SEVERITY[result.adjudication.severity],
          recoilAmount: undefined,
        });
      }
      if (adjustsExistingDefect) {
        result.adjudication = AdjudicationRecordSchema.parse({
          ...result.adjudication,
          scoreEffect: "none",
          exactAmount: 0,
        });
      }
      if (result.adjudication.verdict === "rejected") {
        result.adjudication = AdjudicationRecordSchema.parse({
          ...result.adjudication,
          scoreEffect: "none",
          exactAmount: 0,
          recoilAmount: undefined,
        });
      }
      result.adjudication = AdjudicationRecordSchema.parse({
        ...result.adjudication,
        relationship,
        priorAdjudicationId: referencedPrior!.adjudicationId,
        supersedesAdjudicationId: referencedPrior!.adjudicationId,
      });
    } else {
      result.adjudication = AdjudicationRecordSchema.parse({
        ...result.adjudication,
        relationship: "independent",
      });
    }
    result.adjudication = AdjudicationRecordSchema.parse(
      Object.fromEntries(
        Object.entries({
          ...result.adjudication,
          evidenceFingerprint: result.evidenceFingerprint,
          targetPatchDigest: result.targetPatchDigest,
        }).filter(([, value]) => value !== undefined),
      ),
    );
    if (typeof round === "number" && round >= 4) {
      const triggerIds =
        context.state.adaptiveDecisions.find(
          (decision) => decision.round === round - 1,
        )?.extensionTriggerDefectIds ?? [];
      const referencedDefect = history.find(
        (attack) =>
          attack.adjudication?.id === result.challengeAdjudicationId ||
          attack.adjudication?.id === result.relatedAdjudicationId,
      )?.rootDefectId;
      const inScope =
        Boolean(result.adjudication.canonicalDefectId) &&
        (triggerIds.includes(result.adjudication.canonicalDefectId!) ||
          (referencedDefect ? triggerIds.includes(referencedDefect) : false));
      if (!inScope) {
        result.status = "unproven";
        result.damageActive = false;
        delete result.recoil;
        result.outcomeReason =
          "Recorded as an out-of-scope extension finding without score effect";
        result.adjudication = AdjudicationRecordSchema.parse({
          ...result.adjudication,
          scoreEffect: "none",
          exactAmount: 0,
          recoilAmount: undefined,
        });
      }
    }
    await context.store.writeImmutableJson(
      `rounds/${String(round)}/adjudications/${result.id}.json`,
      result.adjudication,
    );
  }

  private async buildCaseBundle(
    context: ArenaContext,
    attack: Attack,
    round: 1 | 2 | 3 | 4 | 5,
  ): Promise<void> {
    if (!attack.rootDefectId) return;
    const visibleContent = await readFile(attack.patchPath);
    const cases: NonNullable<Attack["caseBundle"]>["cases"] = [
      {
        id: stableId("case", attack.id, "visible"),
        visibility: "visible" as const,
        category: "visible_reproducer",
        patchPath: attack.patchPath,
        focusedCommand: attack.focusedCommand,
        contentHash: sha256(visibleContent),
        status: "accepted" as const,
      },
    ];
    if (
      this.dependencies.caseBuilder &&
      context.config.maxHeldOutCasesPerDefect > 0
    ) {
      let authorPatch: string | undefined;
      if (attack.origin.kind === "contestant") {
        authorPatch = getContestant(
          context.state,
          attack.origin.contestant,
        ).currentPatchPath;
      }
      let worktree = await this.prepareWorktree(context, {
        name: `case-builder-${attack.id}`,
        subject: `case-builder-worktree:${attack.id}`,
        patches: authorPatch ? [authorPatch] : [],
        attackId: attack.id,
      });
      try {
        let prompt = [
          "# Held-out sibling case builder",
          "Generate zero to two deterministic test-only sibling cases for the exact same supported behavior and canonical root defect.",
          "Do not broaden the requirement, severity, claim, or expected behavior. Do not reveal generated paths or inputs to contestants.",
          "",
          "# Attack",
          JSON.stringify(
            {
              claim: attack.claim,
              oracle: attack.oracle,
              rootDefectId: attack.rootDefectId,
              visiblePatch: await readFile(attack.patchPath, "utf8"),
            },
            null,
            2,
          ),
          "",
          `Write {"version":1,"cases":[{"category":"boundary","focusedCommand":"...","paths":["test/..."]}]} to ${path.join(worktree, ".agent-arena-cases.json")}.`,
        ].join("\n");
        const siblingArtifactPaths: string[] = [];
        let captured!: Awaited<
          ReturnType<typeof this.persistReturnedSubmission>
        >;
        let generationFailure: FailureRecord | undefined;
        for (const attempt of [1, 2] as const) {
          const startedAt = this.now().toISOString();
          const transcriptPrefix = context.store.resolve(
            `logs/case-builder-${attack.id}-attempt-${String(attempt)}`,
          );
          siblingArtifactPaths.push(transcriptPrefix);
          try {
            const submission = await this.recordCaseGeneration(
              context,
              round,
              siblingArtifactPaths,
              () =>
                this.dependencies.caseBuilder!.build({
                  worktree,
                  prompt,
                  timeoutMs: context.config.limits.attackMs,
                  transcriptPrefix,
                  signal: context.controller.signal,
                  round,
                }),
            );
            captured = await this.persistReturnedSubmission(context, {
              submission,
              round,
              phase: "held-out-case-generation",
              actor: `${attack.id}-attempt-${String(attempt)}`,
              kind: "case",
            });
            if (captured.parsed.outcome === "invalid")
              throw new Error("Held-out case submission was invalid");
            if (generationFailure) {
              generationFailure = await this.recordFailureAttempt(context, {
                stage: "model_invocation",
                subject: `held-out-case-generation:${attack.id}`,
                category: generationFailure.category,
                attempt: 2,
                startedAt,
                finishedAt: this.now().toISOString(),
                status: "succeeded",
                diagnosticArtifactRefs: [
                  transcriptPrefix,
                  captured.rawPath,
                  captured.parsedPath,
                ],
                attackId: attack.id,
                existing: generationFailure,
                terminalDisposition: "recovered",
              });
            }
            break;
          } catch (error) {
            generationFailure = await this.recordFailureAttempt(context, {
              stage: "model_invocation",
              subject: `held-out-case-generation:${attack.id}`,
              category:
                generationFailure?.category ??
                (this.isInfrastructureError(error)
                  ? "transport"
                  : "invalid_output"),
              attempt,
              startedAt,
              finishedAt: this.now().toISOString(),
              status: "failed",
              diagnosticArtifactRefs: [transcriptPrefix],
              attackId: attack.id,
              ...(generationFailure ? { existing: generationFailure } : {}),
              ...(attempt === 2
                ? { terminalDisposition: "coverage_lost" as const }
                : {}),
            });
            if (attempt === 2) throw error;
            const previousWorktree = worktree;
            await context.worktrees.remove(worktree);
            worktree = await this.prepareWorktree(context, {
              name: `case-builder-${attack.id}`,
              subject: `case-builder-retry-worktree:${attack.id}`,
              patches: authorPatch ? [authorPatch] : [],
              attackId: attack.id,
            });
            prompt = prompt.replaceAll(previousWorktree, worktree);
          }
        }
        siblingArtifactPaths.push(captured.rawPath, captured.parsedPath);
        await rm(path.join(worktree, ".agent-arena-cases.json"), {
          force: true,
        });
        for (const [index, proposal] of (
          captured.parsed.value as CaseSubmission
        ).cases
          .slice(0, context.config.maxHeldOutCasesPerDefect)
          .entries()) {
          const patchPath = context.store.resolve(
            `cases/${attack.id}/held-out/${String(index + 1)}.diff`,
          );
          await context.worktrees.capturePatch(
            worktree,
            patchPath,
            proposal.paths,
          );
          const validation = await validateSiblingCase({
            attack,
            candidate: {
              category: proposal.category,
              focusedCommand: proposal.focusedCommand,
              patchPath,
            },
            ...(authorPatch ? { authorPatch } : {}),
            targetPatches: Object.fromEntries(
              attack.targets.flatMap((target) => {
                const targetPatch = getContestant(
                  context.state,
                  target,
                ).currentPatchPath;
                return targetPatch ? [[target, targetPatch]] : [];
              }),
            ),
            config: context.config,
            runSpec: context.runSpec,
            worktrees: context.worktrees,
            verifier: this.recordingVerifier(context, round),
            logRoot: context.store.resolve(
              `logs/case-${attack.id}-${String(index + 1)}`,
            ),
            signal: context.controller.signal,
          });
          if (this.recordVerifierProviderFailure(context, round))
            throw new Error(context.state.providerFailure?.reason);
          attack.checks.push(...validation.checks);
          cases.push({
            id: stableId("case", attack.id, String(index + 1)),
            visibility: "held_out",
            category: proposal.category,
            patchPath,
            focusedCommand: proposal.focusedCommand,
            contentHash: sha256(await readFile(patchPath)),
            status: validation.accepted ? "accepted" : "rejected",
          });
        }
      } catch (error) {
        context.state.warnings.push(
          `Case builder failed for ${attack.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await context.worktrees.remove(worktree);
      }
    }
    attack.caseBundle = {
      attackId: attack.id,
      oracle: attack.oracle,
      rootDefectId: attack.rootDefectId,
      createdBeforeRepairAt: this.now().toISOString(),
      cases,
    };
    await context.store.writeJson(
      `cases/${attack.id}/manifest.json`,
      attack.caseBundle,
    );
  }

  private async finalValidation(context: ArenaContext): Promise<void> {
    if (context.state.stage !== "final_validate")
      await this.transition(context, "final_validate");
    else {
      for (const contestant of Object.values(context.state.contestants)) {
        contestant.checks = contestant.checks.filter(
          (check) =>
            check.id !== "final-required" && !check.id.startsWith("final-"),
        );
      }
    }
    for (const agent of context.config.agents) {
      const contestant = getContestant(context.state, agent);
      if (context.config.mode === "siege" && contestant.role === "attacker") {
        contestant.status = "survived";
        contestant.finalHealth = calculateHealth(contestant.healthLedger);
        continue;
      }
      const currentPatch = contestant.currentPatchPath;
      if (
        !currentPatch ||
        contestant.patchSize === 0 ||
        contestant.status === "failed" ||
        contestant.status === "eliminated"
      ) {
        contestant.finalHealth = 0;
        continue;
      }
      const worktree = await this.prepareWorktree(context, {
        name: `final-${agent}`,
        subject: `final-validation-worktree:${agent}`,
        patches: [currentPatch],
        contestantId: agent,
        runLevel: true,
      });
      try {
        let command!: Awaited<ReturnType<typeof runShellCommand>>;
        let validationFailure: FailureRecord | undefined;
        for (const attempt of [1, 2] as const) {
          const startedAt = this.now().toISOString();
          const logPrefix = context.store.resolve(
            `logs/final-${agent}-attempt-${String(attempt)}`,
          );
          command = await runShellCommand(context.config.testCommand, {
            cwd: worktree,
            timeoutMs: context.config.limits.attackMs,
            logPrefix,
            signal: context.controller.signal,
          });
          const finishedAt = this.now().toISOString();
          const diagnosticArtifactRefs = [
            command.stdoutPath,
            command.stderrPath,
          ];
          if (command.failureClass !== "arena_infrastructure") {
            if (validationFailure) {
              validationFailure = await this.recordFailureAttempt(context, {
                stage: "final_validation",
                subject: `final-required:${agent}`,
                category: validationFailure.category,
                attempt: 2,
                startedAt,
                finishedAt,
                status: "succeeded",
                diagnosticArtifactRefs,
                contestantId: agent,
                existing: validationFailure,
                reusedArtifactRefs: [currentPatch],
                terminalDisposition: "recovered",
              });
            }
            break;
          }
          validationFailure = await this.recordFailureAttempt(context, {
            stage: "final_validation",
            subject: `final-required:${agent}`,
            category: "command_execution",
            attempt,
            startedAt,
            finishedAt,
            status: "failed",
            diagnosticArtifactRefs,
            contestantId: agent,
            ...(validationFailure ? { existing: validationFailure } : {}),
            reusedArtifactRefs: [currentPatch],
            ...(attempt === 2
              ? { terminalDisposition: "run_level_coverage_lost" as const }
              : {}),
          });
          if (attempt === 2) break;
        }
        const check = requiredCheck("final-required", command);
        contestant.checks.push(check);
        if (check.status === "infrastructure_error") {
          throw new Error(
            `Final validation infrastructure failed for ${agent}`,
          );
        }
        if (check.status !== "passed") {
          contestant.status = "eliminated";
          contestant.healthLedger.eliminatedByRequiredCheck = true;
        } else {
          contestant.status = "survived";
        }
        if (contestant.status !== "eliminated")
          await this.validateBrowserForContestant(
            context,
            contestant,
            worktree,
            "final",
          );
        if (contestant.status !== "eliminated") {
          for (const attack of context.state.attacks.filter(
            (candidate) =>
              candidate.status === "landed" &&
              candidate.targets.includes(agent) &&
              candidate.rootDefectId &&
              candidate.damage,
          )) {
            const finalCases =
              attack.caseBundle?.cases.filter(
                (caseEntry) => caseEntry.status !== "rejected",
              ) ?? [];
            let defectPasses = true;
            if (attack.browserProbe) {
              const validateBrowser = this.browserProbeValidator(
                context,
                attack.id,
                { target: agent },
              );
              const browserResult = validateBrowser
                ? await validateBrowser(
                    worktree,
                    attack.browserProbe,
                    "target",
                    [currentPatch],
                  )
                : undefined;
              const probeResult = browserResult
                ? findBrowserProbeResult(browserResult, attack.browserProbe.id)
                : undefined;
              contestant.checks.push({
                id: `final-browser-${attack.id}`,
                kind: "browser",
                status:
                  probeResult?.status === "verified"
                    ? "passed"
                    : probeResult?.status === "failed"
                      ? "failed"
                      : "infrastructure_error",
                ...(probeResult?.reason ? { reason: probeResult.reason } : {}),
              });
              if (!probeResult || probeResult.status === "unverified")
                throw new Error(
                  `Final browser reproducer was unverified for ${agent}`,
                );
              defectPasses = probeResult.status === "verified";
            }
            for (const caseEntry of finalCases) {
              const caseTree = await this.prepareWorktree(context, {
                name: `final-${agent}-${caseEntry.id}`,
                subject: `final-case-worktree:${agent}:${caseEntry.id}`,
                patches: [currentPatch, caseEntry.patchPath],
                contestantId: agent,
                attackId: attack.id,
                runLevel: true,
              });
              try {
                let caseCommand!: Awaited<ReturnType<typeof runShellCommand>>;
                let caseFailure: FailureRecord | undefined;
                for (const attempt of [1, 2] as const) {
                  const startedAt = this.now().toISOString();
                  const logPrefix = context.store.resolve(
                    `logs/final-${agent}-${caseEntry.id}-attempt-${String(attempt)}`,
                  );
                  caseCommand = await runShellCommand(
                    caseEntry.focusedCommand,
                    {
                      cwd: caseTree,
                      timeoutMs: context.config.limits.attackMs,
                      logPrefix,
                      signal: context.controller.signal,
                    },
                  );
                  const finishedAt = this.now().toISOString();
                  const diagnosticArtifactRefs = [
                    caseCommand.stdoutPath,
                    caseCommand.stderrPath,
                  ];
                  if (caseCommand.failureClass !== "arena_infrastructure") {
                    if (caseFailure) {
                      caseFailure = await this.recordFailureAttempt(context, {
                        stage: "final_validation",
                        subject: `final-case:${agent}:${caseEntry.id}`,
                        category: caseFailure.category,
                        attempt: 2,
                        startedAt,
                        finishedAt,
                        status: "succeeded",
                        diagnosticArtifactRefs,
                        contestantId: agent,
                        attackId: attack.id,
                        existing: caseFailure,
                        reusedArtifactRefs: [currentPatch, caseEntry.patchPath],
                        terminalDisposition: "recovered",
                      });
                    }
                    break;
                  }
                  caseFailure = await this.recordFailureAttempt(context, {
                    stage: "final_validation",
                    subject: `final-case:${agent}:${caseEntry.id}`,
                    category: "command_execution",
                    attempt,
                    startedAt,
                    finishedAt,
                    status: "failed",
                    diagnosticArtifactRefs,
                    contestantId: agent,
                    attackId: attack.id,
                    ...(caseFailure ? { existing: caseFailure } : {}),
                    reusedArtifactRefs: [currentPatch, caseEntry.patchPath],
                    ...(attempt === 2
                      ? {
                          terminalDisposition:
                            "run_level_coverage_lost" as const,
                        }
                      : {}),
                  });
                  if (attempt === 2) break;
                }
                contestant.checks.push({
                  id: `final-${caseEntry.id}`,
                  kind:
                    caseEntry.visibility === "held_out"
                      ? "held_out"
                      : "focused",
                  status:
                    caseCommand.failureClass === "arena_infrastructure"
                      ? "infrastructure_error"
                      : caseCommand.exitCode === 0
                        ? "passed"
                        : "failed",
                  command: caseCommand,
                });
                if (caseCommand.failureClass === "arena_infrastructure") {
                  throw new Error(
                    `Final case infrastructure failed for ${agent}`,
                  );
                }
                if (caseCommand.exitCode !== 0) defectPasses = false;
              } finally {
                await context.worktrees.remove(caseTree);
              }
            }
            if (
              !defectPasses &&
              attack.rootDefectId &&
              !contestant.healthLedger.activeDefects.some(
                (defect) => defect.rootDefectId === attack.rootDefectId,
              )
            ) {
              const canonical = contestant.healthLedger.canonicalDefects?.find(
                (defect) => defect.rootDefectId === attack.rootDefectId,
              );
              const reactivatedDamage =
                canonical?.currentDamage ??
                normalizeAttackAdjudication(attack).exactAmount;
              if (reactivatedDamage <= 0) continue;
              if (canonical) canonical.status = "active";
              contestant.healthLedger.activeDefects.push({
                rootDefectId: attack.rootDefectId,
                attackId: attack.id,
                damage: reactivatedDamage as never,
                ...(canonical
                  ? {
                      severity: canonical.baseSeverity,
                      multiplier: canonical.currentMultiplier,
                    }
                  : {}),
              });
              contestant.healthEvents.push({
                attackId: attack.id,
                round: context.state.currentRound ?? 3,
                type: "target_damage",
                amount: -reactivatedDamage,
                reason:
                  "Previously landed defect regressed during final validation",
              });
            }
          }
        }
        contestant.finalHealth = calculateHealth(contestant.healthLedger);
        if (contestant.finalHealth === 0) contestant.status = "eliminated";
        contestant.finalPatchPath = context.store.resolve(
          `patches/${agent}.diff`,
        );
        await context.store.writeText(
          `patches/${agent}.diff`,
          await readFile(currentPatch, "utf8"),
        );
      } finally {
        await context.worktrees.remove(worktree);
      }
    }
    context.state.ranking = rankContestants(
      context.config.agents.map((agent) => getContestant(context.state, agent)),
      { patchSizeTieBreaker: false },
    );
    await this.persist(context);
  }

  private async collectAndPersistPatchQualityFacts(
    context: ArenaContext,
    agent: ContestantId,
    patchPath: string,
  ): Promise<void> {
    const patchBytes = await readFile(patchPath);
    const patch = patchBytes.toString("utf8");
    let facts = collectPatchQualityFacts({
      contestantId: agent,
      patch,
      patchBytes,
    });
    const manifestPaths =
      facts.version === 2 ? facts.categories.manifest.paths : [];
    if (manifestPaths.length > 0 && context.config.baseCommit) {
      const worktree = await context.worktrees.create(`quality-facts-${agent}`);
      try {
        await context.worktrees.applyPatch(worktree, patchPath);
        const baseContent: Record<string, string> = {};
        const patchedContent: Record<string, string> = {};
        for (const manifestPath of manifestPaths) {
          const base = await readTextAtCommit(
            context.config.repositoryRoot,
            context.config.baseCommit,
            manifestPath,
          );
          if (base !== undefined) baseContent[manifestPath] = base;
          try {
            patchedContent[manifestPath] = await readFile(
              path.join(worktree, manifestPath),
              "utf8",
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        facts = collectPatchQualityFacts({
          contestantId: agent,
          patch,
          patchBytes,
          baseContent,
          patchedContent,
        });
      } finally {
        await context.worktrees.remove(worktree);
      }
    }
    context.state.patchQualityFacts[agent] = facts;
    await context.store.writeImmutableJson(
      `quality/${agent}-facts.json`,
      facts,
    );
  }

  private async finalizeRecommendation(context: ArenaContext): Promise<void> {
    await this.finalizeCoverage(context);
    const arenaOutcome = deriveArenaOutcome(context.state);
    context.state.arenaOutcome = arenaOutcome;
    if (arenaOutcome.kind === "non_discriminating") {
      context.state.ranking = {
        winner: null,
        draw: false,
        order: [...context.config.agents].sort(),
        reason:
          "Non-discriminating battle: complete bidirectional coverage produced no still-valid competitive landing and both eligible patches retain equal active defect damage. Display order is stable contestant order, not a quality ranking.",
      };
    }
    const productionAgents = context.config.agents.filter(
      (agent) =>
        context.config.mode !== "siege" ||
        getContestant(context.state, agent).role === "defender",
    );
    for (const agent of productionAgents) {
      const contestant = getContestant(context.state, agent);
      const patchPath =
        contestant.finalPatchPath ?? contestant.currentPatchPath;
      if (!patchPath) continue;
      await this.collectAndPersistPatchQualityFacts(context, agent, patchPath);
    }
    if (context.config.mode === "siege") {
      context.state.reviewPrompt = buildReviewPrompt(context.state);
      await context.store.writeImmutableJson(
        "review-prompt.json",
        context.state.reviewPrompt,
      );
      await this.finalizeCoverage(context);
      await this.persist(context);
      return;
    }
    const [left, right] = context.config.agents;
    const anonymizationMap =
      left && right
        ? Number.parseInt(
            sha256(`quality-labels:${context.state.runId}`).slice(0, 2),
            16,
          ) %
            2 ===
          0
          ? { patch_a: left, patch_b: right }
          : { patch_a: right, patch_b: left }
        : undefined;
    const comparableContestants =
      left && right
        ? [left, right].map((agent) => getContestant(context.state, agent))
        : [];
    const competitiveHpTie = isCompetitiveQualityTie(
      comparableContestants,
      arenaOutcome.kind,
    );
    const shouldCompareQuality =
      (arenaOutcome.kind === "non_discriminating" || competitiveHpTie) &&
      context.state.coverageAssessment?.confidence !== "provisional" &&
      comparableContestants.length === 2 &&
      comparableContestants.every(
        (contestant) =>
          contestant.status !== "eliminated" &&
          latestRequiredPass(contestant) &&
          Boolean(contestant.finalPatchPath),
      );
    let verdict = inconclusiveQualityVerdict(
      shouldCompareQuality
        ? "No quality verifier was configured."
        : "Patches did not require an implementation-quality comparison.",
    );
    const qualityStartedAt = this.now();
    if (
      context.config.selectionEnabled &&
      context.state.schemaVersion >= 9 &&
      shouldCompareQuality &&
      this.dependencies.qualityVerifier &&
      anonymizationMap
    ) {
      const patchAFacts =
        context.state.patchQualityFacts[anonymizationMap.patch_a];
      const patchBFacts =
        context.state.patchQualityFacts[anonymizationMap.patch_b];
      const patchAPath = getContestant(
        context.state,
        anonymizationMap.patch_a,
      ).finalPatchPath;
      const patchBPath = getContestant(
        context.state,
        anonymizationMap.patch_b,
      ).finalPatchPath;
      if (patchAFacts && patchBFacts && patchAPath && patchBPath) {
        const { contestantId: patchAId, ...anonymousPatchAFacts } = patchAFacts;
        const { contestantId: patchBId, ...anonymousPatchBFacts } = patchBFacts;
        void patchAId;
        void patchBId;
        let worktree = await this.prepareWorktree(context, {
          name: "quality-verifier",
          subject: "quality-verifier-worktree",
        });
        const promptPath = context.store.resolve("quality/prompt.txt");
        await context.store.writeText(
          "quality/prompt.txt",
          "Anonymized neutral implementation-quality comparison. See verifier transcript and input bundle.",
        );
        await context.store.writeImmutableJson(
          "quality/anonymization-map.json",
          anonymizationMap,
        );
        const input = {
          taskContract: context.runSpec.task,
          finalValidation: Object.fromEntries(
            (["a", "b"] as const).map((contestantId) => [
              contestantId === anonymizationMap.patch_a ? "patch_a" : "patch_b",
              getContestant(context.state, contestantId).checks,
            ]),
          ),
          patches: [
            {
              label: "patch_a" as const,
              patch: await readFile(patchAPath, "utf8"),
              facts: anonymousPatchAFacts,
            },
            {
              label: "patch_b" as const,
              patch: await readFile(patchBPath, "utf8"),
              facts: anonymousPatchBFacts,
            },
          ] as const,
          promptPath,
          worktree,
          transcriptPrefix: context.store.resolve("logs/quality-verifier"),
          timeoutMs: context.config.limits.verifierMs,
          signal: context.controller.signal,
          observer: context.observer,
        };
        await context.store.writeImmutableJson("quality/input.json", {
          ...input,
          signal: undefined,
          worktree: undefined,
          transcriptPrefix: undefined,
        });
        try {
          verdict = await compareQualityWithRetry({
            verifier: this.dependencies.qualityVerifier,
            input,
            patchArtifactRefs: [patchAPath, patchBPath],
            transcriptPrefix: (attempt) =>
              context.store.resolve(
                `logs/quality-verifier-attempt-${String(attempt)}`,
              ),
            recreateWorktree: async () => {
              await context.worktrees.remove(worktree);
              worktree = await this.prepareWorktree(context, {
                name: "quality-verifier",
                subject: "quality-verifier-retry-worktree",
              });
              return worktree;
            },
            persistFailureRecord: (record) =>
              this.persistFailureRecord(context, record),
            now: this.now,
          });
        } finally {
          await context.worktrees.remove(worktree);
        }
      }
    }
    context.state.patchQualityVerdict = verdict;
    await context.store.writeImmutableJson("quality/verdict.json", verdict);
    const qualityFinishedAt = this.now();
    await context.store.writeImmutableJson("quality/operation.json", {
      version: 1,
      operationId: stableId("quality", context.state.runId),
      runId: context.state.runId,
      stage: "quality_verifier",
      verifierId: this.dependencies.qualityVerifier?.id ?? "none",
      startedAt: qualityStartedAt.toISOString(),
      finishedAt: qualityFinishedAt.toISOString(),
      durationMs: Math.max(
        0,
        qualityFinishedAt.getTime() - qualityStartedAt.getTime(),
      ),
      timeoutMs: context.config.limits.verifierMs,
      cost: { status: "unknown", amountUsd: null },
      status: verdict.verdict,
    });
    if (
      competitiveHpTie &&
      anonymizationMap &&
      (verdict.verdict === "patch_a" || verdict.verdict === "patch_b")
    ) {
      const championId = anonymizationMap[verdict.verdict];
      arenaOutcome.kind = "winner";
      arenaOutcome.championId = championId;
      arenaOutcome.decisionBasis = "independent_patch_quality";
      if (!arenaOutcome.decidingFactors.includes("tie_breaker"))
        arenaOutcome.decidingFactors.push("tie_breaker");
      context.state.ranking = {
        winner: championId,
        draw: false,
        order: [
          championId,
          ...context.config.agents.filter((agent) => agent !== championId),
        ],
        reason:
          "Equal-HP competitive tie resolved by a decisive identity-blind implementation-quality verdict.",
      };
    }
    context.state.patchRecommendation = selectRecommendedPatch({
      contestants: context.state.contestants,
      ...(arenaOutcome.championId
        ? { championId: arenaOutcome.championId }
        : {}),
      qualityVerdict: verdict,
      outcomeKind: arenaOutcome.kind,
      ...(anonymizationMap ? { anonymizationMap } : {}),
    });
    if (
      arenaOutcome.kind === "non_discriminating" &&
      context.state.patchRecommendation.reason === "implementation_quality"
    )
      arenaOutcome.decisionBasis = "independent_patch_quality";
    context.state.reviewPrompt = buildReviewPrompt(context.state);
    await context.store.writeImmutableJson(
      "review-prompt.json",
      context.state.reviewPrompt,
    );
    await this.finalizeCoverage(context);
    await this.persist(context);
  }

  private async finalizeCoverage(context: ArenaContext): Promise<void> {
    const assessment = assessBattleCoverage(context.state, context.permissions);
    context.state.coverageAssessment = assessment;
    context.state.artifacts.coverageAssessment =
      await context.store.writeImmutableJson(
        "coverage/assessment.json",
        assessment,
      );
    if (assessment.confidence !== "provisional") return;
    if (context.state.arenaOutcome)
      delete context.state.arenaOutcome.championId;
    delete context.state.patchRecommendation;
    delete context.state.reviewPrompt;
  }
}
