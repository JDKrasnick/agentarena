import type { Stage } from "./types.js";

const TRANSITIONS: Readonly<Record<Stage, readonly Stage[]>> = {
  preflight: ["resolve_permissions", "failed", "cancelled"],
  resolve_permissions: ["implement", "failed", "cancelled"],
  implement: ["initial_validate", "inconclusive", "failed", "cancelled"],
  initial_validate: [
    "collect_attacks",
    "repair",
    "inconclusive",
    "failed",
    "cancelled",
  ],
  collect_attacks: ["validate_attacks", "repair", "inconclusive", "cancelled"],
  validate_attacks: [
    "review_infrastructure",
    "assign_severity",
    "inconclusive",
    "cancelled",
  ],
  review_infrastructure: [
    "revise_evidence",
    "assign_severity",
    "inconclusive",
    "cancelled",
  ],
  revise_evidence: ["assign_severity", "inconclusive", "cancelled"],
  assign_severity: ["resolve_damage", "inconclusive", "cancelled"],
  resolve_damage: ["repair", "inconclusive", "cancelled"],
  repair: ["validate_repairs", "inconclusive", "cancelled"],
  validate_repairs: [
    "collect_attacks",
    "recovery_round",
    "final_validate",
    "inconclusive",
    "cancelled",
  ],
  recovery_round: [
    "collect_attacks",
    "final_validate",
    "inconclusive",
    "cancelled",
  ],
  final_validate: ["report", "inconclusive", "failed", "cancelled"],
  report: ["complete", "failed"],
  complete: [],
  inconclusive: ["report"],
  failed: [],
  cancelled: [],
};

export function assertTransition(from: Stage, to: Stage): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid arena transition: ${from} -> ${to}`);
  }
}
