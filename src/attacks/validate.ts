import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  anonymizeAttackForVerifier,
  type AttackVerifier,
  type JudgeAdjudicationInput,
} from "../agents/adapter.js";
import { DAMAGE_BY_SEVERITY } from "../core/scoring.js";
import type {
  Attack,
  CheckResult,
  FightConfig,
  PermissionPolicy,
} from "../core/types.js";
import type { RunSpec } from "../contracts/round.js";
import { changedPathsFromPatch, isAllowedAttackPath } from "../repo/git.js";
import type { WorktreeManager } from "../repo/git.js";
import { runShellCommand } from "../runner/process-runner.js";
import { applyJudgeVerdict, suppressKnownJudgeDefect } from "./adjudicate.js";
import { assertTargetedRetryAllowed } from "../confidence/assessment.js";

interface ValidateAttackOptions {
  attack: Attack;
  authorPatch: string;
  targetPatch: string;
  runSpec: RunSpec;
  permissionPolicy: PermissionPolicy;
  config: FightConfig;
  worktrees: WorktreeManager;
  verifier: AttackVerifier;
  logRoot: string;
  signal: AbortSignal;
  knownRootDefects: ReadonlySet<string>;
  priorCanonicalDefects?: JudgeAdjudicationInput["priorCanonicalDefects"];
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
  try {
    if (implementationPatch)
      await worktrees.applyPatch(worktree, implementationPatch);
    await worktrees.applyPatch(worktree, attackPatch);
    return worktree;
  } catch (error) {
    await worktrees.remove(worktree);
    throw error;
  }
}

function withOutcome(
  attack: Attack,
  status: Attack["status"],
  reason: string,
): Attack {
  return { ...attack, status, outcomeReason: reason };
}

async function judgeFallback(
  options: ValidateAttackOptions,
  attack: Attack,
  reason: string,
  worktree = options.config.repositoryRoot,
): Promise<Attack> {
  if (!options.verifier.adjudicate)
    return withOutcome(attack, "judge_unable", reason);
  let lastFailure = reason;
  for (const attemptNumber of [1, 2] as const) {
    try {
      const verdict = await options.verifier.adjudicate({
        attack: anonymizeAttackForVerifier(attack),
        runSpec: options.runSpec,
        mechanicalFailureReason: reason,
        priorCanonicalDefects: options.priorCanonicalDefects ?? [],
        worktree,
        promptPath: path.join(
          options.logRoot,
          `judge-fallback-attempt-${String(attemptNumber)}.prompt.md`,
        ),
        transcriptPrefix: path.join(
          options.logRoot,
          `judge-fallback-attempt-${String(attemptNumber)}`,
        ),
        timeoutMs: options.config.limits.verifierMs,
        signal: options.signal,
      });
      const adjudicated = suppressKnownJudgeDefect(
        applyJudgeVerdict(attack, verdict),
        options.knownRootDefects,
      );
      if (adjudicated.status !== "judge_unable") return adjudicated;
      lastFailure = adjudicated.outcomeReason ?? reason;
    } catch (error) {
      lastFailure = `Judge fallback failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (attemptNumber === 1) assertTargetedRetryAllowed(attemptNumber);
  }
  return withOutcome(attack, "judge_unable", lastFailure);
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
  const baseName = `${String(attack.round)}-${attack.id}`;
  const created: string[] = [];
  try {
    let baseline: string | undefined;
    try {
      baseline = await prepare(
        options.worktrees,
        `${baseName}-base`,
        undefined,
        attack.patchPath,
      );
      created.push(baseline);
    } catch {
      // Target-relative overlays need only apply after the corresponding
      // implementation patch. Baseline execution is diagnostic when possible.
    }
    if (baseline) {
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
        return judgeFallback(
          options,
          attack,
          "Baseline execution infrastructure failed after the targeted retry",
          baseline,
        );
      }
      if (!baselineResult.stable) {
        return withOutcome(
          attack,
          "invalid",
          "Focused attack is flaky on the base commit",
        );
      }
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
      return judgeFallback(
        options,
        attack,
        "Comparative execution had an infrastructure failure after the targeted retry",
        target,
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
      runSpec: options.runSpec,
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
        severity: verdict.severity,
        evidenceProvenance: "mechanical",
        severityRationale: verdict.rationale,
      };
    }
    return {
      ...attack,
      status: "landed",
      rootDefectId: verdict.rootDefectId,
      severity: verdict.severity,
      damage: DAMAGE_BY_SEVERITY[verdict.severity],
      damageActive: true,
      evidenceProvenance: "mechanical",
      severityRationale: verdict.rationale,
      outcomeReason: `Stable author pass and target failure; ${verdict.rationale}`,
    };
  } catch (error) {
    return judgeFallback(
      options,
      attack,
      `Harness exception during attack validation after the targeted retry: ${error instanceof Error ? error.message : String(error)}`,
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
  const created: string[] = [];
  try {
    let baseline: string | undefined;
    try {
      baseline = await prepare(
        options.worktrees,
        `house-${String(attack.round)}-${attack.id}-base`,
        undefined,
        attack.patchPath,
      );
      created.push(baseline);
    } catch {
      // A target-relative overlay may edit a test that does not exist until the
      // target patch is applied. Continue with target validation in that case.
    }
    if (baseline) {
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
    }

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
      runSpec: options.runSpec,
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
        targets: affected,
        rootDefectId: verdict.rootDefectId,
        severity: verdict.severity,
        evidenceProvenance: "mechanical",
        severityRationale: verdict.rationale,
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
      evidenceProvenance: "mechanical",
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
