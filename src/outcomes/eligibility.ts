import type {
  ContestantResult,
  RunState,
  TerminalContestantDisposition,
} from "../core/types.js";

function artifactPaths(contestant: ContestantResult): string[] {
  return [
    ...new Set(
      [
        contestant.implementation?.promptPath,
        contestant.implementation?.transcriptPath,
        contestant.implementation?.submissionPath,
        ...contestant.checks.flatMap((check) => [
          check.command?.stdoutPath,
          check.command?.stderrPath,
          ...(check.validation?.attempts.flatMap((attempt) => [
            attempt.stdoutPath,
            attempt.stderrPath,
          ]) ?? []),
        ]),
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
}

/** Project the sealed implementation eligibility evidence for public consumers. */
export function projectImplementationEligibility(
  state: RunState,
): TerminalContestantDisposition[] {
  if (state.terminalOutcome?.version === 2)
    return structuredClone(state.terminalOutcome.contestants);

  const contestants = (["a", "b"] as const).flatMap((contestantId) => {
    const contestant = state.contestants[contestantId];
    return contestant ? [contestant] : [];
  });
  if (
    !contestants.some((contestant) =>
      contestant.checks.some(
        (check) => check.id === "initial-required" && check.validation,
      ),
    )
  )
    return [];

  return contestants.map((contestant) => {
    if (contestant.role === "attacker")
      return {
        contestantId: contestant.id,
        eligible: false,
        reasonCode: "test_only_role" as const,
        artifactPaths: artifactPaths(contestant),
      };
    const validation = contestant.checks.find(
      (check) => check.id === "initial-required",
    )?.validation;
    const eligible =
      validation?.outcome === "passed" &&
      contestant.status !== "failed" &&
      contestant.patchSize > 0 &&
      Boolean(contestant.currentPatchPath ?? contestant.finalPatchPath);
    const reasonCode = validation
      ? {
          passed: undefined,
          deterministic_failure: "initial_validation_failed" as const,
          confirmed_timeout: "initial_validation_timeout" as const,
          confirmed_runner_failure:
            "initial_validation_runner_failure" as const,
          unstable: "initial_validation_unstable" as const,
        }[validation.outcome]
      : undefined;
    return {
      contestantId: contestant.id,
      eligible,
      ...(reasonCode ? { reasonCode } : {}),
      artifactPaths: artifactPaths(contestant),
      ...(validation ? { validation } : {}),
    };
  });
}
