import { z } from "zod";
import { DeliveryTargetSchema } from "../core/types.js";

export const DeliveryActionSchema = z.enum([
  "apply_local",
  "create_pull_request",
  "update_pull_request",
  "merge_pull_request",
  "reject",
  "decide_later",
]);
export type DeliveryAction = z.infer<typeof DeliveryActionSchema>;

export const DeliveryStatusSchema = z.enum([
  "pending",
  "authorized",
  "running",
  "waiting_for_checks",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export const DeliveryPlanSchema = z.object({
  version: z.literal(1),
  planHash: z.string().length(64),
  runId: z.string(),
  patchSha256: z.string().length(64),
  target: DeliveryTargetSchema,
  branch: z.string().optional(),
  availableActions: z.array(DeliveryActionSchema),
  recommendedAction: DeliveryActionSchema,
  requires: z.array(z.string()),
  sideEffects: z.array(z.string()),
  status: DeliveryStatusSchema,
});
export type DeliveryPlan = z.infer<typeof DeliveryPlanSchema>;

export const DeliveryDecisionSchema = z.object({
  version: z.literal(1),
  decisionId: z.string(),
  parentDecisionId: z.string().optional(),
  runId: z.string(),
  planHash: z.string().length(64),
  patchSha256: z.string().length(64),
  action: DeliveryActionSchema,
  mergeAfterChecks: z.boolean(),
  closeIssue: z.boolean(),
  promptId: z.string(),
  channel: z.enum(["chat", "cli", "api"]),
  actorRef: z.string().optional(),
  userMessageRef: z.string().optional(),
  attestationHash: z.string().length(64),
  idempotencyKeyHash: z.string().length(64),
  decidedAt: z.string().datetime(),
});
export type DeliveryDecision = z.infer<typeof DeliveryDecisionSchema>;

export const PullRequestStateSchema = z.object({
  repository: z.string(),
  number: z.number().int().positive(),
  url: z.string().url(),
  headSha: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  checks: z.enum(["pending", "success", "failure"]),
  reviews: z.enum(["pending", "approved", "changes_requested"]),
  mergeable: z.enum(["unknown", "mergeable", "conflicting"]),
  queued: z.boolean().default(false),
});
export type PullRequestState = z.infer<typeof PullRequestStateSchema>;

export const DeliveryResultSchema = z.object({
  version: z.literal(1),
  operationId: z.string(),
  runId: z.string(),
  patchSha256: z.string().length(64),
  status: DeliveryStatusSchema,
  branch: z.string().optional(),
  commitSha: z.string().optional(),
  pullRequest: PullRequestStateSchema.optional(),
  linkedIssueState: z.string().optional(),
  terminalReason: z.string().optional(),
  remainingAction: z.string().optional(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DeliveryResult = z.infer<typeof DeliveryResultSchema>;

export interface DeliveryProgressEvent {
  operationId: string;
  runId: string;
  stage: string;
  status: string;
  attempt: number;
  timestamp: string;
  nextPollAt?: string;
  evidence?: Record<string, unknown>;
}
