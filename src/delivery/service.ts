import { stableId } from "../core/ids.js";
import { applyAcceptedPatch } from "../commands/apply.js";
import {
  DirectApprovalVerifier,
  type ApprovalContext,
  type ApprovalVerifier,
} from "../review/approval.js";
import {
  openRun,
  patchSha256,
  reviewRun,
  trustedPatchPath,
  type RunLocation,
} from "../review/service.js";
import {
  hashValue,
  readCurrentReview,
  readOperation,
} from "../review/store.js";
import {
  GitHubCliDeliveryAdapter,
  type GitHubDeliveryAdapter,
} from "./github.js";
import { monitorPullRequest } from "./monitor.js";
import { deriveDeliveryPlan } from "./plan.js";
import { readCurrentDeliveryDecision, readDeliveryResult } from "./store.js";
import {
  DeliveryDecisionSchema,
  DeliveryResultSchema,
  type DeliveryAction,
  type DeliveryDecision,
  type DeliveryPlan,
  type DeliveryProgressEvent,
  type DeliveryResult,
} from "./types.js";

export async function planDelivery(
  options: RunLocation,
): Promise<DeliveryPlan> {
  const { store, state } = await openRun(options);
  const prompt = await reviewRun(options);
  const review = await readCurrentReview(store);
  if (!review || review.status !== "accepted")
    throw new Error("Delivery planning requires an accepted patch");
  if (review.promptId !== prompt.promptId)
    throw new Error("Accepted patch is stale");
  const plan = deriveDeliveryPlan(state, review);
  await store.replaceDerivedJson("delivery/plan.json", plan);
  return plan;
}

export async function recordDeliveryDecision(
  options: RunLocation & {
    expectedPlanHash: string;
    action: DeliveryAction;
    mergeAfterChecks?: boolean;
    closeIssue?: boolean;
    approval: ApprovalContext;
    idempotencyKey: string;
    verifier?: ApprovalVerifier;
    now?: Date;
  },
): Promise<DeliveryDecision> {
  const { store, state } = await openRun(options);
  const plan = await planDelivery(options);
  if (plan.planHash !== options.expectedPlanHash)
    throw new Error("Delivery plan is stale");
  if (!plan.availableActions.includes(options.action))
    throw new Error("Requested delivery action is not available");
  if (
    (options.mergeAfterChecks || options.action === "merge_pull_request") &&
    !state.config.mergeEnabled
  )
    throw new Error("Merge delivery is disabled by configuration");
  if (
    !state.config.deliveryEnabled &&
    !["apply_local", "reject", "decide_later"].includes(options.action)
  )
    throw new Error("External delivery is disabled by configuration");
  if (options.approval.promptId !== plan.planHash)
    throw new Error("Delivery approval is not bound to the current plan");
  const payloadHash = hashValue(
    JSON.stringify({
      planHash: plan.planHash,
      action: options.action,
      mergeAfterChecks: options.mergeAfterChecks ?? false,
      closeIssue: options.closeIssue ?? false,
    }),
  );
  const replay = await readOperation(store, options.idempotencyKey);
  if (replay) {
    if (replay.payloadHash !== payloadHash)
      throw new Error("Idempotency key was already used with another payload");
    return DeliveryDecisionSchema.parse(replay.result);
  }
  const verified = await (
    options.verifier ?? new DirectApprovalVerifier()
  ).verify(options.approval, plan.patchSha256);
  const decisionId = stableId(
    "delivery-decision",
    state.runId,
    plan.planHash,
    options.idempotencyKey,
  );
  const parentDecision = await readCurrentDeliveryDecision(store);
  const decidedAt = (options.now ?? new Date()).toISOString();
  const decision = DeliveryDecisionSchema.parse({
    version: 1,
    decisionId,
    ...(parentDecision && parentDecision.decisionId !== decisionId
      ? { parentDecisionId: parentDecision.decisionId }
      : {}),
    runId: state.runId,
    planHash: plan.planHash,
    patchSha256: plan.patchSha256,
    action: options.action,
    mergeAfterChecks: options.mergeAfterChecks ?? false,
    closeIssue: options.closeIssue ?? false,
    promptId: plan.planHash,
    channel: options.approval.channel,
    ...(verified.actorRef ? { actorRef: verified.actorRef } : {}),
    ...(options.approval.userMessageRef
      ? { userMessageRef: options.approval.userMessageRef }
      : {}),
    attestationHash: hashValue(`${verified.attestationHash}\0${payloadHash}`),
    idempotencyKeyHash: hashValue(options.idempotencyKey),
    decidedAt,
  });
  await store.writeImmutableJson(
    `delivery/decisions/${decision.decisionId}.json`,
    decision,
  );
  await store.writeImmutableJson(
    `operations/${decision.idempotencyKeyHash}.json`,
    {
      version: 1,
      operationId: decision.decisionId,
      kind: "delivery_decision",
      runId: state.runId,
      idempotencyKeyHash: decision.idempotencyKeyHash,
      payloadHash,
      result: decision,
      createdAt: decidedAt,
    },
  );
  return decision;
}

export async function executeDelivery(
  options: RunLocation & {
    expectedPlanHash: string;
    idempotencyKey: string;
    adapter?: GitHubDeliveryAdapter;
    signal?: AbortSignal;
    monitorTimeoutMs?: number;
    onProgress?: (event: DeliveryProgressEvent) => void;
    now?: () => Date;
  },
): Promise<DeliveryResult> {
  const { store, state } = await openRun(options);
  const plan = await planDelivery(options);
  if (plan.planHash !== options.expectedPlanHash)
    throw new Error("Delivery plan is stale");
  const decision = await readCurrentDeliveryDecision(store);
  if (
    !decision ||
    decision.planHash !== plan.planHash ||
    decision.patchSha256 !== plan.patchSha256
  )
    throw new Error("No current delivery authorization exists");
  const payloadHash = hashValue(
    JSON.stringify({
      planHash: plan.planHash,
      decisionId: decision.decisionId,
    }),
  );
  const replay = await readOperation(store, options.idempotencyKey);
  if (replay) {
    if (replay.payloadHash !== payloadHash)
      throw new Error("Idempotency key was already used with another payload");
    return DeliveryResultSchema.parse(replay.result);
  }
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const operationId = stableId(
    "delivery",
    state.runId,
    plan.planHash,
    options.idempotencyKey,
  );
  let result: DeliveryResult;
  try {
    if (decision.action === "reject" || decision.action === "decide_later") {
      result = DeliveryResultSchema.parse({
        version: 1,
        operationId,
        runId: state.runId,
        patchSha256: plan.patchSha256,
        status: decision.action === "reject" ? "cancelled" : "pending",
        terminalReason:
          decision.action === "reject"
            ? "Delivery was rejected."
            : "Delivery remains pending.",
        startedAt,
        updatedAt: now().toISOString(),
      });
    } else if (decision.action === "apply_local") {
      const applied = await applyAcceptedPatch({
        runId: options.runId,
        ...(options.repositoryRoot
          ? { repositoryRoot: options.repositoryRoot }
          : {}),
        ...(options.artifactRoot ? { artifactRoot: options.artifactRoot } : {}),
        idempotencyKey: `${options.idempotencyKey}:apply`,
        expectedPatchSha256: plan.patchSha256,
      });
      result = DeliveryResultSchema.parse({
        version: 1,
        operationId,
        runId: state.runId,
        patchSha256: plan.patchSha256,
        status: "completed",
        terminalReason: `Applied ${String(applied.changedPaths.length)} changed paths locally.`,
        startedAt,
        updatedAt: now().toISOString(),
      });
    } else {
      if (!state.config.deliveryEnabled)
        throw new Error("External delivery is disabled by configuration");
      const target = plan.target;
      if (!target.repository)
        throw new Error("Delivery target has no GitHub repository identity");
      const review = await readCurrentReview(store);
      if (!review?.selectedContestantId)
        throw new Error("Accepted contestant is missing");
      const patchPath = await trustedPatchPath(
        state,
        review.selectedContestantId,
        store.runDirectory,
      );
      if ((await patchSha256(patchPath)) !== plan.patchSha256)
        throw new Error("Accepted patch digest changed before delivery");
      const adapter =
        options.adapter ??
        new GitHubCliDeliveryAdapter(state.config.repositoryRoot);
      const prepared = await adapter.prepare({
        state,
        target,
        patchPath,
        patchSha256: plan.patchSha256,
        branch: plan.branch ?? target.headBranch ?? "",
        closeIssue: decision.closeIssue,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const eventWrites: Array<Promise<string>> = [];
      let eventSequence = 0;
      const onProgress = (event: DeliveryProgressEvent): void => {
        eventSequence += 1;
        const eventId = `${event.operationId}-${String(eventSequence).padStart(4, "0")}`;
        eventWrites.push(
          store.writeImmutableJson(`delivery/events/${eventId}.json`, {
            version: 1,
            eventId,
            sequence: eventSequence,
            ...event,
          }),
        );
        options.onProgress?.(event);
      };
      let pullRequest = await adapter.getPullRequest(
        target.repository,
        prepared.pullRequestNumber,
        options.signal,
      );
      if (pullRequest.headSha !== prepared.commitSha)
        throw new Error("Pull request head changed after delivery preparation");
      if (pullRequest.state === "closed")
        throw new Error("Pull request closed without merging");
      const shouldMonitor =
        decision.mergeAfterChecks || decision.action === "merge_pull_request";
      let monitorFailure: unknown;
      if (shouldMonitor) {
        try {
          pullRequest = await monitorPullRequest({
            adapter,
            repository: target.repository,
            pullRequestNumber: prepared.pullRequestNumber,
            expectedHeadSha: prepared.commitSha,
            mergeAuthorized: true,
            operationId,
            runId: state.runId,
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.monitorTimeoutMs
              ? { timeoutMs: options.monitorTimeoutMs }
              : {}),
            ...(options.now ? { now: options.now } : {}),
            onProgress,
          });
        } catch (error) {
          monitorFailure = error;
        }
      }
      const eventResults = await Promise.allSettled(eventWrites);
      if (monitorFailure !== undefined) {
        if (monitorFailure instanceof Error) throw monitorFailure;
        throw new Error("Delivery monitoring failed with a non-Error value");
      }
      const failedEventWrite = eventResults.find(
        (event): event is PromiseRejectedResult => event.status === "rejected",
      );
      if (failedEventWrite) {
        const reason: unknown = failedEventWrite.reason;
        if (reason instanceof Error) throw reason;
        throw new Error("Delivery event persistence failed");
      }
      const linkedIssueState =
        pullRequest.state === "merged" &&
        target.kind === "github_issue" &&
        target.number
          ? await adapter.getIssueState(
              target.repository,
              target.number,
              options.signal,
            )
          : undefined;
      result = DeliveryResultSchema.parse({
        version: 1,
        operationId,
        runId: state.runId,
        patchSha256: plan.patchSha256,
        status:
          pullRequest.state === "merged" || !shouldMonitor
            ? "completed"
            : "waiting_for_checks",
        branch: prepared.branch,
        commitSha: prepared.commitSha,
        pullRequest,
        ...(linkedIssueState ? { linkedIssueState } : {}),
        ...(!shouldMonitor
          ? { remainingAction: "Review or merge the pull request." }
          : {}),
        startedAt,
        updatedAt: now().toISOString(),
      });
    }
  } catch (error) {
    result = DeliveryResultSchema.parse({
      version: 1,
      operationId,
      runId: state.runId,
      patchSha256: plan.patchSha256,
      status: options.signal?.aborted
        ? "cancelled"
        : error instanceof Error && /timed out/i.test(error.message)
          ? "timed_out"
          : "failed",
      terminalReason: error instanceof Error ? error.message : String(error),
      remainingAction:
        "Inspect the evidence, update the patch or target, record a new authorization if material state changed, and retry with a new idempotency key.",
      startedAt,
      updatedAt: now().toISOString(),
    });
  }
  await store.replaceDerivedJson("delivery/status.json", result);
  const keyHash = hashValue(options.idempotencyKey);
  await store.writeImmutableJson(`operations/${keyHash}.json`, {
    version: 1,
    operationId,
    kind: "execute_delivery",
    runId: state.runId,
    idempotencyKeyHash: keyHash,
    payloadHash,
    result,
    createdAt: startedAt,
  });
  return result;
}

export async function getDeliveryStatus(
  options: RunLocation,
): Promise<DeliveryResult | undefined> {
  const { store } = await openRun(options);
  return readDeliveryResult(store);
}
