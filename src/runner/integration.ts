import path from "node:path";
import type { AgentId, CheckResult, FightConfig } from "../core/types.js";
import type { WorktreeManager } from "../repo/git.js";
import { runShellCommand } from "./process-runner.js";

export interface IntegrationProvisionResult {
  ready: boolean;
  checks: CheckResult[];
  reason?: string;
}

export async function provisionIntegrationProfile(options: {
  config: FightConfig;
  patches: Partial<Record<AgentId, string>>;
  worktrees: WorktreeManager;
  logRoot: string;
  signal: AbortSignal;
}): Promise<IntegrationProvisionResult> {
  const profile = options.config.integrationProfile;
  if (!profile)
    return {
      ready: false,
      checks: [],
      reason: "No integration profile configured",
    };
  const checks: CheckResult[] = [];

  for (const [agent, patch] of Object.entries(options.patches) as Array<
    [AgentId, string]
  >) {
    const worktree = await options.worktrees.create(`integration-${agent}`);
    let setupSucceeded = false;
    try {
      await options.worktrees.applyPatch(worktree, patch);
      const setup = await runShellCommand(profile.setupCommand, {
        cwd: worktree,
        timeoutMs: options.config.limits.attackMs,
        logPrefix: path.join(options.logRoot, `${agent}-setup`),
        signal: options.signal,
      });
      setupSucceeded = setup.exitCode === 0;
      checks.push({
        id: `${agent}-integration-setup`,
        kind: "service_health",
        status:
          setup.failureClass === "arena_infrastructure"
            ? "infrastructure_error"
            : setup.exitCode === 0
              ? "passed"
              : "failed",
        command: setup,
      });
      if (!setupSucceeded) {
        return {
          ready: false,
          checks,
          reason: `Integration setup failed for ${agent}`,
        };
      }
      const steady = await runShellCommand(profile.checkCommand, {
        cwd: worktree,
        timeoutMs: options.config.limits.attackMs,
        logPrefix: path.join(options.logRoot, `${agent}-steady-state`),
        signal: options.signal,
      });
      checks.push({
        id: `${agent}-integration-steady-state`,
        kind: "service_health",
        status:
          steady.failureClass === "arena_infrastructure"
            ? "infrastructure_error"
            : steady.exitCode === 0
              ? "passed"
              : "failed",
        command: steady,
      });
      if (steady.exitCode !== 0) {
        return {
          ready: false,
          checks,
          reason: `Steady-state check failed for ${agent}`,
        };
      }
    } finally {
      if (setupSucceeded) {
        const teardown = await runShellCommand(profile.teardownCommand, {
          cwd: worktree,
          timeoutMs: options.config.limits.attackMs,
          logPrefix: path.join(options.logRoot, `${agent}-teardown`),
          signal: options.signal,
        });
        checks.push({
          id: `${agent}-integration-teardown`,
          kind: "service_health",
          status:
            teardown.failureClass === "arena_infrastructure"
              ? "infrastructure_error"
              : teardown.exitCode === 0
                ? "passed"
                : "failed",
          command: teardown,
        });
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
