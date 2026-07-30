import { describe, expect, it } from "vitest";
import { deriveDeliveryPlan } from "../../src/delivery/plan.js";
import type { ReviewDecision } from "../../src/review/store.js";
import { makeRunState } from "../helpers/run-state.js";

const review: ReviewDecision = {
  version: 1,
  decisionId: "decision",
  runId: "run-12345678",
  promptId: "prompt",
  status: "accepted",
  selectedContestantId: "claude",
  selectionSource: "recommended",
  patchSha256: "b".repeat(64),
  baseCommit: "a".repeat(40),
  channel: "api",
  attestationHash: "c".repeat(64),
  idempotencyKeyHash: "d".repeat(64),
  decidedAt: "2026-07-29T00:00:00.000Z",
};

describe("delivery plan", () => {
  it("keeps local tasks local", () => {
    const state = makeRunState();
    state.deliveryTarget = { kind: "local_task" };
    expect(deriveDeliveryPlan(state, review)).toMatchObject({
      availableActions: ["apply_local", "reject", "decide_later"],
      recommendedAction: "apply_local",
    });
  });

  it("plans a deterministic issue branch without enabling merge", () => {
    const state = makeRunState();
    state.deliveryTarget = {
      kind: "github_issue",
      repository: "acme/repo",
      number: 17,
      url: "https://github.com/acme/repo/issues/17",
    };
    const plan = deriveDeliveryPlan(state, review);
    expect(plan.branch).toContain("github_issue-17-run-1234");
    expect(plan.availableActions).not.toContain("merge_pull_request");
  });
});
