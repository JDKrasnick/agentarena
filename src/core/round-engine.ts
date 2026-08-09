import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentAdapter,
  AttackVerifier,
  CaseBuilder,
  HarnessMaintainer,
  HouseScout,
  InfrastructureReviewer,
  IssueResolver,
  PullRequestResolver,
} from "../index-internal.js";
import {
  readAttackSubmission,
  readReviewSubmission,
  removeSubmission,
} from "../agents/adapter.js";
import {
  composeAttackReviewPrompt,
  composeNeutralCasePrompt,
  composePrompt,
  createPromptManifest,
} from "../agents/prompts.js";
import { ArtifactStore } from "../artifacts/store.js";
import {
  materializeAttack,
  materializeHouseAttack,
  validateAttackOrdering,
} from "../attacks/submission.js";
import { validateAttack, validateHouseAttack } from "../attacks/validate.js";
import { validateSiblingCase } from "../attacks/case-bundle.js";
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
import {
  renderConsoleSummary,
  type ConsoleRenderOptions,
} from "../reports/console.js";
import { renderBattleHtml } from "../reports/html.js";
import { renderBattleReport } from "../reports/markdown.js";
import { renderBattleVisual } from "../reports/visual.js";
import { deriveArenaOutcome } from "../outcomes/derive-outcome.js";
import { collectPatchQualityFacts } from "../quality/collect-facts.js";
import { isManifestPath } from "../quality/manifest-adapters.js";
import {
  inconclusiveQualityVerdict,
  type PatchQualityVerifier,
} from "../quality/verifier.js";
import { selectRecommendedPatch } from "../recommendation/select-patch.js";
import { buildReviewPrompt } from "../review/prompt.js";
import { runShellCommand } from "../runner/process-runner.js";
import { provisionIntegrationProfile } from "../runner/integration.js";
import {
  buildRunSpec,
  calculateRunSpecHash,
  GitHubPullRequestResolver,
  type ResolvedPullRequest,
} from "../task/task-contract.js";
import type { RunSpec } from "../contracts/round.js";
import {
  freezePullRequest,
  type PullRequestFixtureOptions,
} from "../task/pr-fixture.js";
import { deriveDeliveryTarget } from "../delivery/target.js";
import { createRunId, sha256, stableId } from "./ids.js";
import {
  calculateHealth,
  healDefect,
  rankContestants,
  resolveRound,
} from "./scoring.js";
import { assertTransition } from "./state-machine.js";
import {
  FightConfigSchema,
  PermissionPolicySchema,
  type AgentId,
  type AgentInvocation,
  type Attack,
  type AttackReviewArtifact,
  type AttackSubmission,
  type CheckResult,
  type ContestantResult,
  type ContestantConfig,
  type ContestantId,
  type ContestantRoundResult,
  type FightConfig,
  type PermissionPolicy,
  type PullRequestFixture,
  type RoundId,
  type RunState,
  type Stage,
} from "./types.js";
import {
  calculateReplayHash,
  calculateSnapshotHash,
  RoundReplaySchema,
  RoundResultSchema,
  validateRoundResult,
  validateRoundSnapshot,
  type ArtifactReference,
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
} from "../recovery/contracts.js";
import {
  applyEnvelopeExactlyOnce,
  sealRoundEnvelope,
  writeBaseline,
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

export interface ArenaDependencies {
  adapters: Partial<Record<AgentId, AgentAdapter>>;
  contestantAdapters?: Partial<Record<ContestantId, AgentAdapter>>;
  adapterFactory?: (
    contestant: Pick<ContestantConfig, "id" | "provider" | "model">,
  ) => AgentAdapter;
  verifier: AttackVerifier;
  houseScout?: HouseScout;
  caseBuilder?: CaseBuilder;
  infrastructureReviewer?: InfrastructureReviewer;
  harnessMaintainer?: HarnessMaintainer;
  issueResolver?: IssueResolver;
  pullRequestResolver?: PullRequestResolver;
  qualityVerifier?: PatchQualityVerifier;
  freezePullRequest?: (
    options: PullRequestFixtureOptions,
  ) => Promise<PullRequestFixture>;
  now?: () => Date;
  onProgress?: (message: string) => void;
  consoleOptions?: ConsoleRenderOptions;
  /** Transactional executor hook used by isolated RoundEngine tests/adapters. */
  executeRound?: (snapshot: RoundSnapshot) => Promise<RoundResult>;
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

interface ArenaContext {
  config: FightConfig;
  store: ArtifactStore;
  worktrees: WorktreeManager;
  runSpec: RunSpec;
  permissions: PermissionPolicy;
  state: RunState;
  controller: AbortController;
  roundInvocations: RecordedRoundInvocation[];
  priorEnvelopeHash: string | null;
  appliedEnvelopes: AppliedEnvelope[];
}

interface RecordedRoundInvocation {
  id: string;
  kind: "case_generation" | "verification";
  actor: "verifier";
  status:
    "succeeded" | "failed" | "timed_out" | "cancelled" | "infrastructure_error";
  startedAt: string;
  finishedAt: string;
  artifactPaths: string[];
}

interface RoundExecutionRuntime {
  context: ArenaContext;
  before: RunState;
  options: {
    initialize?: boolean;
    pullRequestFixture?: PullRequestFixture;
    recovery?: boolean;
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
    replacementCredits: [],
    healthLedger: {
      permanentRecoil: 0,
      activeDefects: [],
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

  constructor(
    private readonly dependencies: ArenaDependencies,
    private readonly runtime?: RoundExecutionRuntime,
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.progress = dependencies.onProgress ?? (() => undefined);
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
  ): Promise<FightOutcome> {
    for (const contestantId of Object.keys(
      this.generatedContestantAdapters,
    ) as ContestantId[])
      delete this.generatedContestantAdapters[contestantId];
    const repositoryRoot = await resolveRepositoryRoot(
      rawConfig.repositoryRoot,
    );
    await assertCleanRepository(repositoryRoot);
    let config = FightConfigSchema.parse({ ...rawConfig, repositoryRoot });
    const runId = createRunId(this.now());
    const store = new ArtifactStore(config.artifactRoot, runId, {
      durableV5: true,
    });
    await store.initialize();
    let pullRequestFixture: PullRequestFixture | undefined;
    let frozenBasePullRequest: ResolvedPullRequest | undefined;
    let frozenModePullRequest: ResolvedPullRequest | undefined;
    let baseCommit: string;
    if (config.mode === "catch_up" || config.mode === "siege") {
      const reference = config.pullRequestReferences[0];
      if (!reference)
        throw new Error(`${config.mode} mode requires a pull request`);
      const resolver =
        this.dependencies.pullRequestResolver ??
        new GitHubPullRequestResolver();
      frozenModePullRequest = await resolver.resolve(reference, repositoryRoot);
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
      const resolver =
        this.dependencies.pullRequestResolver ??
        new GitHubPullRequestResolver();
      frozenBasePullRequest = await resolver.resolve(
        rawConfig.baseFromPullRequest,
        repositoryRoot,
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

    let context: ArenaContext | undefined;
    try {
      this.progress("Preflight: snapshotting run specification");
      const contractWarnings: string[] = [];
      const permissions = resolvePermissionPolicy(
        config,
        discoverCapabilities(config),
      );
      const runSpec = await buildRunSpec({
        runId,
        baseCommit,
        config,
        permissions,
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
      });
      await store.writeImmutableJson("run-spec.json", runSpec);
      const repositoryIdentity =
        await resolveGitHubRepositoryIdentity(repositoryRoot);
      const targetResolution = deriveDeliveryTarget(
        runSpec,
        repositoryIdentity,
      );
      if (targetResolution.ambiguous && targetResolution.reason)
        contractWarnings.push(targetResolution.reason);
      await store.writeJson("permissions.json", permissions);
      const startedAt = this.now().toISOString();
      const state: RunState = {
        schemaVersion: 4,
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
        harnessOverlays: [],
        patchQualityFacts: {},
        ...(targetResolution.target
          ? { deliveryTarget: targetResolution.target }
          : {}),
        artifacts: {
          runDirectory: store.runDirectory,
          runSpec: store.resolve("run-spec.json"),
          permissions: store.resolve("permissions.json"),
          result: store.resolve("result.json"),
          battle: store.resolve("BATTLE.md"),
          battleHtml: store.resolve("BATTLE.html"),
          battleVisual: store.resolve("BATTLE.svg"),
        },
        warnings: [
          "Worktrees isolate accidental changes; they are not a hostile-code security sandbox.",
          ...contractWarnings,
        ],
        ...(pullRequestFixture ? { pullRequestFixture } : {}),
      };
      context = {
        config,
        store,
        worktrees,
        runSpec,
        permissions,
        state,
        controller,
        roundInvocations: [],
        priorEnvelopeHash: null,
        appliedEnvelopes: [],
      };
      await this.persist(context);

      await this.preflight(context);
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
      let priorReplayHash: string | null = null;
      for (const round of [1, 2, 3] as const) {
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
            ...(pullRequestFixture ? { pullRequestFixture } : {}),
          },
        );
        const { result } = transaction;
        if (result.status !== "completed") {
          return this.finishTerminalRound(context, result);
        }
        await this.applyRoundTransaction(context, result);
        priorReplayHash = result.replay.replayHash;
      }

      const credits = config.agents.reduce(
        (sum, agent) =>
          sum +
          getContestant(state, agent).replacementCredits.filter(
            (credit) => credit.status === "available",
          ).length,
        0,
      );
      if (
        !this.shouldStop(context) &&
        credits > 0 &&
        config.infrastructureRecoveryRound
      ) {
        await this.transition(context, "recovery_round", "recovery");
        const beforeRound = structuredClone(context.state);
        const snapshot = await this.createRoundSnapshot(
          context,
          "recovery",
          priorReplayHash,
        );
        const transaction = await this.executeLiveRound(
          context,
          snapshot,
          beforeRound,
          { recovery: true },
        );
        const { result } = transaction;
        if (result.status !== "completed")
          return this.finishTerminalRound(context, result);
        await this.applyRoundTransaction(context, result);
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
      }
      throw error;
    } finally {
      externalSignal?.removeEventListener("abort", abort);
      if (!config.keepWorktrees)
        await worktrees.cleanup().catch(() => undefined);
    }
  }

  async resume(
    options: ResumeOptions,
    externalSignal?: AbortSignal,
  ): Promise<FightOutcome> {
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
    if (!summary) throw new Error("Only schema v5 runs support durable resume");
    await appendRecoveryEvent({
      store,
      type: "resume_started",
      now: this.now(),
    });
    let state = await store.readState();
    if (state.schemaVersion !== 4)
      throw new Error("Durable resume requires a v5 run with a v4 baseline");
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
    let ledger = [...summary.appliedEnvelopes];
    for (const envelope of envelopes.slice(ledger.length)) {
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

    const nextRound = ([1, 2, 3, "recovery"] as const).find(
      (roundId) =>
        !envelopes.some((envelope) => envelope.roundId === roundId) &&
        (roundId !== "recovery" ||
          config.agents.some((agent) =>
            getContestant(state, agent).replacementCredits.some(
              (credit) => credit.status === "available",
            ),
          )),
    );
    if (nextRound) {
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
    const context: ArenaContext = {
      config,
      store,
      worktrees,
      runSpec,
      permissions,
      state,
      controller,
      roundInvocations: [],
      priorEnvelopeHash: envelopes.at(-1)?.envelopeHash ?? null,
      appliedEnvelopes: ledger,
    };
    try {
      let priorReplayHash = envelopes.at(-1)?.replayHash ?? null;
      for (const round of [1, 2, 3] as const) {
        if (envelopes.some((envelope) => envelope.roundId === round)) continue;
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
          { initialize: round === 1 },
        );
        if (transaction.result.status !== "completed") {
          return this.finishTerminalRound(context, transaction.result);
        }
        await this.applyRoundTransaction(context, transaction.result);
        priorReplayHash = transaction.result.replay.replayHash;
      }
      const credits = config.agents.reduce(
        (sum, agent) =>
          sum +
          getContestant(state, agent).replacementCredits.filter(
            (credit) => credit.status === "available",
          ).length,
        0,
      );
      if (
        credits > 0 &&
        config.infrastructureRecoveryRound &&
        !envelopes.some((envelope) => envelope.roundId === "recovery")
      ) {
        await this.transition(context, "recovery_round", "recovery");
        const beforeRound = structuredClone(context.state);
        const snapshot = await this.createRoundSnapshot(
          context,
          "recovery",
          priorReplayHash,
        );
        const transaction = await this.executeLiveRound(
          context,
          snapshot,
          beforeRound,
          { recovery: true },
        );
        if (transaction.result.status !== "completed") {
          return this.finishTerminalRound(context, transaction.result);
        }
        await this.applyRoundTransaction(context, transaction.result);
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
    }
  }

  private async executeLiveRound(
    coordinator: ArenaContext,
    snapshot: RoundSnapshot,
    before: RunState,
    options: {
      initialize?: boolean;
      pullRequestFixture?: PullRequestFixture;
      recovery?: boolean;
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
            const check = protectedState.checks.at(-1);
            throw new Error(
              `Frozen PR patch failed required validation; preflight cannot award a free win${check?.reason ? `: ${check.reason}` : check?.command?.stderrPath ? ` (stderr: ${check.command.stderrPath})` : ""}`,
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
      }
      await this.runRound(context, snapshot.roundId);
      if (options.recovery) {
        for (const agent of context.config.agents) {
          for (const credit of getContestant(context.state, agent)
            .replacementCredits) {
            if (credit.status === "available") credit.status = "spent";
          }
        }
      }
      return this.persistRoundBoundary(context, snapshot, before);
    } catch (error) {
      if (this.isRoundInvariantError(error)) throw error;
      const status = context.controller.signal.aborted
        ? "cancelled"
        : options.recovery || this.isInfrastructureError(error)
          ? "inconclusive"
          : "failed";
      return this.persistRoundBoundary(
        context,
        snapshot,
        before,
        status,
        error,
      );
    }
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
              severity: attack?.severity ?? ("low" as const),
              damage: defect.damage,
            };
          }),
          replacementCredits: structuredClone(contestant.replacementCredits),
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
    const knownDefects = context.state.attacks.flatMap((attack) =>
      attack.rootDefectId && attack.severity && attack.damage
        ? attack.targets.map((target) => ({
            defectId: attack.rootDefectId!,
            attackId: attack.id,
            target,
            severity: attack.severity!,
            damage: attack.damage!,
            status: getContestant(
              context.state,
              target,
            ).healthLedger.activeDefects.some(
              (defect) => defect.rootDefectId === attack.rootDefectId,
            )
              ? ("active" as const)
              : ("healed" as const),
            visibleReproducerArtifactIds: [
              stableId("artifact", attack.patchPath),
            ],
          }))
        : [],
    );
    const draft = {
      version: 1 as const,
      runId: context.state.runId,
      roundId,
      snapshotHash: "0".repeat(64),
      runSpec: context.runSpec,
      contestants: [contestants[0]!, contestants[1]!] as const,
      knownDefects,
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

  private async persistRoundBoundary(
    context: ArenaContext,
    snapshot: RoundSnapshot,
    before: RunState,
    status: "completed" | "inconclusive" | "cancelled" | "failed" = "completed",
    error?: unknown,
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
            : attack.status === "capability_denied" ||
                attack.status === "infrastructure_error" ||
                attack.status === "execution_inconclusive"
              ? attack.status
              : ("missed" as const),
        ...(attack.rootDefectId ? { defectId: attack.rootDefectId } : {}),
        artifactIds: artifactIdFor(attack.patchPath),
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
      const healed = priorActive.filter(
        (defectId) => !active.includes(defectId),
      );
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
      version: 1 as const,
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
      artifacts,
      stateDeltaArtifactId: deltaArtifact.id,
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
              severity: attack?.severity ?? ("low" as const),
              damage: defect.damage,
            };
          }),
          replacementCredits: structuredClone(contestant.replacementCredits),
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
      version: 1,
      runId: snapshot.runId,
      roundId,
      resultingContestants: [
        resultingContestants[0]!,
        resultingContestants[1]!,
      ],
      replay,
    } as const;
    const result = RoundResultSchema.parse(
      status === "completed"
        ? { ...baseResult, status }
        : {
            ...baseResult,
            status,
            diagnostics: replay.diagnostics,
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
    result: Exclude<RoundResult, { status: "completed" }>,
  ): Promise<FightOutcome> {
    const completedAt = this.now().toISOString();
    context.state.status = result.status;
    context.state.stage = result.status;
    context.state.completedAt = completedAt;
    context.state.updatedAt = completedAt;
    context.state.warnings.push(
      ...result.diagnostics.map((entry) => entry.message),
    );
    await context.store.writeState(context.state, context.appliedEnvelopes);
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
    if (this.runtime) return;
    await context.store.writeState(context.state, context.appliedEnvelopes);
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

  private async laneFeedback(
    context: ArenaContext,
    contestantId: ContestantId,
    roundId: RoundId,
    phase: "review" | "attack" | "repair" | "recovery",
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
    await this.persist(context);
  }

  private async preflight(context: ArenaContext): Promise<void> {
    await this.transition(context, "resolve_permissions");
    const unavailable: string[] = [];
    for (const agent of context.config.agents) {
      const availability = await this.adapterFor(
        context,
        agent,
      ).checkAvailability();
      if (!availability.available)
        unavailable.push(`${agent}: ${availability.reason ?? "unavailable"}`);
    }
    if (unavailable.length > 0)
      throw new Error(`Agent availability failed:\n${unavailable.join("\n")}`);
    const baseline = await context.worktrees.create("preflight-baseline");
    try {
      const command = await runShellCommand(context.config.testCommand, {
        cwd: baseline,
        timeoutMs: context.config.limits.attackMs,
        logPrefix: context.store.resolve("logs/preflight-baseline"),
        signal: context.controller.signal,
      });
      if (command.failureClass === "arena_infrastructure") {
        throw new Error("Baseline validation could not start");
      }
      if (command.exitCode !== 0)
        throw new Error(
          "Baseline validation failed; pre-existing failures are unsupported",
        );
    } finally {
      await context.worktrees.remove(baseline);
    }
  }

  private async implement(context: ArenaContext): Promise<void> {
    await this.transition(context, "implement");
    const worktrees = new Map<ContestantId, string>();
    const implementationAgents = context.config.agents.filter(
      (agent) =>
        context.config.contestants.find((contestant) => contestant.id === agent)
          ?.startingPatch !== "pull_request",
    );
    for (const agent of implementationAgents) {
      worktrees.set(
        agent,
        await context.worktrees.create(`implement-${agent}`),
      );
    }
    try {
      await Promise.all(
        implementationAgents.map(async (agent) => {
          const worktree = worktrees.get(agent);
          if (!worktree)
            throw new Error(`Missing implementation worktree for ${agent}`);
          const prompt = composePrompt({
            agent,
            stage: "implement",
            runSpec: context.runSpec,
            config: context.config,
            permissions: context.permissions,
          });
          const promptPath = await context.store.writeText(
            `prompts/implementation-${agent}.md`,
            prompt,
          );
          const invocation = await this.adapterFor(context, agent).implement({
            worktree,
            contestantId: agent,
            prompt,
            promptPath,
            transcriptPrefix: context.store.resolve(
              `logs/implementation-${agent}`,
            ),
            timeoutMs: context.config.limits.implementationMs,
            signal: context.controller.signal,
          });
          const contestant = getContestant(context.state, agent);
          invocation.contestantId = agent;
          invocation.role = contestant.role;
          contestant.implementation = invocation;
          if (invocation.status !== "succeeded") {
            if (invocation.status === "cancelled") {
              context.controller.abort(
                new Error(`Implementation cancelled for ${agent}`),
              );
              throw new Error(`Implementation cancelled for ${agent}`);
            }
            if (invocation.status === "infrastructure_error")
              throw new Error(
                `Implementation infrastructure failed for ${agent}`,
              );
            contestant.status = "failed";
            return;
          }
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
    } finally {
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
      const worktree = await context.worktrees.create(
        `initial-validate-${agent}`,
      );
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
          continue;
        }
        const command = await runShellCommand(context.config.testCommand, {
          cwd: worktree,
          timeoutMs: context.config.limits.attackMs,
          logPrefix: context.store.resolve(`logs/initial-validation-${agent}`),
          signal: context.controller.signal,
        });
        contestant.checks.push(requiredCheck("initial-required", command));
      } finally {
        await context.worktrees.remove(worktree);
      }
    }
    await this.persist(context);
  }

  private shouldStop(context: ArenaContext): boolean {
    const active = context.config.agents.filter(
      (agent) => getContestant(context.state, agent).status !== "eliminated",
    );
    return active.length <= 1;
  }

  private async collectAttackReviews(
    context: ArenaContext,
    round: RoundId,
    selection: ReturnType<typeof selectMethods>,
    reviewers: readonly ContestantId[],
    siegeDefender: ContestantId | undefined,
  ): Promise<
    Map<ContestantId, Omit<AttackReviewArtifact, "reviewer" | "target">>
  > {
    const packets = new Map<
      ContestantId,
      Omit<AttackReviewArtifact, "reviewer" | "target">
    >();
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
      const emptyPacket: Omit<AttackReviewArtifact, "reviewer" | "target"> = {
        version: 1,
        round,
        targetPatchSha256: sha256(targetPatch),
        findings: [],
      };
      packets.set(reviewer, emptyPacket);
      const worktree = await context.worktrees.create(
        `round-${String(round)}-review-${reviewer}`,
      );
      try {
        await context.worktrees.applyPatch(worktree, targetPatchPath);
        const targetSnapshot = await context.worktrees.snapshot(worktree);
        const contestantFeedback = await this.laneFeedback(
          context,
          reviewer,
          round,
          round === "recovery" ? "recovery" : "review",
        );
        const prompt = composeAttackReviewPrompt({
          agent: reviewer,
          target,
          round,
          runSpec: context.runSpec,
          config: context.config,
          permissions: context.permissions,
          methodSelection: selection,
          opponentPatch: targetPatch.toString("utf8"),
          contestantFeedback,
        });
        const promptPath = await context.store.writeText(
          `prompts/round-${String(round)}-review-${reviewer}.md`,
          prompt,
        );
        const invocation = await this.adapterFor(context, reviewer).review({
          worktree,
          contestantId: reviewer,
          prompt,
          promptPath,
          transcriptPrefix: context.store.resolve(
            `logs/round-${String(round)}-review-${reviewer}`,
          ),
          timeoutMs: context.config.limits.reviewMs,
          signal: context.controller.signal,
          round,
          opponent: target,
        });
        invocation.contestantId = reviewer;
        invocation.role = contestant.role;
        if (invocation.status !== "succeeded") {
          context.state.reviewInvocations.push({
            round,
            reviewer,
            target,
            invocation,
            submissionStatus: "not_run",
            findingCount: 0,
            detail: `Review generation ${invocation.status}`,
          });
          context.state.warnings.push(
            `Review generation ${invocation.status} for ${reviewer} against ${target}; test generation received an empty review packet`,
          );
          continue;
        }
        try {
          const submission = await readReviewSubmission(worktree);
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
          const artifact: AttackReviewArtifact = {
            ...emptyPacket,
            reviewer,
            target,
            findings: submission.findings,
          };
          const artifactPath = await context.store.writeJson(
            `attack-reviews/round-${String(round)}/${reviewer}-against-${target}.json`,
            artifact,
          );
          packets.set(reviewer, {
            version: artifact.version,
            round: artifact.round,
            targetPatchSha256: artifact.targetPatchSha256,
            findings: artifact.findings,
          });
          context.state.reviewInvocations.push({
            round,
            reviewer,
            target,
            invocation,
            submissionStatus: "submitted",
            findingCount: artifact.findings.length,
            artifactPath,
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
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
          const verdict = await verifier.assess(input);
          context.roundInvocations.push({
            id,
            kind: "verification",
            actor: "verifier",
            status: "succeeded",
            startedAt,
            finishedAt: this.now().toISOString(),
            artifactPaths: [input.promptPath, input.transcriptPrefix],
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
    const worktree = await context.worktrees.create(
      `case-judge-${String(round)}-${attacker}-${String(entry.rank)}`,
    );
    try {
      const snapshot = await context.worktrees.snapshot(worktree);
      const prompt = composeNeutralCasePrompt({
        runSpec: context.runSpec,
        permissions: context.permissions,
        failure: entry,
        outputPath: path.join(worktree, ".agent-arena-cases.json"),
      });
      const transcriptPrefix = context.store.resolve(
        `logs/case-judge-${String(round)}-${attacker}-${String(entry.rank)}`,
      );
      const submission = await this.recordCaseGeneration(
        context,
        round,
        [transcriptPrefix],
        () =>
          this.dependencies.caseBuilder!.build({
            worktree,
            prompt,
            timeoutMs: context.config.limits.attackMs,
            transcriptPrefix,
            signal: context.controller.signal,
            round: round === "recovery" ? 3 : round,
          }),
      );
      const proposal = submission.cases[0];
      if (!proposal) return undefined;
      assertDirectCapabilitiesAllowed(
        context.permissions,
        entry.requiredCapabilities,
        proposal.requiredCapabilities,
      );
      const patchPath = context.store.resolve(
        `cases/round-${String(round)}/${attacker}/${String(entry.rank)}.diff`,
      );
      await context.worktrees.capturePatchAgainstSnapshot(
        worktree,
        patchPath,
        snapshot,
        proposal.paths,
      );
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
      context.state.warnings.push(
        `Neutral case judge could not verify ${attacker}'s rank ${String(entry.rank)} description: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    } finally {
      await context.worktrees.remove(worktree);
    }
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
      runSpec: context.runSpec,
      config: context.config,
      permissions: context.permissions,
      methodSelection: selection,
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
    const siegeAttacker = context.config.contestants.find(
      (contestant) => contestant.role === "attacker",
    );
    const siegeDefender = context.config.contestants.find(
      (contestant) => contestant.role === "defender",
    );
    const collectingAgents =
      context.config.mode === "siege" && siegeAttacker
        ? [siegeAttacker.id]
        : context.config.agents;
    const reviewPackets = await this.collectAttackReviews(
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
      const worktree = await context.worktrees.create(
        `round-${String(round)}-attack-${agent}`,
      );
      try {
        await context.worktrees.applyPatch(worktree, targetPatchPath);
        const opponentPatch = await readFile(targetPatchPath, "utf8");
        const contestantFeedback = await this.laneFeedback(
          context,
          agent,
          round,
          round === "recovery" ? "recovery" : "attack",
        );
        const prompt = composePrompt({
          agent,
          target,
          stage: "attack",
          round,
          runSpec: context.runSpec,
          config: context.config,
          permissions: context.permissions,
          methodSelection: selection,
          opponentPatch,
          ...(reviewPackets.get(agent)
            ? { reviewPacket: reviewPackets.get(agent)! }
            : {}),
          currentHealth: contestant.finalHealth,
          contestantFeedback,
        });
        const promptPath = await context.store.writeText(
          `prompts/round-${String(round)}-${agent}.md`,
          prompt,
        );
        const invocation = await this.adapterFor(context, agent).attack({
          worktree,
          contestantId: agent,
          prompt,
          promptPath,
          transcriptPrefix: context.store.resolve(
            `logs/round-${String(round)}-attack-${agent}`,
          ),
          timeoutMs: context.config.limits.attackMs,
          signal: context.controller.signal,
          round,
          opponent: target,
        });
        // A timed-out model can still have written a complete, schema-valid
        // submission before its CLI wrapper finishes shutting down. Preserve
        // that work; failed/infrastructure invocations remain ineligible.
        const salvagingTimedOutSubmission = invocation.status === "timed_out";
        if (invocation.status !== "succeeded" && !salvagingTimedOutSubmission) {
          context.state.attackInvocations.push({
            round,
            attacker: agent,
            target,
            invocation,
            submissionStatus: "not_run",
            attackCount: 0,
            detail: `Attack generation ${invocation.status}`,
          });
          context.state.warnings.push(
            `Attack generation ${invocation.status} for ${agent} against ${target}; no submission was collected`,
          );
          continue;
        }
        try {
          const submission = await readAttackSubmission(worktree);
          validateAttackOrdering(submission);
          const availableCredits =
            round === "recovery"
              ? contestant.replacementCredits.filter(
                  (credit) => credit.status === "available",
                ).length
              : 3;
          const accepted = submission.attacks.slice(0, availableCredits);
          await context.store.writeJson(
            `hypotheses/round-${String(round)}/${agent}.json`,
            submission.hypotheses,
          );
          await removeSubmission(worktree);
          for (const entry of accepted) {
            const neutralCase = await this.buildNeutralCase(
              context,
              entry,
              round,
              agent,
            );
            if (!neutralCase) {
              context.state.warnings.push(
                `No executable neutral case was produced for ${agent}'s rank ${String(entry.rank)} description`,
              );
              continue;
            }
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
          }
          context.state.attackInvocations.push({
            round,
            attacker: agent,
            target,
            invocation,
            submissionStatus: "submitted",
            attackCount: accepted.length,
            ...(salvagingTimedOutSubmission
              ? { detail: "Valid submission salvaged after timeout" }
              : {}),
          });
          if (salvagingTimedOutSubmission) {
            context.state.warnings.push(
              `Attack submission from ${agent} against ${target} was salvaged after timeout; inspect the invocation duration before relying on the configured limit`,
            );
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          context.state.attackInvocations.push({
            round,
            attacker: agent,
            target,
            invocation,
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
        context.state.warnings.push(
          `Attack collection failed for ${agent}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await context.worktrees.remove(worktree);
      }
    }
    if (
      context.config.mode !== "siege" &&
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
        const worktree = await context.worktrees.create(
          `round-${String(round)}-attack-house-${target}`,
        );
        this.dependencies.onProgress?.(
          `Round ${String(round)}: house scout ${String(candidateIndex + 1)}/2 started for ${target}`,
        );
        await this.persist(context);
        try {
          await context.worktrees.applyPatch(worktree, targetPatchPath);
          const targetSnapshot = await context.worktrees.snapshot(worktree);
          const patch = await readFile(targetPatchPath, "utf8");
          const prompt = [
            "# Neutral house scout",
            `Inspect Candidate ${String(candidateIndex + 1)}'s anonymized frozen patch for one task defect.`,
            "You may submit zero or one unranked executable test-only attack. You have no health, recoil, or replacement credits.",
            "Use the ordinary oracle and determinism rules. The assigned worktree contains this candidate patch; execute every probe against it. Do not infer contestant identity.",
            "",
            "# Immutable run specification",
            JSON.stringify(context.runSpec, null, 2),
            "",
            "# Method pack",
            JSON.stringify(selection, null, 2),
            "",
            "# Candidate patch",
            patch,
            "",
            `Write {"version":1,"hypotheses":[],"attacks":[]} to ${path.join(worktree, ".agent-arena-house.json")}. Each attack uses the normal attack schema without rank.`,
          ].join("\n");
          const submission = await this.dependencies.houseScout.scout({
            worktree,
            prompt,
            timeoutMs: context.config.limits.attackMs,
            transcriptPrefix: context.store.resolve(
              `logs/round-${String(round)}-attack-house-${target}`,
            ),
            signal: context.controller.signal,
            round,
          });
          await context.store.writeJson(
            `hypotheses/round-${String(round)}/house-${target}.json`,
            submission.hypotheses,
          );
          const entry = submission.attacks[0];
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
      context.state.attacks
        .filter((attack) => attack.status === "landed")
        .flatMap((attack) =>
          attack.rootDefectId ? [attack.rootDefectId] : [],
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
        });
        if (result.status === "landed" && result.rootDefectId)
          knownRoots.add(result.rootDefectId);
        if (result.status === "landed" && typeof round === "number") {
          await this.buildCaseBundle(context, result, round);
        }
        validated.push(result);
        continue;
      }
      const author = attack.origin.contestant;
      const target = attack.targets[0];
      if (!target) continue;
      const targetPatch = getContestant(context.state, target).currentPatchPath;
      if (!targetPatch) continue;
      const authorPatch = getContestant(context.state, author).currentPatchPath;
      let result =
        context.config.mode === "siege"
          ? await validateHouseAttack({
              attack,
              targetPatches: { [target]: targetPatch },
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
              })
            : undefined;
      if (!result) continue;
      if (result.status === "provisional_infrastructure") {
        if (typeof round !== "number") {
          throw new Error(
            "Infrastructure failure during recovery makes the run inconclusive",
          );
        }
        if (!authorPatch) continue;
        result = await this.reviewInfrastructure(
          context,
          result,
          authorPatch,
          targetPatch,
          knownRoots,
          round,
        );
      }
      if (result.status === "landed" && result.rootDefectId)
        knownRoots.add(result.rootDefectId);
      if (result.status === "landed" && typeof round === "number") {
        await this.buildCaseBundle(context, result, round);
      }
      if (
        result.status === "infrastructure_error" ||
        result.status === "execution_inconclusive"
      ) {
        const contestant = getContestant(context.state, author);
        if (typeof round === "number") {
          contestant.replacementCredits.push({
            id: stableId("credit", result.id),
            sourceAttackId: result.id,
            issuedRound: round,
            reason:
              result.status === "execution_inconclusive"
                ? "inconclusive"
                : result.infrastructureReview === "accept"
                  ? "accepted_infrastructure"
                  : "final_infrastructure",
            status: "available",
          });
        } else {
          throw new Error(
            "Infrastructure failure during recovery makes the run inconclusive",
          );
        }
      }
      validated.push(result);
    }
    context.state.attacks.push(...validated);
    await this.persist(context);

    await this.transition(context, "assign_severity", round);
    await this.transition(context, "resolve_damage", round);
    const resolved = resolveRound(context.state.contestants, validated, round);
    context.state.contestants = resolved.contestants;
    for (const attack of validated) {
      if (
        attack.origin.kind === "contestant" &&
        [
          "invalid",
          "duplicate",
          "self_defeating",
          "unproven",
          "blocked",
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

    await this.transition(context, "repair", round);
    const repairs = new Map<ContestantId, AgentInvocation>();
    for (const agent of context.config.agents) {
      const contestant = getContestant(context.state, agent);
      const currentPatch = contestant.currentPatchPath;
      const activeAttacks = context.state.attacks.filter(
        (attack) =>
          attack.status === "landed" &&
          attack.targets.includes(agent) &&
          attack.rootDefectId !== undefined &&
          contestant.healthLedger.activeDefects.some(
            (defect) => defect.rootDefectId === attack.rootDefectId,
          ),
      );
      if (
        !currentPatch ||
        contestant.patchSize === 0 ||
        contestant.status === "failed" ||
        contestant.status === "eliminated" ||
        (latestRequiredPass(contestant) && activeAttacks.length === 0)
      ) {
        continue;
      }
      const worktree = await context.worktrees.create(
        `round-${String(round)}-repair-${agent}`,
      );
      try {
        await context.worktrees.applyPatch(worktree, currentPatch);
        const contestantFeedback = await this.laneFeedback(
          context,
          agent,
          round,
          round === "recovery" ? "recovery" : "repair",
        );
        const prompt = composePrompt({
          agent,
          stage: "repair",
          round,
          runSpec: context.runSpec,
          config: context.config,
          permissions: context.permissions,
          currentHealth: contestant.finalHealth,
          contestantFeedback,
        });
        const promptPath = await context.store.writeText(
          `prompts/round-${String(round)}-repair-${agent}.md`,
          prompt,
        );
        const invocation = await this.adapterFor(context, agent).repair({
          worktree,
          contestantId: agent,
          prompt,
          promptPath,
          transcriptPrefix: context.store.resolve(
            `logs/round-${String(round)}-repair-${agent}`,
          ),
          timeoutMs: context.config.limits.repairMs,
          signal: context.controller.signal,
          round,
          activeAttacks,
        });
        invocation.contestantId = agent;
        invocation.role = contestant.role;
        repairs.set(agent, invocation);
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
      const validateTree = await context.worktrees.create(
        `round-${String(round)}-validate-repair-${agent}`,
      );
      try {
        await context.worktrees.applyPatch(validateTree, currentPatch);
        const command = await runShellCommand(context.config.testCommand, {
          cwd: validateTree,
          timeoutMs: context.config.limits.attackMs,
          logPrefix: context.store.resolve(
            `logs/round-${String(round)}-repair-required-${agent}`,
          ),
          signal: context.controller.signal,
        });
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
            const caseTree = await context.worktrees.create(
              `round-${String(round)}-heal-${agent}-${caseEntry.id}`,
            );
            try {
              await context.worktrees.applyPatch(caseTree, currentPatch);
              await context.worktrees.applyPatch(caseTree, caseEntry.patchPath);
              const checks = [];
              for (const attempt of [1, 2]) {
                checks.push(
                  await runShellCommand(caseEntry.focusedCommand, {
                    cwd: caseTree,
                    timeoutMs: context.config.limits.attackMs,
                    logPrefix: context.store.resolve(
                      `logs/round-${String(round)}-heal-${agent}-${caseEntry.id}-${String(attempt)}`,
                    ),
                    signal: context.controller.signal,
                  }),
                );
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

  private async reviewInfrastructure(
    context: ArenaContext,
    provisional: Attack,
    authorPatch: string,
    targetPatch: string,
    knownRoots: ReadonlySet<string>,
    round: 1 | 2 | 3,
  ): Promise<Attack> {
    const author =
      provisional.origin.kind === "contestant"
        ? provisional.origin.contestant
        : undefined;
    if (!author) return { ...provisional, status: "infrastructure_error" };
    await this.proposeHarnessOverlay(context, provisional, round);
    if (!this.dependencies.infrastructureReviewer) {
      return {
        ...provisional,
        status: "infrastructure_error",
        infrastructureReview: "accept",
        outcomeReason: `${provisional.outcomeReason ?? ""}; no reviewer configured, conservatively accepted as infrastructure`,
      };
    }
    const worktree = await context.worktrees.create(
      `infrastructure-review-${provisional.id}`,
    );
    try {
      await context.worktrees.applyPatch(worktree, provisional.patchPath);
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
      const review = await this.dependencies.infrastructureReviewer.review({
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
      });
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

  private async proposeHarnessOverlay(
    context: ArenaContext,
    provisional: Attack,
    round: 1 | 2 | 3,
  ): Promise<void> {
    if (!this.dependencies.harnessMaintainer) return;
    const worktree = await context.worktrees.create(
      `harness-overlay-${provisional.id}`,
    );
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
      const proposal = await this.dependencies.harnessMaintainer.proposeOverlay(
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

  private async buildCaseBundle(
    context: ArenaContext,
    attack: Attack,
    round: 1 | 2 | 3,
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
      const worktree = await context.worktrees.create(
        `case-builder-${attack.id}`,
      );
      try {
        let authorPatch: string | undefined;
        if (attack.origin.kind === "contestant") {
          authorPatch = getContestant(
            context.state,
            attack.origin.contestant,
          ).currentPatchPath;
          if (authorPatch)
            await context.worktrees.applyPatch(worktree, authorPatch);
        }
        const prompt = [
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
        const transcriptPrefix = context.store.resolve(
          `logs/case-builder-${attack.id}`,
        );
        const submission = await this.recordCaseGeneration(
          context,
          round,
          [transcriptPrefix],
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
        await rm(path.join(worktree, ".agent-arena-cases.json"), {
          force: true,
        });
        for (const [index, proposal] of submission.cases
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
      const worktree = await context.worktrees.create(`final-${agent}`);
      try {
        await context.worktrees.applyPatch(worktree, currentPatch);
        const command = await runShellCommand(context.config.testCommand, {
          cwd: worktree,
          timeoutMs: context.config.limits.attackMs,
          logPrefix: context.store.resolve(`logs/final-${agent}`),
          signal: context.controller.signal,
        });
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
            for (const caseEntry of finalCases) {
              const caseTree = await context.worktrees.create(
                `final-${agent}-${caseEntry.id}`,
              );
              try {
                await context.worktrees.applyPatch(caseTree, currentPatch);
                await context.worktrees.applyPatch(
                  caseTree,
                  caseEntry.patchPath,
                );
                const caseCommand = await runShellCommand(
                  caseEntry.focusedCommand,
                  {
                    cwd: caseTree,
                    timeoutMs: context.config.limits.attackMs,
                    logPrefix: context.store.resolve(
                      `logs/final-${agent}-${caseEntry.id}`,
                    ),
                    signal: context.controller.signal,
                  },
                );
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
              attack.damage &&
              !contestant.healthLedger.activeDefects.some(
                (defect) => defect.rootDefectId === attack.rootDefectId,
              )
            ) {
              contestant.healthLedger.activeDefects.push({
                rootDefectId: attack.rootDefectId,
                attackId: attack.id,
                damage: attack.damage,
              });
              contestant.healthEvents.push({
                attackId: attack.id,
                round: context.state.currentRound ?? 3,
                type: "target_damage",
                amount: -attack.damage,
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
      { patchSizeTieBreaker: context.config.mode !== "siege" },
    );
    await this.persist(context);
  }

  private async finalizeRecommendation(context: ArenaContext): Promise<void> {
    context.state.arenaOutcome = deriveArenaOutcome(context.state);
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
      const patchBytes = await readFile(patchPath);
      const patch = patchBytes.toString("utf8");
      let facts = collectPatchQualityFacts({
        contestantId: agent,
        patch,
        patchBytes,
      });
      const manifestPaths = facts.changedPaths.filter(isManifestPath);
      if (manifestPaths.length > 0 && context.config.baseCommit) {
        const worktree = await context.worktrees.create(
          `quality-facts-${agent}`,
        );
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
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
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
    if (context.config.mode === "siege") {
      context.state.reviewPrompt = buildReviewPrompt(context.state);
      await context.store.writeImmutableJson(
        "review-prompt.json",
        context.state.reviewPrompt,
      );
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
    const shouldCompareQuality =
      comparableContestants.length === 2 &&
      comparableContestants.every(
        (contestant) =>
          contestant.status !== "eliminated" &&
          latestRequiredPass(contestant) &&
          Boolean(contestant.finalPatchPath),
      ) &&
      new Set(
        comparableContestants.map((contestant) =>
          contestant.healthLedger.activeDefects.reduce(
            (total, defect) => total + defect.damage,
            0,
          ),
        ),
      ).size === 1;
    let verdict = inconclusiveQualityVerdict(
      shouldCompareQuality
        ? "No quality verifier was configured."
        : "Patches were not equally correct and did not require a quality tie-break.",
    );
    const qualityStartedAt = this.now();
    if (
      context.config.selectionEnabled &&
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
        const worktree = await context.worktrees.create("quality-verifier");
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
          runSpec: context.runSpec,
          finalValidation: Object.fromEntries(
            context.config.agents.map((agent) => [
              agent === anonymizationMap.patch_a ? "patch_a" : "patch_b",
              getContestant(context.state, agent).checks,
            ]),
          ),
          activeDefects: Object.fromEntries(
            context.config.agents.map((agent) => [
              agent === anonymizationMap.patch_a ? "patch_a" : "patch_b",
              getContestant(context.state, agent).healthLedger.activeDefects,
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
        };
        await context.store.writeImmutableJson("quality/input.json", {
          ...input,
          signal: undefined,
          worktree: undefined,
          transcriptPrefix: undefined,
        });
        try {
          verdict = await this.dependencies.qualityVerifier.compare(input);
        } catch (error) {
          verdict = inconclusiveQualityVerdict(
            `Quality verifier failed: ${error instanceof Error ? error.message : String(error)}`,
          );
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
    context.state.patchRecommendation = selectRecommendedPatch({
      contestants: context.state.contestants,
      ...(context.state.arenaOutcome.championId
        ? { championId: context.state.arenaOutcome.championId }
        : {}),
      qualityVerdict: verdict,
      ...(anonymizationMap ? { anonymizationMap } : {}),
    });
    context.state.reviewPrompt = buildReviewPrompt(context.state);
    await context.store.writeImmutableJson(
      "review-prompt.json",
      context.state.reviewPrompt,
    );
    await this.persist(context);
  }
}
