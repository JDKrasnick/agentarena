import { inspectPatch, reviewRun } from "../review/service.js";
import type { AgentId } from "../core/types.js";

export async function runReviewCommand(options: {
  runId: string;
  json?: boolean;
}): Promise<string> {
  const prompt = await reviewRun({ runId: options.runId });
  if (options.json) return JSON.stringify(prompt, null, 2);
  return [
    `Review run ${prompt.runId}`,
    `Prompt: ${prompt.promptId}`,
    `Base: ${prompt.baseCommit}`,
    "",
    ...prompt.choices.map(
      (choice) =>
        `${choice.eligible ? "[ ]" : "[x]"} ${choice.contestantId}${choice.badges.length ? ` — ${choice.badges.join(", ")}` : ""}\n    ${choice.summary}\n    SHA-256: ${choice.patchSha256}${choice.disabledReason ? `\n    Disabled: ${choice.disabledReason}` : ""}`,
    ),
    "",
    "Choose explicitly with `agent-arena accept`; pressing Enter does not accept.",
  ].join("\n");
}

export async function runInspectCommand(options: {
  runId: string;
  agent: AgentId;
  view: "summary" | "diff" | "tests" | "quality";
  json?: boolean;
}): Promise<string> {
  const value = await inspectPatch({
    runId: options.runId,
    contestantId: options.agent,
    view: options.view,
  });
  return typeof value === "string" && !options.json
    ? value
    : JSON.stringify(value, null, 2);
}
