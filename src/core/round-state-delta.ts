import {
  RoundStateDeltaSchema,
  type RoundResult,
  type RoundStateDelta,
} from "../contracts/round.js";
import type {
  Attack,
  AttackInvocationRecord,
  ContestantId,
  ContestantRoundResult,
  HarnessOverlay,
  ReviewInvocationRecord,
  RoundId,
  RoundPromptManifest,
  RunState,
} from "./types.js";

interface TaggedValue {
  contestantId?: ContestantId;
  kind?: "review" | "attack" | "implementation" | "repair";
  value: unknown;
}

/** Build the immutable legacy-report projection produced by one round. */
export function projectRoundStateDelta(
  before: RunState,
  after: RunState,
  roundId: RoundId,
): RoundStateDelta {
  const invocations: TaggedValue[] = [
    ...after.reviewInvocations
      .slice(before.reviewInvocations.length)
      .map((value) => ({
        contestantId: value.reviewer,
        kind: "review" as const,
        value,
      })),
    ...after.attackInvocations
      .slice(before.attackInvocations.length)
      .map((value) => ({
        contestantId: value.attacker,
        kind: "attack" as const,
        value,
      })),
  ];
  const checks: TaggedValue[] = [];
  const roundSummaries: TaggedValue[] = [];
  for (const contestantId of ["a", "b"] as const) {
    const previous = before.contestants[contestantId];
    const current = after.contestants[contestantId];
    if (!current) continue;
    checks.push(
      ...current.checks
        .slice(previous?.checks.length ?? 0)
        .map((value) => ({ contestantId, value })),
    );
    roundSummaries.push(
      ...current.rounds
        .slice(previous?.rounds.length ?? 0)
        .map((value) => ({ contestantId, value })),
    );
    if (!previous?.implementation && current.implementation)
      invocations.push({
        contestantId,
        kind: "implementation",
        value: current.implementation,
      });
    const previousRepairCount =
      previous?.rounds.filter((entry) => entry.repair).length ?? 0;
    const repairs = current.rounds
      .filter((entry) => entry.repair)
      .slice(previousRepairCount);
    invocations.push(
      ...repairs.map((entry) => ({
        contestantId,
        kind: "repair" as const,
        value: entry.repair,
      })),
    );
  }
  const attacks = after.attacks.slice(before.attacks.length);
  return RoundStateDeltaSchema.parse({
    version: 1,
    runId: after.runId,
    roundId,
    attacks,
    invocations,
    cases: attacks.flatMap((attack) =>
      attack.caseBundle
        ? [{ attackId: attack.id, value: attack.caseBundle }]
        : [],
    ),
    promptManifests: after.promptManifests.slice(before.promptManifests.length),
    harnessOverlays: after.harnessOverlays.slice(before.harnessOverlays.length),
    checks,
    roundSummaries,
  });
}

/** Apply a validated completed result and its projection before the next snapshot. */
export function applyCompletedRound(
  state: RunState,
  resultValue: RoundResult,
  deltaValue: RoundStateDelta,
): void {
  if (resultValue.status !== "completed")
    throw new Error("Only a completed round may advance mutable run state");
  const delta = RoundStateDeltaSchema.parse(deltaValue);
  if (
    delta.runId !== resultValue.runId ||
    delta.roundId !== resultValue.roundId
  )
    throw new Error("Round-state delta identity does not match its result");

  for (const resulting of resultValue.resultingContestants) {
    const contestant = state.contestants[resulting.contestantId];
    if (!contestant)
      throw new Error(`Missing contestant ${resulting.contestantId}`);
    contestant.finalHealth = resulting.health;
    contestant.healthLedger.permanentRecoil = resulting.permanentRecoil;
    contestant.healthLedger.activeDefects = resulting.activeDefects.map(
      (defect) => ({
        rootDefectId: defect.defectId,
        attackId: defect.attackId,
        damage: defect.damage as 5 | 15 | 30 | 50,
      }),
    );
    contestant.replacementCredits = structuredClone(
      resulting.replacementCredits,
    );
    contestant.status =
      resulting.status === "eliminated"
        ? "eliminated"
        : resulting.status === "pending"
          ? "pending"
          : "survived";
    if (resulting.patch) contestant.currentPatchPath = resulting.patch.path;
  }

  state.attacks.push(...(delta.attacks as Attack[]));
  for (const entry of delta.invocations as TaggedValue[]) {
    if (entry.kind === "review")
      state.reviewInvocations.push(entry.value as ReviewInvocationRecord);
    if (entry.kind === "attack")
      state.attackInvocations.push(entry.value as AttackInvocationRecord);
    if (entry.kind === "implementation" && entry.contestantId) {
      const contestant = state.contestants[entry.contestantId];
      if (contestant) contestant.implementation = entry.value as never;
    }
  }
  state.promptManifests.push(
    ...(delta.promptManifests as RoundPromptManifest[]),
  );
  state.harnessOverlays.push(...(delta.harnessOverlays as HarnessOverlay[]));
  for (const entry of delta.checks as TaggedValue[]) {
    if (entry.contestantId)
      state.contestants[entry.contestantId]?.checks.push(entry.value as never);
  }
  for (const entry of delta.roundSummaries as TaggedValue[]) {
    if (entry.contestantId)
      state.contestants[entry.contestantId]?.rounds.push(
        entry.value as ContestantRoundResult,
      );
  }
}
