import type {
  ConditionMeasurement,
  PauseReplanEvaluationResult,
} from "./pause-replan.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

function percent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function completion(
  measurements: readonly ConditionMeasurement[],
  provider: "claude" | "codex",
  condition: "telemetry_only" | "checkpoint",
  budget: number,
): string {
  const selected = measurements.filter(
    (measurement) =>
      measurement.provider === provider && measurement.condition === condition,
  );
  if (selected.length === 0) return "—";
  const completed = selected.filter(
    (measurement) =>
      measurement.accepted_attacks > 0 &&
      measurement.first_broad_call !== undefined &&
      measurement.first_executable_test_call !== undefined &&
      measurement.first_executable_test_call - measurement.first_broad_call <=
        budget,
  ).length;
  return `${completed}/${selected.length} (${percent((completed / selected.length) * 100)})`;
}

export function renderPauseReplanSummary(
  result: PauseReplanEvaluationResult,
): string {
  const verdict =
    result.phase === "transport_gate"
      ? result.transport_gate.status
      : (result.verdict?.verdict ?? "Inconclusive");
  const funnel = [
    ["Conditions started", result.measurements.length],
    [
      "Broad action observed",
      result.measurements.filter(
        (measurement) => measurement.first_broad_call !== undefined,
      ).length,
    ],
    [
      "Checkpoint acknowledged",
      result.measurements.filter(
        (measurement) => measurement.checkpoint_acknowledged,
      ).length,
    ],
    [
      "Executable test created",
      result.measurements.filter(
        (measurement) => measurement.first_executable_test_call !== undefined,
      ).length,
    ],
    [
      "Attack accepted",
      result.measurements.filter(
        (measurement) => measurement.accepted_attacks > 0,
      ).length,
    ],
    [
      "Attack landed",
      result.measurements.filter(
        (measurement) => (measurement.landed_attacks ?? 0) > 0,
      ).length,
    ],
  ] as const;
  const funnelRows = funnel
    .map(
      ([label, value]) =>
        `<tr><th scope="row">${label}</th><td>${value}</td><td><span class="bar" style="--value:${result.measurements.length === 0 ? 0 : (value / result.measurements.length) * 100}%"></span></td></tr>`,
    )
    .join("");
  const curveRows = ([20, 40, 60, 100] as const)
    .map(
      (budget) =>
        `<tr><th scope="row">${budget}</th><td>${completion(result.measurements, "claude", "telemetry_only", budget)}</td><td>${completion(result.measurements, "claude", "checkpoint", budget)}</td><td>${completion(result.measurements, "codex", "telemetry_only", budget)}</td><td>${completion(result.measurements, "codex", "checkpoint", budget)}</td></tr>`,
    )
    .join("");
  const ledgerRows = result.measurements
    .map(
      (measurement) =>
        `<tr><th scope="row">${escapeHtml(measurement.scenario_id)}</th><td>${measurement.provider}</td><td>${measurement.condition.replaceAll("_", " ")}</td><td>${measurement.first_broad_call ?? "—"}</td><td>${measurement.first_executable_test_call ?? "Censored"}</td><td>${measurement.primary_outcome ? "Yes" : "No"}</td><td>${measurement.accepted_attacks}</td><td>${measurement.landed_attacks ?? "Incomplete"}</td><td>$${measurement.estimated_cost_usd.toFixed(4)}</td><td class="timeline">${measurement.lifecycle_kinds.map((kind) => escapeHtml(kind.replaceAll("_", " "))).join(" → ")}</td><td><a href="${escapeHtml(measurement.lifecycle_path)}">ledger</a></td></tr>`,
    )
    .join("");
  const modelRows = (result.verdict?.models ?? [])
    .map(
      (model) =>
        `<tr><th scope="row">${model.provider}</th><td>${model.comparable_pairs}</td><td>${percent(model.control_primary_rate * 100)}</td><td>${percent(model.checkpoint_primary_rate * 100)}</td><td>${percent(model.difference_points)}</td><td>${model.accepted_control} / ${model.accepted_checkpoint}</td><td>${model.landed_control ?? "Incomplete"} / ${model.landed_checkpoint ?? "Incomplete"}</td></tr>`,
    )
    .join("");
  const failures = result.transport_gate.failures.length
    ? `<ul>${result.transport_gate.failures.map((failure) => `<li>${escapeHtml(failure)}</li>`).join("")}</ul>`
    : "<p>No protocol failures recorded.</p>";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pause–replan evaluation</title>
<style>
:root{color-scheme:light;--ink:#172126;--muted:#5f6c72;--paper:#f4f1e9;--card:#fff;--line:#cbd1cf;--accent:#ad3e28;--good:#1f6a4b;--focus:#1267a4}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}main{width:min(1180px,calc(100% - 32px));margin:auto;padding:48px 0 72px}header.hero{display:grid;grid-template-columns:1fr auto;gap:28px;align-items:end;border-bottom:2px solid var(--ink);padding-bottom:26px}h1{font:700 clamp(36px,6vw,72px)/.95 ui-serif,Georgia,serif;letter-spacing:-.04em;margin:0}h2{font:700 26px/1.15 ui-serif,Georgia,serif;margin:0}.eyebrow{color:var(--accent);font-weight:800;text-transform:uppercase;letter-spacing:.12em}.verdict{border:1px solid var(--ink);background:var(--card);padding:18px 22px;min-width:230px}.verdict strong{display:block;font-size:24px}.meta{color:var(--muted);margin:.6rem 0 0}section{margin-top:46px}.section-head{display:flex;justify-content:space-between;gap:24px;align-items:end;margin-bottom:14px}.surface{background:var(--card);border:1px solid var(--line);overflow:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:12px 14px;text-align:left;border-bottom:1px solid #e4e7e5;white-space:nowrap}thead th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;background:#ecefeb}tbody th{font-weight:700}.bar{display:block;width:var(--value);height:9px;min-width:2px;background:var(--accent)}code{font-size:12px}.summary-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.callout{background:var(--ink);color:white;padding:22px}.callout strong{font-size:24px}.callout p{color:#ced6d8}.empty{padding:24px;color:var(--muted)}a:focus-visible,summary:focus-visible{outline:3px solid var(--focus);outline-offset:3px}@media(max-width:760px){main{width:min(100% - 20px,1180px);padding-top:26px}header.hero,.summary-grid{grid-template-columns:1fr}.verdict{min-width:0}.section-head{display:block}.section-head p{margin-bottom:0}th,td{padding:10px}}
</style></head><body><main><header class="hero"><div><p class="eyebrow">Agent Arena research · schema v2</p><h1>Pause–replan hypothesis</h1><p class="meta">${escapeHtml(result.manifest.evaluation_id)} · ${result.phase.replaceAll("_", " ")} · ${escapeHtml(result.created_at)}</p></div><div class="verdict"><span>Result</span><strong>${escapeHtml(verdict)}</strong><span>$${result.total_estimated_cost_usd.toFixed(4)} estimated</span></div></header>
<section class="summary-grid"><div class="callout"><span>Primary comparison</span><strong>${result.verdict ? percent(result.verdict.pooled_difference_points) : "Pending full run"}</strong><p>${escapeHtml(result.verdict?.reason ?? "The transport gate validates delivery and containment only; it does not estimate efficacy.")}</p></div><div class="surface empty"><strong>Protocol gate</strong>${failures}</div></section>
<section><div class="section-head"><div><h2>Delivery funnel</h2><p>Exact counts from interruption through landed evidence.</p></div></div><div class="surface"><table><thead><tr><th>Stage</th><th>Sessions</th><th>Relative volume</th></tr></thead><tbody>${funnelRows}</tbody></table></div></section>
<section><div class="section-head"><div><h2>Completion by call budget</h2><p>Accepted executable attacks completed within the stated calls after first drift. Censored sessions remain in the denominator.</p></div></div><div class="surface"><table><thead><tr><th>Calls</th><th>Claude control</th><th>Claude checkpoint</th><th>Codex control</th><th>Codex checkpoint</th></tr></thead><tbody>${curveRows}</tbody></table></div></section>
<section><div class="section-head"><div><h2>Model and quality guardrails</h2><p>Primary rates plus accepted and landed attack counts, shown as control / checkpoint.</p></div></div><div class="surface">${modelRows ? `<table><thead><tr><th>Model</th><th>Pairs</th><th>Control</th><th>Checkpoint</th><th>Difference</th><th>Accepted</th><th>Landed</th></tr></thead><tbody>${modelRows}</tbody></table>` : '<p class="empty">Available after the full comparison.</p>'}</div></section>
<section><div class="section-head"><div><h2>Condition timelines</h2><p>Exact values, ordered redacted event summaries, and paths to the complete local lifecycle sidecars. No prompts, reasoning, commands, or file contents are embedded.</p></div></div><div class="surface"><table><thead><tr><th>Scenario</th><th>Model</th><th>Condition</th><th>Drift call</th><th>Test call</th><th>Primary</th><th>Accepted</th><th>Landed</th><th>Cost</th><th>Timeline</th><th>Lifecycle</th></tr></thead><tbody>${ledgerRows}</tbody></table></div></section>
</main></body></html>`;
}
