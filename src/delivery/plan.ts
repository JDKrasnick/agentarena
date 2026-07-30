import { createHash } from "node:crypto";
import type { RunState } from "../core/types.js";
import type { ReviewDecision } from "../review/store.js";
import {
  DeliveryPlanSchema,
  type DeliveryAction,
  type DeliveryPlan,
} from "./types.js";

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 32) || "task"
  );
}

export function deliveryBranch(
  state: RunState,
  target = state.deliveryTarget,
): string {
  const suffix = target?.number
    ? String(target.number)
    : slug(state.config.task);
  return `agent-arena/${target?.kind ?? "local_task"}-${suffix}-${state.runId.slice(0, 8)}`;
}

export function deriveDeliveryPlan(
  state: RunState,
  review: ReviewDecision,
): DeliveryPlan {
  if (
    review.status !== "accepted" ||
    !review.patchSha256 ||
    !review.selectedContestantId
  )
    throw new Error("Delivery requires a current accepted patch");
  const target = state.deliveryTarget;
  if (!target)
    throw new Error("Delivery target is ambiguous and requires a user choice");
  let availableActions: DeliveryAction[];
  let recommendedAction: DeliveryAction;
  let requires: string[];
  let sideEffects: string[];
  if (target.kind === "local_task") {
    availableActions = ["apply_local", "reject", "decide_later"];
    recommendedAction = "apply_local";
    requires = ["local_worktree_write"];
    sideEffects = ["Apply the accepted patch to the current working tree."];
  } else if (target.kind === "github_pull_request") {
    availableActions = [
      "apply_local",
      ...(state.config.deliveryEnabled
        ? (["update_pull_request"] as const)
        : []),
      ...(state.config.deliveryEnabled && state.config.mergeEnabled
        ? (["merge_pull_request"] as const)
        : []),
      "reject",
      "decide_later",
    ];
    recommendedAction = state.config.deliveryEnabled
      ? "update_pull_request"
      : "apply_local";
    requires = state.config.deliveryEnabled
      ? ["git_push", "pull_request_write"]
      : ["local_worktree_write"];
    sideEffects = state.config.deliveryEnabled
      ? [
          `Push to ${target.headRepository ?? target.repository ?? "the pull request head repository"}:${target.headBranch ?? deliveryBranch(state, target)} and update GitHub pull request #${String(target.number ?? "")} only if its head is unchanged.`,
        ]
      : ["Apply the accepted patch to the current working tree."];
  } else {
    availableActions = [
      "apply_local",
      ...(state.config.deliveryEnabled
        ? (["create_pull_request"] as const)
        : []),
      ...(state.config.deliveryEnabled && state.config.mergeEnabled
        ? (["merge_pull_request"] as const)
        : []),
      "reject",
      "decide_later",
    ];
    recommendedAction = state.config.deliveryEnabled
      ? "create_pull_request"
      : "apply_local";
    requires = state.config.deliveryEnabled
      ? ["git_push", "pull_request_write"]
      : ["local_worktree_write"];
    sideEffects = state.config.deliveryEnabled
      ? [
          `Create branch ${deliveryBranch(state, target)} and a pull request in ${target.repository ?? "the current GitHub repository"}.`,
        ]
      : ["Apply the accepted patch to the current working tree."];
  }
  const base = {
    version: 1 as const,
    runId: state.runId,
    patchSha256: review.patchSha256,
    target,
    ...(target.kind !== "local_task"
      ? { branch: deliveryBranch(state, target) }
      : {}),
    availableActions,
    recommendedAction,
    requires,
    sideEffects,
    status: "pending" as const,
  };
  return DeliveryPlanSchema.parse({
    ...base,
    planHash: createHash("sha256").update(JSON.stringify(base)).digest("hex"),
  });
}
