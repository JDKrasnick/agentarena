import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PatchQualityVerdictSchema,
  type AgentId,
  type PatchQualityFacts,
  type PatchQualityVerdict,
} from "../core/types.js";
import type { RunSpec } from "../contracts/round.js";
import { runProcess } from "../runner/process-runner.js";
import type { ArenaObserver } from "../observability/events.js";
import { providerCommand } from "../agents/adapter.js";
import type { FrozenMcpPolicy } from "../mcp/policy.js";

export interface PatchQualityVerifierInput {
  taskContract: RunSpec["task"];
  patches: readonly [
    {
      label: "patch_a";
      patch: string;
      facts: Omit<PatchQualityFacts, "contestantId">;
    },
    {
      label: "patch_b";
      patch: string;
      facts: Omit<PatchQualityFacts, "contestantId">;
    },
  ];
  finalValidation: Record<string, unknown>;
  promptPath: string;
  worktree: string;
  transcriptPrefix: string;
  timeoutMs: number;
  signal: AbortSignal;
  observer?: ArenaObserver;
}

export interface PatchQualityVerifier {
  readonly id: string;
  compare(input: PatchQualityVerifierInput): Promise<PatchQualityVerdict>;
}

export class CommandPatchQualityVerifier implements PatchQualityVerifier {
  readonly id: string;
  private readonly command;

  constructor(provider: AgentId, model?: string, mcpPolicy?: FrozenMcpPolicy) {
    this.id = `quality-${provider}`;
    this.command = providerCommand(provider, model, mcpPolicy);
  }

  async compare(
    input: PatchQualityVerifierInput,
  ): Promise<PatchQualityVerdict> {
    const outputPath = path.join(input.worktree, "quality-verdict.json");
    await rm(outputPath, { force: true });
    const command = this.command;
    const prompt = [
      "You are a neutral implementation-quality verifier.",
      "Correctness has already been adjudicated. Compare only the anonymized patches using scope precision, dependency/operational footprint, change surface, structural simplicity, verification/observability, and normalized patch size (last).",
      "Do not infer contestant/provider identity. Cite only supplied evidence.",
      `Write strict JSON matching this schema to ${outputPath}:`,
      '{"version":1,"verdict":"patch_a|patch_b|equivalent|inconclusive","criteria":[{"name":"...","verdict":"patch_a|patch_b|equivalent|unknown","evidence":["..."],"rationale":"..."}],"rationale":["..."]}',
      "",
      JSON.stringify(
        {
          taskContract: input.taskContract,
          finalValidation: input.finalValidation,
          patches: input.patches,
        },
        null,
        2,
      ),
    ].join("\n");
    await writeFile(input.promptPath, prompt, "utf8");
    const invocationId = `quality-verifier-${String(Date.now())}`;
    await input.observer?.publish({
      type: "invocation_started",
      invocationId,
      source: "verifier",
      stage: "quality-verifier",
    });
    const result = await runProcess({
      ...command,
      ...(command.providerStream
        ? { providerStream: command.providerStream }
        : {}),
      providerInvocation: {
        provider: this.id.replace(/^quality-/, ""),
        ...(command.model ? { requestedModel: command.model } : {}),
        role: "judge",
        stage: "quality-verifier",
      },
      input: prompt,
      cwd: input.worktree,
      timeoutMs: input.timeoutMs,
      logPrefix: input.transcriptPrefix,
      signal: input.signal,
      env: {
        AGENT_ARENA_STAGE: "quality_verifier",
        AGENT_ARENA_SUBMISSION: outputPath,
      },
      onOutput: async (stream, text) =>
        input.observer?.publish({
          type: "output",
          invocationId,
          source: "verifier",
          stream,
          text,
        }),
    });
    await input.observer?.publish({
      type: "invocation_finished",
      invocationId,
      status: result.exitCode === 0 ? "succeeded" : "failed",
      durationMs: result.durationMs,
    });
    if (result.exitCode !== 0 || result.failureClass) {
      throw new Error("Quality verifier invocation failed");
    }
    return PatchQualityVerdictSchema.parse(
      JSON.parse(await readFile(outputPath, "utf8")),
    );
  }
}

export function inconclusiveQualityVerdict(
  reason: string,
): PatchQualityVerdict {
  return {
    version: 1,
    verdict: "inconclusive",
    criteria: [],
    rationale: [reason],
  };
}
