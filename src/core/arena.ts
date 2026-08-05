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
import { readAttackSubmission, removeSubmission } from "../agents/adapter.js";
import { composePrompt, createPromptManifest } from "../agents/prompts.js";
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
import { renderConsoleSummary } from "../reports/console.js";
import { renderBattleReport } from "../reports/markdown.js";
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
  buildTaskContract,
  GitHubPullRequestResolver,
  type ResolvedPullRequest,
} from "../task/task-contract.js";
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
  type AgentId,
  type AgentInvocation,
  type Attack,
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
  type TaskContract,
} from "./types.js";

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
}

export interface FightOutcome {
  state: RunState;
  summary: string;
}

interface ArenaContext {
  config: FightConfig;
  store: ArtifactStore;
  worktrees: WorktreeManager;
  contract: TaskContract;
  permissions: PermissionPolicy;
  state: RunState;
  controller: AbortController;
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

export class Arena {
  private readonly now: () => Date;
  private readonly progress: (message: string) => void;
  private readonly generatedContestantAdapters: Partial<
    Record<ContestantId, AgentAdapter>
  > = {};

  constructor(private readonly dependencies: ArenaDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.progress = dependencies.onProgress ?? (() => undefined);
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
    const store = new ArtifactStore(config.artifactRoot, runId);
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
      this.progress("Preflight: snapshotting task contract");
      const contractWarnings: string[] = [];
      const contract = await buildTaskContract({
        task: config.task,
        acceptanceCriteria: config.acceptanceCriteria,
        specPaths: config.specPaths,
        issueReferences: config.issueReferences,
        pullRequestReferences: config.pullRequestReferences,
        taskReferences: config.taskReferences,
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
      await store.writeJson("task-contract.json", contract);
      const targetResolution = deriveDeliveryTarget(
        contract,
        await resolveGitHubRepositoryIdentity(repositoryRoot),
      );
      if (targetResolution.ambiguous && targetResolution.reason)
        contractWarnings.push(targetResolution.reason);
      const permissions = resolvePermissionPolicy(
        config,
        discoverCapabilities(config),
      );
      await store.writeJson("permissions.json", permissions);
      const startedAt = this.now().toISOString();
      const state: RunState = {
        schemaVersion: 3,
        runId,
        harnessVersion: "0.1.0",
        status: "running",
        startedAt,
        updatedAt: startedAt,
        stage: "preflight",
        taskContractHash: contract.contractHash,
        config,
        contestants: Object.fromEntries(
          config.contestants.map((contestant) => [
            contestant.id,
            initialContestant(contestant),
          ]),
        ),
        attacks: [],
        attackInvocations: [],
        promptManifests: [],
        harnessOverlays: [],
        patchQualityFacts: {},
        ...(targetResolution.target
          ? { deliveryTarget: targetResolution.target }
          : {}),
        artifacts: {
          runDirectory: store.runDirectory,
          taskContract: store.resolve("task-contract.json"),
          permissions: store.resolve("permissions.json"),
          result: store.resolve("result.json"),
          battle: store.resolve("BATTLE.md"),
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
        contract,
        permissions,
        state,
        controller,
      };
      await this.persist(context);

      await this.preflight(context);
      if (pullRequestFixture) {
        await this.initializePullRequestContestant(context, pullRequestFixture);
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
      if (config.mode !== "siege") {
        await this.implement(context);
        const readyContext = context;
        await this.initialValidation(
          readyContext,
          readyContext.config.agents.filter(
            (agent) =>
              getContestant(readyContext.state, agent).role !== "incumbent",
          ),
        );
      }

      for (const round of [1, 2, 3] as const) {
        if (this.shouldStop(context)) break;
        await this.runRound(context, round);
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
        await this.runRound(context, "recovery");
        for (const agent of config.agents) {
          for (const credit of getContestant(context.state, agent)
            .replacementCredits) {
            if (credit.status === "available") credit.status = "spent";
          }
        }
      }

      await this.finalValidation(context);
      await this.finalizeRecommendation(context);
      await this.transition(context, "report");
      const report = renderBattleReport(context.state);
      await store.writeText("BATTLE.md", report);
      context.state.status = "complete";
      context.state.completedAt = this.now().toISOString();
      await this.transition(context, "complete");
      return {
        state: context.state,
        summary: renderConsoleSummary(context.state),
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
      }
      throw error;
    } finally {
      externalSignal?.removeEventListener("abort", abort);
      if (!config.keepWorktrees)
        await worktrees.cleanup().catch(() => undefined);
    }
  }

  private async persist(context: ArenaContext): Promise<void> {
    context.state.updatedAt = this.now().toISOString();
    await context.store.writeState(context.state);
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
            contract: context.contract,
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
          await removeSubmission(worktree);
          const patchPath = context.store.resolve(
            `patches/${agent}-initial.diff`,
          );
          const patchSize = await context.worktrees.capturePatch(
            worktree,
            patchPath,
          );
          const contestant = getContestant(context.state, agent);
          invocation.contestantId = agent;
          invocation.role = contestant.role;
          contestant.implementation = invocation;
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

  private async runRound(context: ArenaContext, round: RoundId): Promise<void> {
    await this.transition(context, "collect_attacks", round);
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
      contract: context.contract,
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
        const prompt = composePrompt({
          agent,
          stage: "attack",
          round,
          contract: context.contract,
          config: context.config,
          permissions: context.permissions,
          methodSelection: selection,
          opponentPatch,
          currentHealth: contestant.finalHealth,
          priorOutcomes: JSON.stringify(
            context.state.attacks.map((attack) => ({
              id: attack.id,
              status: attack.status,
              rootDefectId: attack.rootDefectId,
            })),
          ),
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
        if (invocation.status !== "succeeded") {
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
            const patchPath = context.store.resolve(
              `attacks/round-${String(round)}/${agent}/${String(entry.rank)}.diff`,
            );
            await context.worktrees.capturePatch(
              worktree,
              patchPath,
              entry.paths,
            );
            collected.push(
              await materializeAttack(entry, {
                author: agent,
                authorProvider: contestant.provider,
                target,
                round,
                patchPath,
              }),
            );
          }
          context.state.attackInvocations.push({
            round,
            attacker: agent,
            target,
            invocation,
            submissionStatus: "submitted",
            attackCount: accepted.length,
          });
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
        try {
          await context.worktrees.applyPatch(worktree, targetPatchPath);
          const patch = await readFile(targetPatchPath, "utf8");
          const prompt = [
            "# Neutral house scout",
            `Inspect Candidate ${String(candidateIndex + 1)}'s anonymized frozen patch for one task defect.`,
            "You may submit zero or one unranked executable test-only attack. You have no health, recoil, or replacement credits.",
            "Use the ordinary oracle and determinism rules. The assigned worktree contains this candidate patch; execute every probe against it. Do not infer contestant identity.",
            "",
            "# Task contract",
            JSON.stringify(context.contract, null, 2),
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
            await context.worktrees.capturePatch(
              worktree,
              patchPath,
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
          taskContract: context.contract,
          permissionPolicy: context.permissions,
          config: context.config,
          worktrees: context.worktrees,
          verifier: this.dependencies.verifier,
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
              taskContract: context.contract,
              permissionPolicy: context.permissions,
              config: context.config,
              worktrees: context.worktrees,
              verifier: this.dependencies.verifier,
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
                taskContract: context.contract,
                permissionPolicy: context.permissions,
                config: context.config,
                worktrees: context.worktrees,
                verifier: this.dependencies.verifier,
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
        const evidence = JSON.stringify(
          activeAttacks.map((attack) => ({
            claim: attack.claim,
            oracle: attack.oracle,
            severity: attack.severity,
            damage: attack.damage,
            focusedCommand: attack.focusedCommand,
            visiblePatch: attack.patchPath,
            heldOutCaseCount:
              attack.caseBundle?.cases.filter(
                (caseEntry) => caseEntry.visibility === "held_out",
              ).length ?? 0,
            revealedCases:
              attack.caseBundle?.cases
                .filter(
                  (caseEntry) =>
                    caseEntry.visibility === "held_out" &&
                    caseEntry.status === "revealed",
                )
                .map((caseEntry) => ({
                  category: caseEntry.category,
                  patchPath: caseEntry.patchPath,
                  focusedCommand: caseEntry.focusedCommand,
                })) ?? [],
          })),
          null,
          2,
        );
        const prompt = composePrompt({
          agent,
          stage: "repair",
          round,
          contract: context.contract,
          config: context.config,
          permissions: context.permissions,
          evidence,
          currentHealth: contestant.finalHealth,
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
              await context.worktrees.applyEvidencePatch(
                caseTree,
                caseEntry.patchPath,
              );
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
      const reviewContestant = getContestant(context.state, author);
      const review = await this.dependencies.infrastructureReviewer.review({
        agent: reviewContestant.provider,
        ...(reviewContestant.model ? { model: reviewContestant.model } : {}),
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
        taskContract: context.contract,
        permissionPolicy: context.permissions,
        config: context.config,
        worktrees: context.worktrees,
        verifier: this.dependencies.verifier,
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
          "Generate zero to two deterministic test-only sibling cases for the exact same cited invariant and canonical root defect.",
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
        const submission = await this.dependencies.caseBuilder.build({
          worktree,
          prompt,
          timeoutMs: context.config.limits.attackMs,
          transcriptPrefix: context.store.resolve(
            `logs/case-builder-${attack.id}`,
          ),
          signal: context.controller.signal,
          round,
          attack,
        });
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
            contract: context.contract,
            worktrees: context.worktrees,
            verifier: this.dependencies.verifier,
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
    await this.transition(context, "final_validate");
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
                await context.worktrees.applyEvidencePatch(
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
          taskContract: context.contract,
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
