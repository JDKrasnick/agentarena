import path from "node:path";
import type { CheckResult, ContestantId, FightConfig } from "../core/types.js";
import type { WorktreeManager } from "../repo/git.js";
import { prepareWorktreeWithRetry } from "../repo/retry.js";
import type { FailureRecord } from "../contracts/failure.js";
import { runShellCommand } from "./process-runner.js";

export interface IntegrationProvisionResult {
  ready: boolean;
  checks: CheckResult[];
  reason?: string;
}

export interface IntegrationFailureAttempt {
  agent: ContestantId;
  phase: "setup" | "steady-state" | "teardown";
  subject: string;
  attempt: 1 | 2;
  startedAt: string;
  finishedAt: string;
  status: "failed" | "succeeded";
  diagnosticArtifactRefs: string[];
  terminalDisposition?: "recovered" | "coverage_lost";
}

export async function provisionIntegrationProfile(options: {
  config: FightConfig;
  patches: Partial<Record<ContestantId, string>>;
  worktrees: WorktreeManager;
  logRoot: string;
  signal: AbortSignal;
  persistFailureAttempt?: (failure: IntegrationFailureAttempt) => Promise<void>;
  persistFailureRecord?: (record: FailureRecord) => Promise<void>;
  now?: () => Date;
}): Promise<IntegrationProvisionResult> {
  const profile = options.config.integrationProfile;
  if (!profile)
    return {
      ready: false,
      checks: [],
      reason: "No integration profile configured",
    };
  const checks: CheckResult[] = [];
  const now = options.now ?? (() => new Date());

  const runPhase = async (
    agent: ContestantId,
    phase: IntegrationFailureAttempt["phase"],
    command: string,
    worktree: string,
    subject: string = phase,
    beforeRetry?: () => Promise<void>,
  ): Promise<boolean> => {
    let failedOnce = false;
    for (const attempt of [1, 2] as const) {
      const startedAt = now().toISOString();
      const result = await runShellCommand(command, {
        cwd: worktree,
        timeoutMs: options.config.limits.attackMs,
        logPrefix: path.join(
          options.logRoot,
          `${agent}-${phase}-${String(attempt)}`,
        ),
        signal: options.signal,
      });
      const finishedAt = now().toISOString();
      const failed = result.exitCode !== 0;
      checks.push({
        id: `${agent}-integration-${phase}-${String(attempt)}`,
        kind: "service_health",
        status:
          result.failureClass === "arena_infrastructure"
            ? "infrastructure_error"
            : failed
              ? "failed"
              : "passed",
        command: result,
      });
      if (failed || failedOnce) {
        await options.persistFailureAttempt?.({
          agent,
          phase,
          subject,
          attempt,
          startedAt,
          finishedAt,
          status: failed ? "failed" : "succeeded",
          diagnosticArtifactRefs: [result.stdoutPath, result.stderrPath],
          ...(failed
            ? attempt === 2
              ? { terminalDisposition: "coverage_lost" as const }
              : {}
            : { terminalDisposition: "recovered" as const }),
        });
      }
      if (!failed) return true;
      failedOnce = true;
      if (attempt === 1) await beforeRetry?.();
    }
    return false;
  };

  for (const [agent, patch] of Object.entries(options.patches) as Array<
    [ContestantId, string]
  >) {
    let worktree = await prepareWorktreeWithRetry({
      worktrees: options.worktrees,
      name: `integration-${agent}`,
      subject: `integration-worktree:${agent}`,
      patches: [patch],
      contestantId: agent,
      laneId: `integration-${agent}`,
      ...(options.persistFailureRecord
        ? { persistFailureRecord: options.persistFailureRecord }
        : {}),
      now,
    });
    let setupSucceeded: boolean;
    let setupAttempted = false;
    const recreate = async (): Promise<void> => {
      await options.worktrees.remove(worktree);
      worktree = await prepareWorktreeWithRetry({
        worktrees: options.worktrees,
        name: `integration-${agent}`,
        subject: `integration-retry-worktree:${agent}`,
        patches: [patch],
        contestantId: agent,
        laneId: `integration-${agent}`,
        ...(options.persistFailureRecord
          ? { persistFailureRecord: options.persistFailureRecord }
          : {}),
        now,
      });
    };
    const cleanServiceBeforeRetry = async (subject: string): Promise<void> => {
      await runPhase(
        agent,
        "teardown",
        profile.teardownCommand,
        worktree,
        subject,
      );
      await recreate();
    };
    try {
      setupAttempted = true;
      setupSucceeded = await runPhase(
        agent,
        "setup",
        profile.setupCommand,
        worktree,
        "setup",
        () => cleanServiceBeforeRetry("cleanup-before-setup-retry"),
      );
      if (!setupSucceeded) {
        return {
          ready: false,
          checks,
          reason: `Integration setup failed for ${agent}`,
        };
      }
      const steadySucceeded = await runPhase(
        agent,
        "steady-state",
        profile.checkCommand,
        worktree,
        "steady-state",
        async () => {
          await cleanServiceBeforeRetry("cleanup-before-steady-state-retry");
          const retrySetupSucceeded = await runPhase(
            agent,
            "setup",
            profile.setupCommand,
            worktree,
            "setup-before-steady-state-retry",
            () =>
              cleanServiceBeforeRetry(
                "cleanup-before-steady-state-setup-retry",
              ),
          );
          if (!retrySetupSucceeded)
            throw new Error(
              `Integration setup failed while retrying steady-state for ${agent}`,
            );
        },
      );
      if (!steadySucceeded) {
        return {
          ready: false,
          checks,
          reason: `Steady-state check failed for ${agent}`,
        };
      }
    } finally {
      if (setupAttempted) {
        await runPhase(
          agent,
          "teardown",
          profile.teardownCommand,
          worktree,
          "teardown",
        );
      }
      await options.worktrees.remove(worktree);
    }
  }
  const ready = checks.every((check) => check.status === "passed");
  return {
    ready,
    checks,
    ...(ready
      ? {}
      : { reason: "Integration profile did not pass symmetrically" }),
  };
}
