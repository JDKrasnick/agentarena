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
import { FightConfigSchema } from "../core/types.js";
import { discoverCapabilities } from "../permissions/policy.js";
import { ArenaBattleControl } from "../observability/control.js";
import type { ArenaObserver } from "../observability/events.js";
import type { WebDashboard } from "../dashboard/web-server.js";

export type DisplayMode = "auto" | "dashboard" | "terminal" | "plain";

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

export async function runFight(
  overrides: CliConfigOverrides,
  display: DisplayMode = "auto",
): Promise<string> {
  const config = await approvePermissionPlan(await loadFightConfig(overrides));
  const interactive = Boolean(stdout.isTTY && stdin.isTTY);
  const useWebDashboard = display === "dashboard";
  const useTerminalDashboard =
    display === "terminal" || (display === "auto" && interactive);
  if (useTerminalDashboard && !interactive) {
    throw new Error(
      "--display terminal requires an interactive TTY; use --display plain for redirected output or CI",
    );
  }
  const controller = new AbortController();
  const control = new ArenaBattleControl(controller);
  let dashboard: { unmount(): void } | undefined;
  let webDashboard: WebDashboard | undefined;
  let observer: ArenaObserver | undefined;
  if (useWebDashboard) {
    const { startWebDashboard } = await import("../dashboard/web-server.js");
    webDashboard = await startWebDashboard(control);
    observer = webDashboard.observer;
    stdout.write(`Agent Arena dashboard: ${webDashboard.url}\n`);
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
    void observer?.publish({
      type: "cancellation_requested",
      reason: "Interrupted",
    });
    control.cancel(new Error("Interrupted"));
    void webDashboard?.close();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const summary = (await arena.fight(config, controller.signal)).summary;
    if (webDashboard) {
      stdout.write(
        "Battle complete. Review the dashboard, then choose Finish session.\n",
      );
      await webDashboard.waitUntilClosed();
    }
    return summary;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    dashboard?.unmount();
    await webDashboard?.close();
  }
}

export async function runResume(options: {
  runId: string;
  approveDriftHash?: string;
  display?: "console" | "json";
}): Promise<string> {
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
    return (
      await arena.resume(
        {
          runId: options.runId,
          repositoryRoot,
          ...(options.approveDriftHash
            ? { approveDriftHash: options.approveDriftHash }
            : {}),
          ...(options.display ? { display: options.display } : {}),
        },
        controller.signal,
      )
    ).summary;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
