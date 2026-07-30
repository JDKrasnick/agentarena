import type { Attack } from "../core/types.js";

export function assertEvidenceIdentityPreserved(
  original: Attack,
  revised: Attack,
): void {
  const immutablePairs: Array<[string, unknown, unknown]> = [
    ["claim", original.claim, revised.claim],
    ["oracle", original.oracle, revised.oracle],
    [
      "assertion fingerprint",
      original.assertionFingerprint,
      revised.assertionFingerprint,
    ],
    ["targets", original.targets, revised.targets],
    ["rank", original.rank, revised.rank],
    ["root defect", original.rootDefectId, revised.rootDefectId],
  ];
  for (const [label, before, after] of immutablePairs) {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error(`Evidence revision changed immutable ${label}`);
    }
  }
  if (original.evidenceRevision) {
    throw new Error(
      "Only one evidence revision is allowed per challenged attack",
    );
  }
}
