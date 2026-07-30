import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import {
  AgentInvocationSchema,
  AttackSubmissionSchema,
  CaseSubmissionSchema,
  HouseSubmissionSchema,
  InfrastructureReviewSubmissionSchema,
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
  type Severity,
  type TaskContract,
} from "../core/types.js";
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
  round?: 1 | 2 | 3 | "recovery";
}

export type ImplementInput = InvocationInput;

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
  taskContract: TaskContract;
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

export interface HouseScout {
  readonly id: AgentId;
  scout(input: StructuredGeneratorInput): Promise<HouseSubmission>;
}

export interface CaseBuilder {
  readonly id: AgentId;
  build(
    input: StructuredGeneratorInput & { attack: Attack },
  ): Promise<CaseSubmission>;
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
  return AttackSubmissionSchema.parse(
    JSON.parse(await readFile(submissionPath, "utf8")),
  );
}

export async function readStageSubmission(
  worktree: string,
): Promise<{ explanation: string }> {
  const submissionPath = path.join(worktree, ".agent-arena-submission.json");
  try {
    return StageSubmissionSchema.parse(
      JSON.parse(await readFile(submissionPath, "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { explanation: "" };
    throw error;
  }
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
  environment?: Record<string, string>;
}

function providerCommand(id: AgentId): Omit<CommandAdapterOptions, "id"> {
  switch (id) {
    case "codex":
      return {
        executable: "codex",
        args: ["exec", "--full-auto", "--skip-git-repo-check", "-"],
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
        ],
      };
    case "gemini":
      return {
        executable: "gemini",
        args: ["--yolo"],
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

  attack(input: AttackInput): Promise<AgentInvocation> {
    return this.invoke("collect_attacks", input);
  }

  repair(input: RepairInput): Promise<AgentInvocation> {
    return this.invoke("repair", input);
  }

  private async invoke(
    stage: "implement" | "collect_attacks" | "repair",
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

export function createProviderAdapter(id: AgentId): CommandAgentAdapter {
  return new CommandAgentAdapter({ id, ...providerCommand(id) });
}

const AttackVerdictSchema = z.object({
  relevant: z.boolean(),
  oracleSupported: z.boolean(),
  oracleRationale: z.string(),
  rootDefectId: z.string().min(1),
  severity: SeveritySchema,
  rationale: z.string().min(1),
});

export class CommandAttackVerifier implements AttackVerifier {
  private readonly command: Omit<CommandAdapterOptions, "id">;

  constructor(readonly id: AgentId) {
    this.command = providerCommand(id);
  }

  async assess(input: AnonymizedAttackInput): Promise<AttackVerdict> {
    const outputPath = path.join(input.worktree, ".agent-arena-verdict.json");
    const prompt = [
      "# Neutral Agent Arena attack adjudication",
      "You do not know either contestant's identity. Mechanical execution already established an author-side pass and target-side failure.",
      "Assess only oracle support, task relevance, canonical root-defect identity, and the lowest fully supported severity.",
      "Do not infer correctness from the test alone. Critical means security bypass/data loss/corruption/catastrophic failure; High means a core criterion, normal crash/hang, or major wrong result; Medium is a realistic edge or secondary requirement; Low is narrow robustness/performance impact. Ambiguous High/Critical must be capped at Medium.",
      "",
      "# Immutable task contract",
      JSON.stringify(input.taskContract, null, 2),
      "",
      "# Anonymized attack",
      JSON.stringify(
        {
          claim: input.attack.claim,
          impact: input.attack.impact,
          oracle: input.attack.oracle,
          assertionFingerprint: input.attack.assertionFingerprint,
          testPatchPath: input.attack.patchPath,
          authorPassed: input.authorPassed,
          targetFailed: input.targetFailed,
        },
        null,
        2,
      ),
      "",
      `Write only valid JSON to ${outputPath} with keys relevant, oracleSupported, oracleRationale, rootDefectId, severity, and rationale.`,
    ].join("\n");
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
        lastError = new Error("Verifier provider infrastructure failed");
        continue;
      }
      try {
        return AttackVerdictSchema.parse(
          JSON.parse(await readFile(outputPath, "utf8")),
        );
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `Verifier failed after two attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
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
): Promise<unknown> {
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
  return JSON.parse(await readFile(outputPath, "utf8")) as unknown;
}

export class CommandHouseScout implements HouseScout {
  constructor(
    readonly id: AgentId,
    private readonly commandOverride?: Omit<CommandAdapterOptions, "id">,
  ) {}

  async scout(input: StructuredGeneratorInput): Promise<HouseSubmission> {
    return HouseSubmissionSchema.parse(
      await invokeStructuredGenerator(
        this.id,
        "house",
        input,
        ".agent-arena-house.json",
        this.commandOverride,
      ),
    );
  }
}

export class CommandCaseBuilder implements CaseBuilder {
  constructor(
    readonly id: AgentId,
    private readonly commandOverride?: Omit<CommandAdapterOptions, "id">,
  ) {}

  async build(
    input: StructuredGeneratorInput & { attack: Attack },
  ): Promise<CaseSubmission> {
    return CaseSubmissionSchema.parse(
      await invokeStructuredGenerator(
        this.id,
        "case_builder",
        input,
        ".agent-arena-cases.json",
        this.commandOverride,
      ),
    );
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
      await invokeStructuredGenerator(
        input.agent,
        "infrastructure_review",
        input,
        ".agent-arena-infrastructure-review.json",
        this.commandOverrides[input.agent],
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

  assess(input: AnonymizedAttackInput): Promise<AttackVerdict> {
    const severity = SeveritySchema.parse(
      input.attack.proposedSeverity ?? "medium",
    );
    return Promise.resolve({
      relevant: input.attack.claim.trim().length > 0,
      oracleSupported: input.taskContract.sources.some(
        (source) => source.id === input.attack.oracle.sourceId,
      ),
      oracleRationale: `Citation ${input.attack.oracle.sourceId} exists in the immutable task contract`,
      rootDefectId: input.attack.assertionFingerprint,
      severity,
      rationale: `Mechanically reproduced against the target and not the author; rated ${severity} using the submitted impact and fixed rubric.`,
    });
  }
}
