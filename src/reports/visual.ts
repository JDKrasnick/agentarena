import type { ContestantResult, RunState } from "../core/types.js";
import { contestantLabel } from "../core/labels.js";
import {
  latestCheck,
  reportCheckStatus,
  reportContestants,
  reportDefects,
  reportOutcome,
  reportRounds,
  truncateReportText,
} from "./presentation.js";

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

function latestRequired(contestant: ContestantResult): string {
  return reportCheckStatus(latestCheck(contestant, "required"));
}

/** A deterministic, self-contained visual companion to BATTLE.md. */
export function renderBattleVisual(state: RunState): string {
  const contestants = reportContestants(state);
  const blocks = contestants
    .map((contestant, index) => {
      const outcome = state.arenaOutcome?.contestants[contestant.id];
      const x = 54 + index * 570;
      return `<rect x="${x}" y="158" width="520" height="180" rx="16" fill="#121b26" stroke="#294056"/>
      <text x="${x + 28}" y="202" class="label">${escapeXml(contestantLabel(state.config.contestants, contestant.id).toUpperCase())}</text>
      <text x="${x + 28}" y="256" class="hp">${String(contestant.finalHealth)} HP</text>
      <text x="${x + 28}" y="292" class="body">Required suite: <tspan class="${latestRequired(contestant) === "PASS" ? "pass" : latestRequired(contestant) === "FAIL" ? "fail" : "warn"}">${latestRequired(contestant)}</tspan></text>
      <text x="${x + 28}" y="316" class="body">Recoil: ${String(outcome?.permanentRecoil ?? contestant.healthLedger.permanentRecoil)} HP</text>
      <text x="${x + 250}" y="316" class="body">Active damage: ${String(outcome?.activeDefectDamage ?? 0)} HP</text>`;
    })
    .join("\n");
  const defects = reportDefects(state);
  const defectLines = defects.length
    ? defects
        .slice(0, 3)
        .map(
          (defect, index) =>
            `<text x="76" y="${520 + index * 42}" class="body"><tspan class="${defect.active ? "fail" : "pass"}">${escapeXml(defect.active ? "UNRESOLVED" : "REPAIRED")}</tspan> · ${escapeXml(defect.representative.severity ?? "unrated")} · ${escapeXml(truncateReportText(defect.representative.claim, 88))}</text>`,
        )
        .join("\n")
    : `<text x="76" y="520" class="body">No landed defects recorded; this does not establish correctness.</text>`;
  const rounds = reportRounds(state)
    .slice(0, 3)
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
      return `<rect x="${54 + index * 380}" y="690" width="340" height="112" rx="12" fill="#121b26" stroke="#294056"/><text x="${78 + index * 380}" y="730" class="label">${label}</text><text x="${78 + index * 380}" y="766" class="body">${count ? `${String(count)} proven attack(s)` : "No proven attacks"}</text>`;
    })
    .join("\n");
  const outcome = reportOutcome(state);
  const verdict =
    state.coverageDecision?.decision === "inconclusive"
      ? `Inconclusive · ledger leader: ${state.ranking?.winner ?? "none"}`
      : state.coverageAssessment?.confidence === "provisional" &&
          !state.coverageDecision
        ? `Provisional leader: ${state.ranking?.winner ?? "none"}`
        : outcome.kind === "winner"
          ? `${state.coverageAssessment?.confidence === "reduced_confidence" || state.coverageDecision?.decision === "accept-reduced" ? "Reduced-confidence champion" : "Winner"}: ${contestantLabel(state.config.contestants, outcome.winner)}`
          : outcome.kind === "draw"
            ? "Result: DRAW"
            : "Result: INCOMPLETE";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="860" viewBox="0 0 1240 860" role="img" aria-label="Agent Arena battle result">
<style>.title{font:700 28px ui-monospace,Menlo,monospace;fill:#f5f7fa}.label{font:700 18px ui-monospace,Menlo,monospace;fill:#9ac0ff}.hp{font:700 38px ui-monospace,Menlo,monospace;fill:#72df90}.body{font:16px ui-monospace,Menlo,monospace;fill:#d7e0ea}.pass{fill:#72df90}.fail{fill:#ff8b84}.warn{fill:#f5c979}.muted{font:15px ui-monospace,Menlo,monospace;fill:#b4c1cd}</style>
<rect width="1240" height="860" fill="#070c12"/><text x="54" y="72" class="title">AGENT ARENA — EVIDENCE-LINKED BATTLE REPLAY</text><text x="54" y="112" class="muted">${escapeXml(verdict)} · ${escapeXml(state.ranking?.reason ?? "run incomplete")}</text>
${state.coverageAssessment ? `<text x="54" y="138" class="muted">Coverage ${escapeXml(state.coverageAssessment.confidence)} · ${String(state.coverageAssessment.counts.completed)} completed · ${String(state.coverageAssessment.counts.degraded)} degraded · ${String(state.coverageAssessment.counts.unresolved)} unresolved / ${String(state.coverageAssessment.counts.required)}</text>` : ""}
${blocks}
<text x="54" y="410" class="title">DECISIVE DEFECTS</text><rect x="54" y="438" width="1132" height="${defects.length ? 56 + Math.min(defects.length, 3) * 42 : 98}" rx="16" fill="#121b26" stroke="#294056"/>${defectLines}
<text x="54" y="650" class="title">ROUND DIGEST</text>${rounds}
<text x="54" y="842" class="muted">Generated from result.json · See BATTLE.md for commands, logs, and all evidence.</text>
</svg>`;
}
