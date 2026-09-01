import { EventEmitter } from "node:events";
import type {
  ArenaEvent,
  ArenaEventInput,
  ArenaEventSink,
  ArenaObserver,
} from "../observability/events.js";
import type { ContestantId, RoundId, Stage } from "../core/types.js";

export interface DashboardContestant {
  provider: string;
  model?: string;
  health: number;
  status: string;
  activity: string;
  checks: Array<{ id: string; status: string; round?: RoundId }>;
  authoritativeCheckCounts?: { passed: number; total: number };
  invocations: Array<{
    id: string;
    stage: string;
    status: string;
    round?: RoundId;
    startedAt: string;
    durationMs?: number;
    lastActivityAt?: string;
    currentOpenTool?: string;
    sessionId?: string;
    diagnosticArtifactRefs?: string[];
    progress?: Array<{
      kind:
        "message" | "tool_started" | "tool_finished" | "progress" | "result";
      label: string;
      timestamp: string;
      toolName?: string;
    }>;
  }>;
  summaries: Array<{
    text: string;
    invocationId: string;
    timestamp: string;
    round?: RoundId;
  }>;
  output: Array<{
    stream: "stdout" | "stderr";
    text: string;
    invocationId: string;
    timestamp: string;
    round?: RoundId;
  }>;
  lastHealthChange?: {
    sequence: number;
    amount: number;
    reason: string;
  };
  healthChanges: Array<{
    sequence: number;
    amount: number;
    health: number;
    reason: string;
    round?: RoundId;
    attackId?: string;
  }>;
}

export interface DashboardAttackActivity {
  id: string;
  round?: RoundId;
  phase: "mounting" | "landed" | "revised" | "resolved";
  status: string;
  attacker?: string;
  target?: string;
  severity?: string;
  damage?: number;
  evidenceClass?: "competitive" | "shared";
  detail?: string;
}

export interface DashboardBrowserSession {
  id: string;
  label: string;
  contestantId?: ContestantId;
  url: string;
  runner: "playwright" | "cypress" | "custom";
  attempt: number;
  startedAt: string;
}

export interface DashboardState {
  runId?: string;
  task: string;
  startedAt?: string;
  stage: Stage;
  round?: RoundId;
  roundPlan?: { planned: number; maximum: number };
  status: string;
  assisted: boolean;
  warnings: string[];
  contestants: { a: DashboardContestant; b: DashboardContestant };
  systemOutput: Array<{ source: string; stream: string; text: string }>;
  attacks: DashboardAttackActivity[];
  browserSessions: DashboardBrowserSession[];
  failures: Array<{
    id: string;
    stage: string;
    subject: string;
    attempt: number;
    status: string;
    state: "retrying" | "recovered" | "resolved";
    terminalDisposition?: string;
    contestantId?: string;
    laneId?: string;
    attackId?: string;
    diagnosticArtifactRefs: string[];
  }>;
  result?: {
    roundsCompleted?: number;
    championId?: ContestantId;
    outcomeKind?: "winner" | "draw" | "non_discriminating";
    decisionBasis?: string;
    competitiveLandingCount?: number;
    sharedDefectCount?: number;
    explicitEmptyLaneCount?: number;
    recommendedId?: ContestantId;
    recommendationReason?: string;
    coverageConfidence?: string;
    terminalOutcome?: {
      kind: string;
      reasonCode: string;
      reason: string;
    };
    contestants?: Array<{
      id: "a" | "b";
      health: number;
      status: string;
      checksPassed: number;
      checksTotal: number;
    }>;
  };
  links: Array<{
    kind: "pull_request" | "issue" | "spec" | "artifacts";
    label: string;
    url: string;
  }>;
}

function contestant(): DashboardContestant {
  return {
    provider: "unknown",
    health: 100,
    status: "pending",
    activity: "Waiting",
    checks: [],
    invocations: [],
    summaries: [],
    output: [],
    healthChanges: [],
  };
}

export function initialDashboardState(): DashboardState {
  return {
    task: "Preparing battle…",
    stage: "preflight",
    status: "running",
    assisted: false,
    warnings: [],
    contestants: { a: contestant(), b: contestant() },
    systemOutput: [],
    attacks: [],
    browserSessions: [],
    failures: [],
    links: [],
  };
}

function appendBounded<T>(items: T[], item: T, maximum = 2_000): void {
  items.push(item);
  if (items.length > maximum) items.splice(0, items.length - maximum);
}

export function projectEvent(state: DashboardState, event: ArenaEvent): void {
  switch (event.type) {
    case "battle_started":
      Object.assign(state, initialDashboardState());
      state.runId = event.runId;
      state.task = event.task;
      state.startedAt = event.timestamp;
      state.links = event.links ?? [];
      for (const configured of event.contestants ?? []) {
        state.contestants[configured.id].provider = configured.provider;
        if (configured.model)
          state.contestants[configured.id].model = configured.model;
      }
      return;
    case "stage_changed":
      state.stage = event.stage;
      if (event.round !== undefined) state.round = event.round;
      return;
    case "round_started":
      state.round = event.round;
      return;
    case "effort_assessed":
      state.roundPlan = {
        planned: event.plannedRounds,
        maximum: event.maxRounds,
      };
      appendBounded(state.systemOutput, {
        source: "harness",
        stream: "stdout",
        text: `Effort ${event.tier}; score ${String(event.score)}/8; ${String(event.plannedRounds)} planned rounds; cap ${String(event.maxRounds)}${event.fallback ? "; fallback" : ""}.`,
      });
      return;
    case "effort_resolved":
      state.roundPlan = {
        planned: event.plannedRounds,
        maximum: event.maxRounds,
      };
      appendBounded(state.systemOutput, {
        source: "harness",
        stream: "stdout",
        text: `Effort ${event.tier}; assessment skipped; ${String(event.plannedRounds)} planned rounds; cap ${String(event.maxRounds)}.`,
      });
      return;
    case "budget_pressure":
    case "convergence_evaluated":
    case "extension_qualified":
    case "extension_declined":
    case "adaptive_stop":
      appendBounded(state.systemOutput, {
        source: "harness",
        stream: "stdout",
        text:
          event.type === "adaptive_stop"
            ? `Adaptive stop after round ${String(event.round)}: ${event.reason}.`
            : `${event.type.replaceAll("_", " ")} in round ${String(event.round)}.`,
      });
      return;
    case "invocation_started":
      if (event.contestantId) {
        const target = state.contestants[event.contestantId];
        target.activity = event.stage;
        target.status = "working";
        appendBounded(target.invocations, {
          id: event.invocationId,
          stage: event.stage,
          status: "running",
          startedAt: event.timestamp,
          progress: [],
          ...((event.round ?? state.round)
            ? { round: event.round ?? state.round }
            : {}),
        });
        appendBounded(target.summaries, {
          text: `${event.stage.replaceAll("_", " ")} in progress…`,
          invocationId: event.invocationId,
          timestamp: event.timestamp,
          ...((event.round ?? state.round)
            ? { round: event.round ?? state.round }
            : {}),
        });
      }
      return;
    case "invocation_progress":
      if (event.contestantId) {
        const target = state.contestants[event.contestantId];
        const invocation = target.invocations.find(
          (entry) => entry.id === event.invocationId,
        );
        if (!invocation) return;
        invocation.lastActivityAt = event.timestamp;
        if (event.sessionId) invocation.sessionId = event.sessionId;
        if (event.kind === "tool_started" && event.toolName)
          invocation.currentOpenTool = event.toolName;
        if (
          event.kind === "tool_finished" &&
          (!event.toolName || invocation.currentOpenTool === event.toolName)
        )
          delete invocation.currentOpenTool;
        appendBounded((invocation.progress ??= []), {
          kind: event.kind,
          label: event.label,
          timestamp: event.timestamp,
          ...(event.toolName ? { toolName: event.toolName } : {}),
        });
        target.activity = event.toolName
          ? event.kind === "tool_started"
            ? `Waiting on ${event.toolName}`
            : event.label
          : event.label;
      }
      return;
    case "invocation_finished":
      if (event.contestantId) {
        const target = state.contestants[event.contestantId];
        target.status = event.status;
        target.activity = "Waiting";
        const invocation = target.invocations.find(
          (entry) => entry.id === event.invocationId,
        );
        if (invocation) {
          invocation.status = event.status;
          invocation.durationMs = event.durationMs;
          if (event.sessionId) invocation.sessionId = event.sessionId;
          if (event.diagnosticArtifactRefs)
            invocation.diagnosticArtifactRefs = event.diagnosticArtifactRefs;
        }
        const summary = target.summaries.find(
          (entry) => entry.invocationId === event.invocationId,
        );
        const text =
          event.summary?.trim() ||
          `${(invocation?.stage ?? "invocation").replaceAll("_", " ")} ${event.status.replaceAll("_", " ")}.`;
        if (summary) {
          summary.text = text;
          summary.timestamp = event.timestamp;
        } else {
          appendBounded(target.summaries, {
            text,
            invocationId: event.invocationId,
            timestamp: event.timestamp,
            ...(invocation?.round ? { round: invocation.round } : {}),
          });
        }
      }
      return;
    case "output":
      if (event.contestantId) {
        const target = state.contestants[event.contestantId];
        const invocation = target.invocations.find(
          (entry) => entry.id === event.invocationId,
        );
        // Fighter detail is the authoritative live transcript. Keep every
        // redacted chunk; compact fighter cards use invocation summaries.
        target.output.push({
          stream: event.stream,
          text: event.text,
          invocationId: event.invocationId,
          timestamp: event.timestamp,
          ...((invocation?.round ?? state.round)
            ? { round: invocation?.round ?? state.round }
            : {}),
        });
      } else {
        appendBounded(state.systemOutput, {
          source: event.source,
          stream: event.stream,
          text: event.text,
        });
      }
      return;
    case "health_changed":
      state.contestants[event.contestantId].health = event.health;
      state.contestants[event.contestantId].lastHealthChange = {
        sequence: event.sequence,
        amount: event.amount,
        reason: event.reason,
      };
      appendBounded(state.contestants[event.contestantId].healthChanges, {
        sequence: event.sequence,
        amount: event.amount,
        health: event.health,
        reason: event.reason,
        ...(event.round ? { round: event.round } : {}),
        ...(event.attackId ? { attackId: event.attackId } : {}),
      });
      return;
    case "check_completed":
      if (event.contestantId) {
        delete state.contestants[event.contestantId].authoritativeCheckCounts;
        appendBounded(state.contestants[event.contestantId].checks, {
          id: event.checkId,
          status: event.status,
          ...(state.round ? { round: state.round } : {}),
        });
      }
      return;
    case "browser_session_started": {
      const session = {
        id: event.sessionId,
        label: event.label,
        ...(event.contestantId ? { contestantId: event.contestantId } : {}),
        url: event.url,
        runner: event.runner,
        attempt: event.attempt,
        startedAt: event.timestamp,
      };
      const index = state.browserSessions.findIndex(
        (entry) => entry.id === session.id,
      );
      if (index === -1) appendBounded(state.browserSessions, session, 8);
      else state.browserSessions[index] = session;
      return;
    }
    case "browser_session_finished":
      state.browserSessions = state.browserSessions.filter(
        (session) => session.id !== event.sessionId,
      );
      return;
    case "attack_mounted":
      appendBounded(state.attacks, {
        id: event.attackId,
        round: event.round,
        phase: "mounting",
        status: "mounting",
        ...(event.attackerId ? { attacker: event.attackerId } : {}),
        ...(event.targetId ? { target: event.targetId } : {}),
        ...(event.claim ? { detail: event.claim } : {}),
        ...(event.evidenceClass ? { evidenceClass: event.evidenceClass } : {}),
      });
      return;
    case "attack_revised":
      appendBounded(state.attacks, {
        id: event.attackId,
        round: event.round,
        phase: "revised",
        status: "revised",
        ...(event.attackerId ? { attacker: event.attackerId } : {}),
        ...(event.targetId ? { target: event.targetId } : {}),
        detail: event.explanation,
      });
      return;
    case "attack_resolved":
      appendBounded(state.attacks, {
        id: event.attackId,
        ...(event.round ? { round: event.round } : {}),
        phase: event.status === "landed" ? "landed" : "resolved",
        status: event.status,
        ...(event.attackerId ? { attacker: event.attackerId } : {}),
        ...(event.targetId ? { target: event.targetId } : {}),
        ...(event.severity ? { severity: event.severity } : {}),
        ...(event.damage === undefined ? {} : { damage: event.damage }),
        ...(event.evidenceClass ? { evidenceClass: event.evidenceClass } : {}),
      });
      return;
    case "warning":
      appendBounded(state.warnings, event.message, 20);
      return;
    case "failure_updated": {
      const failure = {
        id: event.failureId,
        stage: event.stage,
        subject: event.subject,
        attempt: event.attempt,
        status: event.attemptStatus,
        state: event.state,
        diagnosticArtifactRefs: [...event.diagnosticArtifactRefs],
        ...(event.terminalDisposition
          ? { terminalDisposition: event.terminalDisposition }
          : {}),
        ...(event.contestantId ? { contestantId: event.contestantId } : {}),
        ...(event.laneId ? { laneId: event.laneId } : {}),
        ...(event.attackId ? { attackId: event.attackId } : {}),
      };
      const index = state.failures.findIndex(
        (entry) => entry.id === failure.id,
      );
      if (index === -1) appendBounded(state.failures, failure);
      else state.failures[index] = failure;
      return;
    }
    case "steering_applied":
      state.assisted = true;
      return;
    case "cancellation_requested":
      state.status = "cancelling";
      return;
    case "cancellation_completed":
      state.status = "cancelled";
      return;
    case "battle_completed":
      state.status = event.status;
      state.stage = "complete";
      state.result = {
        ...(event.roundsCompleted === undefined
          ? {}
          : { roundsCompleted: event.roundsCompleted }),
        ...(event.championId ? { championId: event.championId } : {}),
        ...(event.outcomeKind ? { outcomeKind: event.outcomeKind } : {}),
        ...(event.decisionBasis ? { decisionBasis: event.decisionBasis } : {}),
        ...(event.competitiveLandingCount === undefined
          ? {}
          : { competitiveLandingCount: event.competitiveLandingCount }),
        ...(event.sharedDefectCount === undefined
          ? {}
          : { sharedDefectCount: event.sharedDefectCount }),
        ...(event.explicitEmptyLaneCount === undefined
          ? {}
          : { explicitEmptyLaneCount: event.explicitEmptyLaneCount }),
        ...(event.recommendedId ? { recommendedId: event.recommendedId } : {}),
        ...(event.recommendationReason
          ? { recommendationReason: event.recommendationReason }
          : {}),
        ...(event.coverageConfidence
          ? { coverageConfidence: event.coverageConfidence }
          : {}),
        ...(event.terminalOutcome
          ? {
              terminalOutcome: {
                kind: event.terminalOutcome.kind,
                reasonCode: event.terminalOutcome.reasonCode,
                reason: event.terminalOutcome.reason,
              },
            }
          : {}),
        ...(event.contestants ? { contestants: event.contestants } : {}),
      };
      for (const final of event.contestants ?? []) {
        const target = state.contestants[final.id];
        target.health = final.health;
        target.status = final.status;
        target.authoritativeCheckCounts = {
          passed: final.checksPassed,
          total: final.checksTotal,
        };
      }
      return;
    default:
      return;
  }
}

export class DashboardObserver implements ArenaObserver, ArenaEventSink {
  private readonly emitter = new EventEmitter();
  private sequence = 0;
  readonly state = initialDashboardState();

  publish(input: ArenaEventInput | ArenaEvent): void {
    const finalized =
      "sequence" in input && "timestamp" in input && "version" in input;
    const event = finalized
      ? input
      : ({
          ...input,
          version: 1 as const,
          sequence: ++this.sequence,
          timestamp: new Date().toISOString(),
        } as ArenaEvent);
    this.sequence = Math.max(this.sequence, event.sequence);
    projectEvent(this.state, event);
    this.emitter.emit("change");
  }

  subscribe(listener: () => void): () => void {
    this.emitter.on("change", listener);
    return () => this.emitter.off("change", listener);
  }

  snapshot(): DashboardState {
    return structuredClone(this.state);
  }
}
