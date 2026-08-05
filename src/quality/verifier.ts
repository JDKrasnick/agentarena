import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PatchQualityVerdictSchema,
  type AgentId,
  type PatchQualityFacts,
  type PatchQualityVerdict,
  type TaskContract,
} from "../core/types.js";
import { providerCommand } from "../agents/adapter.js";
import { runProcess } from "../runner/process-runner.js";

export interface PatchQualityVerifierInput {
  taskContract: TaskContract;
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
  activeDefects: Record<string, unknown>;
  promptPath: string;
  worktree: string;
  transcriptPrefix: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface PatchQualityVerifier {
  readonly id: string;
  compare(input: PatchQualityVerifierInput): Promise<PatchQualityVerdict>;
}

export class CommandPatchQualityVerifier implements PatchQualityVerifier {
  readonly id: string;

  constructor(
    private readonly provider: AgentId,
    private readonly model?: string,
  ) {
    this.id = `quality-${provider}`;
  }

  async compare(
    input: PatchQualityVerifierInput,
  ): Promise<PatchQualityVerdict> {
    const outputPath = path.join(input.worktree, "quality-verdict.json");
    await rm(outputPath, { force: true });
    const command = providerCommand(this.provider, this.model);
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
          activeDefects: input.activeDefects,
          patches: input.patches,
        },
        null,
        2,
      ),
    ].join("\n");
    await writeFile(input.promptPath, prompt, "utf8");
    const result = await runProcess({
      ...command,
      input: prompt,
      cwd: input.worktree,
      timeoutMs: input.timeoutMs,
      logPrefix: input.transcriptPrefix,
      signal: input.signal,
      env: {
        AGENT_ARENA_STAGE: "quality_verifier",
        AGENT_ARENA_SUBMISSION: outputPath,
      },
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
