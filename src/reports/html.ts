import type {
  Attack,
  CheckResult,
  ContestantResult,
  RunState,
} from "../core/types.js";
import { contestantLabel } from "../core/labels.js";
import { sharedDefectIsActive } from "../outcomes/evidence.js";
import { conciseUsage, readRunUsageSummarySync } from "../telemetry/usage.js";
import {
  latestCheck,
  reportCheckStatus,
  reportContestants,
  reportDefects,
  reportOutcome,
  reportOutcomeTotals,
  reportRounds,
  requiredValidationAttemptSummary,
  resolveArtifactHref,
} from "./presentation.js";
import { qualityCategoryRows } from "../quality/presentation.js";
import { projectImplementationEligibility } from "../outcomes/eligibility.js";
import { describeTokenPressureV1 } from "../effort/policy.js";
import { retainedWorktreePathsSync } from "../repo/worktree-manifest.js";

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
  const amount = attack.adjudication?.exactAmount ?? attack.damage ?? 0;
  if (attack.adjudication?.scoreEffect === "damage_upgrade")
    return `${String(amount)} HP upgrade delta`;
  if (attack.status === "landed")
    return attack.damageActive
      ? `${String(amount)} HP remains active`
      : `${String(amount)} HP repaired`;
  if (attack.status === "shared_defect")
    return sharedDefectIsActive(attack)
      ? "Shared repair target remains active · no HP change"
      : "Shared repair verified · no HP change";
  if (attack.recoil) return `${String(attack.recoil)} HP recoil`;
  return "No health change";
}

function attackNarrative(attack: Attack): string {
  const narrative =
    attack.outcomeReason ??
    attack.impact ??
    "No adjudication detail was recorded.";
  const basis =
    attack.adjudication?.evidenceBasis ??
    attack.evidenceProvenance ??
    "legacy_unknown";
  const relationship = attack.adjudication?.relationship ?? "independent";
  const chain = attack.adjudication?.priorAdjudicationId
    ? ` Decision chain ${attack.adjudication.priorAdjudicationId} → ${attack.adjudication.id}: ${relationship}; score ${attack.adjudication.scoreEffect} ${String(attack.adjudication.exactAmount)} HP.`
    : "";
  return `${basis.replaceAll("_", " ")}: ${narrative}${chain}`;
}

/** A deterministic, self-contained, clickable battle dossier for local review. */
export function renderBattleHtml(state: RunState): string {
  const usageSummary = readRunUsageSummarySync(
    `${state.config.artifactRoot}/${state.runId}`,
  );
  const usageRows = usageSummary
    ? [
        ...usageSummary.byProvider.map(
          (entry) =>
            `<tr><td>Provider</td><td>${escapeHtml(entry.key)}</td><td>${String(entry.invocationCount)}</td><td>${(entry.providerDurationMs / 1000).toFixed(1)}s</td><td>${entry.usage.processedTokens === null ? "unavailable" : entry.usage.processedTokens.toLocaleString("en-US")}</td><td>${entry.cost.usd === null ? escapeHtml(`unavailable (${entry.cost.unavailableReason ?? "unknown"})`) : `$${entry.cost.usd.toFixed(4)}`}</td></tr>`,
        ),
        ...usageSummary.byResolvedModel.map(
          (entry) =>
            `<tr><td>Resolved model</td><td>${escapeHtml(entry.key)}</td><td>${String(entry.invocationCount)}</td><td>${(entry.providerDurationMs / 1000).toFixed(1)}s</td><td>${entry.usage.processedTokens === null ? "unavailable" : entry.usage.processedTokens.toLocaleString("en-US")}</td><td>${entry.cost.usd === null ? "unavailable" : `$${entry.cost.usd.toFixed(4)}`}</td></tr>`,
        ),
        ...usageSummary.byRole.map(
          (entry) =>
            `<tr><td>Role</td><td>${escapeHtml(entry.key)}</td><td>${String(entry.invocationCount)}</td><td>${(entry.providerDurationMs / 1000).toFixed(1)}s</td><td>${entry.usage.processedTokens === null ? "unavailable" : entry.usage.processedTokens.toLocaleString("en-US")}</td><td>${entry.cost.usd === null ? "unavailable" : `$${entry.cost.usd.toFixed(4)}`}</td></tr>`,
        ),
      ].join("")
    : `<tr><td colspan="6">Telemetry unavailable (legacy or incomplete run).</td></tr>`;
  const retainedWorktrees = state.config.keepWorktrees
    ? retainedWorktreePathsSync(state.artifacts.worktreeManifest)
    : [];
  const retentionHtml = state.config.keepWorktrees
    ? `<section class="section"><h2>Retained worktrees</h2><ul>${retainedWorktrees.map((worktree) => `<li><code>${escapeHtml(worktree)}</code></li>`).join("")}<li>${link(state, "Worktree manifest", state.artifacts.worktreeManifest)}</li></ul></section>`
    : "";
  if (state.terminalOutcome) {
    const terminal = state.terminalOutcome;
    const recommended =
      terminal.kind === "forfeit" && terminal.eligibleContestantIds[0]
        ? contestantLabel(
            state.config.contestants,
            terminal.eligibleContestantIds[0],
          )
        : "none";
    const rows =
      terminal.version === 2
        ? terminal.contestants
            .map((entry) => {
              const evidence = entry.validation
                ? `<strong>${escapeHtml(entry.validation.outcome.replaceAll("_", " "))}</strong>${requiredValidationAttemptSummary(
                    entry.validation,
                  )
                    .map((attempt) => `<div>${escapeHtml(attempt)}</div>`)
                    .join("")}${entry.validation.attempts
                    .map((attempt, index) =>
                      attempt.failureExcerpt
                        ? `<details><summary>Attempt ${String(index + 1)} failure excerpt</summary><pre>${escapeHtml(attempt.failureExcerpt)}</pre></details>`
                        : "",
                    )
                    .join("")}`
                : "none";
              return `<tr><td>${escapeHtml(contestantLabel(state.config.contestants, entry.contestantId))}</td><td>${entry.eligible ? "eligible" : "ineligible"}</td><td>${escapeHtml(entry.reasonCode ?? "eligible_patch")}</td><td>${evidence}</td></tr>`;
            })
            .join("")
        : terminal.affectedContestantIds
            .map(
              (id) =>
                `<tr><td>${escapeHtml(contestantLabel(state.config.contestants, id))}</td><td>ineligible</td><td>${escapeHtml(terminal.reasonCode)}</td><td>legacy record</td></tr>`,
            )
            .join("");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Arena — pre-review result</title><style>:root{color-scheme:dark}body{margin:0;background:#0b1017;color:#edf3f8;font:16px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}main{max-width:1180px;margin:auto;padding:48px}.panel{background:#121b26;border:1px solid #36526b;border-radius:14px;padding:24px;margin-top:24px}h1{margin:0}p{color:#d7e0ea}table{border-collapse:collapse;width:100%;margin-top:20px}th,td{text-align:left;vertical-align:top;padding:12px;border-bottom:1px solid #36526b}td div{margin-top:6px;color:#d7e0ea;font-size:13px}pre{max-width:560px;overflow:auto;white-space:pre-wrap}</style></head><body><main><h1>Agent Arena — pre-review result</h1><div class="panel"><strong>${escapeHtml(terminal.kind.toUpperCase())} · ${escapeHtml(terminal.reasonCode)}</strong><p>${escapeHtml(terminal.reason)}</p><p>Recommended production patch: ${escapeHtml(recommended)}.</p><p>No review, attack, repair, quality comparison, or coverage stage ran.</p><p>Provider usage: ${escapeHtml(conciseUsage(usageSummary))}</p><table><thead><tr><th>Contestant</th><th>Eligibility</th><th>Cause</th><th>Validation evidence</th></tr></thead><tbody>${rows}</tbody></table></div>${retentionHtml}</main></body></html>`;
  }
  const contestants = reportContestants(state);
  const implementationEligibility = projectImplementationEligibility(state);
  const outcome = reportOutcome(state);
  const winnerId = outcome.kind === "winner" ? outcome.winner : undefined;
  const winner = winnerId
    ? contestantLabel(state.config.contestants, winnerId)
    : undefined;
  const outcomeHeading =
    state.coverageDecision?.decision === "inconclusive"
      ? `Inconclusive · ledger leader ${state.ranking?.order[0] ?? "none"}`
      : state.coverageAssessment?.confidence === "provisional" &&
          !state.coverageDecision
        ? `Provisional leader ${state.ranking?.winner ?? "none"}`
        : winner
          ? `${winner} won`
          : outcome.kind === "draw"
            ? "Draw result"
            : outcome.kind === "non_discriminating"
              ? "Non-discriminating battle"
              : "Battle incomplete";
  const decisionHeading =
    state.coverageAssessment?.confidence === "provisional" &&
    !state.coverageDecision
      ? "Coverage must be resolved before patch review"
      : winner
        ? `Why ${winner} won`
        : outcome.kind === "draw"
          ? "Why the battle ended in a draw"
          : outcome.kind === "non_discriminating"
            ? "Why no arena champion was awarded"
            : "Why the battle is incomplete";
  const defects = reportDefects(state);
  const outcomeTotals = reportOutcomeTotals(state);
  const unresolved = defects.filter((defect) => defect.active);
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
  const effortProfile = state.config.resolvedEffortProfile;
  const effortBudget = effortProfile
    ? `Sealed-round pressure thresholds: ${String(effortProfile.roundEnvelopeMs / 60_000)} minutes · ${String(effortProfile.maxProviderCallsPerRound)} provider calls · ${String(effortProfile.maxTokensPerRound)} weighted token units (v1; cache reads ×0.1); implementation/review/attack/judge/repair ${String(effortProfile.implementationMs / 60_000)}/${String(effortProfile.reviewMs / 60_000)}/${String(effortProfile.attackMs / 60_000)}/${String(effortProfile.judgeMs / 60_000)}/${String(effortProfile.repairMs / 60_000)} minutes`
    : "Legacy budget unavailable";
  const adaptiveRows = state.adaptiveDecisions.length
    ? state.adaptiveDecisions
        .map((decision) => {
          const telemetry = decision.consumption.tokenTelemetry;
          const signal =
            "signal" in decision
              ? `${decision.signal.lowSignal ? "low" : "present"} · ${String(decision.signal.competitiveLandings)} competitive · ${String(decision.signal.sharedDefects)} shared · ${String(decision.signal.explicitEmptyLanes)} empty`
              : "legacy / unknown";
          const streak =
            "signal" in decision
              ? String(decision.signal.consecutiveLowSignalCount)
              : "—";
          const pressure =
            decision.version === 3
              ? `<br>${escapeHtml(describeTokenPressureV1(decision.consumption.tokenPressureEvaluation))}`
              : "";
          return `<tr><th>Round ${String(decision.round)}</th><td>${(decision.consumption.wallTimeMs / 1000).toFixed(1)}s</td><td>${String(decision.consumption.providerCalls)}</td><td>${escapeHtml(telemetry.state)}${telemetry.totalTokens === undefined ? "" : ` (${String(telemetry.totalTokens)} processed)`}${pressure}</td><td>${decision.convergence.passed ? "yes" : "no"}</td><td>${escapeHtml(signal)}</td><td>${escapeHtml(streak)}</td><td>${escapeHtml(decision.extensionTriggerDefectIds.join(", ") || "none")}</td><td>${escapeHtml(`${decision.action}: ${decision.reason}`)}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="9">No adaptive decisions were recorded.</td></tr>`;
  const contestantCards = contestants
    .map((contestant) => {
      const outcome = state.arenaOutcome?.contestants[contestant.id];
      const isWinner = contestant.id === winnerId;
      return `<article class="contestant ${isWinner ? "winner" : ""}">
      <div class="contestant-name">${escapeHtml(contestantLabel(state.config.contestants, contestant.id))}${isWinner ? ' <span class="winner-mark">Winner</span>' : ""}</div>
      <div class="model">${escapeHtml(contestant.model ?? `${contestant.provider} default`)}</div>
      <div class="hp">${String(contestant.finalHealth)} <small>HP</small></div>
      <div class="ledger">100 − ${String(outcome?.permanentRecoil ?? contestant.healthLedger.permanentRecoil)} recoil − ${String(outcome?.activeDefectDamage ?? 0)} unresolved damage</div>
      <div class="ledger">Browser: ${escapeHtml(contestant.browserValidation?.status ?? "not run")}${contestant.browserValidation?.reason ? ` · ${escapeHtml(contestant.browserValidation.reason)}` : ""}</div>
      <div class="card-links">${link(state, "Final patch", contestant.finalPatchPath)} · ${contestant.status}</div>
    </article>`;
    })
    .join("\n");
  const eligibilityRows = implementationEligibility.length
    ? implementationEligibility
        .map((entry) => {
          const validation = entry.validation;
          return `<tr><td>${escapeHtml(contestantLabel(state.config.contestants, entry.contestantId))}</td><td>${entry.eligible ? chip("eligible", "pass") : chip("ineligible", "fail")}</td><td>${escapeHtml(entry.reasonCode ?? "eligible_patch")}</td><td>${
            validation
              ? `<strong>${escapeHtml(validation.outcome.replaceAll("_", " "))}</strong>${requiredValidationAttemptSummary(
                  validation,
                )
                  .map((attempt) => `<div>${escapeHtml(attempt)}</div>`)
                  .join(
                    "",
                  )}${validation.attempts.map((attempt, index) => (attempt.failureExcerpt ? `<details><summary>Attempt ${String(index + 1)} failure excerpt</summary><pre>${escapeHtml(attempt.failureExcerpt)}</pre></details>` : "")).join("")}`
              : "not recorded"
          }</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="4">Implementation eligibility was not recorded for this legacy or incomplete run.</td></tr>`;
  const qualityRows = contestants
    .flatMap((contestant) => {
      const facts = state.patchQualityFacts[contestant.id];
      const label = contestantLabel(state.config.contestants, contestant.id);
      const rows = qualityCategoryRows(facts);
      if (!rows.length)
        return [
          `<tr><td>${escapeHtml(label)}</td><td>legacy v1 facts</td><td colspan="5">Stored historical schema retained unchanged</td></tr>`,
        ];
      return rows.map(
        (row) =>
          `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(row.category)}</td><td>${String(row.filesChanged)}</td><td>+${String(row.addedLines)}</td><td>-${String(row.deletedLines)}</td><td>${String(row.normalizedLines)}</td><td>${escapeHtml(row.paths.join(", ") || "—")}</td></tr>`,
      );
    })
    .join("");
  const observabilityRows = contestants
    .map((contestant) => {
      const facts = state.patchQualityFacts[contestant.id];
      const label = contestantLabel(state.config.contestants, contestant.id);
      if (!facts || facts.version !== 2)
        return `<li><strong>${escapeHtml(label)}</strong>: legacy v1 observability facts.</li>`;
      const facet = facts.facets.observability;
      return `<li><strong>${escapeHtml(label)}</strong>: heuristic matches in ${String(facet.filesChanged)} file(s), +${String(facet.matchedAddedLines)} / -${String(facet.matchedDeletedLines)} lines; paths: ${escapeHtml(facet.paths.join(", ") || "none")}${facet.risks.length ? `; risks: ${escapeHtml(facet.risks.join("; "))}` : ""}.</li>`;
    })
    .join("");
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
              : attack.status === "shared_defect"
                ? sharedDefectIsActive(attack)
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
            ...(attack.browserArtifactRefs ?? []).map((artifact, index) =>
              link(state, `browser artifact ${String(index + 1)}`, artifact),
            ),
            ...attack.checks.flatMap((check) =>
              check.command
                ? [
                    link(state, "stdout", check.command.stdoutPath),
                    link(state, "stderr", check.command.stderrPath),
                  ]
                : [],
            ),
          ].join(" · ");
          return `<tr><td>R${String(attack.round)}</td><td>${escapeHtml(attackAuthor(state, attack))}</td><td>${escapeHtml(target)}</td><td>${chip(attack.status.replaceAll("_", " "), statusTone)}</td><td>${escapeHtml(attack.origin.kind === "house" ? "shared" : "competitive")}</td><td><strong>${escapeHtml(attack.claim)}</strong><span class="subtle">${escapeHtml(attackNarrative(attack))}</span></td><td>${escapeHtml(attack.severity ?? "—")}<span class="subtle">${escapeHtml(attackEffect(attack))}</span></td><td>${evidence}</td></tr>`;
        })
        .join("\n")
    : `<tr><td colspan="8">No attacks were submitted.</td></tr>`;
  const rounds = reportRounds(state);
  const roundRows = rounds
    .map((round) => {
      const attacksForRound = round.attacks;
      const provenForRound = attacksForRound.filter(
        (attack) =>
          attack.status === "landed" || attack.status === "shared_defect",
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
              : round.id === 4
                ? "Extension generalization"
                : round.id === 5
                  ? "Extension durability & recovery"
                  : round.id === "reconciliation"
                    ? "Correction-only reconciliation"
                    : "Infrastructure recovery";
      const label =
        round.id === "recovery"
          ? "Recovery"
          : round.id === "reconciliation"
            ? "Reconciliation"
            : `Round ${String(round.id)}`;
      return `<tr><th>${label}<span class="subtle">${focus}</span></th><td>${String(attacksForRound.length)} submitted · ${String(provenForRound.length)} proven · ${String(recoil)} HP recoil</td><td>${escapeHtml(health)} HP</td><td>${link(state, "Open report", state.artifacts.battle)}</td></tr>`;
    })
    .join("\n");
  const phaseReplay = rounds
    .map((round) => {
      const title =
        round.id === "recovery"
          ? "Recovery round"
          : round.id === "reconciliation"
            ? "Reconciliation round"
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
  const terminalNotice = "";
  const submissionArtifacts = state.submissionArtifacts
    .map(
      (record) =>
        `<li><strong>${escapeHtml(`${String(record.round)} ${record.phase} ${record.actor}`)}</strong><span class="subtle">${escapeHtml(record.outcome)} · SHA-256 ${escapeHtml(record.rawSha256)} · ${link(state, "raw", record.rawArtifactPath)} · ${link(state, "parsed", record.parsedArtifactPath)}</span></li>`,
    )
    .join("");
  const failureRows = state.failureRecords.length
    ? state.failureRecords
        .map((failure) => {
          const disposition = failure.terminalDisposition ?? "coverage_lost";
          const judgeBasis = disposition.startsWith("judge_")
            ? disposition
            : "—";
          const confidence = [
            "judge_partial",
            "judge_unable",
            "coverage_lost",
            "run_level_coverage_lost",
          ].includes(disposition)
            ? "reduced or provisional"
            : "none";
          const score =
            disposition === "judge_confirmed"
              ? "full frozen severity"
              : disposition === "judge_partial"
                ? "35% frozen severity"
                : disposition === "judge_rejected"
                  ? "normal rank recoil"
                  : "none";
          return `<tr><td>${escapeHtml(failure.failureId)}</td><td>${escapeHtml(failure.stage)}</td><td>${String(failure.attempts.length)}/2</td><td>${escapeHtml(disposition)}</td><td>${escapeHtml(judgeBasis)}</td><td>${escapeHtml(confidence)}</td><td>${escapeHtml(score)}</td><td>${failure.diagnosticArtifactRefs.map((artifact) => link(state, "diagnostic", artifact)).join(" · ") || "—"}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="8">No bounded failures were recorded.</td></tr>`;
  const laneCoverage = state.coverageAssessment
    ? `<section class="section"><h2>Required attack-lane coverage</h2><p class="note"><strong>${escapeHtml(state.coverageAssessment.confidence.replaceAll("_", " "))}</strong> · ${String(state.coverageAssessment.counts.completed)} completed · ${String(state.coverageAssessment.counts.degraded)} degraded · ${String(state.coverageAssessment.counts.unresolved)} unresolved / ${String(state.coverageAssessment.counts.required)} required. Evidence: ${String(state.coverageAssessment.evidenceCounts.mechanical)} mechanical, ${String(state.coverageAssessment.evidenceCounts.judgeConfirmed)} judge-confirmed, ${String(state.coverageAssessment.evidenceCounts.judgePartial)} 35% partial-judge. Reasons: ${escapeHtml(state.coverageAssessment.reasonCodes.join(", ") || "none")}.</p><div class="table-wrap" tabindex="0"><table><thead><tr><th>Lane</th><th>State</th><th>Evidence basis</th><th>Reason codes</th></tr></thead><tbody>${state.coverageAssessment.requiredLanes.map((lane) => `<tr><td>${escapeHtml(lane.id)}</td><td>${chip(lane.finalState, lane.finalState === "completed" ? "pass" : lane.finalState === "degraded" ? "warn" : "fail")}</td><td>${escapeHtml(lane.evidenceBasis)}</td><td>${escapeHtml(lane.reasonCodes.join(", ") || "none")}</td></tr>`).join("")}</tbody></table></div><p class="note">Assessment digest: <code>${escapeHtml(state.coverageAssessment.assessmentDigest)}</code></p></section>`
    : `<section class="section"><h2>Required attack-lane coverage</h2><p class="note">Legacy / unknown. No confidence claim is inferred.</p></section>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Arena — Battle dossier</title>
<style>
:root{color-scheme:dark;--bg:#0b1017;--panel:#121b26;--line:#36526b;--ink:#edf3f8;--muted:#b4c1cd;--blue:#9ac0ff;--green:#72df90;--red:#ff8b84;--amber:#f5c979}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}main{max-width:1440px;margin:auto;padding:42px 48px 72px}.masthead{border-bottom:1px solid var(--line);padding-bottom:26px;display:flex;justify-content:space-between;gap:32px}.eyebrow{margin:0;color:var(--blue);font-weight:700}.masthead h1{font-size:34px;line-height:1.15;text-wrap:balance;margin:9px 0}.summary{max-width:70ch;color:var(--muted);margin:0;text-wrap:pretty}.artifacts{white-space:nowrap;align-self:end}a{color:var(--blue);text-underline-offset:3px}a:focus-visible{outline:3px solid var(--amber);outline-offset:3px;border-radius:2px}.section{margin-top:36px}.section h2{font-size:19px;margin:0 0 14px}.contestants{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.contestant{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:22px}.contestant.winner{border-color:var(--green)}.contestant-name{font-weight:700;font-size:18px}.winner-mark{color:var(--green);font-size:13px;margin-left:8px}.model,.ledger,.subtle,.command{display:block;color:var(--muted);font-size:13px}.hp{font-weight:700;font-size:44px;line-height:1.1;color:var(--green);margin:12px 0}.hp small{font-size:18px}.card-links{margin-top:16px}.decision{display:grid;grid-template-columns:1.3fr 1fr;gap:16px}.callout,.score{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px}.callout strong{font-size:20px}.score dl{display:grid;grid-template-columns:1fr auto;gap:8px;margin:0}.score dt{color:var(--muted)}.score dd{margin:0}.chip{display:inline-block;border-radius:999px;padding:2px 8px;font-size:12px;font-weight:700;text-transform:uppercase}.pass{color:var(--green);background:#123325}.fail{color:var(--red);background:#3a1d22}.warn{color:var(--amber);background:#382d16}.muted{color:var(--muted);background:#202b37}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:720px;background:var(--panel);border:1px solid var(--line)}caption{text-align:left;color:var(--muted);padding:0 0 10px}th,td{text-align:left;vertical-align:top;padding:13px 14px;border-bottom:1px solid var(--line)}th{font-weight:700}tr:last-child>*{border-bottom:0}code{color:var(--blue);font:inherit}.log-links{white-space:nowrap}.note{color:var(--muted);margin:0 0 14px}.round-replay{padding:20px 0;border-top:1px solid var(--line)}.round-replay h3{margin:0 0 12px}.phase-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 32px}.phase-grid h4{margin:0 0 6px}.phase-grid p,.phase-grid ul{margin:0;padding-left:20px}.handoff{display:grid;grid-template-columns:1fr 1fr;gap:16px}.handoff>div{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px}.handoff h3{margin:0 0 8px;font-size:16px}@media(max-width:760px){main{padding:28px 18px}.masthead,.decision{display:block}.artifacts{margin-top:16px;white-space:normal}.contestants,.handoff,.phase-grid{grid-template-columns:1fr}.summary{font-size:14px}}
</style></head><body><main>
<header class="masthead"><div><p class="eyebrow">AGENT ARENA · EVIDENCE-LINKED BATTLE DOSSIER</p><h1>${escapeHtml(outcomeHeading)}</h1><p class="summary">${escapeHtml(state.ranking?.reason ?? "This run did not reach a final ranking.")} This dossier separates proven defects, unsuccessful attacks, verified checks, and the recommendation so the score is explainable.</p></div><nav class="artifacts" aria-label="Battle artifacts">${link(state, "Full report", state.artifacts.battle)} · ${link(state, "Raw result", state.artifacts.result)} · ${link(state, "Share image", state.artifacts.battleVisual)}</nav></header>
<section class="section"><h2>Final decision</h2><div class="contestants">${contestantCards}</div></section>
<section class="section"><h2>Implementation eligibility and required-validation attempts</h2><div class="table-wrap" tabindex="0"><table><thead><tr><th>Contestant</th><th>Eligibility</th><th>Cause</th><th>Validation evidence</th></tr></thead><tbody>${eligibilityRows}</tbody></table></div></section>
<section class="section"><h2>Provider usage</h2><p class="note">${escapeHtml(conciseUsage(usageSummary))}</p><div class="table-wrap" tabindex="0"><table><thead><tr><th>Dimension</th><th>Value</th><th>Invocations</th><th>Provider time</th><th>Processed tokens</th><th>Cost</th></tr></thead><tbody>${usageRows}</tbody></table></div></section>
<section class="section"><h2>Effort and adaptive coverage</h2><p class="note"><strong>${escapeHtml(state.config.resolvedEffortProfile?.tier ?? state.config.effortMode)}</strong> · ${state.config.fixedRounds ? `${String(state.config.rounds)} exact rounds` : `${String(state.config.resolvedEffortProfile?.plannedRounds ?? state.config.rounds)} planned, up to ${String(state.config.resolvedEffortProfile?.maxRounds ?? state.config.rounds)}`} · ${escapeHtml(state.adaptiveCompletion?.reason ?? "run in progress or fixed-round completion")}. Skipped briefs: ${escapeHtml(state.adaptiveCompletion?.skippedBriefs.join(", ") || "none")}.</p><p class="note">Configured budget: ${escapeHtml(effortBudget)}.</p><div class="table-wrap" tabindex="0"><table><thead><tr><th>Boundary</th><th>Wall time</th><th>Calls</th><th>Tokens</th><th>Converged</th><th>Signal</th><th>Low-signal streak</th><th>Extension triggers</th><th>Exact decision</th></tr></thead><tbody>${adaptiveRows}</tbody></table></div></section>
${laneCoverage}
${terminalNotice}
<section class="section decision"><div class="callout"><strong>${escapeHtml(decisionHeading)}</strong><p>${escapeHtml(state.ranking?.reason ?? "No final ranking reason was recorded.")}</p><p class="note">${outcome.kind === "non_discriminating" ? "Raw HP, recoil, shared defects, and patch size remain evidence, but none creates an arena champion. Any recommendation below is an independent identity-blind quality judgment." : "The champion is determined by remaining health. Health starts at 100, then subtracts missed-attack recoil and active, un-repaired defect damage."}</p></div><div class="score"><dl><dt>Verified required suites</dt><dd>${requiredPassed ? chip("Both pass", "pass") : chip("Review failures", "fail")}</dd><dt>Distinct defects</dt><dd>${String(defects.length)} (${String(unresolved.length)} unresolved, ${String(defects.length - unresolved.length)} repaired)</dd><dt>Competitive landings</dt><dd>${String(outcomeTotals.competitiveLandings)}</dd><dt>Shared defects</dt><dd>${String(outcomeTotals.sharedDefects)}</dd><dt>Schema-rejected findings</dt><dd>${String(outcomeTotals.schemaRejectedFindings)}</dd><dt>Explicit-empty lanes</dt><dd>${String(state.arenaOutcome && "explicitEmptyLaneCount" in state.arenaOutcome ? state.arenaOutcome.explicitEmptyLaneCount : (state.coverageAssessment?.evidenceCounts.explicitEmpty ?? 0))}</dd><dt>Deciding factors</dt><dd>${escapeHtml(state.arenaOutcome?.decidingFactors.join(", ") || "none")}</dd><dt>${outcome.kind === "non_discriminating" ? "Independent recommendation" : "Recommended patch"}</dt><dd>${escapeHtml(recommendation)}</dd></dl></div></section>
<section class="section"><h2>Patch quality facts</h2><p class="note">Primary categories are mutually exclusive. Production minimality excludes every other category; raw test volume is not a quality advantage.</p><div class="table-wrap" tabindex="0"><table><thead><tr><th>Contestant</th><th>Primary category</th><th>Files</th><th>Added</th><th>Deleted</th><th>Normalized</th><th>Paths</th></tr></thead><tbody>${qualityRows}</tbody></table></div><p class="note">Observability is an overlapping heuristic; zero matches do not prove absence.</p><ul>${observabilityRows}</ul></section>
<section class="section"><h2>Verified test coverage</h2><p class="note">These results apply to each named final patch in this run. “Not run” is intentionally not shown as a pass. Open stdout/stderr to inspect the harness evidence.</p><div class="table-wrap" tabindex="0"><table><caption>Recorded checks by contestant and exact command</caption><thead><tr><th>Check / command</th>${contestants.map((contestant) => `<th>${escapeHtml(contestantLabel(state.config.contestants, contestant.id))}</th>`).join("")}</tr></thead><tbody>${coverageRows}</tbody></table></div></section>
<section class="section"><h2>What happened in each round</h2><div class="table-wrap" tabindex="0"><table><caption>Round outcomes and health after repair</caption><thead><tr><th>Investigation</th><th>Attack outcome</th><th>Health after repair</th><th>Artifacts</th></tr></thead><tbody>${roundRows}</tbody></table></div></section>
<section class="section" aria-labelledby="phase-heading"><h2 id="phase-heading">Phase replay</h2>${phaseReplay}</section>
<section class="section"><h2>Attack ledger — bugs found, misses, and repairs</h2><p class="note">Each row reports its recorded evidence basis; partial-judge rulings apply exact 35% damage. Zero landed attacks is not presented as proof of correctness.</p><div class="table-wrap" tabindex="0"><table><caption>All submitted contestant and house attacks</caption><thead><tr><th>Round</th><th>Author</th><th>Target</th><th>Result</th><th>Evidence class</th><th>What failed / why</th><th>Severity & score</th><th>Evidence</th></tr></thead><tbody>${attacks}</tbody></table></div></section>
<section class="section"><h2>Failure handling ledger</h2><p class="note">Each distinct stage failure gets at most two attempts. Judge outcomes identify semantic evidence and never masquerade as mechanical execution.</p><div class="table-wrap" tabindex="0"><table><thead><tr><th>Failure</th><th>Stage</th><th>Attempts</th><th>Disposition</th><th>Judge basis</th><th>Confidence effect</th><th>Score effect</th><th>Diagnostics</th></tr></thead><tbody>${failureRows}</tbody></table></div></section>
<section class="section"><h2>Submission artifacts</h2><p class="note">Exact provider bytes are retained locally and linked, never embedded. Parsed artifacts contain accepted normalized values and redacted diagnostics.</p><ul>${submissionArtifacts || "<li>No permanent submission artifacts recorded (legacy run).</li>"}</ul></section>
${retentionHtml}
<section class="section handoff" id="handoff"><div><h3>Already done</h3><p>Required validation was run, ${String(defects.length)} distinct defect(s) were adjudicated, and final patches were frozen for review.</p></div><div><h3>What remains</h3><p>${unresolved.length ? `Review ${String(unresolved.length)} unresolved defect(s) before accepting a patch.` : "Choose and inspect the recommended patch; no unresolved proven defect remains."}</p><p>${link(state, "Open the review handoff", state.artifacts.battle)}</p></div></section>
</main></body></html>`;
}
