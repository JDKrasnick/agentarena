import type { ContestantResult, RunState } from "../core/types.js";
import { contestantLabel } from "../core/labels.js";
import {
  latestCheck,
  reportCheckStatus,
  reportContestants,
  reportDefects,
  reportOutcome,
  reportOutcomeTotals,
  reportRounds,
  requiredValidationAttemptSummary,
  truncateReportText,
} from "./presentation.js";
import { projectImplementationEligibility } from "../outcomes/eligibility.js";
import { describeTokenPressureV1 } from "../effort/policy.js";

function escapeXml(value: string): string {
  return value.replace(
    /[<>&"']/gu,
    (character) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[character] ?? character,
  );
}

function wrapVisualText(value: string, maxCharacters: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of value.split(/\s+/u)) {
    if (!current) {
      current = word;
      continue;
    }
    if (current.length + word.length + 1 <= maxCharacters) {
      current += ` ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function latestRequired(contestant: ContestantResult): string {
  return reportCheckStatus(latestCheck(contestant, "required"));
}

/** A deterministic, self-contained visual companion to BATTLE.md. */
export function renderBattleVisual(state: RunState): string {
  if (state.terminalOutcome) {
    const terminal = state.terminalOutcome;
    const recommended =
      terminal.kind === "forfeit" && terminal.eligibleContestantIds[0]
        ? contestantLabel(
            state.config.contestants,
            terminal.eligibleContestantIds[0],
          )
        : "none";
    const evidenceLines =
      terminal.version === 2
        ? terminal.contestants.flatMap((entry) => {
            const label = contestantLabel(
              state.config.contestants,
              entry.contestantId,
            );
            return [
              `${label}: ${entry.eligible ? "eligible" : "ineligible"} · ${entry.reasonCode ?? "eligible_patch"}${entry.validation ? ` · ${entry.validation.outcome.replaceAll("_", " ")}` : ""}`,
              ...(entry.validation
                ? requiredValidationAttemptSummary(entry.validation).map(
                    (attempt) => `  ${attempt}`,
                  )
                : []),
            ];
          })
        : terminal.affectedContestantIds.map(
            (id) =>
              `${contestantLabel(state.config.contestants, id)}: ineligible · ${terminal.reasonCode} · legacy record`,
          );
    const evidence = evidenceLines
      .map(
        (line, index) =>
          `<text x="84" y="${String(342 + index * 30)}" class="${line.startsWith("  ") ? "muted" : "body"}">${escapeXml(truncateReportText(line, 122))}</text>`,
      )
      .join("\n");
    const footerY = 380 + evidenceLines.length * 30;
    const height = footerY + 54;
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="${String(height)}" viewBox="0 0 1240 ${String(height)}" role="img" aria-label="Agent Arena pre-review terminal result">
<style>.title{font:700 30px ui-monospace,Menlo,monospace;fill:#f5f7fa}.label{font:700 20px ui-monospace,Menlo,monospace;fill:#9ac0ff}.body{font:17px ui-monospace,Menlo,monospace;fill:#d7e0ea}.muted{font:15px ui-monospace,Menlo,monospace;fill:#b4c1cd}</style>
<rect width="1240" height="${String(height)}" fill="#070c12"/><text x="54" y="78" class="title">AGENT ARENA — PRE-REVIEW RESULT</text>
<rect x="54" y="122" width="1132" height="${String(height - 140)}" rx="16" fill="#121b26" stroke="#294056"/>
<text x="84" y="176" class="label">${escapeXml(terminal.kind.toUpperCase())} · ${escapeXml(terminal.reasonCode)}</text>
<text x="84" y="226" class="body">Eligible production patch: ${escapeXml(recommended)}</text>
<text x="84" y="274" class="body">${escapeXml(truncateReportText(terminal.reason, 108))}</text>
<text x="84" y="312" class="label">CONTESTANT ELIGIBILITY AND VALIDATION</text>
${evidence}
<text x="84" y="${String(footerY)}" class="muted">Review, attack, repair, quality comparison, and coverage stages were not run.</text>
<text x="84" y="${String(footerY + 30)}" class="muted">Generated from result.json · See BATTLE.md for diagnostic artifacts.</text>
</svg>`;
  }
  const contestants = reportContestants(state);
  const implementationEligibility = projectImplementationEligibility(state);
  const blocks = contestants
    .map((contestant, index) => {
      const outcome = state.arenaOutcome?.contestants[contestant.id];
      const eligibility = implementationEligibility.find(
        (entry) => entry.contestantId === contestant.id,
      );
      const x = 54 + index * 570;
      const attempt = eligibility?.validation
        ? requiredValidationAttemptSummary(eligibility.validation)[0]
        : undefined;
      return `<rect x="${x}" y="158" width="520" height="195" rx="16" fill="#121b26" stroke="#294056"/>
      <text x="${x + 28}" y="202" class="label">${escapeXml(contestantLabel(state.config.contestants, contestant.id).toUpperCase())}</text>
      <text x="${x + 28}" y="256" class="hp">${String(contestant.finalHealth)} HP</text>
      <text x="${x + 28}" y="292" class="body">Required suite: <tspan class="${latestRequired(contestant) === "PASS" ? "pass" : latestRequired(contestant) === "FAIL" ? "fail" : "warn"}">${latestRequired(contestant)}</tspan></text>
      <text x="${x + 28}" y="316" class="body">Recoil: ${String(outcome?.permanentRecoil ?? contestant.healthLedger.permanentRecoil)} HP</text>
      <text x="${x + 250}" y="316" class="body">Active damage: ${String(outcome?.activeDefectDamage ?? 0)} HP</text>
      <text x="${x + 28}" y="340" class="tiny">Eligibility: ${escapeXml(eligibility ? (eligibility.eligible ? "eligible" : "ineligible") : "not recorded")}${eligibility?.validation ? ` · ${escapeXml(eligibility.validation.outcome)} · ${escapeXml(truncateReportText(attempt ?? "", 48))}` : ""}</text>`;
    })
    .join("\n");
  const defects = reportDefects(state);
  const outcomeTotals = reportOutcomeTotals(state);
  const defectLines = defects.length
    ? defects
        .slice(0, 3)
        .map(
          (defect, index) =>
            `<text x="76" y="${520 + index * 42}" class="body"><tspan class="${defect.active ? "fail" : "pass"}">${escapeXml(defect.active ? "UNRESOLVED" : "REPAIRED")}</tspan> · ${escapeXml(defect.evidenceClass.toUpperCase())} · ${escapeXml(defect.representative.severity ?? "unrated")} · ${escapeXml(truncateReportText(defect.representative.claim, 76))}</text>`,
        )
        .join("\n")
    : `<text x="76" y="520" class="body">No landed defects recorded; this does not establish correctness.</text>`;
  const rounds = reportRounds(state)
    .slice(0, 5)
    .map((round, index) => {
      const count = round.attacks.filter(
        (attack) => attack.status === "landed",
      ).length;
      const label =
        round.id === "recovery"
          ? "RECOVERY"
          : round.id === "reconciliation"
            ? "RECONCILIATION"
            : `ROUND ${String(round.id)}`;
      return `<rect x="${54 + index * 226}" y="690" width="206" height="112" rx="12" fill="#121b26" stroke="#294056"/><text x="${70 + index * 226}" y="730" class="label">${label}</text><text x="${70 + index * 226}" y="766" class="body">${count ? `${String(count)} proven` : "No proven attacks"}</text>`;
    })
    .join("\n");
  const profile = state.config.resolvedEffortProfile;
  const budgetLine = profile
    ? `${profile.tier} · ${String(profile.plannedRounds)} planned / ${String(profile.maxRounds)} max · sealed-round pressure at ${String(profile.roundEnvelopeMs / 60_000)}m / ${String(profile.maxProviderCallsPerRound)} calls / ${String(profile.maxTokensPerRound)} weighted token units (v1; cache reads ×0.1)`
    : `${state.config.effortMode} · legacy budget unavailable`;
  const budgetLines = wrapVisualText(budgetLine, 108);
  const budgetText = budgetLines
    .map(
      (line, index) =>
        `<text x="54" y="${String(858 + index * 20)}" class="muted" data-effort-line="${String(index + 1)}">${escapeXml(line)}</text>`,
    )
    .join("\n");
  let decisionY = 858 + budgetLines.length * 20 + 12;
  const decisionLines = state.adaptiveDecisions.length
    ? state.adaptiveDecisions
        .map((decision) => {
          const telemetry = decision.consumption.tokenTelemetry;
          const tokens = `${telemetry.state}${telemetry.totalTokens === undefined ? "" : ` ${String(telemetry.totalTokens)} processed`}${decision.version === 3 ? ` · ${describeTokenPressureV1(decision.consumption.tokenPressureEvaluation)}` : ""}`;
          const signal =
            "signal" in decision
              ? ` · ${String(decision.signal.competitiveLandings)} competitive/${String(decision.signal.sharedDefects)} shared/${String(decision.signal.explicitEmptyLanes)} empty · streak ${String(decision.signal.consecutiveLowSignalCount)}`
              : "";
          const lines = wrapVisualText(
            `R${String(decision.round)} · ${(decision.consumption.wallTimeMs / 1000).toFixed(1)}s · ${String(decision.consumption.providerCalls)} calls · tokens ${tokens}${signal} · ${decision.action}: ${decision.reason}`,
            120,
          );
          const text = lines
            .map(
              (line, index) =>
                `<text x="76" y="${String(decisionY + index * 20)}" class="tiny" data-decision-round="${String(decision.round)}" data-decision-line="${String(index + 1)}">${escapeXml(line)}</text>`,
            )
            .join("\n");
          decisionY += lines.length * 20 + 8;
          return text;
        })
        .join("\n")
    : `<text x="76" y="${String(decisionY)}" class="tiny">No adaptive decisions recorded.</text>`;
  if (!state.adaptiveDecisions.length) decisionY += 28;
  const visualHeight = Math.max(1040, decisionY + 48);
  const footerY = visualHeight - 15;
  const outcome = reportOutcome(state);
  const verdict =
    state.coverageDecision?.decision === "inconclusive"
      ? `Inconclusive · ledger leader: ${state.ranking?.order[0] ?? "none"}`
      : state.coverageAssessment?.confidence === "provisional" &&
          !state.coverageDecision
        ? `Provisional leader: ${state.ranking?.winner ?? "none"}`
        : outcome.kind === "winner"
          ? `${state.coverageAssessment?.confidence === "reduced_confidence" || state.coverageDecision?.decision === "accept-reduced" ? "Reduced-confidence champion" : "Winner"}: ${contestantLabel(state.config.contestants, outcome.winner)}`
          : outcome.kind === "draw"
            ? "Result: DRAW"
            : outcome.kind === "non_discriminating"
              ? "Non-discriminating battle · No arena champion"
              : "Result: INCOMPLETE";
  return `<?xml version="1.0" encoding="UTF-8"?>
 <svg xmlns="http://www.w3.org/2000/svg" width="1240" height="${String(visualHeight)}" viewBox="0 0 1240 ${String(visualHeight)}" role="img" aria-label="Agent Arena battle result">
 <style>.title{font:700 28px ui-monospace,Menlo,monospace;fill:#f5f7fa}.label{font:700 18px ui-monospace,Menlo,monospace;fill:#9ac0ff}.hp{font:700 38px ui-monospace,Menlo,monospace;fill:#72df90}.body{font:16px ui-monospace,Menlo,monospace;fill:#d7e0ea}.tiny{font:13px ui-monospace,Menlo,monospace;fill:#d7e0ea}.pass{fill:#72df90}.fail{fill:#ff8b84}.warn{fill:#f5c979}.muted{font:15px ui-monospace,Menlo,monospace;fill:#b4c1cd}</style>
 <rect width="1240" height="${String(visualHeight)}" fill="#070c12"/><text x="54" y="72" class="title">AGENT ARENA — EVIDENCE-LINKED BATTLE REPLAY</text><text x="54" y="112" class="muted">${escapeXml(verdict)} · ${escapeXml(state.ranking?.reason ?? "run incomplete")}</text>
${state.coverageAssessment ? `<text x="54" y="138" class="muted">Coverage ${escapeXml(state.coverageAssessment.confidence)} · ${String(state.coverageAssessment.counts.completed)} completed · ${String(state.coverageAssessment.counts.degraded)} degraded · ${String(state.coverageAssessment.counts.unresolved)} unresolved / ${String(state.coverageAssessment.counts.required)}</text>` : ""}
${blocks}
<text x="54" y="378" class="muted">Competitive landings ${String(outcomeTotals.competitiveLandings)} · Shared defects ${String(outcomeTotals.sharedDefects)} · Schema-rejected findings ${String(outcomeTotals.schemaRejectedFindings)}</text>
<text x="54" y="410" class="title">DECISIVE DEFECTS</text><rect x="54" y="438" width="1132" height="${defects.length ? 56 + Math.min(defects.length, 3) * 42 : 98}" rx="16" fill="#121b26" stroke="#294056"/>${defectLines}
<text x="54" y="650" class="title">ROUND DIGEST</text>${rounds}
 <text x="54" y="835" class="title">EFFORT AND DECISION LEDGER</text>${budgetText}${decisionLines}
 <text x="54" y="${String(footerY)}" class="muted">Generated from result.json · See BATTLE.md for commands, logs, and all evidence.</text>
 </svg>`;
}
