import { describe, expect, it } from "vitest";
import {
  decideProviderRecovery,
  isCausalProviderFailure,
  type ProviderStageFailure,
} from "../../src/recovery/provider-policy.js";

function failure(
  stage: ProviderStageFailure["stage"],
  provider: ProviderStageFailure["provider"] = "codex",
): ProviderStageFailure {
  return {
    version: 1,
    provider,
    stage,
    reason: "provider transport failed after retry",
    causalEvidence: ["transport connection failed"],
    artifactRefs: ["stderr.log"],
    usableTerminalResult: false,
  };
}

describe("provider recovery chain policy", () => {
  it("permits two continuations but at most one per provider", () => {
    expect(
      decideProviderRecovery(failure("review"), {
        continuationsCreated: 0,
        recoveredProviders: new Set(),
        unrecoveredFailures: 0,
      }),
    ).toEqual({ action: "recover", continuationOrdinal: 1 });
    expect(
      decideProviderRecovery(failure("review"), {
        continuationsCreated: 1,
        recoveredProviders: new Set(["codex"]),
        unrecoveredFailures: 0,
      }),
    ).toMatchObject({
      action: "ordinary_stage_semantics",
      reason: "provider_already_recovered",
    });
    expect(
      decideProviderRecovery(failure("attack_construction", "claude"), {
        continuationsCreated: 1,
        recoveredProviders: new Set(["codex"]),
        unrecoveredFailures: 0,
      }),
    ).toEqual({ action: "recover", continuationOrdinal: 2 });
  });

  it("makes a second unrecovered coverage-stage failure inconclusive", () => {
    expect(
      decideProviderRecovery(failure("review"), {
        continuationsCreated: 2,
        recoveredProviders: new Set(["codex", "claude"]),
        unrecoveredFailures: 1,
      }),
    ).toMatchObject({
      action: "inconclusive",
      reason: "second_unrecovered_failure",
    });
  });

  it("keeps correctness-critical unrecovered failures immediately inconclusive", () => {
    expect(
      decideProviderRecovery(failure("repair"), {
        continuationsCreated: 2,
        recoveredProviders: new Set(["codex", "claude"]),
        unrecoveredFailures: 0,
      }),
    ).toMatchObject({
      action: "inconclusive",
      reason: "correctness_critical_stage",
    });
  });

  it("requires causal transport evidence, exhausted retry, and no usable result", () => {
    expect(
      isCausalProviderFailure({
        transportEvidence: ["MCP OAuth failed"],
        usableTerminalResult: false,
        targetedAttempts: 2,
      }),
    ).toBe(true);
    expect(
      isCausalProviderFailure({
        transportEvidence: ["stale MCP warning"],
        usableTerminalResult: true,
        targetedAttempts: 2,
      }),
    ).toBe(false);
  });
});
