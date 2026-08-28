import { createHash } from "node:crypto";
import {
  FailureRecordSchema,
  type FailureRecord,
} from "../contracts/failure.js";
import type { PatchQualityVerdict } from "../core/types.js";
import {
  inconclusiveQualityVerdict,
  type PatchQualityVerifier,
  type PatchQualityVerifierInput,
} from "./verifier.js";

export async function compareQualityWithRetry(options: {
  verifier: PatchQualityVerifier;
  input: PatchQualityVerifierInput;
  patchArtifactRefs: readonly string[];
  transcriptPrefix: (attempt: 1 | 2) => string;
  recreateWorktree: () => Promise<string>;
  persistFailureRecord: (record: FailureRecord) => Promise<void>;
  now?: () => Date;
}): Promise<PatchQualityVerdict> {
  const now = options.now ?? (() => new Date());
  const causalDigest = createHash("sha256")
    .update(JSON.stringify({ subject: "quality-verifier" }))
    .digest("hex");
  let record: FailureRecord | undefined;
  for (const attempt of [1, 2] as const) {
    const startedAt = now().toISOString();
    options.input.transcriptPrefix = options.transcriptPrefix(attempt);
    const diagnosticArtifactRefs = [
      options.input.promptPath,
      options.input.transcriptPrefix,
    ];
    try {
      const verdict = await options.verifier.compare(options.input);
      if (record) {
        record = FailureRecordSchema.parse({
          ...record,
          attempts: [
            ...record.attempts,
            {
              attempt: 2,
              startedAt,
              finishedAt: now().toISOString(),
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
        await options.persistFailureRecord(record);
      }
      return verdict;
    } catch (error) {
      record = FailureRecordSchema.parse({
        version: 1,
        failureId: `failure-quality-${causalDigest.slice(0, 24)}`,
        stage: "model_invocation",
        subject: "quality-verifier",
        category: "transport",
        causalDigest,
        attempts: [
          ...(record?.attempts ?? []),
          {
            attempt,
            startedAt,
            finishedAt: now().toISOString(),
            status: "failed",
            diagnosticArtifactRefs,
          },
        ],
        reusedArtifactRefs: [...options.patchArtifactRefs],
        diagnosticArtifactRefs: [
          ...new Set([
            ...(record?.diagnosticArtifactRefs ?? []),
            ...diagnosticArtifactRefs,
          ]),
        ],
        ...(attempt === 2
          ? { terminalDisposition: "advisory_unavailable" }
          : {}),
      });
      await options.persistFailureRecord(record);
      if (attempt === 2) {
        return inconclusiveQualityVerdict(
          `Quality verifier failed after the targeted retry: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      options.input.worktree = await options.recreateWorktree();
    }
  }
  throw new Error("Unreachable quality verifier retry state");
}
