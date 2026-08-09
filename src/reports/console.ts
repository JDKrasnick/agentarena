import { pathToFileURL } from "node:url";
import type { RunState } from "../core/types.js";
import { contestantLabel } from "../core/labels.js";
import {
  latestCheck,
  reportCheckStatus,
  reportContestants,
  reportDefects,
  truncateReportText,
} from "./presentation.js";

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
  const contestants = reportContestants(state);
  const defects = reportDefects(state);
  const unresolved = defects.filter((defect) => defect.active);
  const completedRounds = Math.max(
    0,
    ...contestants.flatMap((contestant) =>
      contestant.rounds
        .filter((round) => typeof round.round === "number")
        .map((round) => Number(round.round)),
    ),
  );
  const champion = state.ranking?.draw
    ? `Draw: ${state.ranking.reason}`
    : `${state.coverageDecision?.decision === "inconclusive" ? "Inconclusive; ledger leader" : state.coverageAssessment?.confidence === "provisional" && !state.coverageDecision ? "Provisional leader" : state.coverageAssessment?.confidence === "reduced_confidence" || state.coverageDecision?.decision === "accept-reduced" ? "Reduced-confidence champion" : "Arena champion"}: ${state.coverageDecision?.decision === "inconclusive" && state.ranking?.order[0] ? contestantLabel(state.config.contestants, state.ranking.order[0]) : state.ranking?.winner ? contestantLabel(state.config.contestants, state.ranking.winner) : "none"} (${String(state.arenaOutcome?.marginHp ?? 0)} HP, ${state.arenaOutcome?.marginClass ?? "unknown"})`;
  const recommendation = state.patchRecommendation?.contestantId
    ? contestantLabel(
        state.config.contestants,
        state.patchRecommendation.contestantId,
      )
    : "none";

  return [
    style("Agent Arena — evidence-backed final result", ANSI.bold, color),
    `Mode: ${state.config.mode}`,
    ...(state.pullRequestFixture
      ? [
          `Frozen PR: ${state.pullRequestFixture.repository}#${String(state.pullRequestFixture.number)}`,
          `Incumbent attribution: ${state.pullRequestFixture.attribution.confidence}${state.pullRequestFixture.attribution.provider ? ` (${state.pullRequestFixture.attribution.provider})` : ""}`,
        ]
      : []),
    `Rounds completed: ${String(completedRounds)}/3`,
    ...(state.coverageAssessment
      ? [
          `Coverage: ${state.coverageAssessment.confidence.replaceAll("_", " ")} — ${String(state.coverageAssessment.counts.completed)} completed, ${String(state.coverageAssessment.counts.degraded)} degraded, ${String(state.coverageAssessment.counts.unresolved)} unresolved / ${String(state.coverageAssessment.counts.required)} required`,
          `Evidence: ${String(state.coverageAssessment.evidenceCounts.mechanical)} mechanical, ${String(state.coverageAssessment.evidenceCounts.judgeConfirmed)} judge-confirmed, ${String(state.coverageAssessment.evidenceCounts.judgePartial)} half-damage judge`,
          ...(state.coverageAssessment.reasonCodes.length
            ? [
                `Coverage reasons: ${state.coverageAssessment.reasonCodes.join(", ")}`,
              ]
            : []),
        ]
      : ["Coverage: legacy/unknown"]),
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
    style(champion, ANSI.bold, color),
    state.config.mode === "siege"
      ? "Production artifact: defender final patch only"
      : `Recommended patch: ${recommendation}`,
    state.config.mode === "siege"
      ? "Patch comparison: disabled for asymmetric siege"
      : `Recommendation reason: ${state.patchRecommendation?.rationale.join(" ") ?? "run incomplete"}`,
    defects.length
      ? `Decisive defects: ${defects.map((defect) => `${defect.representative.severity ?? "unrated"} ${truncateReportText(defect.representative.claim, 80)} (${defect.active ? "UNRESOLVED" : "REPAIRED"})`).join("; ")}`
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
