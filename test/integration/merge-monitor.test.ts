import { describe, expect, it } from "vitest";
import { monitorPullRequest } from "../../src/delivery/monitor.js";
import type { GitHubDeliveryAdapter } from "../../src/delivery/github.js";
import type { PullRequestState } from "../../src/delivery/types.js";

function state(
  checks: PullRequestState["checks"],
  merged = false,
): PullRequestState {
  return {
    repository: "acme/repo",
    number: 1,
    url: "https://github.com/acme/repo/pull/1",
    headSha: "head",
    state: merged ? "merged" : "open",
    checks,
    reviews: "approved",
    mergeable: "mergeable",
    queued: false,
  };
}

describe("merge monitor", () => {
  it("waits for checks and requests merge exactly once", async () => {
    const states = [state("pending"), state("success"), state("success", true)];
    let reads = 0;
    let merges = 0;
    const adapter: GitHubDeliveryAdapter = {
      prepare: () => Promise.reject(new Error("unused")),
      getPullRequest: () =>
        Promise.resolve(states[Math.min(reads++, states.length - 1)]!),
      requestMerge: () => {
        merges += 1;
        return Promise.resolve();
      },
      getIssueState: () => Promise.resolve("closed"),
    };
    const result = await monitorPullRequest({
      adapter,
      repository: "acme/repo",
      pullRequestNumber: 1,
      expectedHeadSha: "head",
      mergeAuthorized: true,
      operationId: "operation",
      runId: "run",
      timeoutMs: 100,
      initialDelayMs: 1,
      maxDelayMs: 1,
      sleep: () => Promise.resolve(),
    });
    expect(result.state).toBe("merged");
    expect(merges).toBe(1);
  });

  it("returns deterministic failure evidence for failed checks", async () => {
    const adapter: GitHubDeliveryAdapter = {
      prepare: () => Promise.reject(new Error("unused")),
      getPullRequest: () => Promise.resolve(state("failure")),
      requestMerge: () => Promise.resolve(),
      getIssueState: () => Promise.resolve("open"),
    };
    await expect(
      monitorPullRequest({
        adapter,
        repository: "acme/repo",
        pullRequestNumber: 1,
        expectedHeadSha: "head",
        mergeAuthorized: true,
        operationId: "operation",
        runId: "run",
      }),
    ).rejects.toThrow("checks failed");
  });

  it("propagates cancellation to an in-flight pull request read", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const adapter: GitHubDeliveryAdapter = {
      prepare: () => Promise.reject(new Error("unused")),
      getPullRequest: (_repository, _number, signal) => {
        receivedSignal = signal;
        return Promise.reject(new Error("cancelled"));
      },
      requestMerge: () => Promise.resolve(),
      getIssueState: () => Promise.resolve("open"),
    };
    await expect(
      monitorPullRequest({
        adapter,
        repository: "acme/repo",
        pullRequestNumber: 1,
        expectedHeadSha: "head",
        mergeAuthorized: true,
        operationId: "operation",
        runId: "run",
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(receivedSignal).toBe(controller.signal);
  });
});
