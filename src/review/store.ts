import { createHash } from "node:crypto";
import { z } from "zod";
import type { ArtifactStore } from "../artifacts/store.js";
import { AgentIdSchema } from "../core/types.js";

export const ReviewDecisionSchema = z.object({
  version: z.literal(1),
  decisionId: z.string(),
  parentDecisionId: z.string().optional(),
  runId: z.string(),
  promptId: z.string(),
  status: z.enum(["accepted", "rejected"]),
  selectedContestantId: AgentIdSchema.optional(),
  selectionSource: z.enum(["recommended", "champion", "contestant"]).optional(),
  patchSha256: z.string().length(64).optional(),
  baseCommit: z.string().optional(),
  channel: z.enum(["chat", "cli", "api"]),
  actorRef: z.string().optional(),
  conversationRef: z.string().optional(),
  userMessageRef: z.string().optional(),
  attestationHash: z.string().length(64),
  idempotencyKeyHash: z.string().length(64),
  decidedAt: z.string().datetime(),
});
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export const OperationRecordSchema = z.object({
  version: z.literal(1),
  operationId: z.string(),
  kind: z.string(),
  runId: z.string(),
  idempotencyKeyHash: z.string().length(64),
  payloadHash: z.string().length(64),
  result: z.unknown(),
  createdAt: z.string().datetime(),
});
export type OperationRecord = z.infer<typeof OperationRecordSchema>;

export function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function readCurrentReview(
  store: ArtifactStore,
): Promise<ReviewDecision | undefined> {
  const decisions = await store.listValidatedArtifacts(
    "reviews",
    ReviewDecisionSchema,
  );
  return decisions
    .sort((left, right) => left.decidedAt.localeCompare(right.decidedAt))
    .at(-1);
}

export async function readOperation(
  store: ArtifactStore,
  idempotencyKey: string,
): Promise<OperationRecord | undefined> {
  return store.readOptionalJson(
    `operations/${hashValue(idempotencyKey)}.json`,
    OperationRecordSchema,
  );
}
