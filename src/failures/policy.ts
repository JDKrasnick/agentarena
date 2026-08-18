import { createHash } from "node:crypto";
import {
  FailureRecordSchema,
  type FailureAttempt,
  type FailureCategory,
  type FailureDisposition,
  type FailureRecord,
  type FailureStage,
} from "../contracts/failure.js";

export interface FailureIdentity {
  failureId: string;
  stage: FailureStage;
  subject: string;
  category: FailureCategory;
  causalDigest: string;
  laneId?: string;
  attackId?: string;
  contestantId?: "a" | "b";
}

export interface TargetedRetryOptions<T> extends FailureIdentity {
  run: (attempt: 1 | 2) => Promise<T>;
  isFailure: (value: T) => boolean;
  persist: (record: FailureRecord) => Promise<void>;
  diagnosticArtifactRefs?: (value: T) => string[];
  reusedArtifactRefs?: string[];
  now?: () => Date;
}

function digestIdentity(identity: Omit<FailureIdentity, "failureId">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        stage: identity.stage,
        subject: identity.subject,
        category: identity.category,
        causalDigest: identity.causalDigest,
      }),
    )
    .digest("hex");
}

/** Stable key that prevents correction/revision/command routing from stacking retries. */
export function distinctFailureKey(
  identity: Omit<FailureIdentity, "failureId">,
): string {
  return digestIdentity(identity);
}

export function assertFailureRetryAllowed(
  record: Pick<FailureRecord, "attempts">,
): void {
  if (record.attempts.length >= 2)
    throw new Error("Targeted retry allowance is exhausted for this failure");
}

/**
 * Run one stage with one targeted retry. Attempt one is durably persisted
 * before attempt two starts, and validated upstream artifact references remain
 * attached to both attempts through the shared record.
 */
export async function runWithTargetedRetry<T>(
  options: TargetedRetryOptions<T>,
): Promise<{ value: T; record: FailureRecord }> {
  const now = options.now ?? (() => new Date());
  const attempts: FailureAttempt[] = [];
  let value!: T;
  for (const attempt of [1, 2] as const) {
    const startedAt = now().toISOString();
    value = await options.run(attempt);
    const failed = options.isFailure(value);
    attempts.push({
      attempt,
      startedAt,
      finishedAt: now().toISOString(),
      status: failed ? "failed" : "succeeded",
      diagnosticArtifactRefs: options.diagnosticArtifactRefs?.(value) ?? [],
    });
    const record = FailureRecordSchema.parse({
      version: 1,
      failureId: options.failureId,
      stage: options.stage,
      subject: options.subject,
      category: options.category,
      causalDigest: options.causalDigest,
      ...(options.laneId ? { laneId: options.laneId } : {}),
      ...(options.attackId ? { attackId: options.attackId } : {}),
      ...(options.contestantId ? { contestantId: options.contestantId } : {}),
      attempts,
      reusedArtifactRefs: options.reusedArtifactRefs ?? [],
      diagnosticArtifactRefs: [
        ...new Set(attempts.flatMap((entry) => entry.diagnosticArtifactRefs)),
      ],
      ...(failed ? {} : { terminalDisposition: "recovered" as const }),
    });
    await options.persist(record);
    if (!failed) return { value, record };
    if (attempt === 2) return { value, record };
    assertFailureRetryAllowed(record);
  }
  throw new Error("Unreachable targeted retry state");
}

export function finalizeFailureRecord(
  record: FailureRecord,
  terminalDisposition: Exclude<FailureDisposition, "recovered">,
): FailureRecord {
  return FailureRecordSchema.parse({ ...record, terminalDisposition });
}
