import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import {
  AgentInvocationSchema,
  AttackSubmissionV2Schema,
  InfrastructureReviewSubmissionSchema,
  SeveritySchema,
  StageSubmissionSchema,
  type AgentId,
  type AgentInvocation,
  type CommandResult,
  type Attack,
  type ContestantId,
  ConnectivityProbeResultSchema,
  type ConnectivityProbeResult,
  type AttackSubmission,
  type CaseSubmission,
  type HouseSubmission,
  type InfrastructureReviewSubmission,
  type PermissionPolicy,
  type Severity,
} from "../core/types.js";
import {
  TrustedReviewSubmissionSchema,
  type TrustedReviewSubmission,
} from "../review/evidence-handoff.js";
import { calculateCanonicalHash, type RunSpec } from "../contracts/round.js";
import { sha256 } from "../core/ids.js";
import { buildJudgePacket } from "../judge/packets.js";
import type { PriorAdjudicationContext } from "../attacks/challenges.js";
import { runProcess, type ProcessRequest } from "../runner/process-runner.js";
import { z } from "zod";
import type { ArenaObserver, OutputSource } from "../observability/events.js";
import { selectedMcpNames, type FrozenMcpPolicy } from "../mcp/policy.js";
import type {
  ProviderStage,
  ProviderStageFailure,
} from "../recovery/provider-policy.js";

async function runObservedProcess(
  request: ProcessRequest,
  observation?: {
    observer?: ArenaObserver;
    source: OutputSource;
    stage: string;
    contestantId?: ContestantId;
    round?: 1 | 2 | 3 | "recovery" | "reconciliation";
  },
): Promise<CommandResult> {
  if (!observation?.observer) return runProcess(request);
  const invocationId = `${observation.stage}-${path.basename(request.logPrefix)}-${String(Date.now())}`;
  await observation.observer.publish({
    type: "invocation_started",
    invocationId,
    source: observation.source,
    stage: observation.stage,
    ...(observation.contestantId
      ? { contestantId: observation.contestantId }
      : {}),
    ...(observation.round === undefined ? {} : { round: observation.round }),
  });
  const result = await runProcess({
    ...request,
    onOutput: (stream, text) =>
      observation.observer?.publish({
        type: "output",
        invocationId,
        source: observation.source,
        stream,
        text,
        ...(observation.contestantId
          ? { contestantId: observation.contestantId }
          : {}),
      }),
  });
  await observation.observer.publish({
    type: "invocation_finished",
    invocationId,
    status:
      result.failureClass === "arena_infrastructure"
        ? "infrastructure_error"
        : result.timedOut
          ? "timed_out"
          : result.exitCode === 0
            ? "succeeded"
            : "failed",
    durationMs: result.durationMs,
    ...(observation.contestantId
      ? { contestantId: observation.contestantId }
      : {}),
  });
  return result;
}

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
  observer?: ArenaObserver;
  outputSource?: OutputSource;
}

export type ImplementInput = InvocationInput;

export interface ConnectivityProbeInput {
  cwd: string;
  transcriptPrefix: string;
  timeoutMs: number;
  signal: AbortSignal;
}

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
  probeConnectivity(
    input: ConnectivityProbeInput,
  ): Promise<ConnectivityProbeResult>;
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
  relationship?: "independent" | "affirm" | "overturn" | "unresolved";
  priorAdjudicationId?: string;
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
  retryReason?: string;
  priorAdjudications?: readonly PriorAdjudicationContext[];
  targetPatchDigest?: string;
  observer?: ArenaObserver;
}

export interface AttackVerifier {
  readonly id: AgentId;
  assess(input: AnonymizedAttackInput): Promise<AttackVerdict>;
  /** Optional semantic fallback used only after the approved mechanical path fails. */
  adjudicate?(input: JudgeAdjudicationInput): Promise<JudgeAttackVerdict>;
  /** Optional repair fallback used only after mechanical repair checks remain unavailable. */
  assessRepair?(input: JudgeRepairInput): Promise<JudgeRepairVerdict>;
  /** Returns and removes the oldest causally established terminal provider failure. */
  consumeProviderFailure?(): ProviderStageFailure | undefined;
}

export interface JudgeAdjudicationInput extends Omit<
  AnonymizedAttackInput,
  "authorPassed" | "targetFailed"
> {
  mechanicalFailureReason: string;
  targetPatchPath: string;
  mechanicalDiagnosticArtifactRefs: readonly string[];
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
  relationship?: "independent" | "affirm" | "overturn" | "unresolved";
  priorAdjudicationId?: string;
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
  retryReason?: string;
  observer?: ArenaObserver;
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
  observer?: ArenaObserver;
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
  observer?: ArenaObserver;
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
): Promise<TrustedReviewSubmission> {
  const submissionPath = path.join(worktree, ".agent-arena-submission.json");
  return parseModelSubmission(
    TrustedReviewSubmissionSchema,
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
  mcpPolicy?: FrozenMcpPolicy,
): Omit<CommandAdapterOptions, "id"> {
  // `gpt-5.6` is the default-family name, while ChatGPT-authenticated Codex
  // CLI expects the concrete flagship model identifier.
  const resolvedModel =
    id === "codex" && model === "gpt-5.6" ? "gpt-5.6-sol" : model;
  const modelArgs = resolvedModel ? ["--model", resolvedModel] : [];
  const selectedMcp = mcpPolicy ? selectedMcpNames(mcpPolicy, id) : undefined;
  const providerInventory = mcpPolicy?.inventory.find(
    (entry) => entry.provider === id,
  );
  const unselectedMcp = providerInventory?.servers
    .filter((server) => !selectedMcp?.includes(server.name))
    .map((server) => server.name);
  switch (id) {
    case "codex":
      return {
        executable: "codex",
        args: [
          "exec",
          ...(mcpPolicy
            ? (providerInventory?.servers.length ?? 0) > 0
              ? (providerInventory?.servers ?? []).flatMap((server) => [
                  "-c",
                  `mcp_servers.${JSON.stringify(server.name)}.enabled=${selectedMcp?.includes(server.name) ? "true" : "false"}`,
                ])
              : ["-c", "mcp_servers={}"]
            : []),
          ...modelArgs,
          "--full-auto",
          "--skip-git-repo-check",
          "-",
        ],
        ...(resolvedModel ? { model: resolvedModel } : {}),
      };
    case "claude":
      if (mcpPolicy && selectedMcp?.length)
        throw new Error(
          "Claude named MCP selections require explicit server definitions so --strict-mcp-config can isolate the run; unsafe global configuration reuse is refused",
        );
      return {
        executable: "claude",
        args: [
          "--print",
          "--permission-mode",
          "bypassPermissions",
          "--output-format",
          "text",
          ...modelArgs,
          ...(mcpPolicy && selectedMcp?.length === 0
            ? [
                "--strict-mcp-config",
                "--mcp-config",
                JSON.stringify({ mcpServers: {} }),
              ]
            : (unselectedMcp ?? []).flatMap((name) => [
                "--disallowedTools",
                `mcp__${name}__*`,
              ])),
        ],
        ...(resolvedModel ? { model: resolvedModel } : {}),
      };
    case "gemini":
      return {
        executable: "gemini",
        args: [
          "--yolo",
          ...modelArgs,
          ...(mcpPolicy
            ? ["--allowed-mcp-server-names", (selectedMcp ?? []).join(",")]
            : []),
        ],
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
    const result = await runObservedProcess({
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

  async probeConnectivity(
    input: ConnectivityProbeInput,
  ): Promise<ConnectivityProbeResult> {
    const started = new Date();
    const sentinel = "AGENT_ARENA_PROVIDER_HEALTH_OK";
    const command = await runProcess({
      executable: this.options.executable,
      args: this.options.args,
      input: `Provider connectivity health check. Respond with exactly ${sentinel}.`,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      logPrefix: input.transcriptPrefix,
      env: {
        ...this.options.environment,
        AGENT_ARENA_AGENT: this.id,
        AGENT_ARENA_STAGE: "provider_health_probe",
        AGENT_ARENA_SUBMISSION: path.join(
          input.cwd,
          ".agent-arena-provider-health.json",
        ),
      },
      signal: input.signal,
    });
    const finished = new Date();
    const transportFailures = command.transportFailures ?? [];
    let response = "";
    try {
      response = await readFile(command.stdoutPath, "utf8");
    } catch {
      // A missing transcript cannot authenticate provider connectivity.
    }
    const sentinelMatched = response.trim() === sentinel;
    const healthy =
      command.exitCode === 0 &&
      !command.timedOut &&
      command.failureClass !== "arena_infrastructure" &&
      transportFailures.length === 0 &&
      sentinelMatched;
    return ConnectivityProbeResultSchema.parse({
      version: 1,
      provider: this.id,
      healthy,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      reason: healthy
        ? `Provider backend completed the deterministic ${sentinel} probe.`
        : transportFailures.length
          ? "Provider backend reported transport or authentication failure."
          : command.timedOut
            ? "Provider backend health probe timed out."
            : command.exitCode === 0 && !sentinelMatched
              ? `Provider backend did not return the exact ${sentinel} response.`
              : "Provider backend health probe failed.",
      transportFailures,
      artifactPaths: [command.stdoutPath, command.stderrPath],
      command,
    });
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
    const invocationId = `${input.contestantId ?? this.id}-${stage}-${input.round ?? "none"}-${String(started.getTime())}`;
    await input.observer?.publish({
      type: "invocation_started",
      invocationId,
      source: input.outputSource ?? "agent",
      ...(input.contestantId ? { contestantId: input.contestantId } : {}),
      stage,
      ...(input.round === undefined ? {} : { round: input.round }),
    });
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
      onOutput: (stream, text) =>
        input.observer?.publish({
          type: "output",
          invocationId,
          source: input.outputSource ?? "agent",
          stream,
          text,
          ...(input.contestantId ? { contestantId: input.contestantId } : {}),
        }),
    };
    const command = await runProcess(request);
    const finished = new Date();
    const usableTerminalResult = await this.hasUsableTerminalResult(
      stage,
      input.worktree,
    );
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
    const invocation = AgentInvocationSchema.parse({
      agent: this.id,
      ...(this.options.model ? { model: this.options.model } : {}),
      stage,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      status:
        input.signal.aborted && !command.transportFailures?.length
          ? "cancelled"
          : usableTerminalResult
            ? "succeeded"
            : command.transportFailures?.length &&
                (command.timedOut || command.exitCode !== 0) &&
                !usableTerminalResult
              ? "infrastructure_error"
              : command.failureClass === "arena_infrastructure"
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
    const summary = invocation.explanation?.trim();
    await input.observer?.publish({
      type: "invocation_finished",
      invocationId,
      status: invocation.status,
      durationMs: invocation.durationMs,
      ...(input.contestantId ? { contestantId: input.contestantId } : {}),
      ...(summary ? { summary } : {}),
    });
    return invocation;
  }

  private async hasUsableTerminalResult(
    stage: "implement" | "review_attacks" | "collect_attacks" | "repair",
    worktree: string,
  ): Promise<boolean> {
    try {
      const raw = await readFile(
        path.join(worktree, ".agent-arena-submission.json"),
        "utf8",
      );
      const schema =
        stage === "review_attacks"
          ? TrustedReviewSubmissionSchema
          : stage === "collect_attacks"
            ? AttackSubmissionV2Schema
            : StageSubmissionSchema;
      return schema.safeParse(JSON.parse(raw) as unknown).success;
    } catch {
      return false;
    }
  }
}

export function createProviderAdapter(
  id: AgentId,
  model?: string,
  mcpPolicy?: FrozenMcpPolicy,
): CommandAgentAdapter {
  return new CommandAgentAdapter({
    id,
    ...providerCommand(id, model, mcpPolicy),
  });
}

const AttackVerdictSchema = z.object({
  relevant: z.boolean(),
  oracleSupported: z.boolean(),
  oracleRationale: z.string(),
  rootDefectId: z.string().min(1),
  severity: SeveritySchema,
  rationale: z.string().min(1),
  relationship: z
    .enum(["independent", "affirm", "overturn", "unresolved"])
    .optional(),
  priorAdjudicationId: z.string().min(1).optional(),
});

const JudgeAttackVerdictSchema = z.object({
  decision: z.enum(["confirmed", "supported_untestable", "rejected", "unable"]),
  relevant: z.boolean(),
  expectedBehaviorClearlySupported: z.boolean(),
  evidencePointsToDefect: z.boolean(),
  rootDefectId: z.string().min(1).optional(),
  severity: SeveritySchema.optional(),
  rationale: z.string().min(1),
  relationship: z
    .enum(["independent", "affirm", "overturn", "unresolved"])
    .optional(),
  priorAdjudicationId: z.string().min(1).optional(),
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
  private readonly providerFailures: ProviderStageFailure[] = [];

  constructor(
    readonly id: AgentId,
    command?: Omit<CommandAdapterOptions, "id">,
  ) {
    this.command = command ?? providerCommand(id);
  }

  consumeProviderFailure(): ProviderStageFailure | undefined {
    return this.providerFailures.shift();
  }

  private recordTerminalProviderFailure(
    stage: Extract<ProviderStage, "judge" | "semantic_adjudication">,
    result: CommandResult,
    input: {
      retryReason?: string;
      promptPath: string;
      transcriptPrefix: string;
    },
    reason: string,
  ): void {
    const transportFailures = result.transportFailures;
    if (
      !input.retryReason ||
      !transportFailures?.length ||
      !this.isProviderInfrastructureFailure(result)
    )
      return;
    this.providerFailures.push({
      version: 1,
      provider: this.id,
      stage,
      reason,
      causalEvidence: transportFailures.map(
        (entry) => `${entry.kind}: ${entry.detail}`,
      ),
      artifactRefs: [
        input.promptPath,
        input.transcriptPrefix,
        result.stdoutPath,
        result.stderrPath,
      ],
      usableTerminalResult: false,
    });
  }

  private isProviderInfrastructureFailure(result: CommandResult): boolean {
    return Boolean(
      result.transportFailures?.length &&
      (result.timedOut ||
        result.exitCode !== 0 ||
        result.failureClass === "arena_infrastructure"),
    );
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
      diagnostics: JSON.stringify({
        authorPassed: input.authorPassed,
        targetFailed: input.targetFailed,
        impact: input.attack.impact,
        assertionFingerprint: input.attack.assertionFingerprint,
        targetPatchDigest: input.targetPatchDigest,
        priorAdjudications: input.priorAdjudications ?? [],
      }),
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
      "When prior adjudications are supplied, classify the claim as independent, affirm, overturn, or unresolved and name the related adjudication. Overturn requires material contradictory evidence.",
      `Write only valid JSON to ${outputPath} with keys relevant, oracleSupported, oracleRationale, rootDefectId, severity, rationale, optional relationship, and optional priorAdjudicationId.`,
      ...(input.retryReason
        ? [
            "",
            "The prior bounded attempt failed.",
            `Retry reason: ${input.retryReason}`,
            "Return one corrected JSON object using the exact requested keys.",
          ]
        : []),
    ].join("\n");
    await rm(outputPath, { force: true });
    const result = await runObservedProcess(
      {
        executable: this.command.executable,
        args: this.command.args,
        input: prompt,
        cwd: input.worktree,
        timeoutMs: input.timeoutMs,
        logPrefix: input.transcriptPrefix,
        signal: input.signal,
      },
      {
        ...(input.observer ? { observer: input.observer } : {}),
        source: "verifier",
        stage: "attack-verifier",
      },
    );
    try {
      const verdict = parseModelSubmission(
        AttackVerdictSchema,
        await readFile(outputPath, "utf8"),
      );
      return {
        relevant: verdict.relevant,
        oracleSupported: verdict.oracleSupported,
        oracleRationale: verdict.oracleRationale,
        rootDefectId: verdict.rootDefectId,
        severity: verdict.severity,
        rationale: verdict.rationale,
        ...(verdict.relationship ? { relationship: verdict.relationship } : {}),
        ...(verdict.priorAdjudicationId
          ? { priorAdjudicationId: verdict.priorAdjudicationId }
          : {}),
      };
    } catch (error) {
      if (this.isProviderInfrastructureFailure(result)) {
        this.recordTerminalProviderFailure(
          "judge",
          result,
          input,
          "Attack verifier provider failure persisted after the targeted retry",
        );
        throw new Error("Verifier provider infrastructure failed", {
          cause: error,
        });
      }
      throw new Error(
        `Verifier output was invalid: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  async adjudicate(input: JudgeAdjudicationInput): Promise<JudgeAttackVerdict> {
    const outputPath = path.join(input.worktree, ".agent-arena-judgment.json");
    const sourcePointers = await stageJudgeSources(
      input.runSpec,
      input.worktree,
    );
    const evidenceDirectory = path.join(
      input.worktree,
      ".agent-arena-judge-evidence",
    );
    await mkdir(evidenceDirectory, { recursive: true });
    const stageEvidence = async (
      sourcePath: string,
      name: string,
      artifactId: string,
      description: string,
    ) => {
      const bytes = await readFile(sourcePath);
      const stagedPath = path.join(evidenceDirectory, name);
      await writeFile(stagedPath, bytes);
      return {
        artifactId,
        sha256: sha256(bytes),
        description,
        path: stagedPath,
      };
    };
    const attackEvidence = await stageEvidence(
      input.attack.patchPath,
      "attack-overlay.diff",
      "attack-overlay",
      "Immutable executable attack overlay",
    );
    const targetEvidence = await stageEvidence(
      input.targetPatchPath,
      "target-patch.diff",
      "target-patch",
      "Identity-blind frozen target patch",
    );
    const diagnosticPointers = [];
    for (const [index, artifactPath] of input.mechanicalDiagnosticArtifactRefs
      .slice(0, 16)
      .entries()) {
      try {
        diagnosticPointers.push(
          await stageEvidence(
            artifactPath,
            `mechanical-diagnostic-${String(index + 1)}.txt`,
            `mechanical-diagnostic-${String(index + 1)}`,
            "Mechanical execution diagnostic",
          ),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const packet = buildJudgePacket({
      kind: "attack",
      task: {
        request: input.runSpec.task.task,
        acceptanceCriteria: [...input.runSpec.task.acceptanceCriteria],
      },
      claim: input.attack.claim,
      oracle: JSON.stringify(input.attack.oracle),
      immutableAttackDigest: calculateCanonicalHash(input.attack),
      diagnostics: JSON.stringify({
        mechanicalFailureReason: input.mechanicalFailureReason,
        impact: input.attack.impact,
        assertionFingerprint: input.attack.assertionFingerprint,
        priorCanonicalDefects: input.priorCanonicalDefects,
        targetPatchDigest: input.targetPatchDigest,
        priorAdjudications: input.priorAdjudications ?? [],
      }),
      artifactPointers: [
        ...sourcePointers,
        attackEvidence,
        targetEvidence,
        ...diagnosticPointers,
      ],
    });
    const prompt = [
      "# Neutral Agent Arena semantic adjudication",
      "Contestant identities are unavailable. Do not execute commands or modify evidence.",
      "Use confirmed only for definitive semantic evidence, supported_untestable only when the task clearly supports the oracle and evidence points to the defect, rejected when unsupported, and unable when evidence is insufficient.",
      JSON.stringify(packet, null, 2),
      "Read the digest-linked target patch, attack overlay, and diagnostics from the packet artifact paths before deciding.",
      "When prior adjudications are supplied, classify the claim as independent, affirm, overturn, or unresolved and name the related adjudication. A pass on a changed target patch is repair evidence, not an overturn.",
      `Write only valid JSON to ${outputPath} with keys decision, relevant, expectedBehaviorClearlySupported, evidencePointsToDefect, optional rootDefectId, optional severity, rationale, optional relationship, and optional priorAdjudicationId.`,
      ...(input.retryReason
        ? [
            "The prior bounded attempt failed.",
            `Retry reason: ${input.retryReason}`,
            "Return one corrected JSON object using the exact requested keys.",
          ]
        : []),
    ].join("\n\n");
    await rm(outputPath, { force: true });
    const result = await runObservedProcess(
      {
        executable: this.command.executable,
        args: this.command.args,
        input: prompt,
        cwd: input.worktree,
        timeoutMs: input.timeoutMs,
        logPrefix: input.transcriptPrefix,
        signal: input.signal,
      },
      {
        ...(input.observer ? { observer: input.observer } : {}),
        source: "verifier",
        stage: "judge-fallback",
      },
    );
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
        ...(verdict.rootDefectId ? { rootDefectId: verdict.rootDefectId } : {}),
        ...(verdict.severity ? { severity: verdict.severity } : {}),
        ...(verdict.relationship ? { relationship: verdict.relationship } : {}),
        ...(verdict.priorAdjudicationId
          ? { priorAdjudicationId: verdict.priorAdjudicationId }
          : {}),
      };
    } catch (error) {
      if (this.isProviderInfrastructureFailure(result)) {
        this.recordTerminalProviderFailure(
          "semantic_adjudication",
          result,
          input,
          "Semantic adjudication provider failure persisted after the targeted retry",
        );
        throw new Error("Judge provider infrastructure failed", {
          cause: error,
        });
      }
      throw new Error(
        `Judge fallback output was invalid: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
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
      ...(input.retryReason
        ? [
            "The prior bounded attempt failed.",
            `Retry reason: ${input.retryReason}`,
            "Return one corrected JSON object using the exact requested keys.",
          ]
        : []),
    ].join("\n\n");
    await rm(outputPath, { force: true });
    const schema = z.object({
      decision: z.enum(["repaired", "not_repaired", "unable"]),
      rationale: z.string().min(1),
    });
    const result = await runObservedProcess(
      {
        executable: this.command.executable,
        args: this.command.args,
        input: prompt,
        cwd: input.worktree,
        timeoutMs: input.timeoutMs,
        logPrefix: input.transcriptPrefix,
        signal: input.signal,
      },
      {
        ...(input.observer ? { observer: input.observer } : {}),
        source: "verifier",
        stage: "repair-judge",
      },
    );
    try {
      const verdict = parseModelSubmission(
        schema,
        await readFile(outputPath, "utf8"),
      );
      return { ...verdict, packetDigest: packet.packetDigest };
    } catch (error) {
      if (this.isProviderInfrastructureFailure(result)) {
        this.recordTerminalProviderFailure(
          "judge",
          result,
          input,
          "Repair judge provider failure persisted after the targeted retry",
        );
        throw new Error("Repair judge provider infrastructure failed", {
          cause: error,
        });
      }
      throw new Error(
        `Repair judge output was invalid: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
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
  const result = await runObservedProcess(
    {
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
    },
    {
      ...(input.observer ? { observer: input.observer } : {}),
      source:
        stage === "house" || stage === "case_builder" ? "verifier" : "harness",
      stage,
      round: input.round,
    },
  );
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
