#!/usr/bin/env node
import { Command, Option } from "commander";
import { randomUUID } from "node:crypto";
import { applyAcceptedPatch } from "./commands/apply.js";
import { runAcceptCommand } from "./commands/accept.js";
import { runDeliverCommand } from "./commands/deliver.js";
import { exitCodeForStatus, runFight, runResume } from "./commands/fight.js";
import { runInspectCommand, runReviewCommand } from "./commands/review.js";
import { resolveCoverage } from "./commands/resolve-coverage.js";
import { ContestantIdSchema } from "./core/types.js";
import { DeliveryActionSchema } from "./delivery/types.js";
import {
  renderEvaluationArtifact,
  runPauseReplanEvaluation,
} from "./evaluation/pause-replan.js";

const program = new Command()
  .name("agent-arena")
  .description("Make your coding agents fight for the merge.")
  .version("0.1.0");

program
  .command("eval:pause-replan")
  .description("Run the developer-only schema-v2 pause–replan evaluation")
  .requiredOption("--manifest <path>", "Frozen schema-v2 evaluation manifest")
  .option(
    "--transport-gate <path>",
    "Passing evaluation.json from the transport gate (required for a full run)",
  )
  .action(async (options: { manifest: string; transportGate?: string }) => {
    const evaluation = await runPauseReplanEvaluation(options.manifest, {
      ...(options.transportGate
        ? { gateArtifactPath: options.transportGate }
        : {}),
    });
    const outcome =
      evaluation.result.phase === "transport_gate"
        ? evaluation.result.transport_gate.status
        : evaluation.result.verdict?.verdict;
    process.stdout.write(
      `Pause–replan evaluation: ${outcome ?? "Inconclusive"}\nArtifacts: ${evaluation.outputPath}\n`,
    );
  });

program
  .command("eval:render")
  .description("Render a schema-v1 or schema-v2 evaluation artifact read-only")
  .requiredOption("--evaluation <path>", "Immutable evaluation.json artifact")
  .requiredOption("--output <path>", "Destination HTML path")
  .action(async (options: { evaluation: string; output: string }) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      options.output,
      await renderEvaluationArtifact(options.evaluation),
      {
        encoding: "utf8",
        flag: "wx",
      },
    );
    process.stdout.write(`Rendered evaluation: ${options.output}\n`);
  });

program
  .command("resolve-coverage")
  .description("Finalize a provisional battle's coverage outcome")
  .argument("<run-id>", "Run ID under .agent-arena/runs")
  .requiredOption(
    "--assessment-digest <digest>",
    "Exact coverage assessment SHA-256",
  )
  .addOption(
    new Option("--decision <decision>").choices([
      "accept-reduced",
      "inconclusive",
    ]),
  )
  .option("--json", "Emit the immutable decision as JSON")
  .action(
    async (
      runId: string,
      options: {
        assessmentDigest: string;
        decision: "accept-reduced" | "inconclusive";
        json?: boolean;
      },
    ) => {
      if (!options.decision) throw new Error("--decision is required");
      const decision = await resolveCoverage({
        runId,
        assessmentDigest: options.assessmentDigest,
        decision: options.decision,
      });
      process.stdout.write(
        options.json
          ? `${JSON.stringify(decision, null, 2)}\n`
          : `Coverage resolved: ${decision.decision} (${decision.assessmentDigest})\n`,
      );
    },
  );

program
  .command("resume")
  .description(
    "Validate and continue a durable schema-v8 run from its latest sealed boundary",
  )
  .argument("<run-id>", "Run ID under .agent-arena/runs")
  .addOption(
    new Option("--display <format>", "Resume output format")
      .choices(["console", "json"])
      .default("console"),
  )
  .option(
    "--approve-drift <report-hash>",
    "Approve the exact current approval-required drift report",
  )
  .action(
    async (
      runId: string,
      options: {
        display: "console" | "json";
        approveDrift?: string;
      },
    ) => {
      const result = await runResume({
        runId,
        display: options.display,
        ...(options.approveDrift
          ? { approveDriftHash: options.approveDrift }
          : {}),
      });
      process.stdout.write(`${result.summary}\n`);
      process.exitCode = exitCodeForStatus(result.status);
    },
  );

program
  .command("fight")
  .description(
    "Run two coding agents through implementation and three attack–repair rounds",
  )
  .argument("<task>", "Concrete repository task")
  .option("-c, --config <path>", "YAML configuration path", "agent-arena.yaml")
  .option("--agents <ids>", "Exactly two comma-separated agents")
  .option(
    "--models <ids>",
    "Optional comma-separated models for contestants A and B",
  )
  .option("--rounds <count>", "Attack–repair rounds (MVP requires 3)", "3")
  .option("--test <command>", "Required validation command")
  .option("--spec <path...>", "Local specification path(s)")
  .option("--issue <reference...>", "Official GitHub issue reference(s)")
  .option("--pr <reference...>", "Official GitHub pull request reference(s)")
  .option(
    "--incumbent-from-pr",
    "Start contestant A from the frozen PR patch and give contestant B a clean catch-up implementation phase",
  )
  .option("--challenger <agent>", "Provider for the catch-up challenger")
  .option(
    "--incumbent <agent>",
    "Provider that attacks and repairs the frozen PR incumbent when attribution is unknown",
  )
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
  .option("--judge <agent>", "Identity-blind judge provider")
  .option("--verifier <agent>", "Deprecated alias for --judge")
  .option("--quality-verifier <agent>", "Deprecated; ignored for new runs")
  .option("--maintainer <agent>", "Deprecated; ignored for new runs")
  .option("--yes", "Approve the displayed confirm-mode plan noninteractively")
  .option("--accept-reduced-validation", "Allow required capability denials")
  .option("--keep-worktrees", "Preserve temporary worktrees for debugging")
  .addOption(
    new Option("--display <mode>", "Display mode")
      .choices(["auto", "window", "dashboard", "terminal", "plain"])
      .default("auto"),
  )
  .option(
    "--no-window",
    "Do not launch Electron; use terminal output in a TTY and plain output otherwise",
  )
  .action(
    async (
      task: string,
      options: {
        config: string;
        agents?: string;
        models?: string;
        rounds: string;
        test?: string;
        spec?: string[];
        issue?: string[];
        pr?: string[];
        incumbentFromPr?: boolean;
        challenger?: string;
        incumbent?: string;
        baseFromPr?: string;
        acceptance?: string[];
        permissions: "auto" | "confirm" | "deny";
        judge?: string;
        verifier?: string;
        qualityVerifier?: string;
        maintainer?: string;
        yes?: boolean;
        acceptReducedValidation?: boolean;
        keepWorktrees?: boolean;
        display: "auto" | "window" | "dashboard" | "terminal" | "plain";
        window: boolean;
      },
    ) => {
      if (options.rounds !== "3") {
        throw new Error("The MVP requires exactly three attack–repair rounds");
      }
      const result = await runFight(
        {
          task,
          configPath: options.config,
          ...(options.agents ? { agents: options.agents } : {}),
          ...(options.models ? { models: options.models } : {}),
          ...(options.test ? { testCommand: options.test } : {}),
          ...(options.spec ? { specPaths: options.spec } : {}),
          ...(options.issue ? { issueReferences: options.issue } : {}),
          ...(options.pr ? { pullRequestReferences: options.pr } : {}),
          ...(options.incumbentFromPr ? { mode: "catch_up" as const } : {}),
          ...(options.challenger ? { challenger: options.challenger } : {}),
          ...(options.incumbent ? { incumbent: options.incumbent } : {}),
          ...(options.baseFromPr
            ? { baseFromPullRequest: options.baseFromPr }
            : {}),
          ...(options.acceptance
            ? { acceptanceCriteria: options.acceptance }
            : {}),
          permissionMode: options.permissions,
          ...(options.judge ? { judge: options.judge } : {}),
          ...(options.verifier ? { verifier: options.verifier } : {}),
          ...(options.qualityVerifier
            ? { qualityVerifier: options.qualityVerifier }
            : {}),
          ...(options.maintainer ? { maintainer: options.maintainer } : {}),
          nonInteractiveApproval: options.yes ?? false,
          reducedValidationAccepted: options.acceptReducedValidation ?? false,
          keepWorktrees: options.keepWorktrees ?? false,
        },
        options.display,
        options.window,
      );
      process.stdout.write(`${result.summary}\n`);
      process.exitCode = exitCodeForStatus(result.status);
    },
  );

program
  .command("defend")
  .description(
    "Run a scored attacker-versus-defender review of a frozen pull request",
  )
  .requiredOption("--pr <reference>", "Pull request to defend")
  .requiredOption(
    "--attacker <agent>",
    "Provider that produces test-only attacks",
  )
  .requiredOption(
    "--defender <agent>",
    "Provider that repairs the frozen PR patch",
  )
  .option(
    "--models <ids>",
    "Optional comma-separated models for attacker and defender",
  )
  .option("-c, --config <path>", "YAML configuration path", "agent-arena.yaml")
  .option("--test <command>", "Required validation command")
  .option("--spec <path...>", "Local specification path(s)")
  .option("--issue <reference...>", "Official GitHub issue reference(s)")
  .option("--acceptance <criterion...>", "Explicit acceptance criteria")
  .addOption(
    new Option("--permissions <mode>", "Permission mode")
      .choices(["auto", "confirm", "deny"])
      .default("confirm"),
  )
  .option("--judge <agent>", "Identity-blind judge provider")
  .option("--verifier <agent>", "Deprecated alias for --judge")
  .option("--quality-verifier <agent>", "Deprecated; ignored for new runs")
  .option("--maintainer <agent>", "Deprecated; ignored for new runs")
  .option("--yes", "Approve the displayed confirm-mode plan noninteractively")
  .option("--accept-reduced-validation", "Allow required capability denials")
  .option("--keep-worktrees", "Preserve temporary worktrees for debugging")
  .addOption(
    new Option("--display <mode>", "Display mode")
      .choices(["auto", "window", "dashboard", "terminal", "plain"])
      .default("auto"),
  )
  .option(
    "--no-window",
    "Do not launch Electron; use terminal output in a TTY and plain output otherwise",
  )
  .action(
    async (options: {
      pr: string;
      attacker: string;
      defender: string;
      models?: string;
      config: string;
      test?: string;
      spec?: string[];
      issue?: string[];
      acceptance?: string[];
      permissions: "auto" | "confirm" | "deny";
      judge?: string;
      verifier?: string;
      qualityVerifier?: string;
      maintainer?: string;
      yes?: boolean;
      acceptReducedValidation?: boolean;
      keepWorktrees?: boolean;
      display: "auto" | "window" | "dashboard" | "terminal" | "plain";
      window: boolean;
    }) => {
      const result = await runFight(
        {
          task: `Defend pull request #${options.pr}`,
          configPath: options.config,
          mode: "siege",
          pullRequestReferences: [options.pr],
          attacker: options.attacker,
          defender: options.defender,
          ...(options.models ? { models: options.models } : {}),
          ...(options.test ? { testCommand: options.test } : {}),
          ...(options.spec ? { specPaths: options.spec } : {}),
          ...(options.issue ? { issueReferences: options.issue } : {}),
          ...(options.acceptance
            ? { acceptanceCriteria: options.acceptance }
            : {}),
          permissionMode: options.permissions,
          ...(options.judge ? { judge: options.judge } : {}),
          ...(options.verifier ? { verifier: options.verifier } : {}),
          ...(options.qualityVerifier
            ? { qualityVerifier: options.qualityVerifier }
            : {}),
          ...(options.maintainer ? { maintainer: options.maintainer } : {}),
          nonInteractiveApproval: options.yes ?? false,
          reducedValidationAccepted: options.acceptReducedValidation ?? false,
          keepWorktrees: options.keepWorktrees ?? false,
        },
        options.display,
        options.window,
      );
      process.stdout.write(`${result.summary}\n`);
      process.exitCode = exitCodeForStatus(result.status);
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
          agent: ContestantIdSchema.parse(options.agent),
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
            ? { agent: ContestantIdSchema.parse(options.agent) }
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
