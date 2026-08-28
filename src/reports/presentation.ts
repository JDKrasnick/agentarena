import path from "node:path";
import type {
  AgentInvocation,
  Attack,
  CheckResult,
  ContestantId,
  ContestantResult,
  RoundId,
  RunState,
} from "../core/types.js";

export type ReportCheckStatus =
  "PASS" | "FAIL" | "INFRA" | "SKIPPED" | "NOT RUN";

export interface ReportDefect {
  id: string;
  representative: Attack;
  attacks: Attack[];
  damage: number;
  active: boolean;
  evidenceClass: "competitive" | "shared";
}

export interface ReportRound {
  id: RoundId;
  attacks: Attack[];
  contestants: Array<{
    contestant: ContestantResult;
    result: ContestantResult["rounds"][number] | undefined;
  }>;
}

export type ReportOutcome =
  | { kind: "winner"; winner: ContestantId }
  | { kind: "draw" }
  | { kind: "non_discriminating" }
  | { kind: "incomplete" };

function invocationPaths(invocation: AgentInvocation | undefined): string[] {
  if (!invocation) return [];
  return [
    invocation.promptPath,
    invocation.transcriptPath,
    ...(invocation.submissionPath ? [invocation.submissionPath] : []),
    ...(invocation.command
      ? [invocation.command.stdoutPath, invocation.command.stderrPath]
      : []),
  ];
}

function checkPaths(check: CheckResult): string[] {
  return check.command
    ? [check.command.stdoutPath, check.command.stderrPath]
    : [];
}

export function reportContestants(state: RunState): ContestantResult[] {
  return (["a", "b"] as const).flatMap((id) => {
    const contestant = state.contestants[id];
    return contestant ? [contestant] : [];
  });
}

export function latestCheck(
  contestant: ContestantResult,
  kind: CheckResult["kind"],
): CheckResult | undefined {
  return [...contestant.checks].reverse().find((check) => check.kind === kind);
}

export function reportCheckStatus(check?: CheckResult): ReportCheckStatus {
  if (!check) return "NOT RUN";
  return {
    passed: "PASS",
    failed: "FAIL",
    infrastructure_error: "INFRA",
    skipped: "SKIPPED",
  }[check.status] as ReportCheckStatus;
}

export function reportOutcome(state: RunState): ReportOutcome {
  if (
    state.coverageDecision?.decision === "inconclusive" ||
    (state.coverageAssessment?.confidence === "provisional" &&
      state.coverageDecision?.decision !== "accept-reduced")
  )
    return { kind: "incomplete" };
  if (!state.ranking) return { kind: "incomplete" };
  if (
    state.arenaOutcome &&
    "kind" in state.arenaOutcome &&
    state.arenaOutcome.kind === "non_discriminating"
  )
    return { kind: "non_discriminating" };
  if (state.ranking.draw) return { kind: "draw" };
  return state.ranking.winner
    ? { kind: "winner", winner: state.ranking.winner }
    : { kind: "incomplete" };
}

export function reportDefects(state: RunState): ReportDefect[] {
  const grouped = new Map<string, Attack[]>();
  for (const attack of state.attacks) {
    if (attack.status !== "landed" && attack.status !== "duplicate") continue;
    const id = attack.rootDefectId ?? attack.id;
    grouped.set(id, [...(grouped.get(id) ?? []), attack]);
  }
  return [...grouped.entries()].map(([id, attacks]) => {
    const representative = attacks.at(-1) ?? attacks[0];
    if (!representative)
      throw new Error(`Missing representative for defect ${id}`);
    const canonical = reportContestants(state)
      .flatMap((contestant) => contestant.healthLedger.canonicalDefects ?? [])
      .find((defect) => defect.rootDefectId === id);
    return {
      id,
      representative,
      attacks,
      damage:
        canonical?.currentDamage ??
        Math.max(
          ...attacks.map(
            (attack) => attack.adjudication?.exactAmount ?? attack.damage ?? 0,
          ),
        ),
      active: reportContestants(state).some((contestant) =>
        contestant.healthLedger.activeDefects.some(
          (defect) => defect.rootDefectId === id,
        ),
      ),
      evidenceClass:
        representative.origin.kind === "house" ? "shared" : "competitive",
    };
  });
}

export function reportRounds(state: RunState): ReportRound[] {
  const contestants = reportContestants(state);
  const ids: RoundId[] = [1, 2, 3, 4, 5];
  if (
    state.attacks.some((attack) => attack.round === "recovery") ||
    contestants.some((contestant) =>
      contestant.rounds.some((round) => round.round === "recovery"),
    )
  ) {
    ids.push("recovery");
  }
  if (
    ("reconciliationQueue" in state && state.reconciliationQueue.length > 0) ||
    state.attacks.some((attack) => attack.round === "reconciliation") ||
    contestants.some((contestant) =>
      contestant.rounds.some((round) => round.round === "reconciliation"),
    )
  ) {
    ids.push("reconciliation");
  }
  return ids.map((id) => ({
    id,
    attacks: state.attacks.filter((attack) => attack.round === id),
    contestants: contestants.map((contestant) => ({
      contestant,
      result: contestant.rounds.find((round) => round.round === id),
    })),
  }));
}

export function recordedArtifactPaths(state: RunState): Set<string> {
  const paths = new Set<string>(Object.values(state.artifacts));
  const contestants = reportContestants(state);
  for (const contestant of contestants) {
    for (const artifact of [
      contestant.initialPatchPath,
      contestant.currentPatchPath,
      contestant.finalPatchPath,
    ]) {
      if (artifact) paths.add(artifact);
    }
    for (const artifact of invocationPaths(contestant.implementation))
      paths.add(artifact);
    for (const round of contestant.rounds) {
      for (const artifact of invocationPaths(round.repair)) paths.add(artifact);
    }
    for (const check of contestant.checks) {
      for (const artifact of checkPaths(check)) paths.add(artifact);
    }
  }
  for (const attack of state.attacks) {
    paths.add(attack.patchPath);
    for (const artifact of attack.browserArtifactRefs ?? [])
      paths.add(artifact);
    for (const check of attack.checks) {
      for (const artifact of checkPaths(check)) paths.add(artifact);
    }
    for (const entry of attack.caseBundle?.cases ?? [])
      paths.add(entry.patchPath);
  }
  for (const record of state.attackInvocations) {
    for (const artifact of invocationPaths(record.invocation))
      paths.add(artifact);
    if (record.rawArtifactPath) paths.add(record.rawArtifactPath);
    if (record.parsedArtifactPath) paths.add(record.parsedArtifactPath);
  }
  for (const record of state.reviewInvocations) {
    for (const artifact of invocationPaths(record.invocation))
      paths.add(artifact);
    if (record.rawArtifactPath) paths.add(record.rawArtifactPath);
    if (record.parsedArtifactPath) paths.add(record.parsedArtifactPath);
  }
  for (const candidate of "reconciliationQueue" in state
    ? state.reconciliationQueue
    : []) {
    paths.add(candidate.rawArtifactPath);
    paths.add(candidate.parsedArtifactPath);
    if (candidate.correctionRawArtifactPath)
      paths.add(candidate.correctionRawArtifactPath);
    if (candidate.correctionParsedArtifactPath)
      paths.add(candidate.correctionParsedArtifactPath);
  }
  for (const record of state.submissionArtifacts) {
    paths.add(record.rawArtifactPath);
    paths.add(record.parsedArtifactPath);
  }
  return paths;
}

export function resolveArtifactHref(
  state: RunState,
  artifact?: string,
): string | undefined {
  const runDirectory = state.artifacts.runDirectory;
  if (!artifact || !runDirectory || !path.isAbsolute(artifact))
    return undefined;
  if (!recordedArtifactPaths(state).has(artifact)) return undefined;
  const relative = path.relative(runDirectory, artifact);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    return undefined;
  return `./${relative.split(path.sep).join("/")}`;
}

export function truncateReportText(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
