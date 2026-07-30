import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { AgentId } from "../core/types.js";
import { applyAcceptedPatch } from "./apply.js";
import { recordReviewDecision, reviewRun } from "../review/service.js";

async function confirmDigest(
  patchSha256: string,
  provided?: string,
): Promise<string> {
  if (provided) {
    if (provided !== patchSha256)
      throw new Error("Confirmed digest does not match the selected patch");
    return provided;
  }
  if (!stdin.isTTY || !stdout.isTTY)
    throw new Error(
      "Non-interactive acceptance requires --confirm-sha256 with the full digest",
    );
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await terminal.question(
      `Type the full patch SHA-256 to accept:\n${patchSha256}\n> `,
    );
    if (answer.trim() !== patchSha256)
      throw new Error("Patch was not accepted");
    return patchSha256;
  } finally {
    terminal.close();
  }
}

export async function runAcceptCommand(options: {
  runId: string;
  decision?: "accept" | "reject";
  selection?: "recommended" | "champion";
  agent?: AgentId;
  confirmSha256?: string;
  apply?: boolean;
  idempotencyKey?: string;
  json?: boolean;
}): Promise<string> {
  const prompt = await reviewRun({ runId: options.runId });
  const decision = options.decision ?? "accept";
  const selection = options.agent ?? options.selection ?? "recommended";
  const selected =
    decision === "reject"
      ? undefined
      : selection === "recommended"
        ? prompt.choices.find((choice) => choice.badges.includes("recommended"))
        : selection === "champion"
          ? prompt.choices.find((choice) =>
              choice.badges.includes("arena_champion"),
            )
          : prompt.choices.find((choice) => choice.contestantId === selection);
  if (decision === "accept" && !selected)
    throw new Error("Requested patch selection is unavailable");
  let confirmed: string;
  if (decision === "reject") {
    confirmed = createHash("sha256").update(prompt.promptId).digest("hex");
    if (options.confirmSha256 && options.confirmSha256 !== confirmed)
      throw new Error("Rejection confirmation does not match this prompt");
    if (!options.confirmSha256) {
      if (!stdin.isTTY || !stdout.isTTY)
        throw new Error(
          `Non-interactive rejection requires --confirm-sha256 ${confirmed}`,
        );
      const terminal = createInterface({ input: stdin, output: stdout });
      try {
        if (
          (
            await terminal.question(
              `Type "reject" to reject every patch in prompt ${prompt.promptId}: `,
            )
          )
            .trim()
            .toLowerCase() !== "reject"
        )
          throw new Error("Patches were not rejected");
      } finally {
        terminal.close();
      }
    }
  } else {
    confirmed = await confirmDigest(
      selected?.patchSha256 ?? "0".repeat(64),
      options.confirmSha256,
    );
  }
  const key = options.idempotencyKey ?? randomUUID();
  const record = await recordReviewDecision({
    runId: options.runId,
    promptId: prompt.promptId,
    decision,
    ...(decision === "accept" ? { selection } : {}),
    ...(selected ? { expectedPatchSha256: selected.patchSha256 } : {}),
    expectedBaseCommit: prompt.baseCommit,
    approval: {
      channel: "cli",
      promptId: prompt.promptId,
      provenance: {
        kind: "direct_tty",
        confirmedPatchSha256: confirmed,
      },
    },
    idempotencyKey: `${key}:decision`,
  });
  const applied =
    options.apply && record.status === "accepted"
      ? await applyAcceptedPatch({
          runId: options.runId,
          ...(record.patchSha256
            ? { expectedPatchSha256: record.patchSha256 }
            : {}),
          idempotencyKey: `${key}:apply`,
        })
      : undefined;
  return options.json
    ? JSON.stringify(
        { decision: record, ...(applied ? { applied } : {}) },
        null,
        2,
      )
    : [
        `Review ${record.status}: ${record.selectedContestantId ?? "all patches"}`,
        ...(applied
          ? [
              `Applied ${applied.changedPaths.length} paths. Run: ${applied.testCommand}`,
            ]
          : []),
      ].join("\n");
}
