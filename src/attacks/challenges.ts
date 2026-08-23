import { createHash } from "node:crypto";
import type {
  AdjudicationRecord,
  Attack,
  ContestantId,
  OracleCitation,
} from "../core/types.js";

export interface PriorAdjudicationContext {
  adjudicationId: string;
  attackId: string;
  round: 1 | 2 | 3;
  target: ContestantId;
  claim: string;
  expectedBehavior: string;
  oracle: OracleCitation;
  verdict: AdjudicationRecord["verdict"];
  rationale: string;
  evidenceFingerprint?: string;
  targetPatchDigest?: string;
  scoreEffect: AdjudicationRecord["scoreEffect"];
  exactAmount: number;
  severity?: AdjudicationRecord["severity"];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function normalizedBrowserActionFingerprint(
  attack: Pick<Attack, "browserProbe">,
): string | undefined {
  if (!attack.browserProbe) return undefined;
  const actions = attack.browserProbe.actions.filter(
    (action) => !action.kind.startsWith("assert_"),
  );
  return createHash("sha256")
    .update(
      canonical({
        family: attack.browserProbe.family,
        profile: attack.browserProbe.profile,
        actions,
      }),
    )
    .digest("hex");
}

export function evidenceFingerprint(attack: Attack): string {
  return createHash("sha256")
    .update(
      canonical({
        assertionFingerprint: attack.assertionFingerprint,
        browser: normalizedBrowserActionFingerprint(attack),
        targets: [...attack.targets].sort(),
      }),
    )
    .digest("hex");
}

export function supersededAdjudicationIds(
  history: readonly Attack[],
): Set<string> {
  return new Set(
    history.flatMap((candidate) =>
      candidate.adjudication?.supersedesAdjudicationId
        ? [candidate.adjudication.supersedesAdjudicationId]
        : [],
    ),
  );
}

/** Select explicit or mechanically similar history, then add bounded semantic context. */
export function priorAdjudicationContext(
  attack: Attack,
  history: readonly Attack[],
): PriorAdjudicationContext[] {
  const superseded = supersededAdjudicationIds(history);
  const prior = history.filter(
    (candidate) =>
      typeof candidate.round === "number" &&
      typeof attack.round === "number" &&
      candidate.round < attack.round &&
      candidate.adjudication &&
      !superseded.has(candidate.adjudication.id) &&
      candidate.targets.some((target) => attack.targets.includes(target)),
  );
  const browser = normalizedBrowserActionFingerprint(attack);
  const scored = prior.map((candidate) => {
    const explicit =
      candidate.adjudication!.id === attack.challengeAdjudicationId ? 4 : 0;
    const assertion =
      candidate.assertionFingerprint === attack.assertionFingerprint ? 2 : 0;
    const candidateBrowser = normalizedBrowserActionFingerprint(candidate);
    const browserMatch = browser && candidateBrowser === browser ? 1 : 0;
    return { candidate, score: explicit + assertion + browserMatch };
  });
  return scored
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        (b.candidate.round === "reconciliation"
          ? 5
          : b.candidate.round === "recovery"
            ? 4
            : b.candidate.round) -
          (a.candidate.round === "reconciliation"
            ? 5
            : a.candidate.round === "recovery"
              ? 4
              : a.candidate.round) ||
        a.candidate.id.localeCompare(b.candidate.id),
    )
    .slice(0, 6)
    .map(({ candidate }) => ({
      adjudicationId: candidate.adjudication!.id,
      attackId: candidate.id,
      round: candidate.round as 1 | 2 | 3,
      target: candidate.targets[0]!,
      claim: candidate.claim,
      expectedBehavior: candidate.oracle.expectedBehavior,
      oracle: candidate.oracle,
      verdict: candidate.adjudication!.verdict,
      rationale: candidate.adjudication!.rationale,
      ...(candidate.evidenceFingerprint
        ? { evidenceFingerprint: candidate.evidenceFingerprint }
        : {}),
      ...(candidate.targetPatchDigest
        ? { targetPatchDigest: candidate.targetPatchDigest }
        : {}),
      scoreEffect: candidate.adjudication!.scoreEffect,
      exactAmount: candidate.adjudication!.exactAmount,
      ...(candidate.adjudication!.severity
        ? { severity: candidate.adjudication!.severity }
        : {}),
    }));
}
