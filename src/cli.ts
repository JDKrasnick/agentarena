#!/usr/bin/env node
import { Command, Option } from "commander";
import { randomUUID } from "node:crypto";
import { applyAcceptedPatch } from "./commands/apply.js";
import { runAcceptCommand } from "./commands/accept.js";
import { runDeliverCommand } from "./commands/deliver.js";
import { runFight } from "./commands/fight.js";
import { runInspectCommand, runReviewCommand } from "./commands/review.js";
import { AgentIdSchema } from "./core/types.js";
import { DeliveryActionSchema } from "./delivery/types.js";

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
  .option("--pr <reference...>", "Official GitHub pull request reference(s)")
  .option(
    "--base-from-pr <reference>",
    "Explicitly fetch and use this reviewed PR head as both contestants' base",
  )
  .option("--acceptance <criterion...>", "Explicit acceptance criteria")
  .addOption(
    new Option("--permissions <mode>", "Permission mode")
      .choices(["auto", "confirm", "deny"])
      .default("confirm"),
  )
  .option("--verifier <agent>", "Neutral verifier provider")
  .option(
    "--quality-verifier <agent>",
    "Neutral patch-quality verifier provider",
  )
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
        pr?: string[];
        baseFromPr?: string;
        acceptance?: string[];
        permissions: "auto" | "confirm" | "deny";
        verifier?: string;
        qualityVerifier?: string;
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
        ...(options.pr ? { pullRequestReferences: options.pr } : {}),
        ...(options.baseFromPr
          ? { baseFromPullRequest: options.baseFromPr }
          : {}),
        ...(options.acceptance
          ? { acceptanceCriteria: options.acceptance }
          : {}),
        permissionMode: options.permissions,
        ...(options.verifier ? { verifier: options.verifier } : {}),
        ...(options.qualityVerifier
          ? { qualityVerifier: options.qualityVerifier }
          : {}),
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
  .description("Apply the currently accepted patch from a trusted run")
  .argument("<run-id>", "Run ID under .agent-arena/runs")
  .option("--force-dirty", "Allow applying over a dirty worktree")
  .option("--idempotency-key <key>", "Stable retry key")
  .action(
    async (
      runId: string,
      options: { forceDirty?: boolean; idempotencyKey?: string },
    ) => {
      const result = await applyAcceptedPatch({
        runId,
        forceDirty: options.forceDirty ?? false,
        idempotencyKey: options.idempotencyKey ?? randomUUID(),
      });
      process.stdout.write(
        `Applied ${result.contestantId}'s accepted patch (${result.changedPaths.length} paths). Run: ${result.testCommand}\n`,
      );
    },
  );

program
  .command("review")
  .description("Show chat-ready patch choices for a completed run")
  .argument("<run-id>")
  .option("--json", "Emit the strict typed review prompt")
  .action(async (runId: string, options: { json?: boolean }) => {
    process.stdout.write(
      `${await runReviewCommand({ runId, json: options.json ?? false })}\n`,
    );
  });

program
  .command("inspect")
  .description("Inspect one final patch and its saved evidence")
  .argument("<run-id>")
  .requiredOption("--agent <id>")
  .addOption(
    new Option("--view <kind>")
      .choices(["summary", "diff", "tests", "quality"])
      .default("summary"),
  )
  .option("--json")
  .action(
    async (
      runId: string,
      options: {
        agent: string;
        view: "summary" | "diff" | "tests" | "quality";
        json?: boolean;
      },
    ) => {
      process.stdout.write(
        `${await runInspectCommand({
          runId,
          agent: AgentIdSchema.parse(options.agent),
          view: options.view,
          json: options.json ?? false,
        })}\n`,
      );
    },
  );

program
  .command("accept")
  .description("Record a patch-bound human acceptance")
  .argument("<run-id>")
  .addOption(
    new Option("--selection <choice>").choices(["recommended", "champion"]),
  )
  .option("--agent <id>", "Accept a specific eligible contestant")
  .option(
    "--confirm-sha256 <digest>",
    "Full digest for non-interactive approval",
  )
  .option("--apply", "Apply in the same explicit action")
  .option("--idempotency-key <key>")
  .option("--json")
  .action(
    async (
      runId: string,
      options: {
        selection?: "recommended" | "champion";
        agent?: string;
        confirmSha256?: string;
        apply?: boolean;
        idempotencyKey?: string;
        json?: boolean;
      },
    ) => {
      process.stdout.write(
        `${await runAcceptCommand({
          runId,
          ...(options.selection ? { selection: options.selection } : {}),
          ...(options.agent
            ? { agent: AgentIdSchema.parse(options.agent) }
            : {}),
          ...(options.confirmSha256
            ? { confirmSha256: options.confirmSha256 }
            : {}),
          apply: options.apply ?? false,
          ...(options.idempotencyKey
            ? { idempotencyKey: options.idempotencyKey }
            : {}),
          json: options.json ?? false,
        })}\n`,
      );
    },
  );

program
  .command("reject")
  .description("Reject all patches in a completed run")
  .argument("<run-id>")
  .option("--confirm-sha256 <digest>")
  .option("--idempotency-key <key>")
  .option("--json")
  .action(
    async (
      runId: string,
      options: {
        confirmSha256?: string;
        idempotencyKey?: string;
        json?: boolean;
      },
    ) => {
      process.stdout.write(
        `${await runAcceptCommand({
          runId,
          decision: "reject",
          ...(options.confirmSha256
            ? { confirmSha256: options.confirmSha256 }
            : {}),
          ...(options.idempotencyKey
            ? { idempotencyKey: options.idempotencyKey }
            : {}),
          json: options.json ?? false,
        })}\n`,
      );
    },
  );

program
  .command("deliver")
  .description("Plan, authorize, execute, or inspect delivery")
  .argument("<run-id>")
  .option("--plan")
  .option("--status")
  .option("--execute")
  .option("--action <action>")
  .option("--confirm-sha256 <digest>")
  .option("--merge-after-checks")
  .option("--close-issue")
  .option("--idempotency-key <key>")
  .option("--json")
  .action(
    async (
      runId: string,
      options: {
        plan?: boolean;
        status?: boolean;
        execute?: boolean;
        action?: string;
        confirmSha256?: string;
        mergeAfterChecks?: boolean;
        closeIssue?: boolean;
        idempotencyKey?: string;
        json?: boolean;
      },
    ) => {
      const mode = options.status
        ? "status"
        : options.plan
          ? "plan"
          : options.execute
            ? "execute"
            : "authorize";
      process.stdout.write(
        `${await runDeliverCommand({
          runId,
          mode,
          ...(options.action
            ? { action: DeliveryActionSchema.parse(options.action) }
            : {}),
          ...(options.confirmSha256
            ? { confirmSha256: options.confirmSha256 }
            : {}),
          mergeAfterChecks: options.mergeAfterChecks ?? false,
          closeIssue: options.closeIssue ?? false,
          ...(options.idempotencyKey
            ? { idempotencyKey: options.idempotencyKey }
            : {}),
          json: options.json ?? false,
        })}\n`,
      );
    },
  );

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(
    `Agent Arena failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
