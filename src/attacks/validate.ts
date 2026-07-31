import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  anonymizeAttackForVerifier,
  type AttackVerifier,
} from "../agents/adapter.js";
import { DAMAGE_BY_SEVERITY } from "../core/scoring.js";
import type {
  Attack,
  CheckResult,
  FightConfig,
  PermissionPolicy,
  TaskContract,
} from "../core/types.js";
import { changedPathsFromPatch, isAllowedAttackPath } from "../repo/git.js";
import type { WorktreeManager } from "../repo/git.js";
import { runShellCommand } from "../runner/process-runner.js";
import { oracleResolves } from "../task/task-contract.js";

interface ValidateAttackOptions {
  attack: Attack;
  authorPatch: string;
  targetPatch: string;
  taskContract: TaskContract;
  permissionPolicy: PermissionPolicy;
  config: FightConfig;
  worktrees: WorktreeManager;
  verifier: AttackVerifier;
  logRoot: string;
  signal: AbortSignal;
  knownRootDefects: ReadonlySet<string>;
}

interface RepeatedCheck {
  checks: CheckResult[];
  stable: boolean;
  passed: boolean;
  infrastructure: boolean;
}

async function runTwice(
  id: string,
  kind: CheckResult["kind"],
  command: string,
  cwd: string,
  config: FightConfig,
  logRoot: string,
  signal: AbortSignal,
): Promise<RepeatedCheck> {
  const results = [];
  for (const attempt of [1, 2]) {
    results.push(
      await runShellCommand(command, {
        cwd,
        timeoutMs: config.limits.attackMs,
        logPrefix: path.join(logRoot, `${id}-attempt-${String(attempt)}`),
        signal,
        attempts: attempt,
      }),
    );
  }
  const infrastructure = results.some(
    (result) => result.failureClass === "arena_infrastructure",
  );
  const exits = results.map(
    (result) => `${String(result.exitCode)}:${String(result.timedOut)}`,
  );
  const stable = exits[0] === exits[1];
  const passed =
    stable &&
    !infrastructure &&
    results.every((result) => result.exitCode === 0);
  return {
    checks: results.map((commandResult, index) => ({
      id: `${id}-${String(index + 1)}`,
      kind,
      status:
        commandResult.failureClass === "arena_infrastructure"
          ? "infrastructure_error"
          : commandResult.exitCode === 0
            ? "passed"
            : "failed",
      command: commandResult,
    })),
    stable,
    passed,
    infrastructure,
  };
}

async function prepare(
  worktrees: WorktreeManager,
  name: string,
  implementationPatch: string | undefined,
  attackPatch: string,
): Promise<string> {
  const worktree = await worktrees.create(name);
  if (implementationPatch)
    await worktrees.applyPatch(worktree, implementationPatch);
  await worktrees.applyPatch(worktree, attackPatch);
  return worktree;
}

function withOutcome(
  attack: Attack,
  status: Attack["status"],
  reason: string,
): Attack {
  return { ...attack, status, outcomeReason: reason };
}

export async function validateAttack(
  options: ValidateAttackOptions,
): Promise<Attack> {
  const attack = structuredClone(options.attack);
  const patch = await readFile(attack.patchPath, "utf8");
  if (patch.trim().length === 0)
    return withOutcome(attack, "invalid", "Attack patch is empty");

  const changedPaths = changedPathsFromPatch(patch);
  if (
    changedPaths.length === 0 ||
    changedPaths.some((filePath) => !isAllowedAttackPath(filePath))
  ) {
    return withOutcome(
      attack,
      "invalid",
      "Attack changes production code or has no recognized test/fixture path",
    );
  }

  const denied = attack.requiredCapabilities.find((id) => {
    const capability = options.permissionPolicy.capabilities.find(
      (entry) => entry.id === id,
    );
    return capability?.status === "denied";
  });
  if (denied) {
    return withOutcome(
      attack,
      "capability_denied",
      `Capability ${denied} is denied`,
    );
  }
  const unknown = attack.requiredCapabilities.find(
    (id) =>
      !options.permissionPolicy.capabilities.some((entry) => entry.id === id),
  );
  if (unknown) {
    return withOutcome(
      attack,
      "capability_denied",
      `Optional capability ${unknown} was not in the approved manifest`,
    );
  }
  if (!oracleResolves(options.taskContract, attack.oracle)) {
    return withOutcome(
      attack,
      "unproven",
      "Oracle source is absent from the task contract",
    );
  }

  const baseName = `${String(attack.round)}-${attack.id}`;
  const created: string[] = [];
  try {
    let baseline: string;
    try {
      baseline = await prepare(
        options.worktrees,
        `${baseName}-base`,
        undefined,
        attack.patchPath,
      );
      created.push(baseline);
    } catch (error) {
      return withOutcome(
        attack,
        "invalid",
        `Attack does not apply to the base commit: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const baselineResult = await runTwice(
      "baseline-focused",
      "baseline",
      attack.focusedCommand,
      baseline,
      options.config,
      options.logRoot,
      options.signal,
    );
    attack.checks.push(...baselineResult.checks);
    if (baselineResult.infrastructure) {
      return withOutcome(
        attack,
        "provisional_infrastructure",
        "Baseline execution infrastructure failed",
      );
    }
    if (!baselineResult.stable) {
      return withOutcome(
        attack,
        "invalid",
        "Focused attack is flaky on the base commit",
      );
    }

    let author: string;
    let target: string;
    try {
      author = await prepare(
        options.worktrees,
        `${baseName}-author`,
        options.authorPatch,
        attack.patchPath,
      );
      target = await prepare(
        options.worktrees,
        `${baseName}-target`,
        options.targetPatch,
        attack.patchPath,
      );
      created.push(author, target);
    } catch (error) {
      return withOutcome(
        attack,
        "invalid",
        `Attack does not apply symmetrically: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const [[authorFocused, authorFull], [targetFocused, targetFull]] =
      await Promise.all([
        (async () => {
          const focused = await runTwice(
            "author-focused",
            "focused",
            attack.focusedCommand,
            author,
            options.config,
            options.logRoot,
            options.signal,
          );
          const full = await runTwice(
            "author-required",
            "required",
            options.config.testCommand,
            author,
            options.config,
            options.logRoot,
            options.signal,
          );
          return [focused, full] as const;
        })(),
        (async () => {
          const focused = await runTwice(
            "target-focused",
            "focused",
            attack.focusedCommand,
            target,
            options.config,
            options.logRoot,
            options.signal,
          );
          const full = await runTwice(
            "target-required",
            "required",
            options.config.testCommand,
            target,
            options.config,
            options.logRoot,
            options.signal,
          );
          return [focused, full] as const;
        })(),
      ]);
    attack.checks.push(
      ...authorFocused.checks,
      ...authorFull.checks,
      ...targetFocused.checks,
      ...targetFull.checks,
    );
    if (
      authorFocused.infrastructure ||
      authorFull.infrastructure ||
      targetFocused.infrastructure ||
      targetFull.infrastructure
    ) {
      return withOutcome(
        attack,
        "provisional_infrastructure",
        "A comparative execution had an infrastructure failure",
      );
    }
    if (
      !authorFocused.stable ||
      !authorFull.stable ||
      !targetFocused.stable ||
      !targetFull.stable
    ) {
      return withOutcome(
        attack,
        "invalid",
        "Attack or required validation was flaky",
      );
    }
    if (!authorFocused.passed || !authorFull.passed) {
      return withOutcome(
        attack,
        "self_defeating",
        "Attack fails on its author's patch",
      );
    }
    if (targetFocused.passed) {
      return withOutcome(
        attack,
        "blocked",
        "Target patch passes the focused attack",
      );
    }

    const verdict = await options.verifier.assess({
      attack: anonymizeAttackForVerifier(attack),
      taskContract: options.taskContract,
      authorPassed: true,
      targetFailed: true,
      worktree: target,
      promptPath: path.join(options.logRoot, "verifier.prompt.md"),
      transcriptPrefix: path.join(options.logRoot, "verifier"),
      timeoutMs: options.config.limits.verifierMs,
      signal: options.signal,
    });
    if (!verdict.oracleSupported) {
      return withOutcome(attack, "unproven", verdict.oracleRationale);
    }
    if (!verdict.relevant)
      return withOutcome(attack, "invalid", verdict.rationale);
    if (options.knownRootDefects.has(verdict.rootDefectId)) {
      return {
        ...withOutcome(
          attack,
          "duplicate",
          "Canonical root defect already scored",
        ),
        rootDefectId: verdict.rootDefectId,
      };
    }
    return {
      ...attack,
      status: "landed",
      rootDefectId: verdict.rootDefectId,
      severity: verdict.severity,
      damage: DAMAGE_BY_SEVERITY[verdict.severity],
      damageActive: true,
      severityRationale: verdict.rationale,
      outcomeReason: `Stable author pass and target failure; ${verdict.rationale}`,
    };
  } catch (error) {
    return withOutcome(
      attack,
      "provisional_infrastructure",
      `Harness exception during attack validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    for (const worktree of created) await options.worktrees.remove(worktree);
  }
}

export async function validateHouseAttack(
  options: Omit<ValidateAttackOptions, "authorPatch" | "targetPatch"> & {
    targetPatches: Partial<Record<Attack["targets"][number], string>>;
  },
): Promise<Attack> {
  const attack = structuredClone(options.attack);
  const patch = await readFile(attack.patchPath, "utf8");
  const changedPaths = changedPathsFromPatch(patch);
  if (
    patch.trim().length === 0 ||
    changedPaths.length === 0 ||
    changedPaths.some((filePath) => !isAllowedAttackPath(filePath))
  ) {
    return withOutcome(
      attack,
      "invalid",
      "House attack must change only recognized tests or fixtures",
    );
  }
  if (!oracleResolves(options.taskContract, attack.oracle)) {
    return withOutcome(
      attack,
      "unproven",
      "House oracle source is absent from the task contract",
    );
  }

  const created: string[] = [];
  try {
    const baseline = await prepare(
      options.worktrees,
      `house-${String(attack.round)}-${attack.id}-base`,
      undefined,
      attack.patchPath,
    );
    created.push(baseline);
    const baselineResult = await runTwice(
      "house-baseline",
      "baseline",
      attack.focusedCommand,
      baseline,
      options.config,
      options.logRoot,
      options.signal,
    );
    attack.checks.push(...baselineResult.checks);
    if (baselineResult.infrastructure) {
      return withOutcome(
        attack,
        "infrastructure_error",
        "House baseline infrastructure failed",
      );
    }
    if (!baselineResult.stable)
      return withOutcome(attack, "invalid", "House attack is flaky");

    const affected: Attack["targets"] = [];
    let verifierTree: string | undefined;
    for (const target of attack.targets) {
      const implementationPatch = options.targetPatches[target];
      if (!implementationPatch) continue;
      const targetTree = await prepare(
        options.worktrees,
        `house-${String(attack.round)}-${attack.id}-${target}`,
        implementationPatch,
        attack.patchPath,
      );
      created.push(targetTree);
      const focused = await runTwice(
        `house-${target}-focused`,
        "focused",
        attack.focusedCommand,
        targetTree,
        options.config,
        options.logRoot,
        options.signal,
      );
      const full = await runTwice(
        `house-${target}-required`,
        "required",
        options.config.testCommand,
        targetTree,
        options.config,
        options.logRoot,
        options.signal,
      );
      attack.checks.push(...focused.checks, ...full.checks);
      if (focused.infrastructure || full.infrastructure) {
        return withOutcome(
          attack,
          "infrastructure_error",
          "House comparison infrastructure failed",
        );
      }
      if (!focused.stable || !full.stable) {
        return withOutcome(
          attack,
          "invalid",
          `House evidence is flaky on ${target}`,
        );
      }
      if (!focused.passed) {
        affected.push(target);
        verifierTree ??= targetTree;
      }
    }
    if (affected.length === 0)
      return withOutcome(
        attack,
        "blocked",
        "Both patches block the house attack",
      );
    if (!verifierTree) throw new Error("Missing house verifier worktree");
    const verdict = await options.verifier.assess({
      attack: anonymizeAttackForVerifier(attack),
      taskContract: options.taskContract,
      authorPassed: true,
      targetFailed: true,
      worktree: verifierTree,
      promptPath: path.join(options.logRoot, "verifier.prompt.md"),
      transcriptPrefix: path.join(options.logRoot, "verifier"),
      timeoutMs: options.config.limits.verifierMs,
      signal: options.signal,
    });
    if (!verdict.oracleSupported)
      return withOutcome(attack, "unproven", verdict.oracleRationale);
    if (!verdict.relevant)
      return withOutcome(attack, "invalid", verdict.rationale);
    if (options.knownRootDefects.has(verdict.rootDefectId)) {
      return {
        ...withOutcome(
          attack,
          "duplicate",
          "House evidence corroborates an existing root defect",
        ),
        rootDefectId: verdict.rootDefectId,
      };
    }
    return {
      ...attack,
      targets: affected,
      status: "landed",
      rootDefectId: verdict.rootDefectId,
      severity: verdict.severity,
      damage: DAMAGE_BY_SEVERITY[verdict.severity],
      damageActive: true,
      severityRationale: verdict.rationale,
      outcomeReason: `Neutral house evidence failed on ${affected.join(", ")}`,
    };
  } catch (error) {
    return withOutcome(
      attack,
      "infrastructure_error",
      `House validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    for (const worktree of created) await options.worktrees.remove(worktree);
  }
}
