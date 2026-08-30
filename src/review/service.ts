import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { ArtifactStore } from "../artifacts/store.js";
import { stableId } from "../core/ids.js";
import type { ContestantId, ReviewPrompt, RunState } from "../core/types.js";
import {
  ApprovalContextSchema,
  DirectApprovalVerifier,
  type ApprovalContext,
  type ApprovalVerifier,
} from "./approval.js";
import { buildReviewPrompt } from "./prompt.js";
import { coverageAllowsPatchReview } from "../confidence/assessment.js";
import {
  hashValue,
  readCurrentReview,
  readOperation,
  ReviewDecisionSchema,
  type ReviewDecision,
} from "./store.js";

export interface RunLocation {
  runId: string;
  repositoryRoot?: string;
  artifactRoot?: string;
}

export async function openRun(
  options: RunLocation,
): Promise<{ store: ArtifactStore; state: RunState }> {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  const artifactRoot = path.resolve(
    options.artifactRoot ?? path.join(repositoryRoot, ".agent-arena", "runs"),
  );
  const store = new ArtifactStore(artifactRoot, options.runId);
  const state = await store.readState();
  if (state.runId !== options.runId)
    throw new Error("Run artifact ID does not match its directory");
  if (
    (await realpath(path.resolve(state.artifacts.runDirectory ?? ""))) !==
    (await realpath(store.runDirectory))
  )
    throw new Error("Run artifact directory identity does not match");
  return { store, state };
}

async function ensureReviewFacts(
  store: ArtifactStore,
  state: RunState,
): Promise<void> {
  let changed = false;
  for (const contestant of Object.values(state.contestants)) {
    if (!contestant.finalPatchPath) continue;
    const patchPath = await trustedPatchPath(
      state,
      contestant.id,
      store.runDirectory,
    );
    const patchBytes = await readFile(patchPath);
    const digest = createHash("sha256").update(patchBytes).digest("hex");
    if (state.patchQualityFacts[contestant.id]?.patchSha256 === digest)
      continue;
    throw new Error(
      `Run has no matching stored quality facts for ${contestant.id}; review will not reclassify a historical patch`,
    );
  }
  if (!state.reviewPrompt || changed) {
    state.reviewPrompt = buildReviewPrompt(state);
    changed = true;
  }
  if (changed && (await store.readSummary())) await store.writeState(state);
}

export async function reviewRun(options: RunLocation): Promise<ReviewPrompt> {
  const { store, state } = await openRun(options);
  if (!coverageAllowsPatchReview(state))
    throw new Error(
      "Patch review is blocked until provisional coverage is resolved with accept-reduced",
    );
  if (state.status !== "complete")
    throw new Error("Only a completed run can be reviewed");
  await ensureReviewFacts(store, state);
  return state.reviewPrompt ?? buildReviewPrompt(state);
}

export async function inspectPatch(
  options: RunLocation & {
    contestantId: ContestantId;
    view: "summary" | "diff" | "tests" | "quality";
  },
): Promise<unknown> {
  const { store, state } = await openRun(options);
  await ensureReviewFacts(store, state);
  const contestant = state.contestants[options.contestantId];
  if (!contestant?.finalPatchPath)
    throw new Error(`Run has no final patch for ${options.contestantId}`);
  switch (options.view) {
    case "diff":
      return readFile(
        await trustedPatchPath(state, options.contestantId, store.runDirectory),
        "utf8",
      );
    case "quality":
      return state.patchQualityFacts[options.contestantId];
    case "tests":
      return contestant.checks;
    case "summary":
      return state.reviewPrompt?.choices.find(
        (choice) => choice.contestantId === options.contestantId,
      );
  }
}

export async function recordReviewDecision(
  options: RunLocation & {
    promptId: string;
    decision: "accept" | "reject";
    selection?: "recommended" | "champion" | ContestantId;
    expectedPatchSha256?: string;
    expectedBaseCommit: string;
    approval: ApprovalContext;
    idempotencyKey: string;
    verifier?: ApprovalVerifier;
    now?: Date;
  },
): Promise<ReviewDecision> {
  const { store, state } = await openRun(options);
  if (!coverageAllowsPatchReview(state))
    throw new Error(
      "Patch acceptance is blocked until provisional coverage is resolved with accept-reduced",
    );
  if (state.status !== "complete")
    throw new Error("Review decisions require a completed, trusted run");
  await ensureReviewFacts(store, state);
  const prompt = state.reviewPrompt ?? buildReviewPrompt(state);
  if (
    options.promptId !== prompt.promptId ||
    options.approval.promptId !== prompt.promptId
  )
    throw new Error("Review prompt is stale");
  if (options.expectedBaseCommit !== prompt.baseCommit)
    throw new Error("Review base commit does not match");
  const approval = ApprovalContextSchema.parse(options.approval);
  const selectionSource =
    options.selection === "recommended" || options.selection === "champion"
      ? options.selection
      : "contestant";
  const selected =
    options.decision === "reject"
      ? undefined
      : options.selection === "recommended"
        ? state.patchRecommendation?.contestantId
        : options.selection === "champion"
          ? state.arenaOutcome
            ? state.arenaOutcome.championId
            : state.ranking?.winner
          : options.selection;
  const choice = selected
    ? prompt.choices.find((candidate) => candidate.contestantId === selected)
    : undefined;
  if (options.decision === "accept" && (!choice || !choice.eligible))
    throw new Error("Selected patch is missing or ineligible");
  if (
    choice &&
    options.expectedPatchSha256 !== undefined &&
    options.expectedPatchSha256 !== choice.patchSha256
  )
    throw new Error("Selected patch digest does not match");
  const payloadHash = hashValue(
    JSON.stringify({
      promptId: options.promptId,
      decision: options.decision,
      selected,
      patchSha256: choice?.patchSha256,
      baseCommit: options.expectedBaseCommit,
    }),
  );
  const replay = await readOperation(store, options.idempotencyKey);
  if (replay) {
    if (replay.payloadHash !== payloadHash)
      throw new Error("Idempotency key was already used with another payload");
    return ReviewDecisionSchema.parse(replay.result);
  }
  const verified = await (
    options.verifier ?? new DirectApprovalVerifier()
  ).verify(approval, choice?.patchSha256);
  const decisionId = stableId(
    "decision",
    state.runId,
    prompt.promptId,
    options.idempotencyKey,
  );
  const parentDecision = await readCurrentReview(store);
  const decidedAt = (options.now ?? new Date()).toISOString();
  const decision = ReviewDecisionSchema.parse({
    version: 1,
    decisionId,
    ...(parentDecision && parentDecision.decisionId !== decisionId
      ? { parentDecisionId: parentDecision.decisionId }
      : {}),
    runId: state.runId,
    promptId: prompt.promptId,
    status: options.decision === "accept" ? "accepted" : "rejected",
    ...(selected ? { selectedContestantId: selected } : {}),
    ...(selected ? { selectionSource } : {}),
    ...(choice ? { patchSha256: choice.patchSha256 } : {}),
    ...(selected ? { baseCommit: prompt.baseCommit } : {}),
    channel: approval.channel,
    ...(verified.actorRef ? { actorRef: verified.actorRef } : {}),
    ...(approval.conversationRef
      ? { conversationRef: approval.conversationRef }
      : {}),
    ...(approval.userMessageRef
      ? { userMessageRef: approval.userMessageRef }
      : {}),
    attestationHash: hashValue(`${verified.attestationHash}\0${payloadHash}`),
    idempotencyKeyHash: hashValue(options.idempotencyKey),
    decidedAt,
  });
  await store.writeImmutableJson(
    `reviews/${decision.decisionId}.json`,
    decision,
  );
  await store.writeImmutableJson(
    `operations/${decision.idempotencyKeyHash}.json`,
    {
      version: 1,
      operationId: decision.decisionId,
      kind: "review_decision",
      runId: state.runId,
      idempotencyKeyHash: decision.idempotencyKeyHash,
      payloadHash,
      result: decision,
      createdAt: decidedAt,
    },
  );
  return decision;
}

export async function currentReviewDecision(
  options: RunLocation,
): Promise<ReviewDecision | undefined> {
  const { store } = await openRun(options);
  return readCurrentReview(store);
}

export async function trustedPatchPath(
  state: RunState,
  contestantId: ContestantId,
  expectedRunDirectory = state.artifacts.runDirectory ?? "",
): Promise<string> {
  const patchPath = state.contestants[contestantId]?.finalPatchPath;
  if (!patchPath) throw new Error(`Run has no final patch for ${contestantId}`);
  const expectedRoot = await realpath(expectedRunDirectory);
  const resolved = await realpath(path.resolve(patchPath));
  if (!resolved.startsWith(`${expectedRoot}${path.sep}`))
    throw new Error("Result patch path is outside the trusted run directory");
  return resolved;
}

export async function patchSha256(patchPath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(patchPath))
    .digest("hex");
}
