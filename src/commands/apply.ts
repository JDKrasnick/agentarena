import { readFile } from "node:fs/promises";
import { execa } from "execa";
import { z } from "zod";
import { stableId } from "../core/ids.js";
import {
  assertCleanRepository,
  changedPathsFromPatch,
  resolveCommit,
  resolveRepositoryRoot,
} from "../repo/git.js";
import {
  reviewRun,
  openRun,
  patchSha256,
  trustedPatchPath,
} from "../review/service.js";
import {
  hashValue,
  readCurrentReview,
  readOperation,
} from "../review/store.js";

export const ApplyResultSchema = z.object({
  operationId: z.string(),
  runId: z.string(),
  contestantId: z.string(),
  patchSha256: z.string().length(64),
  changedPaths: z.array(z.string()),
  appliedAt: z.string().datetime(),
  testCommand: z.string(),
  idempotentReplay: z.boolean(),
});
export type ApplyResult = z.infer<typeof ApplyResultSchema>;

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await execa("git", args, { cwd, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
}

async function exactPatchAlreadyApplied(
  repositoryRoot: string,
  patchPath: string,
  changedPaths: string[],
): Promise<boolean> {
  const reverse = await execa(
    "git",
    ["apply", "--reverse", "--check", patchPath],
    { cwd: repositoryRoot, reject: false },
  );
  if (reverse.exitCode !== 0) return false;
  const status = await execa("git", ["status", "--porcelain"], {
    cwd: repositoryRoot,
  });
  const dirtyPaths = status.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").at(-1) ?? "")
    .sort();
  return (
    dirtyPaths.length === changedPaths.length &&
    dirtyPaths.every(
      (entry, index) => entry === [...changedPaths].sort()[index],
    )
  );
}

export async function applyPatchGuarded(options: {
  repositoryRoot: string;
  patchPath: string;
  forceDirty?: boolean;
}): Promise<string[]> {
  if (!options.forceDirty) await assertCleanRepository(options.repositoryRoot);
  const patch = await readFile(options.patchPath, "utf8");
  await git(options.repositoryRoot, ["apply", "--check", options.patchPath]);
  await git(options.repositoryRoot, ["apply", options.patchPath]);
  return changedPathsFromPatch(patch);
}

export async function applyAcceptedPatch(options: {
  runId: string;
  repositoryRoot?: string;
  artifactRoot?: string;
  expectedPatchSha256?: string;
  idempotencyKey: string;
  forceDirty?: boolean;
  now?: Date;
}): Promise<ApplyResult> {
  const repositoryRoot = await resolveRepositoryRoot(
    options.repositoryRoot ?? process.cwd(),
  );
  const { store, state } = await openRun({
    runId: options.runId,
    repositoryRoot,
    ...(options.artifactRoot ? { artifactRoot: options.artifactRoot } : {}),
  });
  const payloadHash = hashValue(
    JSON.stringify({
      runId: options.runId,
      expectedPatchSha256: options.expectedPatchSha256,
      repositoryRoot,
    }),
  );
  const replay = await readOperation(store, options.idempotencyKey);
  if (replay) {
    if (replay.payloadHash !== payloadHash)
      throw new Error("Idempotency key was already used with another payload");
    const prior = ApplyResultSchema.parse(replay.result);
    return { ...prior, idempotentReplay: true };
  }
  if (state.config.repositoryRoot !== repositoryRoot)
    throw new Error("Run belongs to a different repository");
  const prompt = await reviewRun({
    runId: options.runId,
    repositoryRoot,
    ...(options.artifactRoot ? { artifactRoot: options.artifactRoot } : {}),
  });
  const decision = await readCurrentReview(store);
  if (!decision || decision.status !== "accepted")
    throw new Error("Run has no accepted review decision");
  if (
    decision.promptId !== prompt.promptId ||
    !decision.selectedContestantId ||
    !decision.patchSha256 ||
    decision.baseCommit !== prompt.baseCommit
  )
    throw new Error("Accepted review decision is stale");
  const choice = prompt.choices.find(
    (candidate) =>
      candidate.contestantId === decision.selectedContestantId &&
      candidate.eligible,
  );
  if (!choice || choice.patchSha256 !== decision.patchSha256)
    throw new Error(
      "Accepted review decision no longer matches an eligible patch",
    );
  if (
    options.expectedPatchSha256 &&
    options.expectedPatchSha256 !== decision.patchSha256
  )
    throw new Error("Expected patch digest does not match the acceptance");
  const patchPath = await trustedPatchPath(
    state,
    decision.selectedContestantId,
    store.runDirectory,
  );
  if ((await patchSha256(patchPath)) !== decision.patchSha256)
    throw new Error("Accepted patch digest has changed");
  const currentCommit = await resolveCommit(repositoryRoot);
  if (currentCommit !== decision.baseCommit) {
    throw new Error(
      `Current HEAD ${currentCommit} does not match accepted base ${decision.baseCommit}`,
    );
  }
  const patch = await readFile(patchPath, "utf8");
  const expectedChangedPaths = changedPathsFromPatch(patch);
  const alreadyApplied = await exactPatchAlreadyApplied(
    repositoryRoot,
    patchPath,
    expectedChangedPaths,
  );
  const changedPaths = alreadyApplied
    ? expectedChangedPaths
    : await applyPatchGuarded({
        repositoryRoot,
        patchPath,
        forceDirty: options.forceDirty ?? false,
      });
  const appliedAt = (options.now ?? new Date()).toISOString();
  const result = ApplyResultSchema.parse({
    operationId: stableId(
      "apply",
      state.runId,
      decision.patchSha256,
      options.idempotencyKey,
    ),
    runId: state.runId,
    contestantId: decision.selectedContestantId,
    patchSha256: decision.patchSha256,
    changedPaths,
    appliedAt,
    testCommand: state.config.testCommand,
    idempotentReplay: alreadyApplied,
  });
  const keyHash = hashValue(options.idempotencyKey);
  await store.writeImmutableJson(`delivery/events/${result.operationId}.json`, {
    version: 1,
    eventId: result.operationId,
    runId: state.runId,
    patchSha256: decision.patchSha256,
    idempotencyKeyHash: keyHash,
    timestamp: appliedAt,
    stage: "apply_local",
    status: "completed",
    evidence: { changedPaths },
  });
  await store.writeImmutableJson(`operations/${keyHash}.json`, {
    version: 1,
    operationId: result.operationId,
    kind: "apply_local",
    runId: state.runId,
    idempotencyKeyHash: keyHash,
    payloadHash,
    result,
    createdAt: appliedAt,
  });
  return result;
}

export const applyResult = applyAcceptedPatch;
