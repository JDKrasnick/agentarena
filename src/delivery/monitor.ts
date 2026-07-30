import type { GitHubDeliveryAdapter } from "./github.js";
import type { DeliveryProgressEvent, PullRequestState } from "./types.js";

export interface MonitorOptions {
  adapter: GitHubDeliveryAdapter;
  repository: string;
  pullRequestNumber: number;
  expectedHeadSha: string;
  mergeAuthorized: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  now?: () => Date;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  onProgress?: (event: DeliveryProgressEvent) => void;
  operationId: string;
  runId: string;
}

function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Delivery monitoring was cancelled"),
        );
      },
      { once: true },
    );
  });
}

export async function monitorPullRequest(
  options: MonitorOptions,
): Promise<PullRequestState> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const started = now().getTime();
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  let delay = options.initialDelayMs ?? 2_000;
  const maxDelay = options.maxDelayMs ?? 30_000;
  let attempt = 0;
  let mergeRequested = false;
  while (now().getTime() - started <= timeoutMs) {
    if (options.signal?.aborted) throw options.signal.reason;
    attempt += 1;
    const state = await options.adapter.getPullRequest(
      options.repository,
      options.pullRequestNumber,
    );
    if (state.headSha !== options.expectedHeadSha)
      throw new Error("Pull request head changed while monitoring");
    options.onProgress?.({
      operationId: options.operationId,
      runId: options.runId,
      stage: "monitor_pull_request",
      status: state.state === "merged" ? "completed" : "waiting",
      attempt,
      timestamp: now().toISOString(),
      evidence: {
        checks: state.checks,
        reviews: state.reviews,
        mergeable: state.mergeable,
        queued: state.queued,
      },
    });
    if (state.state === "merged") return state;
    if (state.state === "closed")
      throw new Error("Pull request closed without merging");
    if (state.checks === "failure")
      throw new Error("Required pull request checks failed");
    if (state.reviews === "changes_requested")
      throw new Error("Pull request has changes requested");
    if (state.mergeable === "conflicting")
      throw new Error("Pull request has merge conflicts");
    if (
      options.mergeAuthorized &&
      !mergeRequested &&
      state.checks === "success" &&
      state.mergeable === "mergeable"
    ) {
      await options.adapter.requestMerge(
        options.repository,
        options.pullRequestNumber,
        options.expectedHeadSha,
      );
      mergeRequested = true;
    } else if (!options.mergeAuthorized && state.checks === "success") {
      return state;
    }
    const nextPollAt = new Date(now().getTime() + delay).toISOString();
    options.onProgress?.({
      operationId: options.operationId,
      runId: options.runId,
      stage: "monitor_pull_request",
      status: "waiting",
      attempt,
      timestamp: now().toISOString(),
      nextPollAt,
    });
    await sleep(delay, options.signal);
    delay = Math.min(maxDelay, delay * 2);
  }
  throw new Error("Timed out waiting for pull request terminal state");
}
