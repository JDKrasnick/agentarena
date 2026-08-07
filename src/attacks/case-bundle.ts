import path from "node:path";
import {
  anonymizeAttackForVerifier,
  type AttackVerifier,
} from "../agents/adapter.js";
import { sha256, stableId } from "../core/ids.js";
import type {
  Attack,
  CheckResult,
  ContestantId,
  FightConfig,
} from "../core/types.js";
import type { RunSpec } from "../contracts/round.js";
import type { WorktreeManager } from "../repo/git.js";
import { runShellCommand } from "../runner/process-runner.js";

export interface SiblingCaseCandidate {
  category: string;
  focusedCommand: string;
  patchPath: string;
}

interface ValidateSiblingOptions {
  attack: Attack;
  candidate: SiblingCaseCandidate;
  authorPatch?: string;
  targetPatches: Partial<Record<ContestantId, string>>;
  config: FightConfig;
  runSpec: RunSpec;
  worktrees: WorktreeManager;
  verifier: AttackVerifier;
  logRoot: string;
  signal: AbortSignal;
}

async function repeated(
  id: string,
  command: string,
  cwd: string,
  options: ValidateSiblingOptions,
): Promise<{
  passed: boolean;
  stable: boolean;
  infrastructure: boolean;
  checks: CheckResult[];
}> {
  const results = [];
  for (const attempt of [1, 2]) {
    results.push(
      await runShellCommand(command, {
        cwd,
        timeoutMs: options.config.limits.attackMs,
        logPrefix: path.join(options.logRoot, `${id}-${String(attempt)}`),
        signal: options.signal,
      }),
    );
  }
  const stable = results[0]?.exitCode === results[1]?.exitCode;
  const infrastructure = results.some(
    (result) => result.failureClass === "arena_infrastructure",
  );
  return {
    passed:
      stable &&
      !infrastructure &&
      results.every((result) => result.exitCode === 0),
    stable,
    infrastructure,
    checks: results.map((command, index) => ({
      id: `${id}-${String(index + 1)}`,
      kind: "held_out",
      status:
        command.failureClass === "arena_infrastructure"
          ? "infrastructure_error"
          : command.exitCode === 0
            ? "passed"
            : "failed",
      command,
    })),
  };
}

export async function validateSiblingCase(
  options: ValidateSiblingOptions,
): Promise<{ accepted: boolean; checks: CheckResult[]; reason: string }> {
  const created: string[] = [];
  try {
    if (options.authorPatch) {
      const author = await options.worktrees.create(
        `case-${options.attack.id}-${stableId("author", options.candidate.patchPath)}`,
      );
      created.push(author);
      await options.worktrees.applyPatch(author, options.authorPatch);
      await options.worktrees.applyPatch(author, options.candidate.patchPath);
      const result = await repeated(
        "author",
        options.candidate.focusedCommand,
        author,
        options,
      );
      if (result.infrastructure)
        return {
          accepted: false,
          checks: result.checks,
          reason: "infrastructure",
        };
      if (!result.stable || !result.passed) {
        return {
          accepted: false,
          checks: result.checks,
          reason: "Sibling does not pass on author",
        };
      }
    }

    const allChecks: CheckResult[] = [];
    let verifierTree: string | undefined;
    for (const target of options.attack.targets) {
      const patch = options.targetPatches[target];
      if (!patch) continue;
      const tree = await options.worktrees.create(
        `case-${options.attack.id}-${target}-${sha256(options.candidate.patchPath).slice(0, 6)}`,
      );
      created.push(tree);
      await options.worktrees.applyPatch(tree, patch);
      await options.worktrees.applyPatch(tree, options.candidate.patchPath);
      const result = await repeated(
        target,
        options.candidate.focusedCommand,
        tree,
        options,
      );
      allChecks.push(...result.checks);
      if (result.infrastructure)
        return { accepted: false, checks: allChecks, reason: "infrastructure" };
      if (!result.stable || result.passed) {
        return {
          accepted: false,
          checks: allChecks,
          reason: `Sibling does not reproduce the target defect on ${target}`,
        };
      }
      verifierTree ??= tree;
    }
    if (!verifierTree || !options.attack.rootDefectId) {
      return {
        accepted: false,
        checks: allChecks,
        reason: "Missing target or canonical root defect",
      };
    }
    const siblingAttack: Attack = {
      ...options.attack,
      id: stableId(
        "case-verification",
        options.attack.id,
        options.candidate.patchPath,
      ),
      patchPath: options.candidate.patchPath,
      focusedCommand: options.candidate.focusedCommand,
      checks: [],
    };
    const verdict = await options.verifier.assess({
      attack: anonymizeAttackForVerifier(siblingAttack),
      runSpec: options.runSpec,
      authorPassed: true,
      targetFailed: true,
      worktree: verifierTree,
      promptPath: path.join(options.logRoot, "verifier.prompt.md"),
      transcriptPrefix: path.join(options.logRoot, "verifier"),
      timeoutMs: options.config.limits.verifierMs,
      signal: options.signal,
    });
    if (
      !verdict.relevant ||
      !verdict.oracleSupported ||
      verdict.rootDefectId !== options.attack.rootDefectId
    ) {
      return {
        accepted: false,
        checks: allChecks,
        reason: "Verifier did not confirm the same oracle and root defect",
      };
    }
    return {
      accepted: true,
      checks: allChecks,
      reason: "Accepted same-defect sibling",
    };
  } catch (error) {
    return {
      accepted: false,
      checks: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    for (const tree of created) await options.worktrees.remove(tree);
  }
}
