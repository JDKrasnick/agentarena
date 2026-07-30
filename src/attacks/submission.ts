import { readFile } from "node:fs/promises";
import { stableId, sha256 } from "../core/ids.js";
import type {
  AgentId,
  Attack,
  AttackSubmission,
  HouseSubmission,
  RoundId,
} from "../core/types.js";

export function validateAttackOrdering(submission: AttackSubmission): void {
  const ranks = submission.attacks.map((attack) => attack.rank);
  const expected = ranks.map((_, index) => index + 1);
  if (ranks.some((rank, index) => rank !== expected[index])) {
    throw new Error("Attack ranks must be unique and contiguous from rank 1");
  }
  const paths = submission.attacks.flatMap((attack) => attack.paths);
  if (new Set(paths).size !== paths.length) {
    throw new Error("Attacks in one set must use disjoint paths");
  }
}

export async function materializeAttack(
  submission: AttackSubmission["attacks"][number],
  options: {
    author: AgentId;
    target: AgentId;
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
    origin: { kind: "contestant", agent: options.author },
    rank: submission.rank,
    targets: [options.target],
    claim: submission.claim,
    impact: submission.impact,
    oracle: submission.oracle,
    assertionFingerprint: stableId(
      "assertion",
      submission.oracle.sourceId,
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

export async function materializeHouseAttack(
  submission: HouseSubmission["attacks"][number],
  options: {
    targets: AgentId[];
    round: 2 | 3;
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
      submission.oracle.sourceId,
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
