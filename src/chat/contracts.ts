import { z } from "zod";
import { AgentIdSchema } from "../core/types.js";
import { ApprovalContextSchema } from "../review/approval.js";
import { DeliveryActionSchema } from "../delivery/types.js";

export const ReviewRunInputSchema = z
  .object({
    runId: z.string(),
    repositoryRoot: z.string().optional(),
    artifactRoot: z.string().optional(),
  })
  .strict();
export const InspectPatchInputSchema = ReviewRunInputSchema.extend({
  contestantId: AgentIdSchema,
  view: z.enum(["summary", "diff", "tests", "quality"]),
}).strict();
export const RecordReviewDecisionInputSchema = ReviewRunInputSchema.extend({
  promptId: z.string(),
  decision: z.enum(["accept", "reject"]),
  selection: z
    .union([z.literal("recommended"), z.literal("champion"), AgentIdSchema])
    .optional(),
  expectedPatchSha256: z.string().length(64).optional(),
  expectedBaseCommit: z.string(),
  approval: ApprovalContextSchema,
  idempotencyKey: z.string().min(1),
}).strict();
export const ApplyAcceptedPatchInputSchema = ReviewRunInputSchema.extend({
  expectedPatchSha256: z.string().length(64).optional(),
  idempotencyKey: z.string().min(1),
  forceDirty: z.boolean().optional(),
}).strict();
export const RecordDeliveryDecisionInputSchema = ReviewRunInputSchema.extend({
  expectedPlanHash: z.string().length(64),
  action: DeliveryActionSchema,
  mergeAfterChecks: z.boolean().optional(),
  closeIssue: z.boolean().optional(),
  approval: ApprovalContextSchema,
  idempotencyKey: z.string().min(1),
}).strict();
export const ExecuteDeliveryInputSchema = ReviewRunInputSchema.extend({
  expectedPlanHash: z.string().length(64),
  idempotencyKey: z.string().min(1),
  monitorTimeoutMs: z.number().int().positive().optional(),
}).strict();

export {
  ApprovalContextSchema,
  type ApprovalContext,
  type ApprovalVerifier,
} from "../review/approval.js";
export {
  reviewRun,
  inspectPatch,
  recordReviewDecision,
} from "../review/service.js";
export { applyAcceptedPatch } from "../commands/apply.js";
export {
  planDelivery,
  recordDeliveryDecision,
  executeDelivery,
  getDeliveryStatus,
} from "../delivery/service.js";
export {
  DeliveryActionSchema,
  DeliveryDecisionSchema,
  DeliveryPlanSchema,
  DeliveryResultSchema,
} from "../delivery/types.js";
export { PatchChoiceSchema, ReviewPromptSchema } from "../core/types.js";
