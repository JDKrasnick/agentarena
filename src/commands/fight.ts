import { createInterface } from "node:readline/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createBuiltInBrowserAdapters } from "../browser/builtin.js";
import {
  CommandAttackVerifier,
  createProviderAdapter,
  providerCommand,
} from "../agents/adapter.js";
import {
  loadFightConfig,
  type CliConfigOverrides,
} from "../config/load-config.js";
import { Arena } from "../core/arena.js";
import { ArtifactStore } from "../artifacts/store.js";
import { RunSpecSchema } from "../contracts/round.js";
import {
  FightConfigSchema,
  PermissionPolicySchema,
  RunStateSchema,
  type AgentId,
} from "../core/types.js";
import type { RunState } from "../core/types.js";
import { discoverCapabilities } from "../permissions/policy.js";
import { ArenaBattleControl } from "../observability/control.js";
import type { ArenaObserver } from "../observability/events.js";
import { PlainProgressObserver } from "../observability/plain-progress.js";
import type { WebDashboard } from "../dashboard/web-server.js";
import type { DesktopDashboardWindow } from "../dashboard/desktop-window.js";
import { CommandPatchQualityVerifier } from "../quality/verifier.js";
import {
  collectFightReconnaissance,
  type ReconnaissanceSnapshot,
  validateReconnaissance,
} from "../task/task-contract.js";
import { resolveBootstrapContract } from "../task/bootstrap.js";
import {
  probeProviderConnectivity,
  TransportRecoverySchema,
  withReplacementRunId,
} from "../recovery/transport.js";
import {
  readCheckpointDescriptor,
  reconstructRunState,
} from "../recovery/durable.js";
import { decideProviderRecovery } from "../recovery/provider-policy.js";
import { renderBattleReport } from "../reports/markdown.js";
import { renderBattleHtml } from "../reports/html.js";
import { renderBattleVisual } from "../reports/visual.js";
import { renderConsoleSummary } from "../reports/console.js";
import {
  approveMcpPolicy,
  applyMcpReadiness,
  bindMcpRuntimeDefinitions,
  excludeMcpServers,
  freezeMcpPolicy,
  inventoryProviderMcp,
  isolateMcpPolicyForReadiness,
  mcpServerIdentity,
  mcpProviders,
  reconstructMcpRuntimeForResume,
  resolveCodexMcpRuntimeDefinition,
  FrozenMcpPolicySchema,
  type FrozenMcpPolicy,
  type McpRuntimeDefinitions,
} from "../mcp/policy.js";

export type DisplayMode =
  "auto" | "window" | "dashboard" | "terminal" | "plain";

export type ActiveDisplayMode = "window" | "terminal" | "plain";

export function resolveDisplayMode(
  display: DisplayMode,
  launchWindow: boolean,
  interactive: boolean,
): ActiveDisplayMode {
  if (display === "terminal" || display === "plain") return display;
  if (launchWindow) return "window";
  return interactive ? "terminal" : "plain";
}

async function approvePermissionPlan(
  config: Awaited<ReturnType<typeof loadFightConfig>>,
  mcpPolicy: FrozenMcpPolicy,
) {
  if (config.permissionMode !== "confirm") return config;
  stdout.write("Agent Arena permission plan\n");
  for (const request of discoverCapabilities(config)) {
    stdout.write(
      `- ${request.id}: ${request.requirement}, ${request.risk} risk, ${request.role}, ${request.enforcement}\n  ${request.reason}\n  scopes: ${request.scopes.join(", ")}\n`,
    );
  }
  stdout.write(`MCP policy: ${mcpPolicy.mode.replaceAll("_", " ")}\n`);
  for (const server of mcpPolicy.servers.filter(
    (entry) =>
      entry.decision === "included" ||
      entry.reason !== "Not selected for this run",
  )) {
    stdout.write(
      `- ${server.provider}/${server.name}: ${server.decision}, ${server.authentication}, ${server.readiness}, ${server.role}, ${server.requirement}\n`,
    );
  }
  stdout.write(
    "\nNative subprocesses are not OS-confined. They may inherit access to the current account's filesystem, environment, network, credentials, and configured provider integrations, including MCP. Use a sanitized account or external container when the host has sensitive authority.\n",
  );
  if (config.nonInteractiveApproval) {
    stdout.write("Permission plan approved noninteractively via --yes.\n");
    return config;
  }
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question(
      "Approve this consolidated plan? [y/N] ",
    );
    if (!/^y(?:es)?$/i.test(answer.trim()))
      throw new Error("Permission plan was not approved");
    return FightConfigSchema.parse({ ...config, nonInteractiveApproval: true });
  } finally {
    readline.close();
  }
}

export function renderFinalMcpPolicy(policy: FrozenMcpPolicy): string {
  const requested = policy.servers.filter(
    (server) =>
      server.decision === "included" ||
      server.reason !== "Not selected for this run",
  );
  const lines = [
    "Final MCP policy after isolated readiness checks",
    `Policy hash: ${policy.policyHash}`,
  ];
  if (!requested.length) {
    lines.push(
      "- No MCP servers will be exposed to contestant or judge sessions.",
    );
  } else {
    for (const server of requested) {
      lines.push(
        `- ${server.provider}/${server.name}: ${server.decision}, ${server.authentication}, ${server.readiness}, ${server.role}, ${server.requirement}`,
      );
      if (server.decision === "excluded") lines.push(`  ${server.reason}`);
    }
  }
  if (policy.coverageGaps.length) {
    lines.push("Coverage gaps:");
    for (const gap of policy.coverageGaps) lines.push(`- ${gap}`);
  }
  lines.push(
    "Authenticate or repair any excluded server with its provider CLI, then rerun to request it. Agent Arena never reads or copies MCP credentials.",
  );
  return `${lines.join("\n")}\n`;
}

function approveFinalMcpPolicy(
  policy: FrozenMcpPolicy,
  manuallyReviewed: boolean,
): FrozenMcpPolicy {
  stdout.write(renderFinalMcpPolicy(policy));
  if (manuallyReviewed) {
    stdout.write(
      "Manual MCP review complete; only ready servers approved during review will be exposed to agents.\n",
    );
    return approveMcpPolicy(policy, "interactive");
  }
  stdout.write(
    "WARNING: Continuing automatically with only MCP servers that passed isolated readiness and authentication checks. Unavailable servers are excluded and hidden from agents. Use --review-mcp for per-server approval and authentication retries before battle.\n",
  );
  return approveMcpPolicy(policy, "automatic_ready");
}

function createArena(
  config: Awaited<ReturnType<typeof loadFightConfig>>,
  observability?: {
    observer?: ArenaObserver;
    battleControl?: ArenaBattleControl;
    showProgressWithObserver?: boolean;
  },
  mcpPolicy?: FrozenMcpPolicy,
  mcpRuntimeDefinitions: McpRuntimeDefinitions = [],
  recoveryRuntime?: {
    canRecover(provider: AgentId): boolean;
    recordUnrecovered(stage: "review" | "attack_construction"): boolean;
  },
): Arena {
  const adapters = Object.fromEntries(
    config.contestants.map((contestant) => [
      contestant.provider,
      createProviderAdapter(
        contestant.provider,
        contestant.model,
        mcpPolicy,
        mcpRuntimeDefinitions,
      ),
    ]),
  );
  const observer = observability?.observer;
  return new Arena({
    adapters,
    adapterFactory: (contestant) =>
      createProviderAdapter(
        contestant.provider,
        contestant.model,
        mcpPolicy,
        mcpRuntimeDefinitions,
      ),
    verifier: new CommandAttackVerifier(
      config.judge,
      providerCommand(
        config.judge,
        undefined,
        mcpPolicy,
        mcpRuntimeDefinitions,
      ),
    ),
    qualityVerifier: new CommandPatchQualityVerifier(
      config.judge,
      undefined,
      mcpPolicy,
      mcpRuntimeDefinitions,
    ),
    browserAdapters: createBuiltInBrowserAdapters(),
    ...(mcpPolicy ? { mcpPolicy } : {}),
    ...(recoveryRuntime
      ? {
          canRecoverProvider: (provider: AgentId) =>
            recoveryRuntime.canRecover(provider),
          recordUnrecoveredProviderFailure: (
            stage: "review" | "attack_construction",
          ) => recoveryRuntime.recordUnrecovered(stage),
        }
      : {}),
    onProgress:
      observer && !observability?.showProgressWithObserver
        ? () => undefined
        : (message) => stdout.write(`${message}\n`),
    ...(observer ? { observer } : {}),
    ...(observability?.battleControl
      ? { battleControl: observability.battleControl }
      : {}),
  });
}

async function prepareMcpPolicy(
  config: Awaited<ReturnType<typeof loadFightConfig>>,
  signal?: AbortSignal,
): Promise<{ policy: FrozenMcpPolicy; temporaryRoot: string }> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "arena-mcp-"));
  const inventory = await Promise.all(
    mcpProviders(config).map((provider) =>
      inventoryProviderMcp({
        provider,
        repositoryRoot: config.repositoryRoot,
        logRoot: temporaryRoot,
        ...(signal ? { signal } : {}),
      }),
    ),
  );
  return {
    policy: freezeMcpPolicy({
      config: config.mcp,
      inventory: inventory.map((entry) => ({
        ...entry,
        // Preflight uses a temporary directory so provider output, even when
        // already masked by the CLI, never becomes a credential-bearing run
        // artifact. The durable inventory contains metadata only.
        diagnosticArtifactRefs: [],
      })),
      reducedValidationAccepted: config.reducedValidationAccepted,
    }),
    temporaryRoot,
  };
}

async function checkSelectedMcpReadiness(options: {
  config: Awaited<ReturnType<typeof loadFightConfig>>;
  policy: FrozenMcpPolicy;
  temporaryRoot: string;
  signal: AbortSignal;
  manualReview: boolean;
}): Promise<{
  policy: FrozenMcpPolicy;
  runtimeDefinitions: McpRuntimeDefinitions;
}> {
  if (options.manualReview && (!stdin.isTTY || !stdout.isTTY))
    throw new Error("--review-mcp requires an interactive TTY");
  const readiness = new Map<string, "ready" | "unavailable">();
  const declined = new Set<string>();
  const runtimeDefinitions = new Map<string, McpRuntimeDefinitions[number]>();
  const selected = options.policy.servers.filter(
    (server) => server.decision === "included",
  );
  const readline = options.manualReview
    ? createInterface({ input: stdin, output: stdout })
    : undefined;
  try {
    for (const [index, server] of selected.entries()) {
      const provider = server.provider;
      const identity = mcpServerIdentity(provider, server.name);
      const contestant = options.config.contestants.find(
        (entry) => entry.provider === provider,
      );
      let attempt = 0;
      while (true) {
        attempt += 1;
        let scopedRuntimeDefinitions: McpRuntimeDefinitions = [];
        if (provider === "codex") {
          const resolution = await resolveCodexMcpRuntimeDefinition({
            name: server.name,
            repositoryRoot: options.config.repositoryRoot,
            logRoot: options.temporaryRoot,
            signal: options.signal,
          });
          if (resolution.status === "unavailable") {
            if (!readline) {
              readiness.set(identity, "unavailable");
              break;
            }
            stdout.write(
              `${provider}/${server.name} cannot be reconstructed safely for an isolated child process. ${resolution.reason}.\n`,
            );
            const answer = await readline.question(
              "Repair the provider configuration and press Enter to retry, or type s to skip this server: ",
            );
            if (/^s(?:kip)?$/i.test(answer.trim())) {
              readiness.set(identity, "unavailable");
              break;
            }
            continue;
          }
          scopedRuntimeDefinitions = [resolution.definition];
          runtimeDefinitions.set(identity, resolution.definition);
        }
        const adapter = createProviderAdapter(
          provider,
          contestant?.model,
          isolateMcpPolicyForReadiness(options.policy, provider, server.name),
          scopedRuntimeDefinitions,
        );
        const result = await adapter.probeConnectivity({
          cwd: options.config.repositoryRoot,
          transcriptPrefix: path.join(
            options.temporaryRoot,
            `mcp-readiness-${provider}-${String(index + 1)}-${String(attempt)}`,
          ),
          timeoutMs: 15_000,
          signal: options.signal,
          mcpServerName: server.name,
        });
        if (result.healthy) {
          readiness.set(identity, "ready");
          if (readline) {
            const answer = await readline.question(
              `Allow ready MCP server ${provider}/${server.name} for this battle? [Y/n] `,
            );
            if (/^n(?:o)?$/i.test(answer.trim())) declined.add(identity);
          }
          break;
        }
        if (!readline) {
          readiness.set(identity, "unavailable");
          break;
        }
        stdout.write(
          `${provider}/${server.name} is not ready or authenticated. Authenticate it with the ${provider} CLI; Agent Arena will not read or copy credentials.\n`,
        );
        const answer = await readline.question(
          "Press Enter to retry, or type s to skip this server: ",
        );
        if (/^s(?:kip)?$/i.test(answer.trim())) {
          readiness.set(identity, "unavailable");
          break;
        }
      }
    }
  } finally {
    readline?.close();
  }
  const resolved = applyMcpReadiness(options.policy, readiness, true);
  const policy = declined.size
    ? excludeMcpServers(resolved, declined)
    : resolved;
  if (
    !options.config.reducedValidationAccepted &&
    policy.servers.some(
      (server) =>
        server.requirement === "required" && server.decision === "excluded",
    )
  )
    throw new Error(
      "A required MCP server is unavailable; explicitly accept reduced validation to continue",
    );
  const exposed = new Set(
    policy.servers
      .filter((server) => server.decision === "included")
      .map((server) => mcpServerIdentity(server.provider, server.name)),
  );
  const exposedRuntimeDefinitions = [...runtimeDefinitions]
    .filter(([identity]) => exposed.has(identity))
    .map(([, definition]) => definition);
  return {
    policy: bindMcpRuntimeDefinitions(policy, exposedRuntimeDefinitions),
    runtimeDefinitions: exposedRuntimeDefinitions,
  };
}

export interface RunCommandResult {
  runId: string;
  status: RunState["status"];
  summary: string;
  runIds: string[];
}

export function exitCodeForStatus(status: RunState["status"]): number {
  if (status === "complete") return 0;
  if (status === "inconclusive") return 2;
  if (status === "cancelled") return 130;
  return 1;
}

export async function runFight(
  overrides: CliConfigOverrides,
  display: DisplayMode = "auto",
  launchWindow = true,
): Promise<RunCommandResult> {
  const loadedConfig = await loadFightConfig(overrides);
  const reconnaissance = await collectFightReconnaissance(loadedConfig);
  const plannedConfig = FightConfigSchema.parse({
    ...loadedConfig,
    resolvedBootstrap: await resolveBootstrapContract({
      repositoryRoot: loadedConfig.repositoryRoot,
      bootstrap: loadedConfig.bootstrap ?? "none",
      timeoutMs: loadedConfig.limits.attackMs,
    }),
  });
  const mcpPreflight = await prepareMcpPolicy(plannedConfig);
  let config: Awaited<ReturnType<typeof loadFightConfig>>;
  let mcpPolicy: FrozenMcpPolicy;
  let mcpRuntimeDefinitions: McpRuntimeDefinitions;
  try {
    config = await approvePermissionPlan(plannedConfig, mcpPreflight.policy);
    const readiness = await checkSelectedMcpReadiness({
      config,
      policy: mcpPreflight.policy,
      temporaryRoot: mcpPreflight.temporaryRoot,
      signal: new AbortController().signal,
      manualReview: overrides.reviewMcp ?? false,
    });
    mcpPolicy = readiness.policy;
    mcpRuntimeDefinitions = readiness.runtimeDefinitions;
    mcpPolicy = approveFinalMcpPolicy(mcpPolicy, overrides.reviewMcp ?? false);
    await rm(mcpPreflight.temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    await rm(mcpPreflight.temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  const interactive = Boolean(stdout.isTTY && stdin.isTTY);
  const activeDisplay = resolveDisplayMode(display, launchWindow, interactive);
  const useDesktopDashboard = activeDisplay === "window";
  const useTerminalDashboard = activeDisplay === "terminal";
  const usePlainProgress = activeDisplay === "plain";
  if (useTerminalDashboard && !interactive) {
    throw new Error(
      "--display terminal requires an interactive TTY; use --display plain for redirected output or CI",
    );
  }
  const controller = new AbortController();
  const control = new ArenaBattleControl(controller);
  let dashboard: { unmount(): void } | undefined;
  let webDashboard: WebDashboard | undefined;
  let desktopWindow: DesktopDashboardWindow | undefined;
  let observer: ArenaObserver | undefined;
  const recoveredProviders = new Set<AgentId>();
  let continuationsCreated = 0;
  let unrecoveredProviderFailures = 0;
  const recoveryRuntime = {
    canRecover: (provider: AgentId) =>
      continuationsCreated < 2 && !recoveredProviders.has(provider),
    recordUnrecovered: () => {
      unrecoveredProviderFailures += 1;
      return unrecoveredProviderFailures >= 2;
    },
  };
  if (useDesktopDashboard) {
    const [{ startWebDashboard }, { startDesktopDashboardWindow }] =
      await Promise.all([
        import("../dashboard/web-server.js"),
        import("../dashboard/desktop-window.js"),
      ]);
    webDashboard = await startWebDashboard(control);
    try {
      desktopWindow = await startDesktopDashboardWindow(webDashboard.url, {
        onUserClose: () => {
          control.cancel(new Error("Agent Arena window closed"));
          void webDashboard?.close();
        },
      });
      await desktopWindow.waitUntilReady();
    } catch (error) {
      await webDashboard.close();
      await desktopWindow?.close();
      throw error;
    }
    observer = webDashboard.observer;
    stdout.write("Agent Arena window opened.\n");
  } else if (useTerminalDashboard) {
    const [{ DashboardObserver }, { startDashboard }] = await Promise.all([
      import("../dashboard/state.js"),
      import("../dashboard/app.js"),
    ]);
    const dashboardObserver = new DashboardObserver();
    observer = dashboardObserver;
    dashboard = startDashboard(dashboardObserver, control);
  } else if (usePlainProgress) {
    observer = new PlainProgressObserver((line) => stdout.write(line));
  }
  const arena = createArena(
    config,
    {
      ...(observer ? { observer } : {}),
      battleControl: control,
      ...(usePlainProgress ? { showProgressWithObserver: true } : {}),
    },
    mcpPolicy,
    mcpRuntimeDefinitions,
    recoveryRuntime,
  );
  const cancel = (): void => {
    if (controller.signal.aborted) return;
    control.cancel(new Error("Interrupted"));
    void webDashboard?.close();
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    let outcome = await arena.fight(config, controller.signal, reconnaissance);
    const runIds = [outcome.state.runId];
    let recoveryCancelled = false;
    while (
      outcome.state.providerFailure ||
      outcome.state.terminalOutcome?.reasonCode === "provider_transport_failure"
    ) {
      const parent = outcome;
      const terminalOutcome = parent.state.terminalOutcome;
      const providerFailure = parent.state.providerFailure;
      if (!providerFailure && !terminalOutcome) break;
      const recoveryDecision = providerFailure
        ? decideProviderRecovery(providerFailure, {
            continuationsCreated,
            recoveredProviders,
            unrecoveredFailures: unrecoveredProviderFailures,
          })
        : undefined;
      if (recoveryDecision?.action === "inconclusive") {
        const completedAt = new Date().toISOString();
        parent.state.status = "inconclusive";
        parent.state.stage = "inconclusive";
        parent.state.completedAt = completedAt;
        parent.state.updatedAt = completedAt;
        parent.state.warnings.push(
          `Provider recovery is unavailable (${recoveryDecision.reason}); ${providerFailure?.stage ?? "the provider stage"} cannot be trusted.`,
        );
        const terminalStore = new ArtifactStore(
          parent.state.config.artifactRoot,
          parent.state.runId,
          { durableV5: true },
        );
        await terminalStore.writeState(parent.state);
        await terminalStore.writeText(
          "BATTLE.md",
          renderBattleReport(parent.state),
        );
        await terminalStore.writeText(
          "BATTLE.html",
          renderBattleHtml(parent.state),
        );
        await terminalStore.writeText(
          "BATTLE.svg",
          renderBattleVisual(parent.state),
        );
        outcome = {
          state: parent.state,
          summary: renderConsoleSummary(parent.state),
        };
        break;
      }
      const parentStore = new ArtifactStore(
        parent.state.config.artifactRoot,
        parent.state.runId,
        { durableV5: true },
      );
      const affected = new Set(
        providerFailure?.contestantId
          ? [providerFailure.contestantId]
          : terminalOutcome?.version === 2
            ? terminalOutcome.contestants
                .filter(
                  (entry) => entry.reasonCode === "provider_transport_failure",
                )
                .map((entry) => entry.contestantId)
            : (terminalOutcome?.affectedContestantIds ?? []),
      );
      const adapters = new Map<
        AgentId,
        ReturnType<typeof createProviderAdapter>
      >();
      if (providerFailure) {
        const contestant = parent.state.config.contestants.find(
          (entry) => entry.provider === providerFailure.provider,
        );
        adapters.set(
          providerFailure.provider,
          createProviderAdapter(
            providerFailure.provider,
            contestant?.model,
            mcpPolicy,
            mcpRuntimeDefinitions,
          ),
        );
      } else {
        for (const contestant of parent.state.config.contestants.filter(
          (entry) => affected.has(entry.id),
        )) {
          if (adapters.has(contestant.provider)) continue;
          adapters.set(
            contestant.provider,
            createProviderAdapter(
              contestant.provider,
              contestant.model,
              mcpPolicy,
              mcpRuntimeDefinitions,
            ),
          );
        }
      }
      if (!adapters.size) break;
      if (recoveryDecision?.action === "ordinary_stage_semantics") break;
      if (!providerFailure && runIds.length > 2) break;
      if (
        !providerFailure &&
        [...adapters.keys()].some((provider) =>
          recoveredProviders.has(provider),
        )
      )
        break;
      const restartOrdinal = runIds.length;
      let recovery = await probeProviderConnectivity({
        parentRunId: parent.state.runId,
        store: parentStore,
        adapters,
        restartOrdinal,
        cwd: parent.state.config.repositoryRoot,
        signal: controller.signal,
        ...(providerFailure ? { failedStage: providerFailure.stage } : {}),
        runChain: runIds,
        recoveryReason:
          providerFailure?.reason ??
          terminalOutcome?.reason ??
          "Provider failure",
      });
      const recoveryPath = await parentStore.writeImmutableJson(
        "transport-recovery.json",
        recovery,
      );
      parent.state.artifacts.transportRecovery = recoveryPath;
      await parentStore.writeState(parent.state);
      if (recovery.disposition === "cancelled") {
        recoveryCancelled = true;
        break;
      }
      if (recovery.disposition !== "provider_recovered") break;
      for (const provider of adapters.keys()) recoveredProviders.add(provider);
      continuationsCreated += 1;
      const frozenRunSpec = await parentStore.readOptionalJson(
        "run-spec.json",
        RunSpecSchema,
      );
      const permissions = await parentStore.readOptionalJson(
        "permissions.json",
        PermissionPolicySchema,
      );
      if (!frozenRunSpec || !permissions)
        throw new Error("Transport recovery is missing frozen run inputs");
      const reconnaissance = validateReconnaissance(
        JSON.parse(
          await readFile(parentStore.resolve("reconnaissance.json"), "utf8"),
        ) as ReconnaissanceSnapshot,
        parent.state.config,
      );
      const parentSummary = await parentStore.readSummary();
      if (!parentSummary)
        throw new Error("Provider recovery is missing the parent summary");
      let inheritedState = await reconstructRunState({
        store: parentStore,
        summary: parentSummary,
      });
      const lastAppliedEnvelope = parentSummary.appliedEnvelopes.at(-1);
      const continuationCheckpoint =
        lastAppliedEnvelope && typeof lastAppliedEnvelope.roundId === "number"
          ? await readCheckpointDescriptor(
              parentStore,
              lastAppliedEnvelope.roundId,
            )
          : undefined;
      let resumeAfterInitialization = false;
      if (providerFailure?.round === 1) {
        const checkpoint = await parentStore.readOptionalJson(
          "provider-recovery-checkpoint.json",
          RunStateSchema,
        );
        if (checkpoint) {
          inheritedState = checkpoint;
          resumeAfterInitialization = true;
        }
      }
      const replacementArena = createArena(
        parent.state.config,
        {
          ...(observer ? { observer } : {}),
          battleControl: control,
          ...(usePlainProgress ? { showProgressWithObserver: true } : {}),
        },
        mcpPolicy,
        mcpRuntimeDefinitions,
        recoveryRuntime,
      );
      outcome = await replacementArena.fightReplacement(
        parent.state.config,
        {
          parentRunId: parent.state.runId,
          restartOrdinal: restartOrdinal as 1 | 2,
          runSpec: frozenRunSpec,
          permissions,
          reconnaissance,
          inheritedState,
          startRound: providerFailure?.round ?? 1,
          ...(continuationCheckpoint ? { continuationCheckpoint } : {}),
          ...(resumeAfterInitialization
            ? { resumeAfterInitialization: true }
            : {}),
          ...(parent.state.pullRequestFixture
            ? { pullRequestFixture: parent.state.pullRequestFixture }
            : {}),
        },
        controller.signal,
      );
      runIds.push(outcome.state.runId);
      recovery = withReplacementRunId(recovery, outcome.state.runId);
      await parentStore.replaceDerivedJson(
        "transport-recovery.json",
        TransportRecoverySchema.parse(recovery),
      );
    }
    if (webDashboard) {
      stdout.write(
        "Battle complete. Review the dashboard, then choose Finish session.\n",
      );
      await webDashboard.waitUntilClosed();
    }
    return {
      runId: outcome.state.runId,
      status: recoveryCancelled ? "cancelled" : outcome.state.status,
      summary: `${outcome.summary}${recoveryCancelled ? "\nTransport recovery was cancelled by an external signal." : ""}\nRun chain: ${runIds.join(" -> ")}`,
      runIds,
    };
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    dashboard?.unmount();
    await webDashboard?.close();
    await desktopWindow?.close();
    await rm(mcpPreflight.temporaryRoot, { recursive: true, force: true });
  }
}

export async function runResume(options: {
  runId: string;
  approveDriftHash?: string;
  display?: "console" | "json";
}): Promise<RunCommandResult> {
  const repositoryRoot = process.cwd();
  const store = new (await import("../artifacts/store.js")).ArtifactStore(
    `${repositoryRoot}/.agent-arena/runs`,
    options.runId,
  );
  const state = await store.readState();
  const config = FightConfigSchema.parse({
    ...state.config,
    repositoryRoot,
    artifactRoot: `${repositoryRoot}/.agent-arena/runs`,
  });
  const controller = new AbortController();
  const cancel = (): void => {
    if (controller.signal.aborted) return;
    controller.abort(new Error("Interrupted"));
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const runSpec = RunSpecSchema.parse(
      JSON.parse(await readFile(store.resolve("run-spec.json"), "utf8")),
    );
    const mcpPolicy = await store.readOptionalJson(
      "mcp-policy.json",
      FrozenMcpPolicySchema,
    );
    // Non-applied terminal envelopes are projected onto the durable summary,
    // not the rebuilt runtime state. Their replay needs no provider session.
    const summary = await store.readSummary();
    const reconstructDefinitions =
      state.status !== "complete" && !summary?.terminalOutcome;
    const temporaryRoot = reconstructDefinitions
      ? await mkdtemp(
          path.join(os.tmpdir(), `arena-mcp-resume-${options.runId}-`),
        )
      : undefined;
    let resumedMcpRuntime: Awaited<
      ReturnType<typeof reconstructMcpRuntimeForResume>
    >;
    try {
      resumedMcpRuntime = await reconstructMcpRuntimeForResume({
        ...(runSpec.mcpPolicyHash ? { policyHash: runSpec.mcpPolicyHash } : {}),
        ...(mcpPolicy ? { policy: mcpPolicy } : {}),
        repositoryRoot,
        logRoot: temporaryRoot ?? store.resolve("logs", "mcp-resume"),
        signal: controller.signal,
        reconstructDefinitions,
      });
    } finally {
      if (temporaryRoot)
        await rm(temporaryRoot, { recursive: true, force: true });
    }
    const arena = createArena(
      config,
      undefined,
      reconstructDefinitions ? resumedMcpRuntime.policy : undefined,
      reconstructDefinitions ? resumedMcpRuntime.runtimeDefinitions : [],
    );
    const outcome = await arena.resume(
      {
        runId: options.runId,
        repositoryRoot,
        ...(options.approveDriftHash
          ? { approveDriftHash: options.approveDriftHash }
          : {}),
        ...(options.display ? { display: options.display } : {}),
      },
      controller.signal,
    );
    return {
      runId: outcome.state.runId,
      status: outcome.state.status,
      summary: outcome.summary,
      runIds: [outcome.state.runId],
    };
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
