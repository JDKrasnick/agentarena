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

export function resolveLedgerHead<
  T extends {
    decisionId: string;
    parentDecisionId?: string | undefined;
  },
>(decisions: readonly T[], ledgerName: string): T | undefined {
  if (decisions.length === 0) return undefined;
  const byId = new Map(
    decisions.map((decision) => [decision.decisionId, decision]),
  );
  if (byId.size !== decisions.length)
    throw new Error(`${ledgerName} ledger contains duplicate decision IDs`);
  const claimedParents = new Set<string>();
  for (const decision of decisions) {
    if (!decision.parentDecisionId) continue;
    if (!byId.has(decision.parentDecisionId))
      throw new Error(
        `${ledgerName} ledger contains an unknown parent decision`,
      );
    claimedParents.add(decision.parentDecisionId);
  }
  const heads = decisions.filter(
    (decision) => !claimedParents.has(decision.decisionId),
  );
  if (heads.length !== 1)
    throw new Error(
      `${ledgerName} ledger does not have exactly one structural head`,
    );
  const visited = new Set<string>();
  let current: T | undefined = heads[0];
  while (current) {
    if (visited.has(current.decisionId))
      throw new Error(`${ledgerName} ledger contains a decision cycle`);
    visited.add(current.decisionId);
    current = current.parentDecisionId
      ? byId.get(current.parentDecisionId)
      : undefined;
  }
  if (visited.size !== decisions.length)
    throw new Error(
      `${ledgerName} ledger contains a disconnected decision chain`,
    );
  return heads[0];
}

export async function readCurrentReview(
  store: ArtifactStore,
): Promise<ReviewDecision | undefined> {
  const decisions = await store.listValidatedArtifacts(
    "reviews",
    ReviewDecisionSchema,
  );
  return resolveLedgerHead(decisions, "Review");
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
