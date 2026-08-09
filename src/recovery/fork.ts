import { readFile } from "node:fs/promises";
import path from "node:path";
import { ArtifactStore } from "../artifacts/store.js";
import {
  calculateCanonicalHash,
  RunSpecSchema,
  type RunSpec,
} from "../contracts/round.js";
import type { RunState } from "../core/types.js";
import { calculateRunSpecHash } from "../task/task-contract.js";
import {
  CheckpointDescriptorSchema,
  ForkSpecSchema,
  type ForkSpec,
} from "./contracts.js";

function hashWithout(value: object, field: string): string {
  const copy = { ...(value as Record<string, unknown>) };
  delete copy[field];
  return calculateCanonicalHash(copy);
}

export async function createForkContract(options: {
  parentStore: ArtifactStore;
  parentState: RunState;
  checkpointRound: 1 | 2 | 3 | "recovery" | "reconciliation";
  newRunId: string;
  artifactRoot?: string;
  steering?: { a?: string[]; b?: string[] };
  configuration?: Record<string, unknown>;
  newRunSpec?: RunSpec;
  now?: Date;
}): Promise<{ fork: ForkSpec; store: ArtifactStore }> {
  const checkpoint = CheckpointDescriptorSchema.parse(
    JSON.parse(
      await readFile(
        options.parentStore.resolve(
          `checkpoints/${String(options.checkpointRound)}.json`,
        ),
        "utf8",
      ),
    ),
  );
  const taskChanged = options.newRunSpec !== undefined;
  if (options.newRunSpec) {
    const spec = RunSpecSchema.parse(options.newRunSpec);
    if (spec.runId !== options.newRunId)
      throw new Error("A forked RunSpec must use the new run ID");
    const { contentHash, ...body } = spec;
    if (contentHash !== calculateRunSpecHash(body))
      throw new Error("A task-changing fork requires a newly hashed RunSpec");
  }
  const suppliedA = options.steering?.a;
  const suppliedB = options.steering?.b;
  const steering = {
    a: suppliedA ?? suppliedB ?? [],
    b: suppliedB ?? suppliedA ?? [],
  };
  const asymmetric =
    calculateCanonicalHash(steering.a) !== calculateCanonicalHash(steering.b);
  const configuration = options.configuration ?? {};
  const assisted =
    steering.a.length > 0 ||
    steering.b.length > 0 ||
    Object.keys(configuration).length > 0;
  const draft = {
    version: 1 as const,
    runId: options.newRunId,
    parentRunId: options.parentState.runId,
    parentCheckpointHash: checkpoint.checkpointHash,
    createdAt: (options.now ?? new Date()).toISOString(),
    intervention: {
      taskChanged,
      steering,
      configuration,
    },
    assisted,
    competitivelyComparable: !taskChanged && !asymmetric,
    forkHash: "0".repeat(64),
  };
  draft.forkHash = hashWithout(draft, "forkHash");
  const fork = ForkSpecSchema.parse(draft);
  const artifactRoot =
    options.artifactRoot ?? path.dirname(options.parentStore.runDirectory);
  const store = new ArtifactStore(artifactRoot, options.newRunId);
  await store.initialize();
  await store.writeImmutableJson("fork-spec.json", fork);
  await store.writeImmutableJson("inherited-checkpoint.json", checkpoint);
  await store.writeImmutableJson("inherited-state.json", {
    version: 1,
    parentRunId: options.parentState.runId,
    parentCheckpointHash: checkpoint.checkpointHash,
    contestants: (["a", "b"] as const).map((contestantId) => {
      const contestant = options.parentState.contestants[contestantId];
      if (!contestant) throw new Error(`Missing contestant ${contestantId}`);
      return {
        contestantId,
        health: contestant.finalHealth,
        status: contestant.status,
        patchPath: contestant.currentPatchPath ?? contestant.finalPatchPath,
        permanentRecoil: contestant.healthLedger.permanentRecoil,
        activeDefects: contestant.healthLedger.activeDefects,
      };
    }),
  });
  if (options.newRunSpec)
    await store.writeImmutableJson("run-spec.json", options.newRunSpec);
  return { fork, store };
}
