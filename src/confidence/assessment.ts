import { calculateCanonicalHash } from "../contracts/round.js";
import { stableId } from "../core/ids.js";
import {
  CoverageAssessmentSchema,
  CoverageDecisionSchema,
  type CoverageAssessment,
  type CoverageAttempt,
  type CoverageDecision,
  type CoverageLaneAssessment,
  type CoverageStageName,
  type ContestantId,
  type PermissionPolicy,
  type RunState,
} from "../core/types.js";

export function requiredCoverageLanes(
  mode: RunState["config"]["mode"],
  rounds: readonly (1 | 2 | 3 | 4 | 5)[] = [1, 2, 3],
): Array<{
  round: 1 | 2 | 3 | 4 | 5;
  attacker: ContestantId;
  target: ContestantId;
}> {
  return rounds.flatMap((round) =>
    mode === "siege"
      ? [{ round, attacker: "a" as const, target: "b" as const }]
      : [
          { round, attacker: "a" as const, target: "b" as const },
          { round, attacker: "b" as const, target: "a" as const },
        ],
  );
}

function attempt(
  state: CoverageAttempt["state"],
  evidencePaths: string[] = [],
  reasonCode?: string,
  attemptNumber: CoverageAttempt["attempt"] = 1,
): CoverageAttempt {
  return {
    attempt: attemptNumber,
    state,
    ...(reasonCode ? { reasonCode } : {}),
    evidencePaths,
  };
}

function stage(
  name: CoverageStageName,
  attempts: CoverageAttempt[],
): CoverageLaneAssessment["stages"][number] {
  const last = attempts.at(-1)!;
  return {
    stage: name,
    finalState:
      last.state === "failed"
        ? "failed"
        : last.state === "not_applicable"
          ? "not_applicable"
          : "completed",
    attempts,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Derive the auditable assessment from persisted lane records. House activity
 * is deliberately ignored: it is useful evidence, but never a required lane.
 */
export function assessBattleCoverage(
  state: RunState,
  permissionPolicy?: PermissionPolicy,
): CoverageAssessment {
  const coverageV2 = state.schemaVersion >= 6;
  const executedRounds = [1, 2, 3, 4, 5].filter(
    (round) =>
      Object.values(state.contestants).some((contestant) =>
        contestant?.rounds.some((entry) => entry.round === round),
      ) ||
      state.reviewInvocations.some((entry) => entry.round === round) ||
      state.attackInvocations.some((entry) => entry.round === round) ||
      state.attacks.some((entry) => entry.round === round) ||
      state.adaptiveDecisions.some((entry) => entry.round === round),
  ) as Array<1 | 2 | 3 | 4 | 5>;
  const legacyConfiguredRounds = [1, 2, 3, 4, 5].slice(
    0,
    state.config.rounds,
  ) as Array<1 | 2 | 3 | 4 | 5>;
  const lanes: CoverageLaneAssessment[] = requiredCoverageLanes(
    state.config.mode,
    executedRounds.length ? executedRounds : legacyConfiguredRounds,
  ).map(({ round, attacker, target }) => {
    const id = `round-${String(round)}:${attacker}->${target}`;
    const reviews = state.reviewInvocations.filter(
      (entry) =>
        entry.round === round &&
        entry.reviewer === attacker &&
        entry.target === target,
    );
    // One lane can compose two ordinary review attempts with packet-size,
    // validation, and blocker refreshes. Preserve all five audit records.
    const reviewAttempts = reviews;
    const review = reviewAttempts.at(-1);
    const focusedRecords = state.attackInvocations.filter(
      (entry) =>
        entry.round === round &&
        entry.attacker === attacker &&
        entry.target === target &&
        entry.detail !== "Correction-only reconciliation lane",
    );
    const blockerRefreshOccurred = focusedRecords.some(
      (entry, index) =>
        index > 0 &&
        Boolean(entry.handoffPacketId) &&
        Boolean(focusedRecords[index - 1]?.handoffPacketId) &&
        entry.handoffPacketId !== focusedRecords[index - 1]!.handoffPacketId,
    );
    const focusedAttemptsRecords = focusedRecords.slice(
      0,
      blockerRefreshOccurred ? 3 : 2,
    );
    const focused = focusedAttemptsRecords.at(-1);
    const attacks = state.attacks.filter(
      (entry) =>
        entry.round === round &&
        entry.origin.kind === "contestant" &&
        entry.origin.contestant === attacker &&
        entry.targets.includes(target),
    );
    const explicitEmpty = focused?.parseOutcome === "valid_empty";
    const usable = attacks.filter(
      (entry) =>
        ![
          "submitted",
          "provisional_infrastructure",
          "infrastructure_error",
          "execution_inconclusive",
          "capability_denied",
          "judge_unable",
        ].includes(entry.status),
    );
    const partial = attacks.filter(
      (entry) => entry.evidenceProvenance === "judge_partial",
    );
    const retryCandidate = (
      "reconciliationQueue" in state ? state.reconciliationQueue : []
    ).find(
      (entry) =>
        entry.actor === attacker &&
        entry.target === target &&
        entry.sourceRound === round &&
        entry.attemptCount === 2,
    );
    const focusedAttempts = focusedAttemptsRecords.map((record, index) =>
      attempt(
        record.parseOutcome === "valid_empty"
          ? "valid_empty"
          : record.parseOutcome === "valid" || record.parseOutcome === "partial"
            ? "succeeded"
            : "failed",
        [record.parsedArtifactPath, record.rawArtifactPath].filter(
          (value): value is string => Boolean(value),
        ),
        record.parseOutcome ? undefined : "focused_description_failed",
        (index + 1) as CoverageAttempt["attempt"],
      ),
    );
    if (!focusedAttempts.length)
      focusedAttempts.push(
        attempt("failed", [], "focused_description_missing"),
      );
    if (retryCandidate && focusedAttempts.length < 2) {
      focusedAttempts.push(
        attempt(
          retryCandidate.status === "corrected" ? "succeeded" : "failed",
          [retryCandidate.correctionParsedArtifactPath].filter(
            (value): value is string => Boolean(value),
          ),
          retryCandidate.discardReason,
          2,
        ),
      );
    }

    const usableTerminal = explicitEmpty || usable.length > 0;
    // Legacy partial reviews may already own a consumable packet artifact.
    // Trusted v2 retries never create one from an exhausted partial parse.
    const reviewOutcomeUsable = (
      record: (typeof reviews)[number] | undefined,
    ): boolean =>
      record?.parseOutcome === "valid" ||
      record?.parseOutcome === "valid_empty" ||
      (record?.parseOutcome === "partial" && Boolean(record.artifactPath)) ||
      (!coverageV2 && record?.parseOutcome === undefined);
    const reviewCompleted = Boolean(
      review?.invocation.status === "succeeded" && reviewOutcomeUsable(review),
    );
    const focusedCompleted = focusedAttempts.at(-1)?.state !== "failed";
    const attackPathResolved =
      reviewCompleted && focusedCompleted && usableTerminal;
    const reasonCodes: string[] = [];
    if (!review) reasonCodes.push("review_missing");
    else if (review.parseOutcome === "partial")
      reasonCodes.push("review_partial");
    else if (
      review.invocation.status !== "succeeded" ||
      review.parseOutcome === "invalid"
    )
      reasonCodes.push("review_failed");
    if (!focusedCompleted)
      reasonCodes.push(
        focused ? "focused_description_failed" : "focused_description_missing",
      );
    if (!explicitEmpty && focused && focused.attackCount > attacks.length)
      reasonCodes.push("submitted_path_lost");
    for (const attack of attacks) {
      if (attack.status === "capability_denied")
        reasonCodes.push("required_capability_unavailable");
      if (
        [
          "provisional_infrastructure",
          "infrastructure_error",
          "execution_inconclusive",
          "judge_unable",
        ].includes(attack.status)
      )
        reasonCodes.push(`attack_${attack.status}`);
      if (attack.evidenceProvenance === "judge_partial")
        reasonCodes.push("judge_partial_35_percent_damage");
    }
    if (!usableTerminal) reasonCodes.push("no_usable_terminal_result");
    if (retryCandidate?.status === "discarded")
      reasonCodes.push("targeted_retry_exhausted");

    const executionPaths = attacks.flatMap((entry) =>
      entry.checks.flatMap((check) =>
        check.command
          ? [check.command.stdoutPath, check.command.stderrPath]
          : [],
      ),
    );
    const hasRepairableDefect = usable.some(
      (entry) => entry.status === "landed" || entry.status === "shared_defect",
    );
    const finalValidationAttempted =
      state.contestants[target]?.checks.some(
        (check) => check.id === "final-required",
      ) ?? false;
    const expectedFinalCheckIds = attacks
      .filter(
        (entry) =>
          entry.status === "landed" || entry.status === "shared_defect",
      )
      .flatMap((entry) => [
        ...(entry.browserProbe ? [`final-browser-${entry.id}`] : []),
        ...(entry.caseBundle?.cases
          .filter((caseEntry) => caseEntry.status !== "rejected")
          .map((caseEntry) => `final-${caseEntry.id}`) ??
          (entry.evidenceKind === "browser_probe"
            ? []
            : [`final-${stableId("case", entry.id, "visible")}`])),
      ]);
    const finalChecks = expectedFinalCheckIds.flatMap((checkId) => {
      const check = state.contestants[target]?.checks.find(
        (candidate) => candidate.id === checkId,
      );
      return check ? [check] : [];
    });
    const finalEvidenceRequired =
      hasRepairableDefect &&
      (finalValidationAttempted || state.status === "inconclusive");
    const finalEvidenceMissing =
      finalEvidenceRequired &&
      (expectedFinalCheckIds.length === 0 ||
        finalChecks.length !== expectedFinalCheckIds.length);
    const finalEvidenceInfrastructure = finalChecks.some(
      (check) => check.status === "infrastructure_error",
    );
    const finalEvidenceSemanticFailure = finalChecks.some(
      (check) => check.status === "failed",
    );
    const finalEvidenceResolved =
      !finalEvidenceRequired ||
      (!finalEvidenceMissing && !finalEvidenceInfrastructure);
    if (finalEvidenceMissing) reasonCodes.push("final_reproducer_missing");
    if (finalEvidenceInfrastructure)
      reasonCodes.push("final_reproducer_infrastructure");
    if (finalEvidenceSemanticFailure)
      reasonCodes.push("final_reproducer_failed");
    const targetRound = state.contestants[target]?.rounds.find(
      (entry) => entry.round === round,
    );
    const repairRequired =
      hasRepairableDefect && targetRound?.postAttackStatus !== "downed";
    const repairAttempts =
      targetRound?.repairAttempts ??
      (targetRound?.repair ? [targetRound.repair] : []);
    const repairJudgments = state.repairJudgments.filter(
      (entry) =>
        entry.round === round &&
        entry.contestantId === target &&
        attacks.some(
          (attack) => attack.rootDefectId === entry.canonicalDefectId,
        ),
    );
    const repairJudgeUnable = repairJudgments.some(
      (entry) => entry.decision === "unable",
    );
    const repairCompleted =
      !repairRequired ||
      (!repairJudgeUnable && repairAttempts.at(-1)?.status === "succeeded");
    if (repairRequired && !repairAttempts.length)
      reasonCodes.push("repair_missing");
    else if (repairRequired && !repairCompleted)
      reasonCodes.push(
        repairJudgeUnable ? "repair_judge_unable" : "repair_failed",
      );
    const laneResolved =
      attackPathResolved && repairCompleted && finalEvidenceResolved;
    const stages = [
      stage(
        "review",
        reviewAttempts.length
          ? reviewAttempts.map((record, index) =>
              attempt(
                record.invocation.status === "succeeded" &&
                  reviewOutcomeUsable(record)
                  ? record.parseOutcome === "valid_empty"
                    ? "valid_empty"
                    : "succeeded"
                  : "failed",
                [record.artifactPath, record.parsedArtifactPath].filter(
                  (value): value is string => Boolean(value),
                ),
                record.invocation.status === "succeeded"
                  ? undefined
                  : "review_failed",
                (index + 1) as CoverageAttempt["attempt"],
              ),
            )
          : [attempt("failed", [], "review_missing")],
      ),
      stage(
        coverageV2 ? "attack_submission" : "focused_description",
        focusedAttempts,
      ),
      stage(coverageV2 ? "evidence_construction" : "case_construction", [
        attempt(
          explicitEmpty
            ? "not_applicable"
            : attacks.length
              ? "succeeded"
              : "failed",
          attacks.map((entry) => entry.patchPath),
          attacks.length ? undefined : "case_construction_failed",
        ),
      ]),
      stage("execution", [
        attempt(
          explicitEmpty
            ? "not_applicable"
            : usableTerminal
              ? "succeeded"
              : "failed",
          executionPaths,
          usableTerminal ? undefined : "execution_no_terminal_result",
        ),
        ...(finalEvidenceRequired
          ? [
              attempt(
                finalEvidenceResolved && !finalEvidenceSemanticFailure
                  ? "succeeded"
                  : "failed",
                finalChecks.flatMap((check) =>
                  check.command
                    ? [check.command.stdoutPath, check.command.stderrPath]
                    : [],
                ),
                finalEvidenceMissing
                  ? "final_reproducer_missing"
                  : finalEvidenceInfrastructure
                    ? "final_reproducer_infrastructure"
                    : finalEvidenceSemanticFailure
                      ? "final_reproducer_failed"
                      : undefined,
                2,
              ),
            ]
          : []),
      ]),
      stage("semantic_adjudication", [
        attempt(
          explicitEmpty
            ? "not_applicable"
            : usableTerminal
              ? "succeeded"
              : "failed",
          [],
          usableTerminal ? undefined : "judge_unable_to_adjudicate",
        ),
      ]),
      stage("repair", [
        ...(repairRequired
          ? repairAttempts.length
            ? repairAttempts.slice(0, 3).map((entry, index) =>
                attempt(
                  entry.status === "succeeded" &&
                    !(repairJudgeUnable && index === repairAttempts.length - 1)
                    ? "succeeded"
                    : "failed",
                  [entry.promptPath, entry.transcriptPath].filter(
                    (value): value is string => Boolean(value),
                  ),
                  entry.status === "succeeded" && !repairJudgeUnable
                    ? undefined
                    : repairJudgeUnable && index === repairAttempts.length - 1
                      ? "repair_judge_unable"
                      : "repair_failed",
                  (index + 1) as CoverageAttempt["attempt"],
                ),
              )
            : [attempt("failed", [], "repair_missing")]
          : [attempt("not_applicable")]),
      ]),
    ];
    const degraded =
      laneResolved &&
      (partial.length > 0 ||
        focused?.parseOutcome === "partial" ||
        review?.parseOutcome === "partial" ||
        reasonCodes.includes("submitted_path_lost") ||
        finalEvidenceSemanticFailure);
    const evidenceBasis: CoverageLaneAssessment["evidenceBasis"] = explicitEmpty
      ? "explicit_empty"
      : partial.length
        ? "partial_judge"
        : usable.some((entry) => entry.evidenceProvenance === "judge_confirmed")
          ? "judge_confirmed"
          : usable.some((entry) => entry.status === "judge_rejected")
            ? "judge_rejected"
            : usable.length
              ? "mechanical"
              : "none";
    return {
      id,
      round,
      attacker,
      target,
      required: true,
      finalState: laneResolved
        ? degraded
          ? "degraded"
          : "completed"
        : "unresolved",
      evidenceBasis,
      reasonCodes: unique(reasonCodes),
      stages,
    };
  });

  const requiredCapabilityGap =
    permissionPolicy?.capabilities.some(
      (entry) =>
        entry.requirement === "required" && entry.status !== "approved",
    ) ?? false;
  const counts = {
    required: lanes.length,
    completed: lanes.filter((lane) => lane.finalState === "completed").length,
    degraded: lanes.filter((lane) => lane.finalState === "degraded").length,
    unresolved: lanes.filter((lane) => lane.finalState === "unresolved").length,
  };
  const contestantAttacks = state.attacks.filter(
    (entry) =>
      entry.origin.kind === "contestant" && typeof entry.round === "number",
  );
  const evidenceCounts = {
    mechanical: contestantAttacks.filter(
      (entry) =>
        ![
          "submitted",
          "capability_denied",
          "provisional_infrastructure",
          "infrastructure_error",
          "execution_inconclusive",
          "judge_rejected",
          "judge_unable",
        ].includes(entry.status) &&
        (!entry.evidenceProvenance ||
          entry.evidenceProvenance === "mechanical"),
    ).length,
    judgeConfirmed: contestantAttacks.filter(
      (entry) => entry.evidenceProvenance === "judge_confirmed",
    ).length,
    judgePartial: contestantAttacks.filter(
      (entry) => entry.evidenceProvenance === "judge_partial",
    ).length,
    judgeRejected: contestantAttacks.filter(
      (entry) => entry.status === "judge_rejected",
    ).length,
    explicitEmpty: lanes.filter(
      (lane) => lane.evidenceBasis === "explicit_empty",
    ).length,
  };
  const reasonCodes = unique([
    ...lanes.flatMap((lane) => lane.reasonCodes),
    ...(requiredCapabilityGap ? ["required_capability_gap_accepted"] : []),
  ]);
  const retryHistory = lanes.flatMap((lane) =>
    lane.stages.flatMap((entry) =>
      entry.attempts.length >= 2
        ? [
            {
              laneId: lane.id,
              stage: entry.stage,
              result:
                entry.finalState === "completed"
                  ? ("succeeded" as const)
                  : ("failed" as const),
              ...(entry.attempts.at(-1)?.reasonCode
                ? { reasonCode: entry.attempts.at(-1)!.reasonCode }
                : {}),
            },
          ]
        : [],
    ),
  );
  const draft = {
    version:
      state.schemaVersion >= 7
        ? (3 as const)
        : coverageV2
          ? (2 as const)
          : (1 as const),
    runId: state.runId,
    mode: state.config.mode,
    confidence:
      counts.unresolved > 0
        ? ("provisional" as const)
        : counts.degraded > 0 ||
            evidenceCounts.judgePartial > 0 ||
            requiredCapabilityGap
          ? ("reduced_confidence" as const)
          : ("full_confidence" as const),
    requiredLanes: lanes,
    counts,
    evidenceCounts,
    reasonCodes,
    retryHistory,
  };
  return CoverageAssessmentSchema.parse({
    ...draft,
    assessmentDigest: calculateCanonicalHash(draft),
  });
}

export function createCoverageDecision(input: {
  runId: string;
  assessmentDigest: string;
  decision: CoverageDecision["decision"];
  decidedAt: string;
}): CoverageDecision {
  const draft = { version: 1 as const, ...input };
  return CoverageDecisionSchema.parse({
    ...draft,
    decisionDigest: calculateCanonicalHash(draft),
  });
}

export function assertTargetedRetryAllowed(attemptsAlreadyMade: number): void {
  if (attemptsAlreadyMade >= 2)
    throw new Error("Targeted retry allowance is exhausted for this failure");
}

export function coverageAllowsPatchReview(
  state: Pick<RunState, "coverageAssessment" | "coverageDecision">,
): boolean {
  if (!state.coverageAssessment) return true; // Legacy/unknown compatibility.
  if (state.coverageDecision?.decision === "inconclusive") return false;
  return (
    state.coverageAssessment.confidence !== "provisional" ||
    state.coverageDecision?.decision === "accept-reduced"
  );
}
