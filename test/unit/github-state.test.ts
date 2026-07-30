import { describe, expect, it } from "vitest";
import { stateFromGh } from "../../src/delivery/github.js";

const base = {
  url: "https://github.com/acme/repo/pull/1",
  number: 1,
  state: "OPEN",
  headRefOid: "head",
  mergeable: "MERGEABLE",
};

describe("GitHub pull request state", () => {
  it("keeps an empty check rollup pending", () => {
    expect(stateFromGh({ ...base, statusCheckRollup: [] }).checks).toBe(
      "pending",
    );
  });

  it("gates on required checks rather than unrelated optional failures", () => {
    expect(
      stateFromGh({
        ...base,
        requiredChecks: [{ name: "build", state: "SUCCESS", bucket: "pass" }],
        statusCheckRollup: [
          { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "optional", status: "COMPLETED", conclusion: "FAILURE" },
        ],
      }).checks,
    ).toBe("success");
  });

  it("recognizes successful legacy commit statuses", () => {
    expect(
      stateFromGh({
        ...base,
        statusCheckRollup: [{ context: "legacy", state: "SUCCESS" }],
      }).checks,
    ).toBe("success");
  });

  it("uses the current aggregate review decision", () => {
    expect(
      stateFromGh({
        ...base,
        reviewDecision: "APPROVED",
        reviews: [
          {
            state: "CHANGES_REQUESTED",
            author: { login: "reviewer" },
            submittedAt: "2026-07-29T00:00:00Z",
          },
          {
            state: "APPROVED",
            author: { login: "reviewer" },
            submittedAt: "2026-07-29T01:00:00Z",
          },
        ],
      }).reviews,
    ).toBe("approved");
  });
});
