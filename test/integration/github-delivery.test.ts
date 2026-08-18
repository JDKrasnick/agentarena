import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/store.js";
import {
  executeDelivery,
  planDelivery,
  recordDeliveryDecision,
} from "../../src/delivery/service.js";
import type { GitHubDeliveryAdapter } from "../../src/delivery/github.js";
import type { DeliveryPlan } from "../../src/delivery/types.js";
import { reviewRun } from "../../src/review/service.js";
import { writeBaseline } from "../../src/recovery/durable.js";
import { hashValue } from "../../src/review/store.js";
import { makeRunState } from "../helpers/run-state.js";

async function acceptedIssueRun(
  options: { mergeEnabled?: boolean } = {},
): Promise<{
  store: ArtifactStore;
  runId: string;
  repositoryRoot: string;
  artifactRoot: string;
  plan: DeliveryPlan;
}> {
  const repositoryRoot = await mkdtemp(
    path.join(os.tmpdir(), "arena-delivery-"),
  );
  const artifactRoot = path.join(repositoryRoot, "runs");
  const store = new ArtifactStore(artifactRoot, "run-12345678");
  await store.initialize();
  const state = makeRunState({
    repositoryRoot,
    runDirectory: store.runDirectory,
  });
  state.config.artifactRoot = artifactRoot;
  state.config.deliveryEnabled = true;
  state.config.mergeEnabled = options.mergeEnabled ?? false;
  state.deliveryTarget = {
    kind: "github_issue",
    repository: "acme/repo",
    number: 17,
    url: "https://github.com/acme/repo/issues/17",
    baseBranch: "main",
  };
  const patch =
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+export const a = 2;\n";
  const patchPath = store.resolve("patches/claude.diff");
  await writeFile(patchPath, patch);
  state.contestants.a!.finalPatchPath = patchPath;
  state.patchQualityFacts.a!.patchSha256 = hashValue(patch);
  state.contestants.b!.finalPatchPath = patchPath;
  state.patchQualityFacts.b!.patchSha256 = hashValue(patch);
  state.reviewPrompt = undefined;
  await writeBaseline({
    store,
    state,
    repositoryIdentity: "local:test",
  });
  await store.writeState(state);
  const prompt = await reviewRun({
    runId: state.runId,
    repositoryRoot,
    artifactRoot,
  });
  const choice = prompt.choices.find(
    (candidate) => candidate.contestantId === "b",
  )!;
  await store.writeImmutableJson("reviews/accepted.json", {
    version: 1,
    decisionId: "accepted",
    runId: state.runId,
    promptId: prompt.promptId,
    status: "accepted",
    selectedContestantId: "b",
    selectionSource: "recommended",
    patchSha256: choice.patchSha256,
    baseCommit: prompt.baseCommit,
    channel: "api",
    attestationHash: "a".repeat(64),
    idempotencyKeyHash: "b".repeat(64),
    decidedAt: "2026-07-29T00:00:00.000Z",
  });
  const plan = await planDelivery({
    runId: state.runId,
    repositoryRoot,
    artifactRoot,
  });
  return { store, runId: state.runId, repositoryRoot, artifactRoot, plan };
}

describe("idempotent GitHub delivery", () => {
  it("creates one prepared PR across execution retries", async () => {
    const { runId, repositoryRoot, artifactRoot, plan } =
      await acceptedIssueRun();
    await recordDeliveryDecision({
      runId,
      repositoryRoot,
      artifactRoot,
      expectedPlanHash: plan.planHash,
      action: "create_pull_request",
      approval: {
        channel: "api",
        promptId: plan.planHash,
        provenance: {
          kind: "direct_tty",
          confirmedPatchSha256: plan.patchSha256,
        },
      },
      idempotencyKey: "delivery-decision",
    });
    let prepared = 0;
    const adapter: GitHubDeliveryAdapter = {
      prepare: () => {
        prepared += 1;
        return Promise.resolve({
          branch: plan.branch!,
          commitSha: "head",
          pullRequestNumber: 9,
          pullRequestUrl: "https://github.com/acme/repo/pull/9",
        });
      },
      getPullRequest: () =>
        Promise.resolve({
          repository: "acme/repo",
          number: 9,
          url: "https://github.com/acme/repo/pull/9",
          headSha: "head",
          state: "open",
          checks: "success",
          reviews: "pending",
          mergeable: "mergeable",
          queued: false,
        }),
      requestMerge: () => Promise.resolve(),
      getIssueState: () => Promise.resolve("open"),
    };
    const first = await executeDelivery({
      runId,
      repositoryRoot,
      artifactRoot,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "delivery-execute",
      adapter,
    });
    const replay = await executeDelivery({
      runId,
      repositoryRoot,
      artifactRoot,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "delivery-execute",
      adapter,
    });
    expect(first.pullRequest?.number).toBe(9);
    expect(replay.operationId).toBe(first.operationId);
    expect(prepared).toBe(1);
  });

  it("records every monitored progress event while merging after checks", async () => {
    const { store, runId, repositoryRoot, artifactRoot, plan } =
      await acceptedIssueRun({ mergeEnabled: true });
    await recordDeliveryDecision({
      runId,
      repositoryRoot,
      artifactRoot,
      expectedPlanHash: plan.planHash,
      action: "create_pull_request",
      mergeAfterChecks: true,
      approval: {
        channel: "api",
        promptId: plan.planHash,
        provenance: {
          kind: "direct_tty",
          confirmedPatchSha256: plan.patchSha256,
        },
      },
      idempotencyKey: "delivery-decision",
    });
    let reads = 0;
    let merges = 0;
    const adapter: GitHubDeliveryAdapter = {
      prepare: () =>
        Promise.resolve({
          branch: plan.branch!,
          commitSha: "head",
          pullRequestNumber: 9,
          pullRequestUrl: "https://github.com/acme/repo/pull/9",
        }),
      getPullRequest: () => {
        reads += 1;
        return Promise.resolve({
          repository: "acme/repo",
          number: 9,
          url: "https://github.com/acme/repo/pull/9",
          headSha: "head",
          state: reads > 2 ? ("merged" as const) : ("open" as const),
          checks: "success" as const,
          reviews: "approved" as const,
          mergeable: "mergeable" as const,
          queued: false,
        });
      },
      requestMerge: () => {
        merges += 1;
        return Promise.resolve();
      },
      getIssueState: () => Promise.resolve("closed"),
    };
    const progress: string[] = [];
    const result = await executeDelivery({
      runId,
      repositoryRoot,
      artifactRoot,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "delivery-execute",
      adapter,
      monitorTimeoutMs: 10_000,
      onProgress: (event) => progress.push(event.status),
    });
    expect(result).toMatchObject({
      status: "completed",
      linkedIssueState: "closed",
    });
    expect(result.terminalReason).toBeUndefined();
    expect(merges).toBe(1);
    const events = (await readdir(store.resolve("delivery", "events"))).filter(
      (name) => name.endsWith(".json"),
    );
    expect(events).toHaveLength(progress.length);
  });
});
