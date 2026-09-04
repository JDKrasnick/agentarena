import { createHash } from "node:crypto";
import {
  FailureRecordSchema,
  type FailureDisposition,
  type FailureRecord,
} from "../contracts/failure.js";
import type { ContestantId } from "../core/types.js";
import type { WorktreeManager } from "./git.js";

export async function prepareWorktreeWithRetry(options: {
  worktrees: WorktreeManager;
  name: string;
  patches?: readonly string[];
  subject: string;
  persistFailureRecord?: (record: FailureRecord) => Promise<void>;
  terminalDisposition?: Exclude<FailureDisposition, "recovered">;
  contestantId?: ContestantId;
  attackId?: string;
  laneId?: string;
  now?: () => Date;
}): Promise<string> {
  const now = options.now ?? (() => new Date());
  const patches = options.patches ?? [];
  const causalDigest = createHash("sha256")
    .update(JSON.stringify({ subject: options.subject, patches }))
    .digest("hex");
  let record: FailureRecord | undefined;
  let lastError: unknown;
  for (const attempt of [1, 2] as const) {
    const startedAt = now().toISOString();
    let worktree: string | undefined;
    try {
      worktree = await options.worktrees.create(
        `${options.name}-attempt-${String(attempt)}`,
        {
          purpose: options.subject,
          ...(options.contestantId
            ? { contestantId: options.contestantId }
            : {}),
        },
      );
      for (const patch of patches)
        await options.worktrees.applyPatch(worktree, patch);
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
              diagnosticArtifactRefs: [...patches],
            },
          ],
          terminalDisposition: "recovered",
        });
        await options.persistFailureRecord?.(record);
      }
      return worktree;
    } catch (error) {
      lastError = error;
      if (worktree)
        await options.worktrees.remove(worktree).catch(() => undefined);
      record = FailureRecordSchema.parse({
        version: 1,
        failureId: `failure-worktree-${causalDigest.slice(0, 24)}`,
        stage: "git",
        subject: options.subject,
        category: "git_operation",
        causalDigest,
        attempts: [
          ...(record?.attempts ?? []),
          {
            attempt,
            startedAt,
            finishedAt: now().toISOString(),
            status: "failed",
            diagnosticArtifactRefs: [...patches],
          },
        ],
        reusedArtifactRefs: [...patches],
        diagnosticArtifactRefs: [...patches],
        ...(options.contestantId ? { contestantId: options.contestantId } : {}),
        ...(options.attackId ? { attackId: options.attackId } : {}),
        ...(options.laneId ? { laneId: options.laneId } : {}),
        ...(attempt === 2
          ? {
              terminalDisposition:
                options.terminalDisposition ?? "coverage_lost",
            }
          : {}),
      });
      await options.persistFailureRecord?.(record);
    }
  }
  throw new Error(
    `Worktree preparation infrastructure failed after the targeted retry for ${options.subject}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
