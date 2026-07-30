import { mkdtemp, writeFile } from "node:fs/promises";
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
import { hashValue } from "../../src/review/store.js";
import { makeRunState } from "../helpers/run-state.js";

describe("idempotent GitHub delivery", () => {
  it("creates one prepared PR across execution retries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-delivery-"));
    const artifactRoot = path.join(root, "runs");
    const store = new ArtifactStore(artifactRoot, "run-12345678");
    await store.initialize();
    const state = makeRunState({
      repositoryRoot: root,
      runDirectory: store.runDirectory,
    });
    state.config.artifactRoot = artifactRoot;
    state.config.deliveryEnabled = true;
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
    state.contestants.claude!.finalPatchPath = patchPath;
    state.patchQualityFacts.claude!.patchSha256 = hashValue(patch);
    state.reviewPrompt = undefined;
    await store.writeState(state);
    const prompt = await import("../../src/review/service.js").then(
      ({ reviewRun }) =>
        reviewRun({
          runId: state.runId,
          repositoryRoot: root,
          artifactRoot,
        }),
    );
    const choice = prompt.choices.find(
      (candidate) => candidate.contestantId === "claude",
    )!;
    await store.writeImmutableJson("reviews/accepted.json", {
      version: 1,
      decisionId: "accepted",
      runId: state.runId,
      promptId: prompt.promptId,
      status: "accepted",
      selectedContestantId: "claude",
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
      repositoryRoot: root,
      artifactRoot,
    });
    await recordDeliveryDecision({
      runId: state.runId,
      repositoryRoot: root,
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
      runId: state.runId,
      repositoryRoot: root,
      artifactRoot,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "delivery-execute",
      adapter,
    });
    const replay = await executeDelivery({
      runId: state.runId,
      repositoryRoot: root,
      artifactRoot,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "delivery-execute",
      adapter,
    });
    expect(first.pullRequest?.number).toBe(9);
    expect(replay.operationId).toBe(first.operationId);
    expect(prepared).toBe(1);
  });
});
