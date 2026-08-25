import type {
  Condition,
  Measurement,
  RediscoveryEvaluationResult,
  SubmissionOutcome,
} from "./rediscovery.js";

const htmlEscape = (value: string): string =>
  value.replace(/[&<>"']/gu, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });

function exact(value: number | undefined, unit = ""): string {
  return value === undefined ? "Not measured" : `${value.toFixed(2)}${unit}`;
}

function conditionMeasurements(
  result: RediscoveryEvaluationResult,
  condition: Condition,
): Measurement[] {
  return result.pairs.map((pair) =>
    condition === "warning" ? pair.treatment : pair.control,
  );
}

function countOutcome(
  result: RediscoveryEvaluationResult,
  condition: Condition,
  outcome: SubmissionOutcome,
): number {
  return conditionMeasurements(result, condition).filter(
    (measurement) => measurement.outcome === outcome,
  ).length;
}

function verdictClass(verdict: string): string {
  return verdict === "Worked"
    ? "worked"
    : verdict === "Did not work"
      ? "failed"
      : "inconclusive";
}

export function renderRediscoverySummary(
  result: RediscoveryEvaluationResult,
): string {
  const measurablePairs = result.pairs.filter(
    (pair) =>
      ["usable", "empty"].includes(pair.control.outcome) &&
      ["usable", "empty"].includes(pair.treatment.outcome) &&
      pair.control.visibility === "complete" &&
      pair.treatment.visibility === "complete" &&
      pair.control.triggered &&
      pair.treatment.triggered &&
      pair.treatment.warningStatus === "shown",
  );
  const maximumCalls = Math.max(
    1,
    ...measurablePairs.flatMap((pair) => [
      pair.control.callsToEdit,
      pair.treatment.callsToEdit,
    ]),
  );
  const plotLeft = 270;
  const plotRight = 960;
  const callX = (value: number) =>
    plotLeft + (value / maximumCalls) * (plotRight - plotLeft);
  const rowHeight = 52;
  const dumbbellHeight = Math.max(150, measurablePairs.length * rowHeight + 80);
  const tickValues = [
    ...new Set([0, Math.ceil(maximumCalls / 2), maximumCalls]),
  ];
  const ticks = tickValues
    .map((value) => {
      const x = callX(value);
      return `<g aria-hidden="true"><line class="grid-line" x1="${x}" x2="${x}" y1="36" y2="${dumbbellHeight - 34}"/><text class="axis-label" x="${x}" y="${dumbbellHeight - 10}" text-anchor="middle">${value}</text></g>`;
    })
    .join("");
  const dumbbells = measurablePairs
    .map((pair, index) => {
      const y = 60 + index * rowHeight;
      const exactControlX = callX(pair.control.callsToEdit);
      const exactTreatmentX = callX(pair.treatment.callsToEdit);
      const coincident = exactControlX === exactTreatmentX;
      const controlX = coincident ? exactControlX - 7 : exactControlX;
      const treatmentX = coincident ? exactTreatmentX + 7 : exactTreatmentX;
      return `<g tabindex="0" role="group" aria-label="${htmlEscape(pair.pairId)}: control ${pair.control.callsToEdit}, warning ${pair.treatment.callsToEdit}"><text class="pair-label" x="0" y="${y + 5}">${htmlEscape(pair.pairId)}</text><line class="pair-line" x1="${controlX}" y1="${y}" x2="${treatmentX}" y2="${y}"/><circle class="control-mark" cx="${controlX}" cy="${y}" r="7"><title>Control: ${pair.control.callsToEdit} calls</title></circle><circle class="warning-mark" cx="${treatmentX}" cy="${y}" r="7"><title>Warning: ${pair.treatment.callsToEdit} calls</title></circle><text class="value-label" x="${controlX}" y="${y - 12}" text-anchor="middle">${pair.control.callsToEdit}</text><text class="value-label" x="${treatmentX}" y="${y + 23}" text-anchor="middle">${pair.treatment.callsToEdit}</text></g>`;
    })
    .join("");

  const effects = [
    ["Tool calls", result.verdict.effects.callsPct, "%"],
    ["Duration", result.verdict.effects.durationMs, " ms"],
    ["Tokens", result.verdict.effects.tokens, ""],
    ["Estimated cost", result.verdict.effects.costUsd, " USD"],
  ] as const;
  const effectRows = effects
    .map(([label, effect, unit]) => {
      const interval = effect.interval;
      return `<tr><th scope="row">${label}</th><td>${effect.measuredPairs}</td><td>${exact(effect.median, unit)}</td><td>${interval ? `${exact(interval[0], unit)} to ${exact(interval[1], unit)}` : "Not measured"}</td></tr>`;
    })
    .join("");

  const quality = [
    [
      "Usable or explicitly empty",
      conditionMeasurements(result, "telemetry_only").filter((measurement) =>
        ["usable", "empty"].includes(measurement.outcome),
      ).length,
      conditionMeasurements(result, "warning").filter((measurement) =>
        ["usable", "empty"].includes(measurement.outcome),
      ).length,
    ],
    [
      "accepted attacks",
      result.verdict.controlAcceptedAttacks,
      result.verdict.treatmentAcceptedAttacks,
    ],
    [
      "landed attacks",
      result.verdict.controlLandedAttacks,
      result.verdict.treatmentLandedAttacks,
    ],
    [
      "Blockers",
      countOutcome(result, "telemetry_only", "blocker"),
      countOutcome(result, "warning", "blocker"),
    ],
    [
      "Malformed output",
      countOutcome(result, "telemetry_only", "malformed"),
      countOutcome(result, "warning", "malformed"),
    ],
    [
      "Timeouts",
      countOutcome(result, "telemetry_only", "timeout"),
      countOutcome(result, "warning", "timeout"),
    ],
  ] as const;
  const maxQuality = Math.max(
    1,
    ...quality.flatMap(([, control, treatment]) => [
      control ?? 0,
      treatment ?? 0,
    ]),
  );
  const qualityRows = quality
    .map(([label, control, treatment]) => {
      const controlWidth = ((control ?? 0) / maxQuality) * 100;
      const treatmentWidth = ((treatment ?? 0) / maxQuality) * 100;
      return `<tr><th scope="row">${label}</th><td><div class="bar-cell"><span class="bar control-bar" style="width:${controlWidth}%"></span><strong>${control === undefined ? "—" : String(control)}</strong></div></td><td><div class="bar-cell"><span class="bar warning-bar" style="width:${treatmentWidth}%"></span><strong>${treatment === undefined ? "—" : String(treatment)}</strong></div></td></tr>`;
    })
    .join("");

  const measurementRows = result.pairs
    .map(
      (pair) =>
        `<tr><th scope="row">${htmlEscape(pair.pairId)}</th><td>${htmlEscape(pair.control.outcome)}</td><td>${htmlEscape(pair.treatment.outcome)}</td><td>${pair.control.callsToEdit}</td><td>${pair.treatment.callsToEdit}</td><td>${htmlEscape(pair.conditionOrder.join(" → "))}</td><td>${pair.attempt}</td></tr>`,
    )
    .join("");
  const exclusionRows = result.excludedPairs
    .map(
      (pair) =>
        `<tr><th scope="row">${htmlEscape(pair.pairId)}</th><td>${htmlEscape(pair.reason.replaceAll("_", " "))}</td><td>${htmlEscape(pair.detail)}</td></tr>`,
    )
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rediscovery warning evaluation</title><style>
:root{color-scheme:light;--canvas:#f4f6f8;--panel:#fff;--ink:#17232b;--muted:#526267;--rule:#c5ced3;--rule-strong:#78888f;--control:#285e9c;--warning:#c04322;--success:#256b40;--danger:#a8321b;--caution:#7a5a08;--focus:#14736f;--shadow:0 12px 34px rgba(23,35,43,.09)}
*{box-sizing:border-box}html{background:var(--canvas);scroll-behavior:smooth}body{margin:0;color:var(--ink);font:15px/1.55 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}::selection{background:#ffe49b;color:#17232b}main{width:min(1240px,100%);margin:0 auto;padding:48px 32px 80px}.report-header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:28px;align-items:end;padding-bottom:28px;border-bottom:2px solid var(--ink)}h1{max-width:18ch;margin:0;font-size:clamp(34px,5vw,64px);line-height:1;letter-spacing:-.035em;text-wrap:balance}.run-meta{max-width:72ch;margin:18px 0 0;color:var(--muted);font-size:16px}.verdict{min-width:220px;padding:18px 20px;background:var(--ink);color:white}.verdict strong{display:block;font-size:26px;line-height:1.1}.verdict span{display:block;margin-top:8px;color:#d9e1e5}.verdict.worked{background:var(--success)}.verdict.failed{background:var(--danger)}.verdict.inconclusive{background:var(--caution)}.result-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-bottom:1px solid var(--rule-strong)}.result-strip div{padding:20px 22px;border-right:1px solid var(--rule)}.result-strip div:last-child{border-right:0}.result-strip dt{color:var(--muted);font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}.result-strip dd{margin:4px 0 0;font-size:22px;font-weight:760;font-variant-numeric:tabular-nums}.legend{display:flex;flex-wrap:wrap;gap:18px;margin:0;color:var(--muted)}.legend span{display:inline-flex;align-items:center;gap:7px}.swatch{width:12px;height:12px}.swatch.control{background:var(--control)}.swatch.warning{background:var(--warning)}section{margin-top:54px}section>header{display:flex;align-items:end;justify-content:space-between;gap:24px;margin-bottom:16px}h2{margin:0;font-size:25px;line-height:1.15;letter-spacing:-.02em}section>header p{max-width:62ch;margin:0;color:var(--muted)}.surface{background:var(--panel);box-shadow:var(--shadow);border:1px solid var(--rule)}.chart-scroll{overflow-x:auto;padding:18px}.chart-scroll svg{display:block;width:100%;min-width:900px;height:auto}.empty-state{padding:28px;max-width:68ch}.empty-state strong{display:block;font-size:18px}.empty-state span{display:block;margin-top:6px;color:var(--muted)}.grid-line{stroke:#dbe1e4;stroke-width:1}.pair-line{stroke:var(--rule-strong);stroke-width:3}.control-mark{fill:var(--control)}.warning-mark{fill:var(--warning)}.pair-label{fill:var(--ink);font-size:13px;font-weight:650}.value-label,.axis-label{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}svg g:focus{outline:none}svg g:focus .control-mark,svg g:focus .warning-mark{stroke:var(--focus);stroke-width:4}.table-scroll{overflow-x:auto}.table-scroll+ .table-scroll{border-top:1px solid var(--rule)}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}caption{text-align:left;padding:18px 20px 10px;color:var(--muted);font-weight:650}th,td{padding:13px 16px;border-bottom:1px solid var(--rule);text-align:left;vertical-align:middle}thead th{background:#edf1f3;color:#394b54;font-size:12px;letter-spacing:.045em;text-transform:uppercase;white-space:nowrap}tbody tr:last-child>*{border-bottom:0}tbody tr:nth-child(even){background:#fafbfc}tbody th{font-weight:650}.bar-cell{display:grid;grid-template-columns:minmax(90px,1fr) 34px;gap:12px;align-items:center;min-width:180px}.bar-cell strong{text-align:right}.bar{display:block;height:10px;min-width:2px}.control-bar{background:var(--control)}.warning-bar{background:var(--warning)}.two-column{display:grid;grid-template-columns:1fr 1.15fr;gap:22px}.limitations{margin-top:54px;padding-top:22px;border-top:1px solid var(--rule-strong);color:var(--muted);max-width:75ch}.mode-label{font-weight:750;color:var(--ink)}:focus-visible{outline:3px solid var(--focus);outline-offset:3px}@media(max-width:850px){main{padding:32px 18px 56px}.report-header{grid-template-columns:1fr}.verdict{min-width:0}.result-strip{grid-template-columns:1fr 1fr}.result-strip div:nth-child(2){border-right:0}.result-strip div:nth-child(-n+2){border-bottom:1px solid var(--rule)}.two-column{grid-template-columns:1fr}section>header{display:block}section>header p,.legend{margin-top:10px}}@media(max-width:520px){main{padding-inline:12px}.result-strip{grid-template-columns:1fr}.result-strip div{border-right:0;border-bottom:1px solid var(--rule)}.result-strip div:nth-child(2){border-bottom:1px solid var(--rule)}h1{font-size:38px}th,td{padding:11px 12px}}
</style></head><body><main><header class="report-header"><div><h1>Rediscovery warning evaluation</h1><p class="run-meta"><span class="mode-label">${result.manifest.mode === "live" ? "Live provider run" : "Synthetic protocol run"}</span> · ${htmlEscape(result.manifest.adapter)} / ${htmlEscape(result.manifest.model)} · seed ${result.manifest.seed}</p></div><div class="verdict ${verdictClass(result.verdict.verdict)}"><strong>${htmlEscape(result.verdict.verdict)}</strong><span>${result.verdict.measurablePairs} measurable of ${result.verdict.triggeredPairs} triggered pairs</span></div></header><dl class="result-strip"><div><dt>Improved pairs</dt><dd>${result.verdict.improvedPairs} / ${result.verdict.measurablePairs}</dd></div><div><dt>Median call improvement</dt><dd>${result.verdict.effects.callsPct.measuredPairs === 0 ? "Not measured" : exact(result.verdict.medianImprovementPct, "%")}</dd></div><div><dt>Median duration delta</dt><dd>${result.verdict.effects.durationMs.measuredPairs === 0 ? "Not measured" : exact(result.verdict.medianDurationDeltaMs, " ms")}</dd></div><div><dt>Excluded pairs</dt><dd>${result.excludedPairs.length}</dd></div></dl><section><header><div><h2>Calls from broad search to test edit</h2><p>Lower is better. Each row links the silent control to the warning treatment for the same frozen scenario.</p></div>${measurablePairs.length > 0 ? `<p class="legend"><span><i class="swatch control"></i>Silent telemetry</span><span><i class="swatch warning"></i>Visible warning</span></p>` : ""}</header>${measurablePairs.length > 0 ? `<div class="surface chart-scroll"><svg viewBox="0 0 1000 ${dumbbellHeight}" role="img" aria-labelledby="dumbbell-title dumbbell-desc"><title id="dumbbell-title">Paired tool calls by scenario</title><desc id="dumbbell-desc">Each labeled row links exact control and warning calls from the first broad inspection to the first executable test edit. Keyboard-focusable groups expose exact values.</desc>${ticks}${dumbbells}</svg></div>` : `<div class="surface empty-state"><strong>No measurable call pairs</strong><span>Every captured control and warning session timed out or otherwise failed the usability guardrail. Capped call counts are retained in the ledger for audit, but excluded from the effect estimate.</span></div>`}</section><section class="two-column"><div><header><div><h2>Effect sizes</h2><p>Paired medians with deterministic seeded 95% bootstrap intervals.</p></div></header><div class="surface table-scroll"><table><caption>Exact paired effects</caption><thead><tr><th>Measure</th><th>Pairs</th><th>Median</th><th>95% interval</th></tr></thead><tbody>${effectRows}</tbody></table></div></div><div><header><div><h2>Quality guardrails</h2><p>Submission usability and mechanically measured attack outcomes.</p></div></header><div class="surface table-scroll"><table><caption>Control versus warning counts</caption><thead><tr><th>Outcome</th><th>Control</th><th>Warning</th></tr></thead><tbody>${qualityRows}</tbody></table></div></div></section><section><header><div><h2>Pair ledger</h2><p>Captured session outcomes, capped call measurements, execution order, and retry attempt.</p></div></header><div class="surface table-scroll"><table><caption>Captured paired sessions</caption><thead><tr><th>Pair</th><th>Control outcome</th><th>Warning outcome</th><th>Control calls</th><th>Warning calls</th><th>Condition order</th><th>Attempt</th></tr></thead><tbody>${measurementRows}</tbody></table></div>${exclusionRows ? `<div class="surface table-scroll"><table><caption>Excluded pairs</caption><thead><tr><th>Pair</th><th>Reason</th><th>Detail</th></tr></thead><tbody>${exclusionRows}</tbody></table></div>` : ""}</section><p class="limitations"><strong>Limitations.</strong> Frozen inputs preserve comparability, but provider caching cannot be eliminated. Condition order is deterministically counterbalanced and reported. Timed-out, unsupported, partially visible, or non-triggered pairs are excluded from causal conclusions.</p></main></body></html>`;
}
