import type { RoundId, RoundProfile } from "../core/types.js";

export interface MethodSelection {
  profile: RoundProfile;
  methodPackIds: string[];
  probeCardIds: string[];
}

export function selectMethods(
  round: RoundId,
  repositoryFacts: readonly string[],
  approvedCapabilities: readonly string[],
): MethodSelection {
  const facts = new Set(repositoryFacts.map((fact) => fact.toLowerCase()));
  const profile: RoundProfile =
    round === 1
      ? "contract_local"
      : round === 2
        ? "systematic_exploration"
        : round === 3
          ? "integration_resilience_security"
          : round === "reconciliation"
            ? "reconciliation"
            : "infrastructure_recovery";
  const methodPackIds = [`${profile}@1`];
  const probeCardIds = [`boundary-table@1`];
  if (round === 2) {
    methodPackIds.push(
      "state-machine@1",
      "generated-inputs@1",
      "versioned-contract-compatibility@1",
      "policy-wiring-lifecycle@1",
    );
    probeCardIds.push(
      facts.has("typescript") ? "mutation-js@1" : "property-cases@1",
    );
  }
  if (round === 3) {
    methodPackIds.push("trust-boundary@1", "dependency-fault@1");
    if (approvedCapabilities.length > 0)
      probeCardIds.push("approved-integration@1");
  }
  return { profile, methodPackIds, probeCardIds };
}
