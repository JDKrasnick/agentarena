import type {
  DashboardContestant,
  DashboardState,
} from "../../dashboard/state.js";

export type ContestantId = "a" | "b";
export type RoundSelection = NonNullable<DashboardState["round"]> | "live";

export function attackDisplayLabel(
  attack: DashboardState["attacks"][number] | undefined,
): string | undefined {
  const detail = attack?.detail?.trim();
  return detail || attack?.id;
}

export function steeringUnavailableMessage(
  connected: boolean,
  status: DashboardState["status"],
): string {
  return !connected && status === "running"
    ? "Steering is unavailable while reconnecting."
    : "Steering is unavailable while the battle is not running.";
}

export function recordedRoundMoveCount(
  state: DashboardState,
  round: NonNullable<DashboardState["round"]>,
): number {
  const attacks = state.attacks.filter(
    (attack) => attack.round === round,
  ).length;
  const invocations = Object.values(state.contestants).reduce(
    (total, fighter) =>
      total +
      fighter.invocations.filter((invocation) => invocation.round === round)
        .length,
    0,
  );
  return attacks + invocations;
}

export function isRoundAvailable(
  state: DashboardState,
  round: NonNullable<DashboardState["round"]>,
): boolean {
  const currentOrder = state.round ? roundOrder(state.round) : 0;
  const isCurrent = state.round === round && state.status === "running";
  const isComplete =
    roundOrder(round) < currentOrder ||
    (typeof round === "number" &&
      (state.result?.roundsCompleted ?? 0) >= round);
  return isCurrent || isComplete || recordedRoundMoveCount(state, round) > 0;
}

export function invocationStatusSentence(id: string, status: string): string {
  const normalized = status.replaceAll("_", " ");
  if (["running", "pending", "queued"].includes(normalized)) {
    return `Invocation ${id} is ${normalized}.`;
  }
  if (
    ["succeeded", "failed", "cancelled", "canceled", "timed out"].includes(
      normalized,
    )
  ) {
    return `Invocation ${id} ${normalized}.`;
  }
  return `Invocation ${id} status: ${normalized}.`;
}

const stageNames: Record<string, string> = {
  preflight: "Preflight",
  implement: "Implementation",
  initial_validation: "Validation",
  review_attacks: "Scout weaknesses",
  collect_attacks: "Mount attacks",
  validate_attacks: "Verify attacks",
  repair: "Repair",
  final_validation: "Final validation",
  complete: "Complete",
};

export function stageLabel(stage: string): string {
  return stageNames[stage] ?? stage.replaceAll("_", " ");
}

export function roundLabel(round: RoundSelection): string {
  if (round === "live") return "Live arena";
  if (round === "recovery") return "Recovery";
  if (round === "reconciliation") return "Reconciliation";
  return `Round ${String(round)}`;
}

export function roundOrder(
  round: NonNullable<DashboardState["round"]>,
): number {
  if (round === "recovery") return 4;
  if (round === "reconciliation") return 5;
  return round;
}

function fighterAtRound(
  fighter: DashboardContestant,
  round: RoundSelection,
): DashboardContestant {
  if (round === "live") return fighter;
  const invocations = fighter.invocations.filter(
    (invocation) => invocation.round === round,
  );
  const output = fighter.output.filter((line) => line.round === round);
  const checks = fighter.checks.filter((check) => check.round === round);
  const healthChanges = fighter.healthChanges.filter(
    (change) => change.round === round,
  );
  const healthAtRound = fighter.healthChanges
    .filter(
      (change) =>
        change.round !== undefined &&
        roundOrder(change.round) <= roundOrder(round),
    )
    .at(-1)?.health;
  const historical: DashboardContestant = {
    ...fighter,
    health: healthAtRound ?? 100,
    status:
      invocations.at(-1)?.status ?? (invocations.length ? "complete" : "idle"),
    activity: invocations.at(-1)?.stage ?? "No recorded activity",
    invocations,
    output,
    checks,
    healthChanges,
  };
  const lastHealthChange = healthChanges.at(-1);
  if (lastHealthChange) historical.lastHealthChange = lastHealthChange;
  else delete historical.lastHealthChange;
  return historical;
}

export interface ArenaPresentation {
  rounds: Array<NonNullable<DashboardState["round"]>>;
  attacks: DashboardState["attacks"];
  contestants: { a: DashboardContestant; b: DashboardContestant };
  stage: string;
  counts: { mounting: number; landed: number; revised: number };
  canSteer: boolean;
}

export function createArenaPresentation(
  state: DashboardState,
  selectedRound: RoundSelection,
  connected: boolean,
): ArenaPresentation {
  const found = new Set<NonNullable<DashboardState["round"]>>([1, 2, 3]);
  if (state.round) found.add(state.round);
  for (const attack of state.attacks) if (attack.round) found.add(attack.round);
  for (const fighter of Object.values(state.contestants)) {
    for (const invocation of fighter.invocations) {
      if (invocation.round) found.add(invocation.round);
    }
    for (const change of fighter.healthChanges) {
      if (change.round) found.add(change.round);
    }
  }
  return {
    rounds: [...found].sort(
      (left, right) => roundOrder(left) - roundOrder(right),
    ),
    attacks:
      selectedRound === "live"
        ? state.attacks
        : state.attacks.filter((attack) => attack.round === selectedRound),
    contestants: {
      a: fighterAtRound(state.contestants.a, selectedRound),
      b: fighterAtRound(state.contestants.b, selectedRound),
    },
    stage: stageLabel(state.stage),
    counts: {
      mounting: state.attacks.filter((attack) => attack.phase === "mounting")
        .length,
      landed: state.attacks.filter((attack) => attack.phase === "landed")
        .length,
      revised: state.attacks.filter((attack) => attack.phase === "revised")
        .length,
    },
    canSteer: connected && state.status === "running",
  };
}
