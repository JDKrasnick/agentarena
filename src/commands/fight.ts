import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  CommandAttackVerifier,
  createProviderAdapter,
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
  type AgentId,
} from "../core/types.js";
import type { RunState } from "../core/types.js";
import { discoverCapabilities } from "../permissions/policy.js";
import { ArenaBattleControl } from "../observability/control.js";
import type { ArenaObserver } from "../observability/events.js";
import type { WebDashboard } from "../dashboard/web-server.js";
import type { DesktopDashboardWindow } from "../dashboard/desktop-window.js";
import {
  probeProviderConnectivity,
  TransportRecoverySchema,
  withReplacementRunId,
} from "../recovery/transport.js";

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
) {
  if (config.permissionMode !== "confirm" || config.nonInteractiveApproval)
    return config;
  stdout.write("Agent Arena permission plan\n");
  for (const request of discoverCapabilities(config)) {
    stdout.write(
      `- ${request.id}: ${request.requirement}, ${request.risk} risk, ${request.role}, ${request.enforcement}\n  ${request.reason}\n  scopes: ${request.scopes.join(", ")}\n`,
    );
  }
  stdout.write(
    "\nAdvisory restrictions are not OS-enforced. Use a sanitized account when the host has sensitive credentials.\n",
  );
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

function createArena(
  config: Awaited<ReturnType<typeof loadFightConfig>>,
  observability?: {
    observer?: ArenaObserver;
    battleControl?: ArenaBattleControl;
  },
): Arena {
  const adapters = Object.fromEntries(
    config.contestants.map((contestant) => [
      contestant.provider,
      createProviderAdapter(contestant.provider, contestant.model),
    ]),
  );
  const observer = observability?.observer;
  return new Arena({
    adapters,
    adapterFactory: (contestant) =>
      createProviderAdapter(contestant.provider, contestant.model),
    verifier: new CommandAttackVerifier(config.judge),
    onProgress: observer
      ? () => undefined
      : (message) => stdout.write(`${message}\n`),
    ...(observer ? { observer } : {}),
    ...(observability?.battleControl
      ? { battleControl: observability.battleControl }
      : {}),
  });
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
  const config = await approvePermissionPlan(await loadFightConfig(overrides));
  const interactive = Boolean(stdout.isTTY && stdin.isTTY);
  const activeDisplay = resolveDisplayMode(display, launchWindow, interactive);
  const useDesktopDashboard = activeDisplay === "window";
  const useTerminalDashboard = activeDisplay === "terminal";
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
  if (useDesktopDashboard) {
    const [{ startWebDashboard }, { startDesktopDashboardWindow }] =
      await Promise.all([
        import("../dashboard/web-server.js"),
        import("../dashboard/desktop-window.js"),
      ]);
    webDashboard = await startWebDashboard(control);
    try {
      desktopWindow = startDesktopDashboardWindow(webDashboard.url, {
        onUserClose: () => {
          control.cancel(new Error("Agent Arena window closed"));
          void webDashboard?.close();
        },
      });
    } catch (error) {
      await webDashboard.close();
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
  }
  const arena = createArena(config, {
    ...(observer ? { observer } : {}),
    battleControl: control,
  });
  const cancel = (): void => {
    control.cancel(new Error("Interrupted"));
    void webDashboard?.close();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    let outcome = await arena.fight(config, controller.signal);
    const runIds = [outcome.state.runId];
    let recoveryCancelled = false;
    while (
      outcome.state.terminalOutcome?.reasonCode === "provider_transport_failure"
    ) {
      const parent = outcome;
      const terminalOutcome = parent.state.terminalOutcome;
      if (!terminalOutcome) break;
      const parentStore = new ArtifactStore(
        parent.state.config.artifactRoot,
        parent.state.runId,
        { durableV5: true },
      );
      const affected = new Set(
        terminalOutcome.version === 2
          ? terminalOutcome.contestants
              .filter(
                (entry) => entry.reasonCode === "provider_transport_failure",
              )
              .map((entry) => entry.contestantId)
          : terminalOutcome.affectedContestantIds,
      );
      const providerConfigs = parent.state.config.contestants.filter(
        (contestant) => affected.has(contestant.id),
      );
      const adapters = new Map<
        AgentId,
        ReturnType<typeof createProviderAdapter>
      >();
      for (const contestant of providerConfigs) {
        if (!adapters.has(contestant.provider))
          adapters.set(
            contestant.provider,
            createProviderAdapter(contestant.provider, contestant.model),
          );
      }
      if (!adapters.size) break;
      const restartOrdinal = runIds.length;
      let recovery = await probeProviderConnectivity({
        parentRunId: parent.state.runId,
        store: parentStore,
        adapters,
        restartOrdinal,
        cwd: parent.state.config.repositoryRoot,
        signal: controller.signal,
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
      const replacementArena = createArena(parent.state.config, {
        ...(observer ? { observer } : {}),
        battleControl: control,
      });
      outcome = await replacementArena.fightReplacement(
        parent.state.config,
        {
          parentRunId: parent.state.runId,
          restartOrdinal: restartOrdinal as 1 | 2,
          runSpec: frozenRunSpec,
          permissions,
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
  const arena = createArena(config);
  const controller = new AbortController();
  const cancel = (): void => controller.abort(new Error("Interrupted"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
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
