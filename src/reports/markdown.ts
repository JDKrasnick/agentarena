import type {
  Attack,
  CheckResult,
  ContestantResult,
  RunState,
} from "../core/types.js";
import { conciseUsage, readRunUsageSummarySync } from "../telemetry/usage.js";
import { contestantLabel } from "../core/labels.js";
import { sharedDefectIsActive } from "../outcomes/evidence.js";
import {
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

function attackOwner(attack: Attack): string {
  return attack.origin.kind === "house" ? "House" : attack.origin.contestant;
}

function attackEffect(attack: Attack): string {
  if (attack.status === "landed")
    return `${String(attack.adjudication?.exactAmount ?? attack.damage ?? 0)} damage (${(attack.adjudication?.evidenceBasis ?? attack.evidenceProvenance ?? "legacy_unknown").replaceAll("_", " ")})`;
  if (attack.status === "shared_defect")
    return sharedDefectIsActive(attack)
      ? "shared defect unresolved; repair affected patches with no health effect"
      : "shared defect repaired and verified; no health effect";
  if (attack.recoil !== undefined) return `${String(attack.recoil)} recoil`;
  return "no health effect";
}

function tableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\r?\n/gu, " ");
}

function markdownCode(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function artifactLink(
  state: RunState,
  label: string,
  artifact?: string,
): string {
  const href = resolveArtifactHref(state, artifact);
  return href ? `[${label}](${href})` : `\`${label}\``;
}

function attackEvidenceLinks(state: RunState, attack: Attack): string {
  return [
    artifactLink(
      state,
      attack.evidenceKind === "browser_probe"
        ? "browser probe evidence"
        : "attack patch",
      attack.patchPath,
    ),
    ...(attack.browserArtifactRefs ?? []).map((artifact, index) =>
      artifactLink(state, `browser artifact ${String(index + 1)}`, artifact),
    ),
  ].join(" ");
}

function checkCell(state: RunState, check?: CheckResult): string {
  if (!check) return "NOT RUN";
  const duration = check.command
    ? ` · ${(check.command.durationMs / 1000).toFixed(1)}s`
    : "";
  const logs = check.command
    ? ` ${artifactLink(state, "stdout", check.command.stdoutPath)} ${artifactLink(state, "stderr", check.command.stderrPath)}`
    : "";
  return `${reportCheckStatus(check)}${duration}${logs}`;
}

function coverageRows(
  state: RunState,
  contestants: ContestantResult[],
): string[] {
  const byId = new Map<string, Partial<Record<"a" | "b", CheckResult>>>();
  for (const contestant of contestants) {
    for (const check of contestant.checks) {
      const row = byId.get(check.id) ?? {};
      row[contestant.id] = check;
      byId.set(check.id, row);
    }
  }
  return [...byId.entries()].map(([id, checks]) => {
    const first = checks.a ?? checks.b;
    const command = first?.command?.command ?? first?.reason ?? "harness check";
    return `| ${tableCell(id)} — \`${tableCell(command)}\` | ${first?.kind ?? "unknown"} | ${checkCell(state, checks.a)} | ${checkCell(state, checks.b)} |`;
  });
}

function roundDigest(
  state: RunState,
  contestants: ContestantResult[],
): string[] {
  return reportRounds(state).map((round) => {
    const attacks = round.attacks;
    const proven = attacks.filter(
      (attack) =>
        attack.status === "landed" || attack.status === "shared_defect",
    );
    const summary = proven.length
      ? proven
          .map((attack) => `${attack.severity ?? "unrated"} ${attack.claim}`)
          .join("; ")
      : attacks.length
        ? `${String(attacks.length)} attack(s), none proven`
        : "No submitted attacks";
    const health = contestants
      .map((contestant) => {
        const result = contestant.rounds.find(
          (entry) => entry.round === round.id,
        );
        return `${contestantLabel(state.config.contestants, contestant.id)} ${result ? `${String(result.startingHealth)} → ${String(result.endingHealth)} HP` : "not run"}`;
      })
      .join("; ");
    const label =
      round.id === "recovery"
        ? "Recovery"
        : round.id === "reconciliation"
          ? "Reconciliation"
          : `R${String(round.id)}`;
    return `| ${label} | ${tableCell(summary)} | ${health} | ${artifactLink(state, "open round evidence", state.artifacts.battle)} |`;
  });
}

function decisiveDefects(state: RunState): string[] {
  const defects = reportDefects(state);
  return defects.length
    ? defects.map((defect) => {
        const attack = defect.representative;
        const cases = attack.caseBundle?.cases ?? [];
        const observed = attack.outcomeReason ?? attack.impact;
        const evidence = [
          attackEvidenceLinks(state, attack),
          ...cases.map((entry) =>
            artifactLink(
              state,
              entry.visibility === "visible" ? "reproducer" : "held-out case",
              entry.patchPath,
            ),
          ),
        ].join(" ");
        return `| ${defect.evidenceClass === "shared" ? "Shared QA" : "Competitive"} | ${tableCell(attack.claim)} | ${tableCell(attack.oracle.expectedBehavior)} | ${tableCell(observed)} | ${tableCell(attack.impact)} | ${attack.severity ?? "unrated"} — ${String(defect.damage)} HP | ${defect.active ? "UNRESOLVED" : "REPAIRED"} | ${evidence} |`;
      })
    : ["| — | No landed defect records | — | — | — | — | — | — |"];
}

function invocationEvidence(
  state: RunState,
  invocation: ContestantResult["implementation"],
): string {
  if (!invocation) return "not run";
  return [
    invocation.status.toUpperCase(),
    artifactLink(state, "prompt", invocation.promptPath),
    artifactLink(state, "transcript", invocation.transcriptPath),
    ...(invocation.submissionPath
      ? [artifactLink(state, "submission", invocation.submissionPath)]
      : []),
  ].join(" · ");
}

function implementationReplay(
  state: RunState,
  contestants: ContestantResult[],
): string[] {
  const eligibility = projectImplementationEligibility(state);
  return [
    "## Implementation and baseline",
    "",
    "| Contestant | Implementation | Initial patch | Baseline / required evidence |",
    "| --- | --- | --- | --- |",
    ...contestants.map((contestant) => {
      const checks = contestant.checks.filter(
        (check) => check.kind === "baseline" || check.id === "initial-required",
      );
      return `| ${contestantLabel(state.config.contestants, contestant.id)} | ${invocationEvidence(state, contestant.implementation)} | ${artifactLink(state, "initial patch", contestant.initialPatchPath)} | ${checks.length ? checks.map((check) => checkCell(state, check)).join("<br>") : "NOT RUN"} |`;
    }),
    "",
    ...(eligibility.length
      ? [
          "### Implementation eligibility and required-validation attempts",
          "",
          ...eligibility.flatMap((entry) => {
            const label = contestantLabel(
              state.config.contestants,
              entry.contestantId,
            );
            return [
              `- **${label}: ${entry.eligible ? "eligible" : "ineligible"}** (${entry.reasonCode ?? "eligible_patch"})${entry.validation ? ` — ${entry.validation.outcome.replaceAll("_", " ")}` : ""}`,
              ...(entry.validation
                ? requiredValidationAttemptSummary(entry.validation).map(
                    (attempt) => `  - ${attempt}`,
                  )
                : []),
            ];
          }),
          "",
        ]
      : []),
  ];
}

function roundValidationRows(
  state: RunState,
  round: ReturnType<typeof reportRounds>[number],
): string[] {
  const attackChecks = round.attacks.flatMap((attack) =>
    attack.checks.map((check) => `- ${check.id}: ${checkCell(state, check)}.`),
  );
  const contestantChecks =
    typeof round.id === "number"
      ? round.contestants.flatMap(({ contestant }) =>
          contestant.checks
            .filter((check) =>
              check.id.startsWith(`round-${String(round.id)}-`),
            )
            .map(
              (check) =>
                `- ${contestantLabel(state.config.contestants, contestant.id)} — ${check.id}: ${checkCell(state, check)}.`,
            ),
        )
      : [];
  return [...contestantChecks, ...attackChecks];
}

function roundReplay(state: RunState): string[] {
  return reportRounds(state).flatMap((round) => {
    const title =
      round.id === "recovery"
        ? "Recovery round"
        : round.id === "reconciliation"
          ? "Reconciliation round"
          : `Round ${String(round.id)}`;
    const goal =
      round.id === 1
        ? "Contract and local correctness"
        : round.id === 2
          ? "Systematic exploration of state, boundaries, and concurrency"
          : round.id === 3
            ? "Integration, resilience, and security"
            : round.id === 4
              ? "Extension generalization across adjacent cases"
              : round.id === 5
                ? "Extension recurrence, repair durability, and recovery boundaries"
                : round.id === "reconciliation"
                  ? "Correction-only reconciliation"
                  : "Replacement attacks for confirmed infrastructure losses";
    const invocations = state.attackInvocations.filter(
      (record) => record.round === round.id,
    );
    const validationRows = roundValidationRows(state, round);
    return [
      `## ${title}`,
      "",
      `**Goal:** ${goal}.`,
      "",
      "### Attack submissions",
      "",
      ...(invocations.length
        ? invocations.map(
            (record) =>
              `- ${contestantLabel(state.config.contestants, record.attacker)} → ${contestantLabel(state.config.contestants, record.target)}: ${record.submissionStatus}, ${String(record.attackCount)} attack(s); ${invocationEvidence(state, record.invocation)}.`,
          )
        : ["- No contestant attack invocation was recorded."]),
      "",
      "### Adjudication",
      "",
      ...(round.attacks.length
        ? round.attacks.map((attack) => {
            const observed =
              attack.outcomeReason ?? "No adjudication detail was recorded.";
            const relationship =
              attack.adjudication?.relationship ?? "independent";
            const chain = attack.adjudication?.priorAdjudicationId
              ? ` Decision chain: ${attack.adjudication.priorAdjudicationId} → ${attack.adjudication.id} (${relationship}, ${attack.adjudication.scoreEffect} ${String(attack.adjudication.exactAmount)} HP).`
              : "";
            return `- **${tableCell(attack.claim)}** — ${attack.status.toUpperCase()}. Observed result: ${tableCell(observed)} Expected: ${tableCell(attack.oracle.expectedBehavior)} Why it matters: ${tableCell(attack.impact)}${chain} Evidence: ${attackEvidenceLinks(state, attack)}.`;
          })
        : ["- No attacks were submitted."]),
      "",
      "### Repair",
      "",
      ...round.contestants.map(
        ({ contestant, result }) =>
          `- ${contestantLabel(state.config.contestants, contestant.id)}: ${result?.repair ? invocationEvidence(state, result.repair) : "no repair invocation recorded"}.`,
      ),
      "",
      "### Validation",
      "",
      ...(validationRows.length
        ? validationRows
        : ["- No round-scoped check result was recorded."]),
      "",
      "### Health ledger",
      "",
      ...round.contestants.map(
        ({ contestant, result }) =>
          `- ${contestantLabel(state.config.contestants, contestant.id)}: ${result ? `${String(result.startingHealth)} → ${String(result.postAttackHealth)} after attacks → ${String(result.endingHealth)} HP after repair (${result.endingStatus})` : "round not run"}.`,
      ),
      "",
    ];
  });
}

function pullRequestProvenance(state: RunState): string[] {
  const fixture = state.pullRequestFixture;
  if (!fixture) return [];
  const attribution = fixture.attribution;
  return [
    "## Frozen pull request",
    "",
    `Source: ${fixture.repository}#${String(fixture.number)}`,
    "",
    `Commits: \`${fixture.base.commit}\` → \`${fixture.head.commit}\``,
    "",
    `Incumbent attribution: **${attribution.confidence}**${attribution.provider ? ` (${attribution.provider})` : ""}`,
    "",
    "| Signal | Source | Value |",
    "| --- | --- | --- |",
    ...(attribution.evidence.length > 0
      ? attribution.evidence.map(
          (entry) =>
            `| ${entry.kind} | ${tableCell(entry.source)} | ${tableCell(entry.value)} |`,
        )
      : ["| none | — | No explicit provider provenance was found |"]),
    "",
    "Attribution is provenance metadata only; it does not change permissions, health, attack validity, or patch selection.",
    "",
  ];
}

function contestantSection(contestant: ContestantResult): string[] {
  const events = contestant.healthEvents.length
    ? contestant.healthEvents.map(
        (event) =>
          `- Round ${String(event.round)}: ${event.type} ${event.amount > 0 ? "+" : ""}${String(event.amount)} — ${event.reason}`,
      )
    : ["- No health events"];
  return [
    `## ${contestant.provider} ${contestant.id.toUpperCase()} (${contestant.role})`,
    "",
    `Status: ${contestant.status}`,
    "",
    `Initial source: ${contestant.role === "incumbent" || contestant.role === "defender" ? "frozen pull request" : contestant.role === "attacker" ? "test-only investigation role" : "fresh implementation"}`,
    "",
    `Final health: ${String(contestant.finalHealth)} HP`,
    "",
    `Final patch: ${contestant.finalPatchPath ?? "none"}`,
    "",
    "### Health timeline",
    "",
    ...events,
    "",
  ];
}

export function renderBattleReport(state: RunState): string {
  const usageSummary = readRunUsageSummarySync(
    `${state.config.artifactRoot}/${state.runId}`,
  );
  const usageSection = usageSummary
    ? [
        "## Provider usage",
        "",
        conciseUsage(usageSummary),
        "",
        "| Provider | Invocations | Provider time | Processed tokens | Cost |",
        "| --- | ---: | ---: | ---: | --- |",
        ...usageSummary.byProvider.map(
          (entry) =>
            `| ${entry.key} | ${String(entry.invocationCount)} | ${(entry.providerDurationMs / 1000).toFixed(1)}s | ${entry.usage.processedTokens === null ? `unavailable (${entry.usage.completeness})` : `${entry.usage.processedTokens.toLocaleString("en-US")} (${entry.usage.completeness})`} | ${entry.cost.usd === null ? `unavailable (${entry.cost.unavailableReason ?? "unknown"})` : `$${entry.cost.usd.toFixed(4)}`} |`,
        ),
        "",
        "| Dimension | Value | Invocations | Processed tokens |",
        "| --- | --- | ---: | ---: |",
        ...usageSummary.byResolvedModel.map(
          (entry) =>
            `| Resolved model | ${entry.key} | ${String(entry.invocationCount)} | ${entry.usage.processedTokens === null ? "unavailable" : entry.usage.processedTokens.toLocaleString("en-US")} |`,
        ),
        ...usageSummary.byRole.map(
          (entry) =>
            `| Role | ${entry.key} | ${String(entry.invocationCount)} | ${entry.usage.processedTokens === null ? "unavailable" : entry.usage.processedTokens.toLocaleString("en-US")} |`,
        ),
        "",
      ]
    : [
        "## Provider usage",
        "",
        "Telemetry unavailable (legacy or incomplete run).",
        "",
      ];
  const retainedWorktrees = state.config.keepWorktrees
    ? retainedWorktreePathsSync(state.artifacts.worktreeManifest)
    : [];
  const retentionSection = state.config.keepWorktrees
    ? [
        "## Retained worktrees",
        "",
        ...retainedWorktrees.map((worktree) => `- \`${worktree}\``),
        `- ${artifactLink(state, "Worktree manifest", state.artifacts.worktreeManifest)}`,
        "",
      ]
    : [];
  if (state.terminalOutcome) {
    const terminal = state.terminalOutcome;
    const recommended =
      terminal.kind === "forfeit"
        ? terminal.eligibleContestantIds[0]
        : undefined;
    const dispositions =
      terminal.version === 2
        ? terminal.contestants.map(
            (entry) =>
              `| ${contestantLabel(state.config.contestants, entry.contestantId)} | ${entry.eligible ? "eligible" : "ineligible"} | ${entry.reasonCode ?? "eligible_patch"} | ${entry.artifactPaths.join("<br>") || "none"} |`,
          )
        : terminal.affectedContestantIds.map(
            (id) =>
              `| ${contestantLabel(state.config.contestants, id)} | ineligible | ${terminal.reasonCode} | ${terminal.artifactPaths.join("<br>") || "none"} |`,
          );
    const validationEvidence =
      terminal.version === 2
        ? terminal.contestants.flatMap((entry) => {
            if (!entry.validation) return [];
            const label = contestantLabel(
              state.config.contestants,
              entry.contestantId,
            );
            return [
              `### ${label} required validation — ${entry.validation.outcome.replaceAll("_", " ")}`,
              "",
              ...requiredValidationAttemptSummary(entry.validation).map(
                (attempt) => `- ${attempt}`,
              ),
              "",
              ...entry.validation.attempts.flatMap((attempt, index) =>
                attempt.failureExcerpt
                  ? [
                      `Attempt ${String(index + 1)} failure excerpt:`,
                      "",
                      `<pre><code>${markdownCode(attempt.failureExcerpt)}</code></pre>`,
                      "",
                    ]
                  : [],
              ),
            ];
          })
        : [];
    return [
      "# Agent Arena Pre-Review Result",
      "",
      `Run: \`${state.runId}\``,
      "",
      `Task: ${state.config.task}`,
      "",
      `Mode: **${state.config.mode}**`,
      "",
      `Status: **${terminal.kind}** (\`${terminal.reasonCode}\`)`,
      "",
      terminal.reason,
      "",
      recommended
        ? `Recommended patch: **${contestantLabel(state.config.contestants, recommended)}** by deterministic duel forfeit.`
        : "Recommended patch: **none**.",
      "",
      "No review, attack, repair, quality comparison, or coverage stage ran.",
      "",
      ...usageSection,
      ...retentionSection,
      "| Contestant | Eligibility | Cause | Diagnostics |",
      "| --- | --- | --- | --- |",
      ...dispositions,
      "",
      ...validationEvidence,
      "Human review is required before applying any recommended patch.",
      "",
    ].join("\n");
  }
  const contestants = reportContestants(state);
  const defects = reportDefects(state);
  const competitiveDefects = defects.filter(
    (defect) => defect.evidenceClass === "competitive",
  );
  const sharedDefects = defects.filter(
    (defect) => defect.evidenceClass === "shared",
  );
  const outcome = reportOutcome(state);
  const nonDiscriminating = outcome.kind === "non_discriminating";
  const outcomeTotals = reportOutcomeTotals(state);
  const lines = [
    "# Agent Arena Battle Report",
    "",
    `Run: \`${state.runId}\``,
    "",
    `Task: ${state.config.task}`,
    "",
    `Mode: **${state.config.mode}**`,
    "",
    `Effort: **${state.config.resolvedEffortProfile?.tier ?? state.config.effortMode}** · ${state.config.fixedRounds ? `${String(state.config.rounds)} exact rounds` : `${String(state.config.resolvedEffortProfile?.plannedRounds ?? state.config.rounds)} planned rounds, up to ${String(state.config.resolvedEffortProfile?.maxRounds ?? state.config.rounds)} total`} · assessment ${state.config.effortAssessment?.fallback ? "medium fallback" : state.config.effortMode === "auto" ? "completed" : "skipped (explicit tier)"}`,
    "",
    ...(state.config.effortAssessment
      ? [
          `Initialization assessment overhead (outside task budgets): ${String(state.config.effortAssessment.attempts.length)} call(s), ${(state.config.effortAssessment.attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0) / 1000).toFixed(1)}s, telemetry ${state.config.effortAssessment.attempts.map((attempt) => attempt.tokenTelemetry.state).join(", ") || "unavailable"}.`,
          "",
        ]
      : []),
    ...(state.adaptiveCompletion
      ? [
          `Adaptive result: **adaptive coverage** (\`${state.adaptiveCompletion.reason}\`)`,
          "",
          `Skipped briefs: ${state.adaptiveCompletion.skippedBriefs.join(", ") || "none"}`,
          "",
        ]
      : []),
    ...(state.adaptiveDecisions.length
      ? [
          "| Round | Wall time | Provider calls | Tokens | Signal | Low-signal streak | Converged | Extension | Decision |",
          "| ---: | ---: | ---: | --- | --- | ---: | --- | --- | --- |",
          ...state.adaptiveDecisions.map(
            (decision) =>
              `| ${String(decision.round)} | ${(decision.consumption.wallTimeMs / 1000).toFixed(1)}s | ${String(decision.consumption.providerCalls)} | ${decision.consumption.tokenTelemetry.state}${decision.consumption.tokenTelemetry.totalTokens === undefined ? "" : ` (${String(decision.consumption.tokenTelemetry.totalTokens)} processed)`}${decision.version === 3 ? `<br>${describeTokenPressureV1(decision.consumption.tokenPressureEvaluation)}` : ""} | ${"signal" in decision ? `${String(decision.signal.competitiveLandings)} competitive / ${String(decision.signal.sharedDefects)} shared / ${String(decision.signal.explicitEmptyLanes)} empty` : "legacy"} | ${"signal" in decision ? String(decision.signal.consecutiveLowSignalCount) : "—"} | ${decision.convergence.passed ? "yes" : "no"} | ${decision.extensionQualified ? decision.extensionTriggerDefectIds.join(", ") || "yes" : "no"} | ${decision.action}: ${decision.reason} |`,
          ),
          "",
        ]
      : []),
    ...(state.integrity === "assisted"
      ? [
          "> **Assisted — not competitively comparable.** Operator steering was applied during this run.",
          "",
        ]
      : []),
    "runSpecHash" in state
      ? `Run specification: \`${state.runSpecHash}\``
      : `Legacy task contract: \`${state.taskContractHash}\``,
    "",
    "Surviving the arena is additional evidence, not a correctness guarantee.",
    "",
    ...usageSection,
    ...pullRequestProvenance(state),
    "## Final result",
    "",
    state.coverageDecision?.decision === "inconclusive"
      ? `Inconclusive; ledger leader: **${state.ranking?.order[0] ?? "none"}** — ${state.ranking?.reason ?? "run incomplete"}`
      : state.coverageAssessment?.confidence === "provisional" &&
          !state.coverageDecision
        ? `Provisional leader: **${state.ranking?.winner ?? "none"}** — ${state.ranking?.reason ?? "run incomplete"}`
        : nonDiscriminating
          ? `**Non-discriminating battle** — ${state.ranking?.reason ?? "complete bidirectional coverage found no competitive differentiator"}`
          : outcome.kind === "draw"
            ? `Draw: ${state.ranking?.reason ?? "equal evidence"}`
            : outcome.kind === "winner"
              ? `${state.coverageAssessment?.confidence === "reduced_confidence" || state.coverageDecision?.decision === "accept-reduced" ? "Reduced-confidence champion" : "Winner"}: **${outcome.winner}** — ${state.ranking?.reason ?? "arena outcome"}`
              : `Battle incomplete: **${state.ranking?.order[0] ?? "none"}** — ${state.ranking?.reason ?? "run incomplete"}`,
    state.coverageDecision?.decision === "inconclusive" ||
    (state.coverageAssessment?.confidence === "provisional" &&
      !state.coverageDecision)
      ? "Arena champion: **not published** (coverage unresolved or finalized inconclusive)"
      : state.arenaOutcome
        ? nonDiscriminating
          ? `Arena champion: **none**. Raw health is preserved (${String(state.arenaOutcome.marginHp)} HP margin) without implying leadership.`
          : outcome.kind === "draw"
            ? `Arena champion: **draw** (${String(state.arenaOutcome.marginHp)} HP, ${state.arenaOutcome.marginClass})`
            : `${state.integrity === "assisted" ? "Assisted leader" : "Arena champion"}: **${outcome.kind === "winner" ? outcome.winner : "unavailable"}** (${String(state.arenaOutcome.marginHp)} HP, ${state.arenaOutcome.marginClass})`
        : "Arena champion: unavailable",
    state.config.mode === "siege"
      ? "Production artifact: **defender final patch only** (patch comparison disabled)"
      : `${nonDiscriminating ? "Independent patch recommendation" : "Recommended patch"}: **${state.patchRecommendation?.contestantId ?? "none"}** (${state.patchRecommendation?.reason ?? "pending"})`,
    ...(state.patchRecommendation?.contestantId &&
    state.patchRecommendation.contestantId !== state.arenaOutcome?.championId
      ? [
          "",
          nonDiscriminating
            ? "> The arena awarded no champion. This recommendation comes only from the separate identity-blind implementation-quality comparison and does not change the competitive result."
            : "> The arena champion and recommended patch differ: arena health remains unchanged; the recommendation is an advisory correctness-first selection.",
        ]
      : []),
    "",
    "| Contestant | Required suite | Final HP | Gross damage | Healed | Active damage | Recoil | Patch bytes | Status |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...contestants.map((contestant) => {
      const finalRequired = [...contestant.checks]
        .reverse()
        .find((check) => check.kind === "required");
      const outcome = state.arenaOutcome?.contestants[contestant.id];
      return `| ${contestantLabel(state.config.contestants, contestant.id)} | ${finalRequired?.status ?? "not run"} | ${String(contestant.finalHealth)} | ${String(outcome?.grossDamageReceived ?? 0)} | ${String(outcome?.grossHealing ?? 0)} | ${String(outcome?.activeDefectDamage ?? 0)} | ${String(outcome?.permanentRecoil ?? contestant.healthLedger.permanentRecoil)} | ${String(contestant.patchSize)} | ${contestant.status} |`;
    }),
    "",
    `Decision basis: ${state.arenaOutcome && "decisionBasis" in state.arenaOutcome ? state.arenaOutcome.decisionBasis : "legacy_unknown"}`,
    "",
    `Evidence counts: ${String(competitiveDefects.length)} competitive landing(s) · ${String(sharedDefects.length)} shared QA defect(s) · ${String(state.coverageAssessment?.evidenceCounts.explicitEmpty ?? 0)} explicit-empty lane(s)`,
    "",
    `Competitive landings: **${String(outcomeTotals.competitiveLandings)}** · Shared defects: **${String(outcomeTotals.sharedDefects)}** · Schema-rejected findings: **${String(outcomeTotals.schemaRejectedFindings)}**`,
    "",
    "## Attack-lane coverage",
    "",
    ...(state.coverageAssessment
      ? [
          `Confidence: **${state.coverageAssessment.confidence.replaceAll("_", " ")}**`,
          "",
          `Required ${String(state.coverageAssessment.counts.required)} · completed ${String(state.coverageAssessment.counts.completed)} · degraded ${String(state.coverageAssessment.counts.degraded)} · unresolved ${String(state.coverageAssessment.counts.unresolved)}`,
          "",
          `Evidence: mechanical ${String(state.coverageAssessment.evidenceCounts.mechanical)} · judge-confirmed ${String(state.coverageAssessment.evidenceCounts.judgeConfirmed)} · judge-partial ${String(state.coverageAssessment.evidenceCounts.judgePartial)} · judge-rejected ${String(state.coverageAssessment.evidenceCounts.judgeRejected)} · explicit empty ${String(state.coverageAssessment.evidenceCounts.explicitEmpty)}`,
          "",
          `Reason codes: ${state.coverageAssessment.reasonCodes.join(", ") || "none"}`,
          "",
          "| Required lane | State | Evidence | Reason codes |",
          "| --- | --- | --- | --- |",
          ...state.coverageAssessment.requiredLanes.map(
            (lane) =>
              `| ${lane.id} | ${lane.finalState} | ${lane.evidenceBasis} | ${lane.reasonCodes.join(", ") || "none"} |`,
          ),
          "",
          `Assessment digest: \`${state.coverageAssessment.assessmentDigest}\``,
        ]
      : ["Confidence: **legacy / unknown** (no coverage claim is inferred)."]),
    "",
    ...(contestants.some((contestant) => contestant.browserValidation)
      ? [
          `Browser coverage: ${contestants
            .map(
              (contestant) =>
                `${contestantLabel(state.config.contestants, contestant.id)} **${contestant.browserValidation?.status ?? "not run"}**${contestant.browserValidation?.reason ? ` (${contestant.browserValidation.reason})` : ""}`,
            )
            .join(" · ")}`,
          "",
        ]
      : []),
    "## Developer takeaway",
    "",
    `- **Arena result:** ${nonDiscriminating ? "Non-discriminating battle; no champion" : state.ranking?.draw ? "Draw" : `${contestantLabel(state.config.contestants, state.coverageDecision?.decision === "inconclusive" ? (state.ranking?.order[0] ?? "a") : (state.ranking?.winner ?? "a"))} — ${state.ranking?.reason ?? "run incomplete"}`}.`,
    `- **Why:** ${contestants
      .map((contestant) => {
        const outcome = state.arenaOutcome?.contestants[contestant.id];
        return `${contestantLabel(state.config.contestants, contestant.id)} ${String(contestant.finalHealth)} HP (recoil ${String(outcome?.permanentRecoil ?? contestant.healthLedger.permanentRecoil)}, active damage ${String(outcome?.activeDefectDamage ?? 0)})`;
      })
      .join("; ")}.`,
    `- **Bugs found:** ${String(competitiveDefects.length)} competitive; ${String(sharedDefects.length)} shared QA; ${String(defects.filter((defect) => !defect.active).length)} repaired; ${String(defects.filter((defect) => defect.active).length)} unresolved.`,
    `- **Battle evidence:** ${defects.length ? "Recorded landed attacks and their repair outcomes are listed below." : "No attacks landed in the recorded evidence; no correctness inference is made from that count."}`,
    "",
    "## Verified test coverage — final patches",
    "",
    "A result applies only to the named contestant, patch revision, and harness environment. `NOT RUN` is not a pass.",
    "",
    `| Check / exact command | Scope | ${contestantLabel(state.config.contestants, "a")} | ${contestantLabel(state.config.contestants, "b")} |`,
    "| --- | --- | --- | --- |",
    ...coverageRows(state, contestants),
    "",
    "## Competitive and shared defect evidence",
    "",
    "| Evidence class | Defect | Expected / invariant | Observed failure | Why it matters | Severity | State | Evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...decisiveDefects(state),
    "",
    "## Round digest",
    "",
    "| Round | Meaningful outcome | Health movement | Evidence |",
    "| --- | --- | --- | --- |",
    ...roundDigest(state, contestants),
    "",
    "## Handoff",
    "",
    ...retentionSection,
    "### Already done",
    "",
    `- Required validation ran for ${contestants.map((contestant) => contestantLabel(state.config.contestants, contestant.id)).join(" and ")}.`,
    `- ${String(defects.length)} proven defect(s) were adjudicated with executable evidence.`,
    `- Final patch artifacts: ${contestants.map((contestant) => artifactLink(state, contestantLabel(state.config.contestants, contestant.id), contestant.finalPatchPath)).join(", ")}.`,
    "",
    "### Still needed",
    "",
    ...(defects.some((defect) => defect.active)
      ? defects
          .filter((defect) => defect.active)
          .map(
            (defect) =>
              `- Review unresolved ${defect.representative.severity ?? "unrated"} defect: ${defect.representative.claim}.`,
          )
      : ["- Inspect the recorded coverage and attack ledger before review."]),
    ...(state.coverageAssessment?.confidence === "provisional" &&
    !state.coverageDecision
      ? [
          `- Resolve provisional coverage before patch review: \`agent-arena resolve-coverage ${state.runId} --assessment-digest ${state.coverageAssessment.assessmentDigest} --decision <accept-reduced|inconclusive>\`.`,
        ]
      : []),
    state.config.mode === "siege"
      ? "- Review the defender patch before delivery."
      : `- Review and choose a patch: \`agent-arena review ${state.runId}\`.`,
    "",
    state.config.mode === "siege"
      ? "## Defender artifact"
      : "## Patch recommendation",
    "",
    ...(state.patchRecommendation?.rationale.map(
      (rationale) => `- ${rationale}`,
    ) ?? [
      state.config.mode === "siege"
        ? "- Only the defender's final production patch is available for review and delivery."
        : "- Recommendation not available.",
    ]),
    "",
    "| Contestant | Primary category | Files | Added | Deleted | Normalized | Paths |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- |",
    ...contestants.flatMap((contestant) => {
      const facts = state.patchQualityFacts[contestant.id];
      const label = contestantLabel(state.config.contestants, contestant.id);
      const rows = qualityCategoryRows(facts);
      if (!rows.length)
        return [
          `| ${label} | legacy v1 facts | — | — | — | — | ${facts?.evidence.join(", ") || "none"} |`,
        ];
      return rows.map(
        (row) =>
          `| ${label} | ${row.category} | ${String(row.filesChanged)} | +${String(row.addedLines)} | -${String(row.deletedLines)} | ${String(row.normalizedLines)} | ${row.paths.join(", ") || "—"} |`,
      );
    }),
    "",
    "Observability is an overlapping heuristic; zero matches do not prove absence.",
    "",
    ...contestants.map((contestant) => {
      const facts = state.patchQualityFacts[contestant.id];
      const label = contestantLabel(state.config.contestants, contestant.id);
      if (!facts || facts.version !== 2)
        return `- ${label}: legacy v1 observability facts.`;
      const facet = facts.facets.observability;
      return `- ${label}: heuristic matches in ${String(facet.filesChanged)} file(s), +${String(facet.matchedAddedLines)} / -${String(facet.matchedDeletedLines)} lines; paths: ${facet.paths.join(", ") || "none"}${facet.risks.length ? `; risks: ${facet.risks.join("; ")}` : ""}.`;
    }),
    "",
    "Human review: pending",
    "",
    ...(state.reviewPrompt?.choices.map(
      (choice) =>
        `- ${choice.contestantId}${choice.badges.length ? ` (${choice.badges.join(", ")})` : ""}: ${choice.eligible ? choice.summary : choice.disabledReason}`,
    ) ?? []),
    "",
    ...implementationReplay(state, contestants),
    ...roundReplay(state),
    "## Attacks",
    "",
    "### Generation activity",
    "",
    "| Round | Attacker | Target | Invocation | Submission | Attacks | Duration | Detail |",
    "| --- | --- | --- | --- | --- | ---: | ---: | --- |",
    ...state.attackInvocations.map(
      (attempt) =>
        `| ${String(attempt.round)} | ${attempt.attacker} | ${attempt.target} | ${attempt.invocation.status} | ${attempt.submissionStatus} | ${String(attempt.attackCount)} | ${(attempt.invocation.durationMs / 1000).toFixed(1)}s | ${(attempt.detail ?? "—").replaceAll("|", "\\|")} |`,
    ),
    ...(state.attackInvocations.length
      ? []
      : [
          "| — | — | — | — | — | 0 | — | No contestant attack invocation recorded |",
        ]),
    "",
    "### Permanent submission artifacts",
    "",
    "Raw provider contents are linked but never embedded. Parsed artifacts contain normalized accepted values and redacted diagnostics.",
    "",
    ...state.submissionArtifacts.map(
      (record) =>
        `- ${String(record.round)} ${record.phase} ${record.actor} (${record.outcome}, SHA-256 \`${record.rawSha256}\`): ${artifactLink(state, "raw", record.rawArtifactPath)} · ${artifactLink(state, "parsed", record.parsedArtifactPath)}`,
    ),
    ...(state.submissionArtifacts.length
      ? []
      : [
          "- No permanent structured-submission artifacts recorded (legacy run).",
        ]),
    "",
    "| Round | Author | Rank | Claim | Outcome | Severity | Effect |",
    "| --- | --- | ---: | --- | --- | --- | --- |",
    ...state.attacks.map(
      (attack) =>
        `| ${String(attack.round)} | ${attackOwner(attack)} | ${String(attack.rank ?? "—")} | ${attack.claim.replaceAll("|", "\\|")} | ${attack.status} | ${attack.severity ?? "—"} | ${attackEffect(attack)} |`,
    ),
    "",
    "## Visible and held-out cases",
    "",
    "| Attack | Visibility | Category | Status | Hash |",
    "| --- | --- | --- | --- | --- |",
    ...state.attacks.flatMap(
      (attack) =>
        attack.caseBundle?.cases.map(
          (caseEntry) =>
            `| ${attack.id} | ${caseEntry.visibility} | ${caseEntry.category} | ${caseEntry.status} | \`${caseEntry.contentHash}\` |`,
        ) ?? [],
    ),
    "",
    "## Failure handling ledger",
    "",
    "| Failure | Stage | Attempts | Retry outcome | Judge basis | Confidence effect | Score effect | Diagnostics |",
    "| --- | --- | ---: | --- | --- | --- | --- | --- |",
    ...(state.failureRecords.length
      ? state.failureRecords.map((failure) => {
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
          const timeoutCause = failure.attempts
            .flatMap((attempt) =>
              attempt.timeout
                ? [
                    `${attempt.timeout.kind} timeout (${String(attempt.timeout.elapsedMs)}ms)`,
                  ]
                : [],
            )
            .join(", ");
          return `| ${failure.failureId} | ${failure.stage}${timeoutCause ? ` · ${timeoutCause}` : ""} | ${String(failure.attempts.length)}/2 | ${disposition} | ${judgeBasis} | ${confidence} | ${score} | ${failure.diagnosticArtifactRefs.map((artifact) => artifactLink(state, "diagnostic", artifact)).join(" · ") || "—"} |`;
        })
      : ["| — | — | 0/2 | no failures recorded | — | none | none | — |"]),
    "",
    ...contestants.flatMap(contestantSection),
    "## Permissions and limitations",
    "",
    ...(state.operatorInterventions.length
      ? [
          `- Operator interventions: ${state.operatorInterventions.map((note) => `${note.contestantId}:${note.status}${note.appliedStage ? `@${note.appliedStage}` : ""}`).join(", ")}.`,
        ]
      : []),
    "- Agent worktrees isolate accidental changes but are not hostile-code sandboxes.",
    "- Credential/service delivery is brokered where declared; advisory restrictions are not OS-enforced.",
    "- No novel final-validation finding can change health after the last repair opportunity.",
    "",
    "## Reproduce",
    "",
    `Required command: \`${state.config.testCommand}\``,
    "",
    `Review with \`agent-arena review ${state.runId}\`, accept an exact digest, then apply with \`agent-arena apply ${state.runId}\`.`,
    "",
  ];
  return lines.join("\n");
}
