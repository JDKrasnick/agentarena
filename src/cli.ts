#!/usr/bin/env node
import { Command, Option } from "commander";
import { applyResult } from "./commands/apply.js";
import { runFight } from "./commands/fight.js";
import { AgentIdSchema } from "./core/types.js";

const program = new Command()
  .name("agent-arena")
  .description("Make your coding agents fight for the merge.")
  .version("0.1.0");

program
  .command("fight")
  .description(
    "Run two coding agents through implementation and three attack–repair rounds",
  )
  .argument("<task>", "Concrete repository task")
  .option("-c, --config <path>", "YAML configuration path", "agent-arena.yaml")
  .option("--agents <ids>", "Exactly two comma-separated agents")
  .option("--rounds <count>", "Attack–repair rounds (MVP requires 3)", "3")
  .option("--test <command>", "Required validation command")
  .option("--spec <path...>", "Local specification path(s)")
  .option("--issue <reference...>", "Official GitHub issue reference(s)")
  .option("--acceptance <criterion...>", "Explicit acceptance criteria")
  .addOption(
    new Option("--permissions <mode>", "Permission mode")
      .choices(["auto", "confirm", "deny"])
      .default("confirm"),
  )
  .option("--verifier <agent>", "Neutral verifier provider")
  .option("--maintainer <agent>", "Harness-maintainer provider")
  .option("--yes", "Approve the displayed confirm-mode plan noninteractively")
  .option("--accept-reduced-validation", "Allow required capability denials")
  .option("--keep-worktrees", "Preserve temporary worktrees for debugging")
  .action(
    async (
      task: string,
      options: {
        config: string;
        agents?: string;
        rounds: string;
        test?: string;
        spec?: string[];
        issue?: string[];
        acceptance?: string[];
        permissions: "auto" | "confirm" | "deny";
        verifier?: string;
        maintainer?: string;
        yes?: boolean;
        acceptReducedValidation?: boolean;
        keepWorktrees?: boolean;
      },
    ) => {
      if (options.rounds !== "3") {
        throw new Error("The MVP requires exactly three attack–repair rounds");
      }
      const summary = await runFight({
        task,
        configPath: options.config,
        ...(options.agents ? { agents: options.agents } : {}),
        ...(options.test ? { testCommand: options.test } : {}),
        ...(options.spec ? { specPaths: options.spec } : {}),
        ...(options.issue ? { issueReferences: options.issue } : {}),
        ...(options.acceptance
          ? { acceptanceCriteria: options.acceptance }
          : {}),
        permissionMode: options.permissions,
        ...(options.verifier ? { verifier: options.verifier } : {}),
        ...(options.maintainer ? { maintainer: options.maintainer } : {}),
        nonInteractiveApproval: options.yes ?? false,
        reducedValidationAccepted: options.acceptReducedValidation ?? false,
        keepWorktrees: options.keepWorktrees ?? false,
      });
      process.stdout.write(`${summary}\n`);
    },
  );

program
  .command("apply")
  .description(
    "Apply a final patch from a trusted run in the current repository",
  )
  .argument("<run-id>", "Run ID under .agent-arena/runs")
  .requiredOption("--agent <id>", "Contestant patch to apply")
  .option("--force-dirty", "Allow applying over a dirty worktree")
  .action(
    async (runId: string, options: { agent: string; forceDirty?: boolean }) => {
      const message = await applyResult({
        runId,
        agent: AgentIdSchema.parse(options.agent),
        forceDirty: options.forceDirty ?? false,
      });
      process.stdout.write(`${message}\n`);
    },
  );

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(
    `Agent Arena failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
