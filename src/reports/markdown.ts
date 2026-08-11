import type {
  Attack,
  CheckResult,
  ContestantResult,
  RunState,
} from "../core/types.js";
import { contestantLabel } from "../core/labels.js";
import {
  reportCheckStatus,
  reportContestants,
  reportDefects,
  reportRounds,
  resolveArtifactHref,
} from "./presentation.js";

function attackOwner(attack: Attack): string {
  return attack.origin.kind === "house" ? "House" : attack.origin.contestant;
}

function attackEffect(attack: Attack): string {
  if (attack.status === "landed")
    return `${String(attack.adjudication?.exactAmount ?? attack.damage ?? 0)} damage (${(attack.adjudication?.evidenceBasis ?? attack.evidenceProvenance ?? "legacy_unknown").replaceAll("_", " ")})`;
  if (attack.recoil !== undefined) return `${String(attack.recoil)} recoil`;
  return "no health effect";
}

function tableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\r?\n/gu, " ");
}

function artifactLink(
  state: RunState,
  label: string,
  artifact?: string,
): string {
  const href = resolveArtifactHref(state, artifact);
  return href ? `[${label}](${href})` : `\`${label}\``;
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
    const landed = attacks.filter((attack) => attack.status === "landed");
    const summary = landed.length
      ? landed
          .map((attack) => `${attack.severity ?? "unrated"} ${attack.claim}`)
          .join("; ")
      : attacks.length
        ? `${String(attacks.length)} attack(s), none landed`
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
          artifactLink(state, "attack patch", attack.patchPath),
          ...cases.map((entry) =>
            artifactLink(
              state,
              entry.visibility === "visible" ? "reproducer" : "held-out case",
              entry.patchPath,
            ),
          ),
        ].join(" ");
        return `| ${tableCell(attack.claim)} | ${tableCell(attack.oracle.expectedBehavior)} | ${tableCell(observed)} | ${tableCell(attack.impact)} | ${attack.severity ?? "unrated"} — ${String(defect.damage)} HP | ${defect.active ? "UNRESOLVED" : "REPAIRED"} | ${evidence} |`;
      })
    : ["| No landed defect records | — | — | — | — | — | — |"];
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
  return [
    "## Implementation and baseline",
    "",
    "| Contestant | Implementation | Initial patch | Baseline / required evidence |",
    "| --- | --- | --- | --- |",
    ...contestants.map((contestant) => {
      const checks = contestant.checks.filter(
        (check) => check.kind === "baseline",
      );
      return `| ${contestantLabel(state.config.contestants, contestant.id)} | ${invocationEvidence(state, contestant.implementation)} | ${artifactLink(state, "initial patch", contestant.initialPatchPath)} | ${checks.length ? checks.map((check) => checkCell(state, check)).join("<br>") : "NOT RUN"} |`;
    }),
    "",
  ];
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
            : round.id === "reconciliation"
              ? "Correction-only reconciliation"
              : "Replacement attacks for confirmed infrastructure losses";
    const invocations = state.attackInvocations.filter(
      (record) => record.round === round.id,
    );
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
            return `- **${tableCell(attack.claim)}** — ${attack.status.toUpperCase()}. Observed result: ${tableCell(observed)} Expected: ${tableCell(attack.oracle.expectedBehavior)} Why it matters: ${tableCell(attack.impact)} Evidence: ${artifactLink(state, "attack patch", attack.patchPath)}.`;
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
      ...(round.attacks.flatMap((attack) => attack.checks).length
        ? round.attacks
            .flatMap((attack) => attack.checks)
            .map((check) => `- ${check.id}: ${checkCell(state, check)}.`)
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
  const contestants = reportContestants(state);
  const defects = reportDefects(state);
  const lines = [
    "# Agent Arena Battle Report",
    "",
    `Run: \`${state.runId}\``,
    "",
    `Task: ${state.config.task}`,
    "",
    `Mode: **${state.config.mode}**`,
    "",
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
    ...pullRequestProvenance(state),
    "## Final result",
    "",
    ...(state.terminalOutcome
      ? [
          `**Pre-review terminal status:** ${state.terminalOutcome.kind} (${state.terminalOutcome.reasonCode})`,
          "",
          state.terminalOutcome.reason,
          "",
          `Eligible production patches: ${state.terminalOutcome.eligibleContestantIds.join(", ") || "none"}. No review, attack, repair, quality, or coverage artifacts were created.`,
          "",
        ]
      : []),
    state.ranking?.draw
      ? `Draw: ${state.ranking.reason}`
      : `${state.coverageDecision?.decision === "inconclusive" ? "Inconclusive; ledger leader" : state.coverageAssessment?.confidence === "provisional" && !state.coverageDecision ? "Provisional leader" : state.coverageAssessment?.confidence === "reduced_confidence" || state.coverageDecision?.decision === "accept-reduced" ? "Reduced-confidence champion" : "Winner"}: **${state.coverageDecision?.decision === "inconclusive" ? (state.ranking?.order[0] ?? "none") : (state.ranking?.winner ?? "none")}** — ${state.ranking?.reason ?? "run incomplete"}`,
    state.coverageDecision?.decision === "inconclusive" ||
    (state.coverageAssessment?.confidence === "provisional" &&
      !state.coverageDecision)
      ? "Arena champion: **not published** (coverage unresolved or finalized inconclusive)"
      : state.arenaOutcome
        ? `${state.integrity === "assisted" ? "Assisted leader" : "Arena champion"}: **${state.arenaOutcome.championId ?? "draw"}** (${String(state.arenaOutcome.marginHp)} HP, ${state.arenaOutcome.marginClass})`
        : "Arena champion: unavailable",
    state.config.mode === "siege"
      ? "Production artifact: **defender final patch only** (patch comparison disabled)"
      : `Recommended patch: **${state.patchRecommendation?.contestantId ?? "draw"}** (${state.patchRecommendation?.reason ?? "pending"})`,
    ...(state.patchRecommendation?.contestantId &&
    state.patchRecommendation.contestantId !== state.arenaOutcome?.championId
      ? [
          "",
          "> The arena champion and recommended patch differ: arena health remains unchanged; the recommendation is an advisory correctness-first selection.",
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
    `Deciding factors: ${state.arenaOutcome?.decidingFactors.join(", ") || "none"}`,
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
    "## Developer takeaway",
    "",
    `- **Ledger result:** ${state.ranking?.draw ? "Draw" : `${contestantLabel(state.config.contestants, state.coverageDecision?.decision === "inconclusive" ? (state.ranking?.order[0] ?? "a") : (state.ranking?.winner ?? "a"))} — ${state.ranking?.reason ?? "run incomplete"}`}.`,
    `- **Why:** ${contestants
      .map((contestant) => {
        const outcome = state.arenaOutcome?.contestants[contestant.id];
        return `${contestantLabel(state.config.contestants, contestant.id)} ${String(contestant.finalHealth)} HP (recoil ${String(outcome?.permanentRecoil ?? contestant.healthLedger.permanentRecoil)}, active damage ${String(outcome?.activeDefectDamage ?? 0)})`;
      })
      .join("; ")}.`,
    `- **Bugs found:** ${String(defects.length)} proven; ${String(defects.filter((defect) => !defect.active).length)} repaired; ${String(defects.filter((defect) => defect.active).length)} unresolved.`,
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
    "## Decisive defects",
    "",
    "| Defect | Expected / invariant | Observed failure | Why it matters | Severity | State | Evidence |",
    "| --- | --- | --- | --- | --- | --- |",
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
    "| Contestant | Production files | Normalized production lines | Tests | Manifests | Observability |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...contestants.map((contestant) => {
      const facts = state.patchQualityFacts[contestant.id];
      return `| ${contestantLabel(state.config.contestants, contestant.id)} | ${String(facts?.productionFilesChanged ?? 0)} | ${String(facts?.normalizedProductionLines ?? 0)} | ${String(facts?.testFilesChanged ?? 0)} | ${String(facts?.manifestDeltas.length ?? 0)} | ${String(facts?.observabilityChanges.length ?? 0)} |`;
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
          return `| ${failure.failureId} | ${failure.stage} | ${String(failure.attempts.length)}/2 | ${disposition} | ${judgeBasis} | ${confidence} | ${score} | ${failure.diagnosticArtifactRefs.map((artifact) => artifactLink(state, "diagnostic", artifact)).join(" · ") || "—"} |`;
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
