import { readFile } from "node:fs/promises";
import { stableId, sha256 } from "../core/ids.js";
import type {
  AgentId,
  Attack,
  AttackSubmission,
  ContestantId,
  HouseSubmission,
  RoundId,
} from "../core/types.js";

export function validateAttackOrdering(submission: {
  attacks: ReadonlyArray<{ rank: 1 | 2 | 3 }>;
}): void {
  const ranks = submission.attacks.map((attack) => attack.rank);
  if (new Set(ranks).size !== ranks.length)
    throw new Error("Attack ranks must be unique values from 1 through 3");
}

export async function materializeAttack(
  submission: AttackSubmission["attacks"][number] & {
    focusedCommand: string;
  },
  options: {
    author: ContestantId;
    authorProvider: AgentId;
    target: ContestantId;
    round: RoundId;
    patchPath: string;
  },
): Promise<Attack> {
  const patchHash = sha256(await readFile(options.patchPath));
  return {
    id: stableId(
      "attack",
      options.author,
      String(options.round),
      String(submission.rank),
      patchHash,
    ),
    round: options.round,
    origin: {
      kind: "contestant",
      contestant: options.author,
      provider: options.authorProvider,
    },
    rank: submission.rank,
    targets: [options.target],
    claim: submission.claim,
    impact: submission.impact,
    oracle: submission.oracle,
    assertionFingerprint: stableId(
      "assertion",
      submission.oracle.sourceId ?? "uncited",
      submission.oracle.expectedBehavior,
      submission.claim,
    ),
    requiredCapabilities: submission.requiredCapabilities,
    patchPath: options.patchPath,
    focusedCommand: submission.focusedCommand,
    ...(submission.browserProbe
      ? { browserProbe: submission.browserProbe }
      : {}),
    status: "submitted",
    proposedSeverity: submission.proposedSeverity,
    proposedConfidence: submission.confidence,
    checks: [],
  };
}

export async function materializeHouseAttack(
  submission: HouseSubmission["attacks"][number],
  options: {
    targets: ContestantId[];
    round: RoundId;
    patchPath: string;
    methodPackId: string;
  },
): Promise<Attack> {
  const patchHash = sha256(await readFile(options.patchPath));
  return {
    id: stableId("house", String(options.round), patchHash),
    round: options.round,
    origin: { kind: "house", methodPackId: options.methodPackId },
    targets: options.targets,
    claim: submission.claim,
    impact: submission.impact,
    oracle: submission.oracle,
    assertionFingerprint: stableId(
      "assertion",
      submission.oracle.sourceId ?? "uncited",
      submission.oracle.expectedBehavior,
      submission.claim,
    ),
    requiredCapabilities: submission.requiredCapabilities,
    patchPath: options.patchPath,
    focusedCommand: submission.focusedCommand,
    status: "submitted",
    proposedSeverity: submission.proposedSeverity,
    proposedConfidence: submission.confidence,
    checks: [],
  };
}
