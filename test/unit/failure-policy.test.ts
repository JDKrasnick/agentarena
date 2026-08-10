import { describe, expect, it, vi } from "vitest";
import {
  assertFailureRetryAllowed,
  distinctFailureKey,
  finalizeFailureRecord,
  runWithTargetedRetry,
} from "../../src/failures/policy.js";
import type { FailureRecord } from "../../src/contracts/failure.js";

const DIGEST = "a".repeat(64);

describe("bounded failure policy", () => {
  it("persists attempt one before starting the only retry", async () => {
    const events: string[] = [];
    const persist = vi.fn((record: FailureRecord) => {
      events.push(`persist-${String(record.attempts.length)}`);
      return Promise.resolve();
    });
    const result = await runWithTargetedRetry({
      failureId: "failure-1",
      stage: "command",
      subject: "required:test",
      category: "command_execution",
      causalDigest: DIGEST,
      run: (attempt) => {
        events.push(`run-${String(attempt)}`);
        return Promise.resolve(attempt === 1 ? "failed" : "passed");
      },
      isFailure: (value) => value === "failed",
      persist,
      reusedArtifactRefs: ["validated-review.json"],
      now: (() => {
        let tick = 0;
        return () => new Date(Date.UTC(2026, 7, 10, 0, 0, tick++));
      })(),
    });

    expect(events).toEqual(["run-1", "persist-1", "run-2", "persist-2"]);
    expect(result.record).toMatchObject({
      terminalDisposition: "recovered",
      reusedArtifactRefs: ["validated-review.json"],
      attempts: [
        { attempt: 1, status: "failed" },
        { attempt: 2, status: "succeeded" },
      ],
    });
    expect(() => assertFailureRetryAllowed(result.record)).toThrow(/exhausted/);
  });

  it("does not stack retries when the same cause is routed differently", () => {
    const base = {
      stage: "parsing" as const,
      subject: "round-1:a->b",
      category: "invalid_output" as const,
      causalDigest: DIGEST,
    };
    expect(distinctFailureKey(base)).toBe(
      distinctFailureKey({ ...base, laneId: "renamed-lane" }),
    );
  });

  it("records exhausted coverage without permitting a third attempt", async () => {
    const { record } = await runWithTargetedRetry({
      failureId: "failure-2",
      stage: "evidence_execution",
      subject: "attack-1",
      category: "service_unavailable",
      causalDigest: DIGEST,
      run: (attempt) => Promise.resolve(`failed-${String(attempt)}`),
      isFailure: () => true,
      persist: () => Promise.resolve(),
    });
    expect(finalizeFailureRecord(record, "coverage_lost")).toMatchObject({
      terminalDisposition: "coverage_lost",
      attempts: [{ attempt: 1 }, { attempt: 2 }],
    });
  });
});
