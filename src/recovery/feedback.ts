import { createHash } from "node:crypto";
import {
  ContestantFeedbackSchema,
  calculateContestantFeedbackDigest,
  canonicalJson,
  type ContestantFeedback,
} from "../contracts/round.js";
import type {
  Attack,
  ContestantId,
  PermissionPolicy,
  RoundId,
  RunState,
} from "../core/types.js";
import type { ArtifactStore } from "../artifacts/store.js";
import { supersededAdjudicationIds } from "../attacks/challenges.js";
import { z } from "zod";

export const FEEDBACK_INLINE_LIMIT_BYTES = 24 * 1024;
export const FEEDBACK_TARGET_BYTES = 8 * 1024;
export const FEEDBACK_RANKING_VERSION = "lane-feedback-rank@2";

const FeedbackManifestSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    runId: z.string().min(1),
    roundId: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal("recovery"),
      z.literal("reconciliation"),
    ]),
    contestantId: z.enum(["a", "b"]),
    phase: z.enum(["review", "attack", "repair", "recovery"]),
    readers: z.tuple([z.enum(["contestant_a", "contestant_b"])]),
    rankingVersion: z.literal(FEEDBACK_RANKING_VERSION),
    inlineBytes: z
      .number()
      .int()
      .nonnegative()
      .max(FEEDBACK_INLINE_LIMIT_BYTES),
    feedbackSha256: z.string().regex(/^[a-f0-9]{64}$/),
    feedbackPath: z.string().min(1),
    artifactPointers: z.array(z.string()),
  })
  .strict();
export type FeedbackManifest = z.infer<typeof FeedbackManifestSchema>;

type FeedbackPhase = ContestantFeedback["phase"];

function publicReason(
  attack: Attack,
): ContestantFeedback["ownAttackOutcomes"][number]["reason"] {
  switch (attack.status) {
    case "landed":
      return "landed";
    case "unproven":
      return "oracle_not_supported";
    case "duplicate":
      return "duplicate_root_defect";
    case "self_defeating":
      return "author_patch_failed";
    case "shared_defect":
      return "shared_defect";
    case "capability_denied":
      return "capability_denied";
    case "infrastructure_error":
    case "execution_inconclusive":
    case "provisional_infrastructure":
    case "judge_unable":
      return "infrastructure_inconclusive";
    case "blocked":
    case "judge_rejected":
      return "target_did_not_fail";
    case "submitted":
    case "invalid":
      return "invalid_evidence";
    default:
      return "target_did_not_fail";
  }
}

function visibleReproducers(attack: Attack) {
  const visible = attack.caseBundle?.cases.filter(
    (entry) =>
      entry.visibility === "visible" ||
      (entry.visibility === "held_out" && entry.status === "revealed"),
  );
  if (visible?.length) {
    return visible.map((entry) => ({
      artifactId: entry.id,
      command: entry.focusedCommand,
      expectedBehavior: attack.oracle.expectedBehavior,
    }));
  }
  return [
    {
      artifactId: `attack:${attack.id}`,
      // A browser-only attack has no focused command; describing its probe is
      // the only honest reproduction instruction we can give the repair agent.
      command:
        attack.evidenceKind === "browser_probe" && attack.browserProbe
          ? `browser probe ${attack.browserProbe.id} (${attack.browserProbe.family}, ${attack.browserProbe.profile})`
          : attack.focusedCommand,
      expectedBehavior: attack.oracle.expectedBehavior,
    },
  ];
}

function roundOrder(round: RoundId): number {
  return round === "recovery" ? 4 : round === "reconciliation" ? 5 : round;
}

function compact(feedback: ContestantFeedback): ContestantFeedback {
  const bytes = (value: ContestantFeedback) =>
    Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
  if (bytes(feedback) <= FEEDBACK_TARGET_BYTES) return feedback;

  // Old healed evidence and old misses are optional. Stable attack IDs break ties.
  const active = new Set(feedback.unresolvedDefectIds);
  const incoming = [...feedback.acceptedIncomingAttacks];
  const own = [...feedback.ownAttackOutcomes];
  const candidate = {
    ...feedback,
    acceptedIncomingAttacks: incoming,
    ownAttackOutcomes: own,
    priorAdjudications: [...feedback.priorAdjudications],
  };
  let verboseFieldsCondensed = false;
  while (bytes(candidate) > FEEDBACK_TARGET_BYTES) {
    const optionalOwn = candidate.ownAttackOutcomes.findLastIndex(
      (entry) => !entry.defectId,
    );
    if (optionalOwn >= 0) {
      candidate.ownAttackOutcomes.splice(optionalOwn, 1);
      continue;
    }
    const optionalIncoming = candidate.acceptedIncomingAttacks.findLastIndex(
      (entry) => !active.has(entry.defectId),
    );
    if (optionalIncoming >= 0) {
      candidate.acceptedIncomingAttacks.splice(optionalIncoming, 1);
      continue;
    }
    const retainedAttackIds = new Set([
      ...candidate.acceptedIncomingAttacks.map((entry) => entry.attackId),
      ...candidate.ownAttackOutcomes.map((entry) => entry.attackId),
    ]);
    const optionalPointer = candidate.evidencePointers.findLastIndex(
      (entry) =>
        entry.artifactId.startsWith("attack:") &&
        !retainedAttackIds.has(entry.artifactId.slice("attack:".length)),
    );
    if (optionalPointer >= 0) {
      candidate.evidencePointers.splice(optionalPointer, 1);
      continue;
    }
    if (!verboseFieldsCondensed) {
      candidate.acceptedIncomingAttacks = candidate.acceptedIncomingAttacks.map(
        (entry) => ({
          ...entry,
          claim: entry.claim.slice(0, 512),
          visibleReproducers: entry.visibleReproducers.map((reproducer) => ({
            ...reproducer,
            command: reproducer.command.slice(0, 512),
            expectedBehavior: reproducer.expectedBehavior.slice(0, 512),
          })),
        }),
      );
      verboseFieldsCondensed = true;
      continue;
    }
    if (bytes(candidate) <= FEEDBACK_INLINE_LIMIT_BYTES) break;
    throw new Error(
      "Mandatory contestant feedback exceeds the 24 KiB inline contract",
    );
  }
  return ContestantFeedbackSchema.parse(candidate);
}

function feedbackScore(options: {
  attack: Attack;
  activeDefectIds: ReadonlySet<string>;
  roundId: RoundId;
  phase: FeedbackPhase;
  own: boolean;
}): number {
  const { attack } = options;
  let score = roundOrder(attack.round) * 100;
  if (attack.round === options.roundId) score += 10_000;
  if (attack.rootDefectId && options.activeDefectIds.has(attack.rootDefectId))
    score += 100_000;
  if (options.phase === "repair" && !options.own) score += 5_000;
  if (
    attack.caseBundle?.cases.some(
      (entry) => entry.visibility === "visible" || entry.status === "revealed",
    )
  )
    score += 500;
  if (attack.status === "duplicate") score -= 2_000;
  if (
    attack.status === "landed" &&
    attack.rootDefectId &&
    !options.activeDefectIds.has(attack.rootDefectId)
  )
    score -= 1_000;
  return score;
}

/** Pure lane-safe projection. It never reads transcripts or verifier prose. */
export function projectContestantFeedback(options: {
  state: RunState;
  contestantId: ContestantId;
  roundId: RoundId;
  phase: FeedbackPhase;
  permissions: PermissionPolicy;
}): ContestantFeedback {
  const contestant = options.state.contestants[options.contestantId];
  if (!contestant)
    throw new Error(`Missing contestant ${options.contestantId}`);
  const history = options.state.attacks.filter(
    (attack) => roundOrder(attack.round) <= roundOrder(options.roundId),
  );
  const supersededAdjudications = supersededAdjudicationIds(history);
  const activeDefectIds = new Set(
    contestant.healthLedger.activeDefects.map((entry) => entry.rootDefectId),
  );
  const incoming = history
    .filter(
      (attack) =>
        attack.status === "landed" &&
        attack.targets.includes(options.contestantId) &&
        attack.rootDefectId &&
        attack.severity &&
        attack.damage &&
        (!attack.adjudication ||
          !supersededAdjudications.has(attack.adjudication.id)),
    )
    .sort(
      (left, right) =>
        feedbackScore({
          attack: right,
          activeDefectIds,
          roundId: options.roundId,
          phase: options.phase,
          own: false,
        }) -
          feedbackScore({
            attack: left,
            activeDefectIds,
            roundId: options.roundId,
            phase: options.phase,
            own: false,
          }) || left.id.localeCompare(right.id),
    )
    .map((attack) => {
      const canonical = contestant.healthLedger.canonicalDefects?.find(
        (defect) =>
          defect.rootDefectId === attack.rootDefectId &&
          defect.status !== "superseded",
      );
      return {
        attackId: attack.id,
        defectId: attack.rootDefectId!,
        severity: canonical?.baseSeverity ?? attack.severity!,
        damage: canonical?.currentDamage ?? attack.damage!,
        evidenceBasis:
          canonical?.evidenceHistory.at(-1)?.basis ??
          attack.adjudication?.evidenceBasis ??
          (attack.evidenceProvenance === "judge_partial"
            ? "partial_judge"
            : attack.evidenceProvenance === "judge_confirmed"
              ? "judge"
              : (attack.evidenceProvenance ?? "legacy_unknown")),
        multiplier:
          canonical?.currentMultiplier ??
          (attack.adjudication?.multiplier === 0.35
            ? (0.35 as const)
            : (1 as const)),
        claim: attack.claim,
        visibleReproducers: visibleReproducers(attack),
      };
    });
  const own = history
    .filter(
      (attack) =>
        attack.origin.kind === "contestant" &&
        attack.origin.contestant === options.contestantId,
    )
    .sort(
      (left, right) =>
        feedbackScore({
          attack: right,
          activeDefectIds,
          roundId: options.roundId,
          phase: options.phase,
          own: true,
        }) -
          feedbackScore({
            attack: left,
            activeDefectIds,
            roundId: options.roundId,
            phase: options.phase,
            own: true,
          }) || left.id.localeCompare(right.id),
    )
    .flatMap((attack) =>
      attack.targets
        .filter((target) => target !== options.contestantId)
        .map((target) => ({
          attackId: attack.id,
          target,
          status:
            attack.status === "landed"
              ? ("landed" as const)
              : attack.status === "shared_defect"
                ? ("shared_defect" as const)
                : attack.status === "duplicate"
                  ? ("duplicate" as const)
                  : attack.status === "capability_denied" ||
                      attack.status === "infrastructure_error" ||
                      attack.status === "execution_inconclusive"
                    ? attack.status
                    : ("missed" as const),
          reason: publicReason(attack),
          recoil: attack.recoil ?? 0,
          ...(attack.rootDefectId &&
          (attack.status === "landed" ||
            attack.status === "shared_defect" ||
            attack.status === "duplicate")
            ? { defectId: attack.rootDefectId }
            : {}),
        })),
    );
  const unresolved = contestant.healthLedger.activeDefects.map(
    (entry) => entry.rootDefectId,
  );
  const observed = incoming.map((entry) => entry.defectId);
  const healed = [
    ...new Set(observed.filter((id) => !unresolved.includes(id))),
  ];
  const starting =
    contestant.rounds.find((entry) => entry.round === options.roundId)
      ?.startingHealth ?? contestant.finalHealth;
  const feedbackDraft = {
    version: options.state.schemaVersion >= 6 ? 3 : 2,
    runId: options.state.runId,
    roundId: options.roundId,
    contestantId: options.contestantId,
    phase: options.phase,
    health: {
      starting,
      afterAttacks: contestant.finalHealth,
      ending: contestant.finalHealth,
    },
    acceptedIncomingAttacks: incoming,
    ownAttackOutcomes: own,
    priorAdjudications: history
      .filter(
        (attack) =>
          attack.origin.kind === "contestant" &&
          attack.origin.contestant === options.contestantId &&
          attack.adjudication &&
          !supersededAdjudications.has(attack.adjudication.id),
      )
      .toSorted(
        (left, right) =>
          roundOrder(right.round) - roundOrder(left.round) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, 6)
      .map((attack) => ({
        adjudicationId: attack.adjudication!.id,
        attackId: attack.id,
        target: attack.targets[0]!,
        verdict: attack.adjudication!.verdict,
        relationship: attack.adjudication!.relationship,
        claim: attack.claim.slice(0, 512),
        expectedBehavior: attack.oracle.expectedBehavior.slice(0, 512),
        publicRationale: attack.adjudication!.rationale.slice(0, 512),
        scoreEffect: attack.adjudication!.scoreEffect,
      })),
    healedDefectIds: healed.sort(),
    unresolvedDefectIds: [...new Set(unresolved)].sort(),
    capabilityRestrictions: options.permissions.capabilities
      .filter((entry) => entry.status !== "approved")
      .map((entry) => ({ capabilityId: entry.id, status: entry.status }))
      .sort((left, right) =>
        left.capabilityId.localeCompare(right.capabilityId),
      ),
    evidencePointers: history
      .filter(
        (attack) =>
          attack.targets.includes(options.contestantId) ||
          (attack.origin.kind === "contestant" &&
            attack.origin.contestant === options.contestantId),
      )
      .map((attack) => ({
        artifactId: `attack:${attack.id}`,
        path: attack.patchPath,
      }))
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
  } as const;
  const feedback = ContestantFeedbackSchema.parse({
    ...feedbackDraft,
    projectionDigest: calculateContestantFeedbackDigest(feedbackDraft),
  });
  const compacted = compact(feedback);
  return ContestantFeedbackSchema.parse({
    ...compacted,
    projectionDigest: calculateContestantFeedbackDigest(compacted),
  });
}

export async function persistContestantFeedback(options: {
  store: ArtifactStore;
  feedback: ContestantFeedback;
}): Promise<FeedbackManifest> {
  const { feedback } = options;
  const relative = `feedback/round-${String(feedback.roundId)}/${feedback.phase}-${feedback.contestantId}.json`;
  await options.store.writeImmutableJson(relative, feedback);
  const encoded = canonicalJson(feedback);
  const manifest = FeedbackManifestSchema.parse({
    version: feedback.version >= 3 ? 3 : 2,
    runId: feedback.runId,
    roundId: feedback.roundId,
    contestantId: feedback.contestantId,
    phase: feedback.phase,
    readers: [feedback.contestantId === "a" ? "contestant_a" : "contestant_b"],
    rankingVersion: FEEDBACK_RANKING_VERSION,
    inlineBytes: Buffer.byteLength(JSON.stringify(feedback, null, 2), "utf8"),
    feedbackSha256: createHash("sha256").update(encoded).digest("hex"),
    feedbackPath: options.store.resolve(relative),
    artifactPointers: feedback.evidencePointers.map((entry) => entry.path),
  });
  await options.store.writeImmutableJson(
    `${relative.slice(0, -5)}.manifest.json`,
    manifest,
  );
  return manifest;
}
