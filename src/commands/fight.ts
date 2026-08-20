import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createBuiltInBrowserAdapters } from "../browser/builtin.js";
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
import {
  collectFightReconnaissance,
  type ReconnaissanceSnapshot,
} from "../task/task-contract.js";

async function approvePermissionPlan(
  config: Awaited<ReturnType<typeof loadFightConfig>>,
  reconnaissance: ReconnaissanceSnapshot,
) {
  if (config.permissionMode !== "confirm" || config.nonInteractiveApproval)
    return config;
  stdout.write("Agent Arena permission plan\n");
  for (const request of discoverCapabilities(config, reconnaissance)) {
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
): Arena {
  const adapters = Object.fromEntries(
    config.contestants.map((contestant) => [
      contestant.provider,
      createProviderAdapter(contestant.provider, contestant.model),
    ]),
  );
  return new Arena({
    adapters,
    adapterFactory: (contestant) =>
      createProviderAdapter(contestant.provider, contestant.model),
    verifier: new CommandAttackVerifier(config.judge),
    browserAdapters: createBuiltInBrowserAdapters(),
    onProgress: (message) => stdout.write(`${message}\n`),
  });
}

export async function runFight(overrides: CliConfigOverrides): Promise<string> {
  const loadedConfig = await loadFightConfig(overrides);
  const reconnaissance = await collectFightReconnaissance(loadedConfig);
  const config = await approvePermissionPlan(loadedConfig, reconnaissance);
  const arena = createArena(config);
  const controller = new AbortController();
  const cancel = (): void => controller.abort(new Error("Interrupted"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    return (await arena.fight(config, controller.signal, reconnaissance))
      .summary;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
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
