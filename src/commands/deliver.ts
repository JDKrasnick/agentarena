import { randomUUID } from "node:crypto";
import {
  executeDelivery,
  getDeliveryStatus,
  planDelivery,
  recordDeliveryDecision,
} from "../delivery/service.js";
import type { DeliveryAction } from "../delivery/types.js";

export async function runDeliverCommand(options: {
  runId: string;
  mode: "plan" | "status" | "execute";
  action?: DeliveryAction;
  confirmSha256?: string;
  mergeAfterChecks?: boolean;
  closeIssue?: boolean;
  idempotencyKey?: string;
  json?: boolean;
}): Promise<string> {
  if (options.mode === "status") {
    const status = await getDeliveryStatus({ runId: options.runId });
    return JSON.stringify(status ?? { status: "pending" }, null, 2);
  }
  const plan = await planDelivery({ runId: options.runId });
  if (options.mode === "plan") return JSON.stringify(plan, null, 2);
  if (!options.action) throw new Error("--action is required for delivery");
  if (options.confirmSha256 !== plan.patchSha256)
    throw new Error(
      "Delivery requires --confirm-sha256 with the accepted patch digest",
    );
  const key = options.idempotencyKey ?? randomUUID();
  await recordDeliveryDecision({
    runId: options.runId,
    expectedPlanHash: plan.planHash,
    action: options.action,
    mergeAfterChecks: options.mergeAfterChecks ?? false,
    closeIssue: options.closeIssue ?? false,
    approval: {
      channel: "cli",
      promptId: plan.planHash,
      provenance: {
        kind: "direct_tty",
        confirmedPatchSha256: plan.patchSha256,
      },
    },
    idempotencyKey: `${key}:decision`,
  });
  const result = await executeDelivery({
    runId: options.runId,
    expectedPlanHash: plan.planHash,
    idempotencyKey: `${key}:execute`,
  });
  return options.json
    ? JSON.stringify(result, null, 2)
    : `Delivery ${result.status}: ${result.pullRequest?.url ?? result.terminalReason ?? ""}`;
}
