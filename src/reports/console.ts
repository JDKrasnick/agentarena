import { pathToFileURL } from "node:url";
import type { RunState } from "../core/types.js";
import { contestantLabel } from "../core/labels.js";
import {
  latestCheck,
  reportCheckStatus,
  reportContestants,
  reportDefects,
  reportOutcome,
  reportOutcomeTotals,
  truncateReportText,
} from "./presentation.js";
import { conciseUsage, readRunUsageSummarySync } from "../telemetry/usage.js";

export interface ConsoleRenderOptions {
  color?: boolean;
  hyperlinks?: boolean;
}

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
};

function style(value: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${value}${ANSI.reset}` : value;
}

function terminalLink(
  label: string,
  artifact: string | undefined,
  enabled: boolean,
): string {
  if (!artifact) return label;
  if (!enabled) return `${label}: ${artifact}`;
  return `\u001b]8;;${pathToFileURL(artifact).href}\u0007${label}\u001b]8;;\u0007`;
}

export function renderConsoleSummary(
  state: RunState,
  options: ConsoleRenderOptions = {},
): string {
  const color = options.color ?? false;
  const hyperlinks = options.hyperlinks ?? false;
  const usageSummary = readRunUsageSummarySync(
    `${state.config.artifactRoot}/${state.runId}`,
  );
  const runWallTimeMs =
    new Date(state.completedAt ?? state.updatedAt).getTime() -
    new Date(state.startedAt).getTime();
  const usageLine = `Fight usage: ${(Math.max(0, runWallTimeMs) / 1000).toFixed(1)}s wall · ${conciseUsage(usageSummary)}`;
  if (state.terminalOutcome) {
    const terminal = state.terminalOutcome;
    const winner = terminal.eligibleContestantIds[0];
    return [
      style("Agent Arena — pre-review terminal result", ANSI.bold, color),
      `Status: ${terminal.kind.toUpperCase()} (${terminal.reasonCode})`,
      `Reason: ${terminal.reason}`,
      `Eligible patch: ${winner ? contestantLabel(state.config.contestants, winner) : "none"}`,
      terminal.kind === "forfeit"
        ? `Recommended patch: ${winner ? contestantLabel(state.config.contestants, winner) : "none"} (forfeit; no attack, repair, quality, or coverage work ran)`
        : "Recommended patch: none",
      usageLine,
      terminalLink("Open HTML dossier", state.artifacts.battleHtml, hyperlinks),
      terminalLink("Open Markdown report", state.artifacts.battle, hyperlinks),
    ].join("\n");
  }
  const contestants = reportContestants(state);
  const defects = reportDefects(state);
  const outcomeTotals = reportOutcomeTotals(state);
  const unresolved = defects.filter((defect) => defect.active);
  const browserAttackArtifacts = [
    ...new Set(
      state.attacks.flatMap((attack) => attack.browserArtifactRefs ?? []),
    ),
  ];
  const completedRounds = Math.max(
    0,
    ...contestants.flatMap((contestant) =>
      contestant.rounds
        .filter((round) => typeof round.round === "number")
        .map((round) => Number(round.round)),
    ),
  );
  const outcome = reportOutcome(state);
  const nonDiscriminating = outcome.kind === "non_discriminating";
  const champion =
    outcome.kind === "non_discriminating"
      ? `Non-discriminating battle: no arena champion (${String(state.arenaOutcome?.marginHp ?? 0)} HP raw ledger margin)`
      : outcome.kind === "draw"
        ? `Draw: ${state.ranking?.reason ?? "equal evidence"}`
        : outcome.kind === "winner"
          ? `${state.coverageAssessment?.confidence === "reduced_confidence" || state.coverageDecision?.decision === "accept-reduced" ? "Reduced-confidence champion" : "Arena champion"}: ${contestantLabel(state.config.contestants, outcome.winner)} (${String(state.arenaOutcome?.marginHp ?? 0)} HP, ${state.arenaOutcome?.marginClass ?? "unknown"})`
          : `${state.coverageDecision?.decision === "inconclusive" ? "Inconclusive; ledger leader" : state.coverageAssessment?.confidence === "provisional" && !state.coverageDecision ? "Provisional leader" : "Arena champion"}: ${state.ranking?.order[0] ? contestantLabel(state.config.contestants, state.ranking.order[0]) : "none"} (${String(state.arenaOutcome?.marginHp ?? 0)} HP, ${state.arenaOutcome?.marginClass ?? "unknown"})`;
  const recommendation = state.patchRecommendation?.contestantId
    ? contestantLabel(
        state.config.contestants,
        state.patchRecommendation.contestantId,
      )
    : "none";
  const profile = state.config.resolvedEffortProfile;
  const decisionLines = state.adaptiveDecisions.map((decision) => {
    const tokens = decision.consumption.tokenTelemetry;
    const signal =
      "signal" in decision
        ? ` · signal ${String(decision.signal.competitiveLandings)} competitive/${String(decision.signal.sharedDefects)} shared/${String(decision.signal.explicitEmptyLanes)} empty · low-signal streak ${String(decision.signal.consecutiveLowSignalCount)}`
        : "";
    return `Round ${String(decision.round)} decision: ${(decision.consumption.wallTimeMs / 1000).toFixed(1)}s · ${String(decision.consumption.providerCalls)} calls · tokens ${tokens.state}${tokens.totalTokens === undefined ? "" : ` (${String(tokens.totalTokens)})`}${signal} · ${decision.action} (${decision.reason})`;
  });

  return [
    style("Agent Arena — evidence-backed final result", ANSI.bold, color),
    `Mode: ${state.config.mode}`,
    ...(state.integrity === "assisted"
      ? ["Assisted — not competitively comparable"]
      : []),
    ...(state.pullRequestFixture
      ? [
          `Frozen PR: ${state.pullRequestFixture.repository}#${String(state.pullRequestFixture.number)}`,
          `Incumbent attribution: ${state.pullRequestFixture.attribution.confidence}${state.pullRequestFixture.attribution.provider ? ` (${state.pullRequestFixture.attribution.provider})` : ""}`,
        ]
      : []),
    `Effort: ${state.config.resolvedEffortProfile?.tier ?? state.config.effortMode}${state.config.effortAssessment?.fallback ? " (medium fallback)" : ""} · ${state.config.fixedRounds ? `${String(state.config.rounds)} fixed` : `${String(state.config.resolvedEffortProfile?.plannedRounds ?? state.config.rounds)} planned`} round(s)`,
    ...(profile
      ? [
          `Sealed-round pressure thresholds: ${(profile.roundEnvelopeMs / 60_000).toFixed(0)}m · ${String(profile.maxProviderCallsPerRound)} provider calls · ${String(profile.maxTokensPerRound)} tokens; phase limits ${String(profile.implementationMs / 60_000)}m/${String(profile.reviewMs / 60_000)}m/${String(profile.attackMs / 60_000)}m/${String(profile.judgeMs / 60_000)}m/${String(profile.repairMs / 60_000)}m`,
        ]
      : []),
    `Rounds completed: ${String(completedRounds)}/${String(state.config.fixedRounds ? state.config.rounds : (state.config.resolvedEffortProfile?.plannedRounds ?? state.config.rounds))}${completedRounds > (state.config.resolvedEffortProfile?.plannedRounds ?? state.config.rounds) ? " (extended)" : ""}`,
    usageLine,
    ...decisionLines,
    ...(state.adaptiveCompletion
      ? [
          `Completion: adaptive coverage (${state.adaptiveCompletion.reason})`,
          ...(state.adaptiveCompletion.skippedBriefs.length
            ? [
                `Skipped briefs: ${state.adaptiveCompletion.skippedBriefs.join(", ")}`,
              ]
            : []),
        ]
      : []),
    ...(state.coverageAssessment
      ? [
          `Coverage: ${state.coverageAssessment.confidence.replaceAll("_", " ")} — ${String(state.coverageAssessment.counts.completed)} completed, ${String(state.coverageAssessment.counts.degraded)} degraded, ${String(state.coverageAssessment.counts.unresolved)} unresolved / ${String(state.coverageAssessment.counts.required)} required`,
          `Evidence: ${String(state.coverageAssessment.evidenceCounts.mechanical)} mechanical, ${String(state.coverageAssessment.evidenceCounts.judgeConfirmed)} judge-confirmed, ${String(state.coverageAssessment.evidenceCounts.judgePartial)} 35% partial-judge`,
          ...(state.coverageAssessment.reasonCodes.length
            ? [
                `Coverage reasons: ${state.coverageAssessment.reasonCodes.join(", ")}`,
              ]
            : []),
        ]
      : ["Coverage: legacy/unknown"]),
    ...(contestants.some((contestant) => contestant.browserValidation)
      ? [
          `Browser coverage: ${contestants
            .map(
              (contestant) =>
                `${contestantLabel(state.config.contestants, contestant.id)} ${contestant.browserValidation?.status ?? "not run"}${contestant.browserValidation?.reason ? ` (${contestant.browserValidation.reason})` : ""}`,
            )
            .join("; ")}`,
        ]
      : []),
    ...(browserAttackArtifacts.length
      ? [
          terminalLink(
            `Browser attack evidence (${String(browserAttackArtifacts.length)} artifacts)`,
            browserAttackArtifacts.find((artifact) =>
              artifact.endsWith("-result.json"),
            ) ?? browserAttackArtifacts[0],
            hyperlinks,
          ),
        ]
      : []),
    `Attack outcomes: ${String(outcomeTotals.competitiveLandings)} competitive landing · ${String(outcomeTotals.sharedDefects)} shared defect · ${String(outcomeTotals.schemaRejectedFindings)} schema-rejected findings`,
    "",
    "Contestant   Required suite  Final HP  Unresolved  Recoil",
    ...contestants.map((contestant) => {
      const outcome = state.arenaOutcome?.contestants[contestant.id];
      const required = reportCheckStatus(latestCheck(contestant, "required"));
      const requiredDisplay = style(
        required,
        required === "PASS"
          ? ANSI.green
          : required === "INFRA" ||
              required === "SKIPPED" ||
              required === "NOT RUN"
            ? ANSI.yellow
            : ANSI.red,
        color,
      );
      return `${contestantLabel(state.config.contestants, contestant.id).padEnd(12)} ${requiredDisplay.padEnd(14 + (color ? ANSI.green.length + ANSI.reset.length : 0))} ${String(contestant.finalHealth).padStart(3)} HP  ${String(outcome?.activeDefectDamage ?? 0).padStart(3)} HP  ${String(outcome?.permanentRecoil ?? contestant.healthLedger.permanentRecoil).padStart(3)} HP`;
    }),
    "",
    style(
      state.integrity === "assisted"
        ? champion.replace(/^Arena champion:/, "Assisted leader:")
        : champion,
      ANSI.bold,
      color,
    ),
    state.config.mode === "siege"
      ? "Production artifact: defender final patch only"
      : nonDiscriminating
        ? `Independent recommendation: ${recommendation}`
        : `Recommended patch: ${recommendation}`,
    state.config.mode === "siege"
      ? "Patch comparison: disabled for asymmetric siege"
      : `Recommendation reason: ${state.patchRecommendation?.rationale.join(" ") ?? "run incomplete"}`,
    defects.length
      ? `Evidence: ${String(defects.filter((defect) => defect.evidenceClass === "competitive").length)} competitive landing(s), ${String(defects.filter((defect) => defect.evidenceClass === "shared").length)} shared defect(s). ${defects.map((defect) => `${defect.representative.severity ?? "unrated"} ${truncateReportText(defect.representative.claim, 80)} (${defect.active ? "UNRESOLVED" : "REPAIRED"})`).join("; ")}`
      : "Recorded attacks: no landed defects; this does not establish correctness",
    unresolved.length
      ? style(
          `Still needed: review ${String(unresolved.length)} unresolved defect(s) before applying a patch`,
          ANSI.red,
          color,
        )
      : "Still needed: choose a patch for human review",
    "Human review: pending",
    terminalLink("Open HTML dossier", state.artifacts.battleHtml, hyperlinks),
    terminalLink("Open Markdown report", state.artifacts.battle, hyperlinks),
    state.coverageAssessment?.confidence === "provisional" &&
    !state.coverageDecision
      ? `Next: agent-arena resolve-coverage ${state.runId} --assessment-digest ${state.coverageAssessment.assessmentDigest} --decision <accept-reduced|inconclusive>`
      : `Next: agent-arena review ${state.runId}`,
  ].join("\n");
}
