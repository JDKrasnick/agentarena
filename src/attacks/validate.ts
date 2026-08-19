import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  anonymizeAttackForVerifier,
  type AttackVerifier,
  type JudgeAdjudicationInput,
} from "../agents/adapter.js";
import {
  FailureRecordSchema,
  type FailureAttempt,
  type FailureRecord,
} from "../contracts/failure.js";
import { DAMAGE_BY_SEVERITY } from "../core/scoring.js";
import type {
  Attack,
  CheckResult,
  FightConfig,
  PermissionPolicy,
} from "../core/types.js";
import type { RunSpec } from "../contracts/round.js";
import type { BrowserValidationResult } from "../contracts/browser.js";
import { changedPathsFromPatch, isAllowedAttackPath } from "../repo/git.js";
import type { WorktreeManager } from "../repo/git.js";
import { runShellCommand } from "../runner/process-runner.js";
import { applyJudgeVerdict, suppressKnownJudgeDefect } from "./adjudicate.js";

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
  persistFailureRecord?: (record: FailureRecord) => Promise<void>;
  validateBrowser?: (
    worktree: string,
    probe: NonNullable<Attack["browserProbe"]>,
    subject: "author" | "target",
    nativeSuiteIdentityPaths: string[],
  ) => Promise<BrowserValidationResult>;
}

interface RepeatedCheck {
  checks: CheckResult[];
  stable: boolean;
  passed: boolean;
  infrastructure: boolean;
}

type AttackAssessment = Awaited<ReturnType<AttackVerifier["assess"]>>;

class AttackPatchApplicationError extends Error {}
class WorktreePreparationInfrastructureError extends Error {}

async function runTwice(
  id: string,
  kind: CheckResult["kind"],
  command: string,
  cwd: string,
  config: FightConfig,
  logRoot: string,
  signal: AbortSignal,
  failureOptions: Pick<
    ValidateAttackOptions,
    "attack" | "persistFailureRecord"
  >,
): Promise<RepeatedCheck> {
  const results = [];
  const samples = [];
  let infrastructure = false;
  for (const sample of [1, 2] as const) {
    let record: FailureRecord | undefined;
    for (const attempt of [1, 2] as const) {
      const startedAt = new Date().toISOString();
      const result = await runShellCommand(command, {
        cwd,
        timeoutMs: config.limits.attackMs,
        logPrefix: path.join(
          logRoot,
          `${id}-sample-${String(sample)}-attempt-${String(attempt)}`,
        ),
        signal,
        attempts: attempt,
      });
      const diagnosticArtifactRefs = [result.stdoutPath, result.stderrPath];
      results.push(result);
      if (result.failureClass !== "arena_infrastructure") {
        samples.push(result);
        if (record) {
          record = FailureRecordSchema.parse({
            ...record,
            attempts: [
              ...record.attempts,
              {
                attempt: 2,
                startedAt,
                finishedAt: new Date().toISOString(),
                status: "succeeded",
                diagnosticArtifactRefs,
              },
            ],
            diagnosticArtifactRefs: [
              ...new Set([
                ...record.diagnosticArtifactRefs,
                ...diagnosticArtifactRefs,
              ]),
            ],
            terminalDisposition: "recovered",
          });
          await failureOptions.persistFailureRecord?.(record);
        }
        break;
      }
      const causalDigest = createHash("sha256")
        .update(
          JSON.stringify({
            attackId: failureOptions.attack.id,
            evidencePath: id,
            sample,
          }),
        )
        .digest("hex");
      record = FailureRecordSchema.parse({
        version: 1,
        failureId: `failure-evidence-${causalDigest.slice(0, 24)}`,
        stage: "evidence_execution",
        subject: `${id}:sample-${String(sample)}`,
        attackId: failureOptions.attack.id,
        category:
          record?.category ??
          (result.timedOut ? "timeout" : "command_execution"),
        causalDigest,
        attempts: [
          ...(record?.attempts ?? []),
          {
            attempt,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "failed",
            diagnosticArtifactRefs,
          },
        ],
        reusedArtifactRefs: [failureOptions.attack.patchPath],
        diagnosticArtifactRefs: [
          ...new Set([
            ...(record?.diagnosticArtifactRefs ?? []),
            ...diagnosticArtifactRefs,
          ]),
        ],
        ...(attempt === 2 ? { terminalDisposition: "coverage_lost" } : {}),
      });
      await failureOptions.persistFailureRecord?.(record);
      if (attempt === 2) infrastructure = true;
    }
    if (infrastructure) break;
  }
  const exits = samples.map(
    (result) => `${String(result.exitCode)}:${String(result.timedOut)}`,
  );
  const stable = samples.length === 2 && exits[0] === exits[1];
  const passed =
    stable &&
    !infrastructure &&
    samples.every((result) => result.exitCode === 0);
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
  failureOptions: Pick<
    ValidateAttackOptions,
    "attack" | "persistFailureRecord"
  >,
  expectedAttackPatchFailure = false,
): Promise<string> {
  const causalDigest = createHash("sha256")
    .update(JSON.stringify({ attackId: failureOptions.attack.id, name }))
    .digest("hex");
  let record: FailureRecord | undefined;
  let lastError: unknown;
  let attackPatchFailed = false;
  for (const attempt of [1, 2] as const) {
    const startedAt = new Date().toISOString();
    let worktree: string | undefined;
    let operation: "create" | "implementation_patch" | "attack_patch" =
      "create";
    try {
      worktree = await worktrees.create(
        `${name}-prepare-attempt-${String(attempt)}`,
      );
      if (implementationPatch) {
        operation = "implementation_patch";
        await worktrees.applyPatch(worktree, implementationPatch);
      }
      operation = "attack_patch";
      await worktrees.applyPatch(worktree, attackPatch);
      if (record) {
        record = FailureRecordSchema.parse({
          ...record,
          attempts: [
            ...record.attempts,
            {
              attempt: 2,
              startedAt,
              finishedAt: new Date().toISOString(),
              status: "succeeded",
              diagnosticArtifactRefs: [
                ...(implementationPatch ? [implementationPatch] : []),
                attackPatch,
              ],
            },
          ],
          terminalDisposition: "recovered",
        });
        await failureOptions.persistFailureRecord?.(record);
      }
      return worktree;
    } catch (error) {
      lastError = error;
      attackPatchFailed = operation === "attack_patch";
      if (worktree) await worktrees.remove(worktree).catch(() => undefined);
      if (!(expectedAttackPatchFailure && attackPatchFailed)) {
        const diagnosticArtifactRefs = [
          ...(implementationPatch ? [implementationPatch] : []),
          attackPatch,
        ];
        record = FailureRecordSchema.parse({
          version: 1,
          failureId: `failure-prepare-${causalDigest.slice(0, 24)}`,
          stage: "git",
          subject: `prepare:${name}`,
          attackId: failureOptions.attack.id,
          category: "git_operation",
          causalDigest,
          attempts: [
            ...(record?.attempts ?? []),
            {
              attempt,
              startedAt,
              finishedAt: new Date().toISOString(),
              status: "failed",
              diagnosticArtifactRefs,
            },
          ],
          reusedArtifactRefs: [
            ...(implementationPatch ? [implementationPatch] : []),
            attackPatch,
          ],
          diagnosticArtifactRefs,
          ...(attempt === 2 && !attackPatchFailed
            ? { terminalDisposition: "coverage_lost" }
            : {}),
        });
        await failureOptions.persistFailureRecord?.(record);
      }
    }
  }
  if (attackPatchFailed)
    throw new AttackPatchApplicationError(
      `Attack patch did not apply after the targeted retry: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  throw new WorktreePreparationInfrastructureError(
    `Worktree preparation infrastructure failed after the targeted retry: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function withOutcome(
  attack: Attack,
  status: Attack["status"],
  reason: string,
): Attack {
  return { ...attack, status, outcomeReason: reason };
}

async function judgeFallback(
  options: Omit<ValidateAttackOptions, "authorPatch" | "targetPatch">,
  attack: Attack,
  reason: string,
  targetPatchPath: string | undefined,
  worktree?: string,
): Promise<Attack> {
  if (
    !attack.claim.trim() ||
    !attack.targets.length ||
    !attack.patchPath.trim() ||
    !targetPatchPath?.trim() ||
    !attack.oracle.rationale.trim()
  ) {
    return withOutcome(
      attack,
      "judge_unable",
      "Judge fallback requires a schema-valid immutable attack with a claim, oracle, target, and concrete patch evidence",
    );
  }
  if (!options.verifier.adjudicate)
    return withOutcome(attack, "judge_unable", reason);
  let fallbackWorktree = worktree;
  const ownsWorktree = worktree === undefined;
  if (!fallbackWorktree) {
    const subject = `judge-worktree:${attack.id}`;
    const causalDigest = createHash("sha256").update(subject).digest("hex");
    let preparationRecord: FailureRecord | undefined;
    let lastError: unknown;
    for (const attempt of [1, 2] as const) {
      const startedAt = new Date().toISOString();
      try {
        fallbackWorktree = await options.worktrees.create(
          `${String(attack.round)}-${attack.id}-judge-fallback-attempt-${String(attempt)}`,
        );
        if (preparationRecord) {
          preparationRecord = FailureRecordSchema.parse({
            ...preparationRecord,
            attempts: [
              ...preparationRecord.attempts,
              {
                attempt: 2,
                startedAt,
                finishedAt: new Date().toISOString(),
                status: "succeeded",
                diagnosticArtifactRefs: [],
              },
            ],
            terminalDisposition: "recovered",
          });
          await options.persistFailureRecord?.(preparationRecord);
        }
        break;
      } catch (error) {
        lastError = error;
        preparationRecord = FailureRecordSchema.parse({
          version: 1,
          failureId: `failure-judge-worktree-${causalDigest.slice(0, 24)}`,
          stage: "git",
          subject,
          attackId: attack.id,
          category: "git_operation",
          causalDigest,
          attempts: [
            ...(preparationRecord?.attempts ?? []),
            {
              attempt,
              startedAt,
              finishedAt: new Date().toISOString(),
              status: "failed",
              diagnosticArtifactRefs: [],
            },
          ],
          reusedArtifactRefs: [attack.patchPath],
          diagnosticArtifactRefs: [],
          ...(attempt === 2 ? { terminalDisposition: "judge_unable" } : {}),
        });
        await options.persistFailureRecord?.(preparationRecord);
      }
    }
    if (!fallbackWorktree) {
      return withOutcome(
        attack,
        "judge_unable",
        `Judge fallback worktree failed after the targeted retry: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
    }
  }
  try {
    const promptPath = path.join(options.logRoot, "judge-fallback.prompt.md");
    const transcriptPrefix = path.join(options.logRoot, "judge-fallback");
    const causalDigest = createHash("sha256")
      .update(JSON.stringify({ attackId: attack.id, reason }))
      .digest("hex");
    const failureId = `failure-judge-${causalDigest.slice(0, 24)}`;
    let record: FailureRecord | undefined;
    let lastFailure = reason;
    let retryReason: string | undefined;
    const mechanicalDiagnosticArtifactRefs = attack.checks.flatMap((check) =>
      check.command ? [check.command.stdoutPath, check.command.stderrPath] : [],
    );
    for (const attempt of [1, 2] as const) {
      const startedAt = new Date().toISOString();
      const attemptTranscriptPrefix = `${transcriptPrefix}-attempt-${String(attempt)}`;
      const diagnosticArtifactRefs = [promptPath, attemptTranscriptPrefix];
      let status: FailureAttempt["status"] = "failed";
      try {
        const verdict = await options.verifier.adjudicate({
          attack: anonymizeAttackForVerifier(attack),
          runSpec: options.runSpec,
          mechanicalFailureReason: reason,
          targetPatchPath,
          mechanicalDiagnosticArtifactRefs,
          priorCanonicalDefects: options.priorCanonicalDefects ?? [],
          worktree: fallbackWorktree,
          promptPath,
          transcriptPrefix: attemptTranscriptPrefix,
          timeoutMs: options.config.limits.verifierMs,
          signal: options.signal,
          ...(retryReason ? { retryReason } : {}),
        });
        const adjudicated = suppressKnownJudgeDefect(
          applyJudgeVerdict(attack, verdict),
          options.knownRootDefects,
        );
        if (adjudicated.status !== "judge_unable") {
          status = "succeeded";
          if (record) {
            record = FailureRecordSchema.parse({
              ...record,
              attempts: [
                ...record.attempts,
                {
                  attempt,
                  startedAt,
                  finishedAt: new Date().toISOString(),
                  status,
                  diagnosticArtifactRefs,
                },
              ],
              diagnosticArtifactRefs: [
                ...new Set([
                  ...record.diagnosticArtifactRefs,
                  ...diagnosticArtifactRefs,
                ]),
              ],
              terminalDisposition: "recovered",
            });
            await options.persistFailureRecord?.(record);
          }
          return adjudicated;
        }
        lastFailure = adjudicated.outcomeReason ?? reason;
        retryReason = lastFailure;
      } catch (error) {
        lastFailure = `Judge fallback failed: ${error instanceof Error ? error.message : String(error)}`;
        retryReason = lastFailure;
      }
      const failureAttempt: FailureAttempt = {
        attempt,
        startedAt,
        finishedAt: new Date().toISOString(),
        status,
        diagnosticArtifactRefs,
      };
      record = FailureRecordSchema.parse({
        version: 1,
        failureId,
        stage: "model_invocation",
        subject: `judge-fallback:${attack.id}`,
        attackId: attack.id,
        category: "transport",
        causalDigest,
        attempts: [...(record?.attempts ?? []), failureAttempt],
        reusedArtifactRefs: [attack.patchPath],
        diagnosticArtifactRefs: [
          ...new Set([
            ...(record?.diagnosticArtifactRefs ?? []),
            ...diagnosticArtifactRefs,
          ]),
        ],
        ...(attempt === 2 ? { terminalDisposition: "judge_unable" } : {}),
      });
      await options.persistFailureRecord?.(record);
      if (attempt === 2) {
        return withOutcome(attack, "judge_unable", lastFailure);
      }
    }
    throw new Error("Unreachable judge fallback retry state");
  } finally {
    if (ownsWorktree) await options.worktrees.remove(fallbackWorktree);
  }
}

async function assessWithRetry(
  options: Omit<ValidateAttackOptions, "authorPatch" | "targetPatch">,
  attack: Attack,
  worktree: string,
): Promise<AttackAssessment> {
  const promptPath = path.join(options.logRoot, "verifier.prompt.md");
  const causalDigest = createHash("sha256")
    .update(JSON.stringify({ attackId: attack.id, stage: "verifier-assess" }))
    .digest("hex");
  let record: FailureRecord | undefined;
  let lastError: unknown;
  let retryReason: string | undefined;
  for (const attempt of [1, 2] as const) {
    const startedAt = new Date().toISOString();
    const transcriptPrefix = path.join(
      options.logRoot,
      `verifier-attempt-${String(attempt)}`,
    );
    const diagnosticArtifactRefs = [promptPath, transcriptPrefix];
    try {
      const verdict = await options.verifier.assess({
        attack: anonymizeAttackForVerifier(attack),
        runSpec: options.runSpec,
        authorPassed: true,
        targetFailed: true,
        worktree,
        promptPath,
        transcriptPrefix,
        timeoutMs: options.config.limits.verifierMs,
        signal: options.signal,
        ...(retryReason ? { retryReason } : {}),
      });
      if (record) {
        record = FailureRecordSchema.parse({
          ...record,
          attempts: [
            ...record.attempts,
            {
              attempt: 2,
              startedAt,
              finishedAt: new Date().toISOString(),
              status: "succeeded",
              diagnosticArtifactRefs,
            },
          ],
          diagnosticArtifactRefs: [
            ...new Set([
              ...record.diagnosticArtifactRefs,
              ...diagnosticArtifactRefs,
            ]),
          ],
          terminalDisposition: "recovered",
        });
        await options.persistFailureRecord?.(record);
      }
      return verdict;
    } catch (error) {
      lastError = error;
      retryReason = error instanceof Error ? error.message : String(error);
      record = FailureRecordSchema.parse({
        version: 1,
        failureId: `failure-assess-${causalDigest.slice(0, 24)}`,
        stage: "model_invocation",
        subject: `verifier-assess:${attack.id}`,
        attackId: attack.id,
        category: "transport",
        causalDigest,
        attempts: [
          ...(record?.attempts ?? []),
          {
            attempt,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "failed",
            diagnosticArtifactRefs,
          },
        ],
        reusedArtifactRefs: [attack.patchPath],
        diagnosticArtifactRefs: [
          ...new Set([
            ...(record?.diagnosticArtifactRefs ?? []),
            ...diagnosticArtifactRefs,
          ]),
        ],
        ...(attempt === 2 ? { terminalDisposition: "coverage_lost" } : {}),
      });
      await options.persistFailureRecord?.(record);
    }
  }
  throw new Error(
    `Verifier assessment failed after the targeted retry: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
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
        options,
        true,
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
        options,
      );
      attack.checks.push(...baselineResult.checks);
      if (baselineResult.infrastructure) {
        return judgeFallback(
          options,
          attack,
          "Baseline execution infrastructure failed after the targeted retry",
          options.targetPatch,
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
        options,
      );
      created.push(author);
      target = await prepare(
        options.worktrees,
        `${baseName}-target`,
        options.targetPatch,
        attack.patchPath,
        options,
      );
      created.push(target);
    } catch (error) {
      if (error instanceof WorktreePreparationInfrastructureError) {
        return judgeFallback(
          options,
          attack,
          error.message,
          options.targetPatch,
          created.at(-1),
        );
      }
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
            options,
          );
          const full = await runTwice(
            "author-required",
            "required",
            options.config.testCommand,
            author,
            options.config,
            options.logRoot,
            options.signal,
            options,
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
            options,
          );
          const full = await runTwice(
            "target-required",
            "required",
            options.config.testCommand,
            target,
            options.config,
            options.logRoot,
            options.signal,
            options,
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
        options.targetPatch,
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
    if (attack.browserProbe) {
      if (!options.validateBrowser)
        return withOutcome(
          attack,
          "capability_denied",
          "Browser validation was requested but no harness adapter is available",
        );
      // Profiles commonly bind one exact approved loopback port. Run the
      // symmetric lanes sequentially so their isolated server processes never
      // contend for that port.
      const authorBrowser = await options.validateBrowser(
        author,
        attack.browserProbe,
        "author",
        [
          options.authorPatch,
          ...(attack.evidenceKind === "browser_probe"
            ? []
            : [attack.patchPath]),
        ],
      );
      const targetBrowser = await options.validateBrowser(
        target,
        attack.browserProbe,
        "target",
        [
          options.targetPatch,
          ...(attack.evidenceKind === "browser_probe"
            ? []
            : [attack.patchPath]),
        ],
      );
      if (
        authorBrowser.reason === "timed_out" ||
        targetBrowser.reason === "timed_out"
      )
        return withOutcome(
          attack,
          "invalid",
          "Browser attack exceeded its configured stage budget",
        );
      const authorProbe = authorBrowser.probes.find(
        (probe) => probe.probeId === attack.browserProbe?.id,
      );
      const targetProbe = targetBrowser.probes.find(
        (probe) => probe.probeId === attack.browserProbe?.id,
      );
      attack.checks.push(
        {
          id: "author-browser-probe",
          kind: "browser",
          status:
            authorProbe?.status === "verified"
              ? "passed"
              : authorProbe?.status === "failed"
                ? "failed"
                : "infrastructure_error",
          ...(authorProbe?.reason ? { reason: authorProbe.reason } : {}),
        },
        {
          id: "target-browser-probe",
          kind: "browser",
          status:
            targetProbe?.status === "verified"
              ? "passed"
              : targetProbe?.status === "failed"
                ? "failed"
                : "infrastructure_error",
          ...(targetProbe?.reason ? { reason: targetProbe.reason } : {}),
        },
      );
      if (
        !authorProbe ||
        !targetProbe ||
        authorProbe.status === "unverified" ||
        targetProbe.status === "unverified"
      )
        return judgeFallback(
          options,
          attack,
          "Comparative browser execution was unverified",
          options.targetPatch,
          target,
        );
      if (authorProbe.status === "failed")
        return withOutcome(
          attack,
          "self_defeating",
          "Agent-chosen browser probe fails on its author's patch",
        );
      if (targetProbe.status === "verified")
        return withOutcome(
          attack,
          "blocked",
          "Target patch passes the agent-chosen browser probe",
        );
    }
    if (targetFocused.passed && attack.evidenceKind !== "browser_probe") {
      return withOutcome(
        attack,
        "blocked",
        "Target patch passes the focused attack",
      );
    }

    const verdict = await assessWithRetry(options, attack, target);
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
      options.targetPatch,
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
  const judgeTargetPatch = attack.targets
    .map((target) => options.targetPatches[target])
    .find((candidate): candidate is string => Boolean(candidate));
  try {
    let baseline: string | undefined;
    try {
      baseline = await prepare(
        options.worktrees,
        `house-${String(attack.round)}-${attack.id}-base`,
        undefined,
        attack.patchPath,
        options,
        true,
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
        options,
      );
      attack.checks.push(...baselineResult.checks);
      if (baselineResult.infrastructure) {
        return judgeFallback(
          options,
          attack,
          "House baseline infrastructure failed",
          judgeTargetPatch,
          baseline,
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
      let targetTree: string;
      try {
        targetTree = await prepare(
          options.worktrees,
          `house-${String(attack.round)}-${attack.id}-${target}`,
          implementationPatch,
          attack.patchPath,
          options,
        );
      } catch (error) {
        if (error instanceof AttackPatchApplicationError) {
          return withOutcome(attack, "invalid", error.message);
        }
        throw error;
      }
      created.push(targetTree);
      const focused = await runTwice(
        `house-${target}-focused`,
        "focused",
        attack.focusedCommand,
        targetTree,
        options.config,
        options.logRoot,
        options.signal,
        options,
      );
      const full = await runTwice(
        `house-${target}-required`,
        "required",
        options.config.testCommand,
        targetTree,
        options.config,
        options.logRoot,
        options.signal,
        options,
      );
      attack.checks.push(...focused.checks, ...full.checks);
      if (focused.infrastructure || full.infrastructure) {
        return judgeFallback(
          options,
          attack,
          "House comparison infrastructure failed",
          implementationPatch,
          targetTree,
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
    const verdict = await assessWithRetry(options, attack, verifierTree);
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
    return judgeFallback(
      options,
      attack,
      `House validation failed: ${error instanceof Error ? error.message : String(error)}`,
      judgeTargetPatch,
    );
  } finally {
    for (const worktree of created) await options.worktrees.remove(worktree);
  }
}
