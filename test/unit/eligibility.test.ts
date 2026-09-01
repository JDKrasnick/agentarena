import { describe, expect, it } from "vitest";
import type { RequiredValidationEvidence } from "../../src/core/types.js";
import { requiredValidationHasHarnessFailure } from "../../src/outcomes/eligibility.js";

function validationAttempt(
  overrides: Partial<RequiredValidationEvidence["attempts"][number]> = {},
): RequiredValidationEvidence["attempts"][number] {
  return {
    command: "npm test",
    cwd: "/tmp/arena-validation",
    exitCode: null,
    signal: null,
    timedOut: false,
    attempts: 1,
    durationMs: 10,
    stdoutPath: "/tmp/validation.stdout.log",
    stderrPath: "/tmp/validation.stderr.log",
    ...overrides,
  };
}

describe("required validation eligibility", () => {
  it("recognizes repeated harness-owned failures before forfeit selection", () => {
    expect(
      requiredValidationHasHarnessFailure({
        outcome: "confirmed_runner_failure",
        attempts: [
          validationAttempt({ failureClass: "arena_infrastructure" }),
          validationAttempt({
            termination: {
              cause: "spawn_error",
              timeoutType: null,
              startedAt: "2026-09-01T00:00:00.000Z",
              finishedAt: "2026-09-01T00:00:00.010Z",
              lastOutputAt: null,
              escalation: [],
            },
          }),
        ],
      }),
    ).toBe(true);
  });

  it("does not treat ordinary confirmed timeouts as harness-owned", () => {
    expect(
      requiredValidationHasHarnessFailure({
        outcome: "confirmed_timeout",
        attempts: [
          validationAttempt({ timedOut: true }),
          validationAttempt({ timedOut: true }),
        ],
      }),
    ).toBe(false);
  });
});
