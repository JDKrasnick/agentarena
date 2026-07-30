import type { Attack, ContestantResult, RunState } from "../core/types.js";

function attackOwner(attack: Attack): string {
  return attack.origin.kind === "house" ? "House" : attack.origin.agent;
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
    `## ${contestant.agent}`,
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
    `Task contract: \`${state.taskContractHash}\``,
    "",
    "Surviving the arena is additional evidence, not a correctness guarantee.",
    "",
    "## Final result",
    "",
    state.ranking?.draw
      ? `Draw: ${state.ranking.reason}`
      : `Winner: **${state.ranking?.winner ?? "none"}** — ${state.ranking?.reason ?? "run incomplete"}`,
    "",
    "| Contestant | Required suite | Final HP | Patch bytes | Status |",
    "| --- | --- | ---: | ---: | --- |",
    ...contestants.map((contestant) => {
      const finalRequired = [...contestant.checks]
        .reverse()
        .find((check) => check.kind === "required");
      return `| ${contestant.agent} | ${finalRequired?.status ?? "not run"} | ${String(contestant.finalHealth)} | ${String(contestant.patchSize)} | ${contestant.status} |`;
    }),
    "",
    "## Attacks",
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
    `Apply a selected patch with \`agent-arena apply ${state.runId} --agent <id>\`.`,
    "",
  ];
  return lines.join("\n");
}
