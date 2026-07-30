import type { Attack, ContestantResult, RunState } from "../core/types.js";
import { contestantLabel } from "../core/labels.js";

function attackOwner(attack: Attack): string {
  return attack.origin.kind === "house" ? "House" : attack.origin.contestant;
}

function attackEffect(attack: Attack): string {
  if (attack.status === "landed") return `${String(attack.damage ?? 0)} damage`;
  if (attack.recoil !== undefined) return `${String(attack.recoil)} recoil`;
  return "no health effect";
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
  const contestants = Object.values(state.contestants);
  const lines = [
    "# Agent Arena Battle Report",
    "",
    `Run: \`${state.runId}\``,
    "",
    `Task: ${state.config.task}`,
    "",
    `Mode: **${state.config.mode}**`,
    "",
    `Task contract: \`${state.taskContractHash}\``,
    "",
    "Surviving the arena is additional evidence, not a correctness guarantee.",
    "",
    "## Final result",
    "",
    state.ranking?.draw
      ? `Draw: ${state.ranking.reason}`
      : `Winner: **${state.ranking?.winner ?? "none"}** — ${state.ranking?.reason ?? "run incomplete"}`,
    state.arenaOutcome
      ? `Arena champion: **${state.arenaOutcome.championId ?? "draw"}** (${String(state.arenaOutcome.marginHp)} HP, ${state.arenaOutcome.marginClass})`
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
    state.config.mode === "siege" ? "## Defender artifact" : "## Patch recommendation",
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
    ...(state.attackInvocations.length ? [] : ["| — | — | — | — | — | 0 | — | No contestant attack invocation recorded |"]),
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
    "## Infrastructure recovery",
    "",
    ...contestants.flatMap((contestant) =>
      contestant.replacementCredits.length
        ? contestant.replacementCredits.map(
            (credit) =>
              `- ${contestantLabel(state.config.contestants, contestant.id)}: credit ${credit.id} from ${credit.sourceAttackId} — ${credit.status}${credit.replacementAttackId ? ` by ${credit.replacementAttackId}` : ""}`,
          )
        : [
            `- ${contestantLabel(state.config.contestants, contestant.id)}: no replacement credits`,
          ],
    ),
    ...state.attacks
      .filter(
        (attack) =>
          attack.infrastructureReview ||
          [
            "infrastructure_error",
            "execution_inconclusive",
            "provisional_infrastructure",
          ].includes(attack.status),
      )
      .map(
        (attack) =>
          `- ${attack.id}: ${attack.status}; review ${attack.infrastructureReview ?? "not recorded"}`,
      ),
    ...(state.harnessOverlays.length
      ? state.harnessOverlays.map(
          (overlay) =>
            `- Overlay ${overlay.id}: ${overlay.status}; scopes ${overlay.scopes.join(", ") || "none"}; validation ${overlay.validationChecks.map((check) => `${check.id}:${check.status}`).join(", ") || "none"}`,
        )
      : ["- No harness overlays applied."]),
    "",
    ...contestants.flatMap(contestantSection),
    "## Permissions and limitations",
    "",
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
