import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import {
  AgentInvocationSchema,
  AttackSubmissionV2Schema,
  InfrastructureReviewSubmissionSchema,
  ReviewSubmissionSchema,
  SeveritySchema,
  StageSubmissionSchema,
  type AgentId,
  type AgentInvocation,
  type Attack,
  type ContestantId,
  type AttackSubmission,
  type CaseSubmission,
  type HouseSubmission,
  type InfrastructureReviewSubmission,
  type PermissionPolicy,
  type ReviewSubmission,
  type Severity,
} from "../core/types.js";
import { calculateCanonicalHash, type RunSpec } from "../contracts/round.js";
import { sha256 } from "../core/ids.js";
import { buildJudgePacket } from "../judge/packets.js";
import { runProcess, type ProcessRequest } from "../runner/process-runner.js";
import { z } from "zod";

export interface Availability {
  available: boolean;
  version?: string;
  reason?: string;
}

interface InvocationInput {
  worktree: string;
  contestantId?: ContestantId;
  prompt: string;
  promptPath: string;
  transcriptPrefix: string;
  timeoutMs: number;
  signal: AbortSignal;
  round?: 1 | 2 | 3 | "recovery" | "reconciliation";
}

export type ImplementInput = InvocationInput;

export interface ReviewInput extends InvocationInput {
  opponent: ContestantId;
}

export interface AttackInput extends InvocationInput {
  opponent: ContestantId;
}

export interface RepairInput extends InvocationInput {
  activeAttacks: Attack[];
}

export interface AgentAdapter {
  readonly id: AgentId;
  checkAvailability(): Promise<Availability>;
  implement(input: ImplementInput): Promise<AgentInvocation>;
  review(input: ReviewInput): Promise<AgentInvocation>;
  attack(input: AttackInput): Promise<AgentInvocation>;
  repair(input: RepairInput): Promise<AgentInvocation>;
}

export interface AttackVerdict {
  relevant: boolean;
  oracleSupported: boolean;
  oracleRationale: string;
  rootDefectId: string;
  severity: Severity;
  rationale: string;
}

export type AnonymizedAttack = Pick<
  Attack,
  | "claim"
  | "impact"
  | "oracle"
  | "assertionFingerprint"
  | "patchPath"
  | "proposedSeverity"
>;

export function anonymizeAttackForVerifier(attack: Attack): AnonymizedAttack {
  return {
    claim: attack.claim,
    impact: attack.impact,
    oracle: attack.oracle,
    assertionFingerprint: attack.assertionFingerprint,
    patchPath: attack.patchPath,
    ...(attack.proposedSeverity
      ? { proposedSeverity: attack.proposedSeverity }
      : {}),
  };
}

export interface AnonymizedAttackInput {
  attack: AnonymizedAttack;
  runSpec: RunSpec;
  authorPassed: boolean;
  targetFailed: boolean;
  worktree: string;
  promptPath: string;
  transcriptPrefix: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface AttackVerifier {
  readonly id: AgentId;
  assess(input: AnonymizedAttackInput): Promise<AttackVerdict>;
  /** Optional semantic fallback used only after the approved mechanical path fails. */
  adjudicate?(input: JudgeAdjudicationInput): Promise<JudgeAttackVerdict>;
  /** Optional repair fallback used only after mechanical repair checks remain unavailable. */
  assessRepair?(input: JudgeRepairInput): Promise<JudgeRepairVerdict>;
}

export interface JudgeAdjudicationInput extends Omit<
  AnonymizedAttackInput,
  "authorPassed" | "targetFailed"
> {
  mechanicalFailureReason: string;
  priorCanonicalDefects: ReadonlyArray<{
    canonicalDefectId: string;
    severity: Severity;
    multiplier: 0.35 | 1;
    effectiveDamage: number;
    status: "active" | "healed";
    evidenceBasis:
      "mechanical" | "judge" | "partial_judge" | "none" | "legacy_unknown";
  }>;
}

export interface JudgeAttackVerdict {
  decision: "confirmed" | "supported_untestable" | "rejected" | "unable";
  relevant: boolean;
  expectedBehaviorClearlySupported: boolean;
  evidencePointsToDefect: boolean;
  rootDefectId?: string;
  severity?: Severity;
  rationale: string;
}

export interface JudgeRepairInput {
  attack: AnonymizedAttack;
  runSpec: RunSpec;
  canonicalDefectId: string;
  adjudicationId: string;
  candidatePatchPath: string;
  mechanicalFailureReason: string;
  worktree: string;
  promptPath: string;
  transcriptPrefix: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface JudgeRepairVerdict {
  decision: "repaired" | "not_repaired" | "unable";
  rationale: string;
  packetDigest: string;
}

export interface HarnessOverlayProposal {
  explanation: string;
  scopes: string[];
  permissionChanges: string[];
}

export interface AnonymizedInfrastructurePacket {
  failureId: string;
  redactedEvidence: string;
  policy: PermissionPolicy;
  worktree: string;
  prompt: string;
  timeoutMs: number;
  transcriptPrefix: string;
  round: 1 | 2 | 3;
}

export interface HarnessMaintainer {
  readonly id: AgentId;
  proposeOverlay(
    packet: AnonymizedInfrastructurePacket,
    signal: AbortSignal,
  ): Promise<HarnessOverlayProposal>;
}

export interface StructuredGeneratorInput {
  worktree: string;
  prompt: string;
  timeoutMs: number;
  transcriptPrefix: string;
  signal: AbortSignal;
  round: 1 | 2 | 3;
}

export interface RawStructuredSubmission {
  rawSource: string;
}

export interface HouseScout {
  readonly id: AgentId;
  scout(
    input: StructuredGeneratorInput,
  ): Promise<HouseSubmission | RawStructuredSubmission>;
}

export interface CaseBuilder {
  readonly id: AgentId;
  build(
    input: StructuredGeneratorInput,
  ): Promise<CaseSubmission | RawStructuredSubmission>;
}

export interface InfrastructureReviewInput extends StructuredGeneratorInput {
  agent: AgentId;
  attack: Attack;
  redactedEvidence: string;
}

export interface InfrastructureReviewer {
  review(
    input: InfrastructureReviewInput,
  ): Promise<InfrastructureReviewSubmission>;
}

export async function readAttackSubmission(
  worktree: string,
): Promise<AttackSubmission> {
  const submissionPath = path.join(worktree, ".agent-arena-submission.json");
  return parseModelSubmission(
    AttackSubmissionV2Schema,
    await readFile(submissionPath, "utf8"),
  );
}

export async function readReviewSubmission(
  worktree: string,
): Promise<ReviewSubmission> {
  const submissionPath = path.join(worktree, ".agent-arena-submission.json");
  return parseModelSubmission(
    ReviewSubmissionSchema,
    await readFile(submissionPath, "utf8"),
  );
}

export async function readStageSubmission(
  worktree: string,
): Promise<{ explanation: string }> {
  const submissionPath = path.join(worktree, ".agent-arena-submission.json");
  try {
    return parseModelSubmission(
      StageSubmissionSchema,
      await readFile(submissionPath, "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { explanation: "" };
    throw error;
  }
}

/**
 * Model output is usually a JSON file, but it may contain a fenced object or
 * harmless presentation differences such as `"Medium"`.  Recover those
 * unambiguous cases before treating a submission as malformed.  We do not
 * invent missing facts: anything that still fails the authoritative schema is
 * rejected (and structured callers can request a repair from the model).
 */
export function parseModelSubmission<T>(
  schema: z.ZodType<T>,
  source: string,
): T {
  return schema.parse(normalizeModelJson(extractJson(source)));
}

function extractJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
    if (fenced) return JSON.parse(fenced);
    const start = source.search(/[[{]/);
    const end = Math.max(source.lastIndexOf("}"), source.lastIndexOf("]"));
    if (start >= 0 && end > start)
      return JSON.parse(source.slice(start, end + 1));
    throw new Error("Submission did not contain a JSON object or array");
  }
}

function normalizeModelJson(value: unknown, key?: string): unknown {
  if (Array.isArray(value))
    return value.map((entry) => normalizeModelJson(entry));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        normalizeModelJson(entryValue, entryKey),
      ]),
    );
  if (typeof value !== "string") return value;

  const normalized = value.trim();
  if (key === "severity") {
    const severity = normalized.toLowerCase();
    if (["critical", "high", "medium", "low"].includes(severity))
      return severity;
  }
  if (["relevant", "oracleSupported"].includes(key ?? "")) {
    if (["true", "yes"].includes(normalized.toLowerCase())) return true;
    if (["false", "no"].includes(normalized.toLowerCase())) return false;
  }
  return value;
}

export async function removeSubmission(worktree: string): Promise<void> {
  await rm(path.join(worktree, ".agent-arena-submission.json"), {
    force: true,
  });
}

export interface CommandAdapterOptions {
  id: AgentId;
  executable: string;
  args: string[];
  model?: string;
  environment?: Record<string, string>;
}

export function providerCommand(
  id: AgentId,
  model?: string,
): Omit<CommandAdapterOptions, "id"> {
  // `gpt-5.6` is the default-family name, while ChatGPT-authenticated Codex
  // CLI expects the concrete flagship model identifier.
  const resolvedModel =
    id === "codex" && model === "gpt-5.6" ? "gpt-5.6-sol" : model;
  const modelArgs = resolvedModel ? ["--model", resolvedModel] : [];
  switch (id) {
    case "codex":
      return {
        executable: "codex",
        args: [
          "exec",
          ...modelArgs,
          "--full-auto",
          "--skip-git-repo-check",
          "-",
        ],
        ...(resolvedModel ? { model: resolvedModel } : {}),
      };
    case "claude":
      return {
        executable: "claude",
        args: [
          "--print",
          "--permission-mode",
          "bypassPermissions",
          "--output-format",
          "text",
          ...modelArgs,
        ],
        ...(resolvedModel ? { model: resolvedModel } : {}),
      };
    case "gemini":
      return {
        executable: "gemini",
        args: ["--yolo", ...modelArgs],
        ...(resolvedModel ? { model: resolvedModel } : {}),
      };
  }
}

export class CommandAgentAdapter implements AgentAdapter {
  readonly id: AgentId;

  constructor(private readonly options: CommandAdapterOptions) {
    this.id = options.id;
  }

  async checkAvailability(): Promise<Availability> {
    try {
      await access(this.options.executable, constants.X_OK);
    } catch {
      // A bare executable name is resolved through PATH by the invocation below.
    }
    const controller = new AbortController();
    const result = await runProcess({
      executable: this.options.executable,
      args: ["--version"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      logPrefix: path.join(
        process.cwd(),
        ".agent-arena",
        "availability",
        this.id,
      ),
      signal: controller.signal,
    });
    if (result.exitCode !== 0) {
      return {
        available: false,
        reason: `Executable ${this.options.executable} failed availability check`,
      };
    }
    return { available: true };
  }

  implement(input: ImplementInput): Promise<AgentInvocation> {
    return this.invoke("implement", input);
  }

  review(input: ReviewInput): Promise<AgentInvocation> {
    return this.invoke("review_attacks", input);
  }

  attack(input: AttackInput): Promise<AgentInvocation> {
    return this.invoke("collect_attacks", input);
  }

  repair(input: RepairInput): Promise<AgentInvocation> {
    return this.invoke("repair", input);
  }

  private async invoke(
    stage: "implement" | "review_attacks" | "collect_attacks" | "repair",
    input: InvocationInput,
  ): Promise<AgentInvocation> {
    const started = new Date();
    const request: ProcessRequest = {
      executable: this.options.executable,
      args: this.options.args,
      input: input.prompt,
      cwd: input.worktree,
      timeoutMs: input.timeoutMs,
      logPrefix: input.transcriptPrefix,
      env: {
        ...this.options.environment,
        AGENT_ARENA_AGENT: this.id,
        AGENT_ARENA_CONTESTANT: input.contestantId ?? "",
        AGENT_ARENA_STAGE: stage,
        AGENT_ARENA_ROUND: input.round === undefined ? "" : String(input.round),
        AGENT_ARENA_SUBMISSION: path.join(
          input.worktree,
          ".agent-arena-submission.json",
        ),
      },
      signal: input.signal,
    };
    const command = await runProcess(request);
    const finished = new Date();
    let explanation = "";
    try {
      explanation = (await readStageSubmission(input.worktree)).explanation;
    } catch {
      // Attack submissions have a different schema and explanation is optional metadata.
    }
    const submissionPath = path.join(
      input.worktree,
      ".agent-arena-submission.json",
    );
    return AgentInvocationSchema.parse({
      agent: this.id,
      ...(this.options.model ? { model: this.options.model } : {}),
      stage,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      status:
        command.failureClass === "arena_infrastructure"
          ? "infrastructure_error"
          : command.timedOut
            ? "timed_out"
            : command.exitCode === 0
              ? "succeeded"
              : "failed",
      command,
      promptPath: input.promptPath,
      transcriptPath: command.stdoutPath,
      submissionPath,
      explanation,
    });
  }
}

export function createProviderAdapter(
  id: AgentId,
  model?: string,
): CommandAgentAdapter {
  return new CommandAgentAdapter({ id, ...providerCommand(id, model) });
}

const AttackVerdictSchema = z.object({
  relevant: z.boolean(),
  oracleSupported: z.boolean(),
  oracleRationale: z.string(),
  rootDefectId: z.string().min(1),
  severity: SeveritySchema,
  rationale: z.string().min(1),
});

const JudgeAttackVerdictSchema = z.object({
  decision: z.enum(["confirmed", "supported_untestable", "rejected", "unable"]),
  relevant: z.boolean(),
  expectedBehaviorClearlySupported: z.boolean(),
  evidencePointsToDefect: z.boolean(),
  rootDefectId: z.string().min(1).optional(),
  severity: SeveritySchema.optional(),
  rationale: z.string().min(1),
});

async function stageJudgeSources(
  runSpec: RunSpec,
  worktree: string,
): Promise<
  Array<{
    artifactId: string;
    sha256: string;
    description: string;
    path: string;
  }>
> {
  const directory = path.join(worktree, ".agent-arena-judge-sources");
  await mkdir(directory, { recursive: true });
  return Promise.all(
    runSpec.task.sources.map(async (source, index) => {
      const bytes = await readFile(source.snapshotPath);
      if (sha256(bytes) !== source.contentHash)
        throw new Error(`Frozen judge source ${source.id} failed its digest`);
      const stagedPath = path.join(
        directory,
        `source-${String(index + 1)}.txt`,
      );
      await writeFile(stagedPath, bytes);
      return {
        artifactId: source.id,
        sha256: source.contentHash,
        description: `Frozen ${source.kind} source`,
        path: stagedPath,
      };
    }),
  );
}

export class CommandAttackVerifier implements AttackVerifier {
  private readonly command: Omit<CommandAdapterOptions, "id">;

  constructor(readonly id: AgentId) {
    this.command = providerCommand(id);
  }

  async assess(input: AnonymizedAttackInput): Promise<AttackVerdict> {
    const outputPath = path.join(input.worktree, ".agent-arena-verdict.json");
    const patchBytes = await readFile(input.attack.patchPath);
    const sourcePointers = await stageJudgeSources(
      input.runSpec,
      input.worktree,
    );
    const packet = buildJudgePacket({
      kind: "attack",
      task: {
        request: input.runSpec.task.task,
        acceptanceCriteria: [...input.runSpec.task.acceptanceCriteria],
      },
      claim: input.attack.claim,
      oracle: JSON.stringify(input.attack.oracle),
      diagnostics: `authorPassed=${String(input.authorPassed)} targetFailed=${String(input.targetFailed)} impact=${input.attack.impact} assertionFingerprint=${input.attack.assertionFingerprint}`,
      artifactPointers: [
        ...sourcePointers,
        {
          artifactId: "attack-overlay",
          sha256: sha256(patchBytes),
          description: "Executable attack overlay",
        },
      ],
    });
    const prompt = [
      "# Neutral Agent Arena attack adjudication",
      "You do not know either contestant's identity. Mechanical execution already established an author-side pass and target-side failure.",
      "Assess only oracle support, task relevance, canonical root-defect identity, and the lowest fully supported severity.",
      "Do not infer correctness from the test or the presence of a source ID. Read the frozen task and source text and confirm that it clearly supports the claimed expected behavior. Critical means security bypass/data loss/corruption/catastrophic failure; High means a core criterion, normal crash/hang, or major wrong result; Medium is a realistic edge or secondary requirement; Low is narrow robustness/performance impact. Ambiguous High/Critical must be capped at Medium.",
      "",
      "# Digest-linked identity-blind judge packet",
      JSON.stringify(packet, null, 2),
      "Read any packet artifact path only as immutable evidence. Do not edit it or execute commands.",
      "",
      `Write only valid JSON to ${outputPath} with keys relevant, oracleSupported, oracleRationale, rootDefectId, severity, and rationale.`,
    ].join("\n");
    await rm(outputPath, { force: true });
    let lastError: unknown;
    let attemptPrompt = prompt;
    for (const attempt of [1, 2]) {
      const result = await runProcess({
        executable: this.command.executable,
        args: this.command.args,
        input: attemptPrompt,
        cwd: input.worktree,
        timeoutMs: input.timeoutMs,
        logPrefix: `${input.transcriptPrefix}-attempt-${String(attempt)}`,
        signal: input.signal,
      });
      if (result.failureClass === "arena_infrastructure") {
        lastError = new Error("Verifier provider infrastructure failed");
        continue;
      }
      try {
        return parseModelSubmission(
          AttackVerdictSchema,
          await readFile(outputPath, "utf8"),
        );
      } catch (error) {
        lastError = error;
        // Only ask again after local recovery has exhausted unambiguous fixes.
        // This is intentionally short: it is a formatting repair, not a new
        // adjudication that could change the evidence or outcome.
        attemptPrompt = [
          prompt,
          "",
          "Your prior submission could not be validated.",
          `Validation problem: ${error instanceof Error ? error.message : String(error)}`,
          `Rewrite ${outputPath} now as one JSON object using the exact requested keys and severity values: critical, high, medium, or low.`,
        ].join("\n");
      }
    }
    throw new Error(
      `Verifier failed after two attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  async adjudicate(input: JudgeAdjudicationInput): Promise<JudgeAttackVerdict> {
    const outputPath = path.join(input.worktree, ".agent-arena-judgment.json");
    const sourcePointers = await stageJudgeSources(
      input.runSpec,
      input.worktree,
    );
    const packet = buildJudgePacket({
      kind: "attack",
      task: {
        request: input.runSpec.task.task,
        acceptanceCriteria: [...input.runSpec.task.acceptanceCriteria],
      },
      claim: input.attack.claim,
      oracle: JSON.stringify(input.attack.oracle),
      diagnostics: JSON.stringify({
        mechanicalFailureReason: input.mechanicalFailureReason,
        impact: input.attack.impact,
        assertionFingerprint: input.attack.assertionFingerprint,
        priorCanonicalDefects: input.priorCanonicalDefects,
      }),
      artifactPointers: sourcePointers,
    });
    const prompt = [
      "# Neutral Agent Arena semantic adjudication",
      "Contestant identities are unavailable. Do not execute commands or modify evidence.",
      "Use confirmed only for definitive semantic evidence, supported_untestable only when the task clearly supports the oracle and evidence points to the defect, rejected when unsupported, and unable when evidence is insufficient.",
      JSON.stringify(packet, null, 2),
      `Write only valid JSON to ${outputPath} with keys decision, relevant, expectedBehaviorClearlySupported, evidencePointsToDefect, optional rootDefectId, optional severity, and rationale.`,
    ].join("\n\n");
    await rm(outputPath, { force: true });
    let lastError: unknown;
    for (const attempt of [1, 2]) {
      const result = await runProcess({
        executable: this.command.executable,
        args: this.command.args,
        input: prompt,
        cwd: input.worktree,
        timeoutMs: input.timeoutMs,
        logPrefix: `${input.transcriptPrefix}-attempt-${String(attempt)}`,
        signal: input.signal,
      });
      if (result.failureClass === "arena_infrastructure") {
        lastError = new Error("Judge provider infrastructure failed");
        continue;
      }
      try {
        const verdict = parseModelSubmission(
          JudgeAttackVerdictSchema,
          await readFile(outputPath, "utf8"),
        );
        return {
          decision: verdict.decision,
          relevant: verdict.relevant,
          expectedBehaviorClearlySupported:
            verdict.expectedBehaviorClearlySupported,
          evidencePointsToDefect: verdict.evidencePointsToDefect,
          rationale: verdict.rationale,
          ...(verdict.rootDefectId
            ? { rootDefectId: verdict.rootDefectId }
            : {}),
          ...(verdict.severity ? { severity: verdict.severity } : {}),
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `Judge fallback failed after two attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  async assessRepair(input: JudgeRepairInput): Promise<JudgeRepairVerdict> {
    const outputPath = path.join(
      input.worktree,
      ".agent-arena-repair-judgment.json",
    );
    const candidatePatch = await readFile(input.candidatePatchPath, "utf8");
    const sourcePointers = await stageJudgeSources(
      input.runSpec,
      input.worktree,
    );
    const neutralCandidatePath = path.join(
      input.worktree,
      ".agent-arena-judge-candidate.diff",
    );
    await writeFile(neutralCandidatePath, candidatePatch, "utf8");
    const packet = buildJudgePacket({
      kind: "repair",
      task: {
        request: input.runSpec.task.task,
        acceptanceCriteria: [...input.runSpec.task.acceptanceCriteria],
      },
      claim: input.attack.claim,
      oracle: JSON.stringify(input.attack.oracle),
      immutableAttackDigest: calculateCanonicalHash(input.attack),
      diagnostics: JSON.stringify({
        canonicalDefectId: input.canonicalDefectId,
        adjudicationId: input.adjudicationId,
        mechanicalFailureReason: input.mechanicalFailureReason,
        candidatePatchDigest: sha256(candidatePatch),
        candidatePatch,
      }),
      artifactPointers: [
        ...sourcePointers,
        {
          artifactId: "candidate-patch",
          sha256: sha256(candidatePatch),
          description: "Identity-blind candidate repair patch",
          path: neutralCandidatePath,
        },
      ],
    });
    const prompt = [
      "# Neutral Agent Arena repair adjudication",
      "Contestant identities are unavailable. Do not execute commands or modify evidence.",
      "Decide repaired only when the candidate patch clearly fixes the immutable claim and oracle without changing their meaning. Decide not_repaired when it clearly does not. Decide unable when the bounded evidence is insufficient.",
      "Read any packet artifact path only as immutable task evidence.",
      JSON.stringify(packet, null, 2),
      `Write only valid JSON to ${outputPath} with keys decision (repaired, not_repaired, or unable) and rationale.`,
    ].join("\n\n");
    await rm(outputPath, { force: true });
    let lastError: unknown;
    const schema = z.object({
      decision: z.enum(["repaired", "not_repaired", "unable"]),
      rationale: z.string().min(1),
    });
    for (const attempt of [1, 2]) {
      const result = await runProcess({
        executable: this.command.executable,
        args: this.command.args,
        input: prompt,
        cwd: input.worktree,
        timeoutMs: input.timeoutMs,
        logPrefix: `${input.transcriptPrefix}-attempt-${String(attempt)}`,
        signal: input.signal,
      });
      if (result.failureClass === "arena_infrastructure") {
        lastError = new Error("Repair judge provider infrastructure failed");
        continue;
      }
      try {
        const verdict = parseModelSubmission(
          schema,
          await readFile(outputPath, "utf8"),
        );
        return { ...verdict, packetDigest: packet.packetDigest };
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `Repair judge failed after two attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
}

async function invokeStructuredGenerator(
  id: AgentId,
  stage:
    "house" | "case_builder" | "infrastructure_review" | "harness_maintainer",
  input: StructuredGeneratorInput,
  outputName: string,
  commandOverride?: Omit<CommandAdapterOptions, "id">,
): Promise<string> {
  const command = commandOverride ?? providerCommand(id);
  const outputPath = path.join(input.worktree, outputName);
  await rm(outputPath, { force: true });
  const result = await runProcess({
    executable: command.executable,
    args: command.args,
    input: input.prompt,
    cwd: input.worktree,
    timeoutMs: input.timeoutMs,
    logPrefix: input.transcriptPrefix,
    signal: input.signal,
    env: {
      AGENT_ARENA_AGENT: id,
      AGENT_ARENA_STAGE: stage,
      AGENT_ARENA_ROUND: String(input.round),
      AGENT_ARENA_SUBMISSION: outputPath,
    },
  });
  if (result.exitCode !== 0 || result.failureClass) {
    throw new Error(`${stage} invocation failed`);
  }
  return readFile(outputPath, "utf8");
}

export class CommandHouseScout implements HouseScout {
  constructor(
    readonly id: AgentId,
    private readonly commandOverride?: Omit<CommandAdapterOptions, "id">,
  ) {}

  async scout(
    input: StructuredGeneratorInput,
  ): Promise<RawStructuredSubmission> {
    const raw = await invokeStructuredGenerator(
      this.id,
      "house",
      input,
      ".agent-arena-house.json",
      this.commandOverride,
    );
    return { rawSource: raw };
  }
}

export class CommandCaseBuilder implements CaseBuilder {
  constructor(
    readonly id: AgentId,
    private readonly commandOverride?: Omit<CommandAdapterOptions, "id">,
  ) {}

  async build(
    input: StructuredGeneratorInput,
  ): Promise<RawStructuredSubmission> {
    const raw = await invokeStructuredGenerator(
      this.id,
      "case_builder",
      input,
      ".agent-arena-cases.json",
      this.commandOverride,
    );
    return { rawSource: raw };
  }
}

export class CommandInfrastructureReviewer implements InfrastructureReviewer {
  constructor(
    private readonly commandOverrides: Partial<
      Record<AgentId, Omit<CommandAdapterOptions, "id">>
    > = {},
  ) {}

  async review(
    input: InfrastructureReviewInput,
  ): Promise<InfrastructureReviewSubmission> {
    return InfrastructureReviewSubmissionSchema.parse(
      normalizeModelJson(
        extractJson(
          await invokeStructuredGenerator(
            input.agent,
            "infrastructure_review",
            input,
            ".agent-arena-infrastructure-review.json",
            this.commandOverrides[input.agent],
          ),
        ),
      ),
    );
  }
}

const HarnessOverlayProposalSchema = z.object({
  version: z.literal(1),
  explanation: z.string().min(1),
  scopes: z.array(z.string()),
  permissionChanges: z.array(z.string()).default([]),
});

export class CommandHarnessMaintainer implements HarnessMaintainer {
  readonly id: AgentId;
  private readonly commandOverride:
    Omit<CommandAdapterOptions, "id"> | undefined;

  constructor(
    id: AgentId,
    commandOverride?: Omit<CommandAdapterOptions, "id">,
  ) {
    this.id = id;
    this.commandOverride = commandOverride;
  }

  async proposeOverlay(
    packet: AnonymizedInfrastructurePacket,
    signal: AbortSignal,
  ): Promise<HarnessOverlayProposal> {
    const value = HarnessOverlayProposalSchema.parse(
      normalizeModelJson(
        extractJson(
          await invokeStructuredGenerator(
            this.id,
            "harness_maintainer",
            {
              worktree: packet.worktree,
              prompt: packet.prompt,
              timeoutMs: packet.timeoutMs,
              transcriptPrefix: packet.transcriptPrefix,
              signal,
              round: packet.round,
            },
            ".agent-arena-overlay.json",
            this.commandOverride,
          ),
        ),
      ),
    );
    return {
      explanation: value.explanation,
      scopes: value.scopes,
      permissionChanges: value.permissionChanges,
    };
  }
}

export class RuleBasedVerifier implements AttackVerifier {
  constructor(readonly id: AgentId) {}

  async assess(input: AnonymizedAttackInput): Promise<AttackVerdict> {
    const severity = SeveritySchema.parse(
      input.attack.proposedSeverity ?? "medium",
    );
    const sourceText = await Promise.all(
      input.runSpec.task.sources.map((source) =>
        readFile(source.snapshotPath, "utf8").catch(() => ""),
      ),
    );
    const frozenText = [
      input.runSpec.task.task,
      ...input.runSpec.task.acceptanceCriteria,
      ...sourceText,
    ]
      .join("\n")
      .toLocaleLowerCase();
    const expectedBehavior = input.attack.oracle.expectedBehavior
      .trim()
      .toLocaleLowerCase();
    const oracleSupported =
      expectedBehavior.length > 0 && frozenText.includes(expectedBehavior);
    return {
      relevant: input.attack.claim.trim().length > 0,
      oracleSupported,
      oracleRationale: oracleSupported
        ? "The expected behavior appears explicitly in the frozen task text."
        : "The expected behavior is not explicitly supported by the frozen task text.",
      rootDefectId: input.attack.assertionFingerprint,
      severity,
      rationale: `Mechanically reproduced against the target and not the author; rated ${severity} using the submitted impact and fixed rubric.`,
    };
  }
}
