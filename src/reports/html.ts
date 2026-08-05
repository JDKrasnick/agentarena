import type {
  Attack,
  CheckResult,
  ContestantResult,
  RunState,
} from "../core/types.js";
import { contestantLabel } from "../core/labels.js";
import {
  latestCheck,
  reportCheckStatus,
  reportContestants,
  reportDefects,
  reportOutcome,
  reportRounds,
  resolveArtifactHref,
} from "./presentation.js";

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] ?? character,
  );
}

function artifactHref(state: RunState, artifact?: string): string | undefined {
  return resolveArtifactHref(state, artifact);
}

function link(state: RunState, label: string, artifact?: string): string {
  const href = artifactHref(state, artifact);
  return href
    ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
    : escapeHtml(label);
}

function chip(value: string, tone = "muted"): string {
  return `<span class="chip ${tone}">${escapeHtml(value)}</span>`;
}

function checkStatus(state: RunState, check?: CheckResult): string {
  if (!check) return chip("Not run", "muted");
  const tone =
    check.status === "passed"
      ? "pass"
      : check.status === "failed"
        ? "fail"
        : "warn";
  const duration = check.command
    ? ` · ${(check.command.durationMs / 1000).toFixed(1)}s`
    : "";
  return `${chip(`${reportCheckStatus(check)}${duration}`, tone)}${check.command ? ` <span class="log-links">${link(state, "stdout", check.command.stdoutPath)} ${link(state, "stderr", check.command.stderrPath)}</span>` : ""}`;
}

function latestChecks(contestant: ContestantResult): Map<string, CheckResult> {
  return contestant.checks.reduce(
    (checks, check) => checks.set(check.id, check),
    new Map<string, CheckResult>(),
  );
}

function attackAuthor(state: RunState, attack: Attack): string {
  return attack.origin.kind === "house"
    ? "House scout"
    : contestantLabel(state.config.contestants, attack.origin.contestant);
}

function attackEffect(attack: Attack): string {
  if (attack.status === "landed")
    return attack.damageActive
      ? `${String(attack.damage ?? 0)} HP remains active`
      : `${String(attack.damage ?? 0)} HP repaired`;
  if (attack.recoil) return `${String(attack.recoil)} HP recoil`;
  return "No health change";
}

function attackNarrative(attack: Attack): string {
  return (
    attack.outcomeReason ??
    attack.impact ??
    "No adjudication detail was recorded."
  );
}

/** A deterministic, self-contained, clickable battle dossier for local review. */
export function renderBattleHtml(state: RunState): string {
  const contestants = reportContestants(state);
  const outcome = reportOutcome(state);
  const winnerId = outcome.kind === "winner" ? outcome.winner : undefined;
  const winner = winnerId
    ? contestantLabel(state.config.contestants, winnerId)
    : undefined;
  const outcomeHeading = winner
    ? `${winner} won`
    : outcome.kind === "draw"
      ? "Draw result"
      : "Battle incomplete";
  const decisionHeading = winner
    ? `Why ${winner} won`
    : outcome.kind === "draw"
      ? "Why the battle ended in a draw"
      : "Why the battle is incomplete";
  const defects = reportDefects(state);
  const unresolved = defects.filter((defect) => defect.active);
  const repaired = defects.filter((defect) => !defect.active);
  const checkIds = [
    ...new Set(
      contestants.flatMap((contestant) =>
        contestant.checks.map((check) => check.id),
      ),
    ),
  ];
  const checkMaps = contestants.map(latestChecks);
  const requiredPassed = contestants.every(
    (contestant) =>
      reportCheckStatus(latestCheck(contestant, "required")) === "PASS",
  );
  const contestantCards = contestants
    .map((contestant) => {
      const outcome = state.arenaOutcome?.contestants[contestant.id];
      const isWinner = contestant.id === winnerId;
      return `<article class="contestant ${isWinner ? "winner" : ""}">
      <div class="contestant-name">${escapeHtml(contestantLabel(state.config.contestants, contestant.id))}${isWinner ? ' <span class="winner-mark">Winner</span>' : ""}</div>
      <div class="model">${escapeHtml(contestant.model ?? `${contestant.provider} default`)}</div>
      <div class="hp">${String(contestant.finalHealth)} <small>HP</small></div>
      <div class="ledger">100 − ${String(outcome?.permanentRecoil ?? contestant.healthLedger.permanentRecoil)} recoil − ${String(outcome?.activeDefectDamage ?? 0)} unresolved damage</div>
      <div class="card-links">${link(state, "Final patch", contestant.finalPatchPath)} · ${contestant.status}</div>
    </article>`;
    })
    .join("\n");
  const coverageRows = checkIds.length
    ? checkIds
        .map((id) => {
          const sample = checkMaps
            .map((checks) => checks.get(id))
            .find(Boolean);
          const command =
            sample?.command?.command ?? sample?.reason ?? "Harness check";
          return `<tr><th><code>${escapeHtml(id)}</code><span class="command">${escapeHtml(command)}</span></th>${checkMaps.map((checks) => `<td>${checkStatus(state, checks.get(id))}</td>`).join("")}</tr>`;
        })
        .join("\n")
    : `<tr><td colspan="3">No validation checks were recorded.</td></tr>`;
  const attacks = state.attacks.length
    ? state.attacks
        .map((attack) => {
          const statusTone =
            attack.status === "landed"
              ? attack.damageActive
                ? "fail"
                : "pass"
              : attack.recoil
                ? "warn"
                : "muted";
          const target = attack.targets
            .map((id) => contestantLabel(state.config.contestants, id))
            .join(", ");
          const evidence = [
            link(state, "attack", attack.patchPath),
            ...attack.checks.flatMap((check) =>
              check.command
                ? [
                    link(state, "stdout", check.command.stdoutPath),
                    link(state, "stderr", check.command.stderrPath),
                  ]
                : [],
            ),
          ].join(" · ");
          return `<tr><td>R${String(attack.round)}</td><td>${escapeHtml(attackAuthor(state, attack))}</td><td>${escapeHtml(target)}</td><td>${chip(attack.status.replaceAll("_", " "), statusTone)}</td><td><strong>${escapeHtml(attack.claim)}</strong><span class="subtle">${escapeHtml(attackNarrative(attack))}</span></td><td>${escapeHtml(attack.severity ?? "—")}<span class="subtle">${escapeHtml(attackEffect(attack))}</span></td><td>${evidence}</td></tr>`;
        })
        .join("\n")
    : `<tr><td colspan="7">No attacks were submitted.</td></tr>`;
  const rounds = reportRounds(state);
  const roundRows = rounds
    .map((round) => {
      const attacksForRound = round.attacks;
      const landedForRound = attacksForRound.filter(
        (attack) => attack.status === "landed",
      );
      const recoil = attacksForRound.reduce(
        (sum, attack) => sum + (attack.recoil ?? 0),
        0,
      );
      const health = contestants
        .map((contestant) => {
          const result = contestant.rounds.find(
            (entry) => entry.round === round.id,
          );
          return result
            ? `${contestantLabel(state.config.contestants, contestant.id)} ${String(result.startingHealth)} → ${String(result.endingHealth)}`
            : `${contestantLabel(state.config.contestants, contestant.id)} —`;
        })
        .join(" · ");
      const focus =
        round.id === 1
          ? "Contract & local correctness"
          : round.id === 2
            ? "State, boundaries & systematic probes"
            : round.id === 3
              ? "Integration, resilience & security"
              : "Infrastructure recovery";
      return `<tr><th>${round.id === "recovery" ? "Recovery" : `Round ${String(round.id)}`}<span class="subtle">${focus}</span></th><td>${String(attacksForRound.length)} submitted · ${String(landedForRound.length)} proven · ${String(recoil)} HP recoil</td><td>${escapeHtml(health)} HP</td><td>${link(state, "Open report", state.artifacts.battle)}</td></tr>`;
    })
    .join("\n");
  const phaseReplay = rounds
    .map((round) => {
      const title =
        round.id === "recovery"
          ? "Recovery round"
          : `Round ${String(round.id)}`;
      const submissions = state.attackInvocations.filter(
        (record) => record.round === round.id,
      );
      const attackItems = round.attacks.length
        ? round.attacks
            .map(
              (attack) =>
                `<li><strong>${escapeHtml(attack.claim)}</strong><span class="subtle">${escapeHtml(attack.status.toUpperCase())}: observed ${escapeHtml(attack.outcomeReason ?? "no adjudication detail recorded")}; expected ${escapeHtml(attack.oracle.expectedBehavior)}.</span></li>`,
            )
            .join("")
        : "<li>No attacks submitted.</li>";
      const repairItems = round.contestants
        .map(
          ({ contestant, result }) =>
            `<li><strong>${escapeHtml(contestantLabel(state.config.contestants, contestant.id))}</strong><span class="subtle">${result?.repair ? `${escapeHtml(result.repair.status.toUpperCase())} · ${link(state, "transcript", result.repair.transcriptPath)}` : "No repair invocation recorded"}</span></li>`,
        )
        .join("");
      const ledger = round.contestants
        .map(
          ({ contestant, result }) =>
            `${contestantLabel(state.config.contestants, contestant.id)} ${result ? `${String(result.startingHealth)} → ${String(result.postAttackHealth)} → ${String(result.endingHealth)} HP` : "not run"}`,
        )
        .join(" · ");
      return `<article class="round-replay"><h3>${title}</h3><div class="phase-grid"><div><h4>Attack submissions</h4><p>${submissions.length ? `${String(submissions.length)} invocation(s), ${String(submissions.reduce((sum, entry) => sum + entry.attackCount, 0))} attack(s)` : "None recorded"}</p></div><div><h4>Adjudication</h4><ul>${attackItems}</ul></div><div><h4>Repair</h4><ul>${repairItems}</ul></div><div><h4>Validation & health</h4><p>${escapeHtml(ledger)}</p></div></div></article>`;
    })
    .join("\n");
  const recommendation = state.patchRecommendation?.contestantId
    ? contestantLabel(
        state.config.contestants,
        state.patchRecommendation.contestantId,
      )
    : "No patch recommendation";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Arena — Battle dossier</title>
<style>
:root{color-scheme:dark;--bg:#0b1017;--panel:#121b26;--line:#36526b;--ink:#edf3f8;--muted:#b4c1cd;--blue:#9ac0ff;--green:#72df90;--red:#ff8b84;--amber:#f5c979}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}main{max-width:1440px;margin:auto;padding:42px 48px 72px}.masthead{border-bottom:1px solid var(--line);padding-bottom:26px;display:flex;justify-content:space-between;gap:32px}.eyebrow{margin:0;color:var(--blue);font-weight:700}.masthead h1{font-size:34px;line-height:1.15;text-wrap:balance;margin:9px 0}.summary{max-width:70ch;color:var(--muted);margin:0;text-wrap:pretty}.artifacts{white-space:nowrap;align-self:end}a{color:var(--blue);text-underline-offset:3px}a:focus-visible{outline:3px solid var(--amber);outline-offset:3px;border-radius:2px}.section{margin-top:36px}.section h2{font-size:19px;margin:0 0 14px}.contestants{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.contestant{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:22px}.contestant.winner{border-color:var(--green)}.contestant-name{font-weight:700;font-size:18px}.winner-mark{color:var(--green);font-size:13px;margin-left:8px}.model,.ledger,.subtle,.command{display:block;color:var(--muted);font-size:13px}.hp{font-weight:700;font-size:44px;line-height:1.1;color:var(--green);margin:12px 0}.hp small{font-size:18px}.card-links{margin-top:16px}.decision{display:grid;grid-template-columns:1.3fr 1fr;gap:16px}.callout,.score{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px}.callout strong{font-size:20px}.score dl{display:grid;grid-template-columns:1fr auto;gap:8px;margin:0}.score dt{color:var(--muted)}.score dd{margin:0}.chip{display:inline-block;border-radius:999px;padding:2px 8px;font-size:12px;font-weight:700;text-transform:uppercase}.pass{color:var(--green);background:#123325}.fail{color:var(--red);background:#3a1d22}.warn{color:var(--amber);background:#382d16}.muted{color:var(--muted);background:#202b37}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:720px;background:var(--panel);border:1px solid var(--line)}caption{text-align:left;color:var(--muted);padding:0 0 10px}th,td{text-align:left;vertical-align:top;padding:13px 14px;border-bottom:1px solid var(--line)}th{font-weight:700}tr:last-child>*{border-bottom:0}code{color:var(--blue);font:inherit}.log-links{white-space:nowrap}.note{color:var(--muted);margin:0 0 14px}.round-replay{padding:20px 0;border-top:1px solid var(--line)}.round-replay h3{margin:0 0 12px}.phase-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 32px}.phase-grid h4{margin:0 0 6px}.phase-grid p,.phase-grid ul{margin:0;padding-left:20px}.handoff{display:grid;grid-template-columns:1fr 1fr;gap:16px}.handoff>div{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px}.handoff h3{margin:0 0 8px;font-size:16px}@media(max-width:760px){main{padding:28px 18px}.masthead,.decision{display:block}.artifacts{margin-top:16px;white-space:normal}.contestants,.handoff,.phase-grid{grid-template-columns:1fr}.summary{font-size:14px}}
</style></head><body><main>
<header class="masthead"><div><p class="eyebrow">AGENT ARENA · EVIDENCE-LINKED BATTLE DOSSIER</p><h1>${escapeHtml(outcomeHeading)}</h1><p class="summary">${escapeHtml(state.ranking?.reason ?? "This run did not reach a final ranking.")} This dossier separates proven defects, unsuccessful attacks, verified checks, and the recommendation so the score is explainable.</p></div><nav class="artifacts" aria-label="Battle artifacts">${link(state, "Full report", state.artifacts.battle)} · ${link(state, "Raw result", state.artifacts.result)} · ${link(state, "Share image", state.artifacts.battleVisual)}</nav></header>
<section class="section"><h2>Final decision</h2><div class="contestants">${contestantCards}</div></section>
<section class="section decision"><div class="callout"><strong>${escapeHtml(decisionHeading)}</strong><p>${escapeHtml(state.ranking?.reason ?? "No final ranking reason was recorded.")}</p><p class="note">The champion is determined by remaining health. Health starts at 100, then subtracts missed-attack recoil and active, un-repaired defect damage. Patch quality only breaks an equal-correctness tie.</p></div><div class="score"><dl><dt>Verified required suites</dt><dd>${requiredPassed ? chip("Both pass", "pass") : chip("Review failures", "fail")}</dd><dt>Proven defects</dt><dd>${String(defects.length)} (${String(unresolved.length)} unresolved, ${String(repaired.length)} repaired)</dd><dt>Deciding factors</dt><dd>${escapeHtml(state.arenaOutcome?.decidingFactors.join(", ") || "ranking")}</dd><dt>Recommended patch</dt><dd>${escapeHtml(recommendation)}</dd></dl></div></section>
<section class="section"><h2>Verified test coverage</h2><p class="note">These results apply to each named final patch in this run. “Not run” is intentionally not shown as a pass. Open stdout/stderr to inspect the harness evidence.</p><div class="table-wrap" tabindex="0"><table><caption>Recorded checks by contestant and exact command</caption><thead><tr><th>Check / command</th>${contestants.map((contestant) => `<th>${escapeHtml(contestantLabel(state.config.contestants, contestant.id))}</th>`).join("")}</tr></thead><tbody>${coverageRows}</tbody></table></div></section>
<section class="section"><h2>What happened in each round</h2><div class="table-wrap" tabindex="0"><table><caption>Round outcomes and health after repair</caption><thead><tr><th>Investigation</th><th>Attack outcome</th><th>Health after repair</th><th>Artifacts</th></tr></thead><tbody>${roundRows}</tbody></table></div></section>
<section class="section" aria-labelledby="phase-heading"><h2 id="phase-heading">Phase replay</h2>${phaseReplay}</section>
<section class="section"><h2>Attack ledger — bugs found, misses, and repairs</h2><p class="note">A landed attack is executable evidence: it passed on the attacker patch, failed on its target, and met the task oracle. Unsuccessful attacks may cost recoil; repaired defects no longer reduce final health.</p><div class="table-wrap" tabindex="0"><table><caption>All submitted contestant and house attacks</caption><thead><tr><th>Round</th><th>Author</th><th>Target</th><th>Result</th><th>What failed / why</th><th>Severity & score</th><th>Evidence</th></tr></thead><tbody>${attacks}</tbody></table></div></section>
<section class="section handoff" id="handoff"><div><h3>Already done</h3><p>Required validation was run, ${String(defects.length)} distinct defect(s) were adjudicated, and final patches were frozen for review.</p></div><div><h3>What remains</h3><p>${unresolved.length ? `Review ${String(unresolved.length)} unresolved defect(s) before accepting a patch.` : "Choose and inspect the recommended patch; no unresolved proven defect remains."}</p><p>${link(state, "Open the review handoff", state.artifacts.battle)}</p></div></section>
</main></body></html>`;
}
