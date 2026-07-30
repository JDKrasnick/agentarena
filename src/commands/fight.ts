import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  CommandAttackVerifier,
  CommandCaseBuilder,
  CommandHouseScout,
  CommandHarnessMaintainer,
  CommandInfrastructureReviewer,
  createProviderAdapter,
} from "../agents/adapter.js";
import { CommandPatchQualityVerifier } from "../quality/verifier.js";
import {
  loadFightConfig,
  type CliConfigOverrides,
} from "../config/load-config.js";
import { Arena } from "../core/arena.js";
import { FightConfigSchema } from "../core/types.js";
import { discoverCapabilities } from "../permissions/policy.js";

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

export async function runFight(overrides: CliConfigOverrides): Promise<string> {
  const config = await approvePermissionPlan(await loadFightConfig(overrides));
  const adapters = Object.fromEntries(
    config.agents.map((agent) => [agent, createProviderAdapter(agent)]),
  );
  const arena = new Arena({
    adapters,
    verifier: new CommandAttackVerifier(config.attackVerifier),
    qualityVerifier: new CommandPatchQualityVerifier(
      config.qualityVerifier ?? config.attackVerifier,
    ),
    houseScout: new CommandHouseScout(config.attackVerifier),
    caseBuilder: new CommandCaseBuilder(config.attackVerifier),
    infrastructureReviewer: new CommandInfrastructureReviewer(),
    harnessMaintainer: new CommandHarnessMaintainer(config.harnessMaintainer),
    onProgress: (message) => stdout.write(`${message}\n`),
  });
  const controller = new AbortController();
  const cancel = (): void => controller.abort(new Error("Interrupted"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    return (await arena.fight(config, controller.signal)).summary;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
