import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  calculateCanonicalHash,
  calculateReplayHash,
  calculateSnapshotHash,
  canonicalJson,
  RoundSnapshotSchema,
  type RoundResult,
  RoundStateDeltaSchema,
} from "../contracts/round.js";
import type { ArtifactStore } from "../artifacts/store.js";
import { applyCompletedRound } from "../core/round-state-delta.js";
import {
  RunStateV4Schema,
  RunStateV5Schema,
  RunStateV6Schema,
  type CheckResult,
  type RunState,
} from "../core/types.js";
import {
  CheckpointDescriptorSchema,
  FinalizationRecordSchema,
  RoundEnvelopeSchema,
  RunBaselineSchema,
  RunSummaryV6Schema,
  RunSummaryV7Schema,
  type RunSummaryV5,
  type AppliedEnvelope,
  type CheckpointDescriptor,
  type FinalizationRecord,
  type RoundEnvelope,
  type RunBaseline,
  type RunSummaryV6,
  type RunSummaryV7,
} from "./contracts.js";

function hashWithout(value: object, field: string): string {
  const copy = { ...(value as Record<string, unknown>) };
  delete copy[field];
  return calculateCanonicalHash(copy);
}

export function calculateEnvelopeHash(value: object): string {
  return hashWithout(value, "envelopeHash");
}

export function calculateBaselineHash(value: object): string {
  return hashWithout(value, "baselineHash");
}

export function calculateCheckpointHash(value: object): string {
  return hashWithout(value, "checkpointHash");
}

export function calculateFinalizationHash(value: object): string {
  return hashWithout(value, "finalizationHash");
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readDurableArtifact(
  store: ArtifactStore,
  artifactPath: string,
): Promise<Buffer> {
  if (!path.isAbsolute(artifactPath))
    return readFile(store.resolve(artifactPath));
  const relative = path.relative(store.runDirectory, artifactPath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative))
    return readFile(store.resolve(relative));
  const marker = `${path.sep}${store.runId}${path.sep}`;
  const markerIndex = artifactPath.lastIndexOf(marker);
  if (markerIndex < 0)
    throw new Error("Durable artifact path is outside the run directory");
  return readFile(
    store.resolve(artifactPath.slice(markerIndex + marker.length)),
  );
}

export async function writeBaseline(options: {
  store: ArtifactStore;
  state: RunState;
  repositoryIdentity: string;
  now?: Date;
}): Promise<RunBaseline> {
  if (options.state.schemaVersion !== 5 && options.state.schemaVersion !== 6)
    throw new Error("Only v5/v6 runtime state can seed a durable baseline");
  const draft = {
    version: 1 as const,
    runId: options.state.runId,
    createdAt: (options.now ?? new Date()).toISOString(),
    repositoryIdentity: options.repositoryIdentity,
    baseCommit: options.state.config.baseCommit,
    runSpecHash: options.state.runSpecHash,
    state: JSON.parse(canonicalJson(options.state)) as unknown,
    baselineHash: "0".repeat(64),
  };
  draft.baselineHash = calculateBaselineHash(draft);
  const baseline = RunBaselineSchema.parse(draft);
  await options.store.writeImmutableJson("baseline.json", baseline);
  return baseline;
}

export async function readBaseline(store: ArtifactStore): Promise<RunBaseline> {
  const baseline = RunBaselineSchema.parse(
    JSON.parse(await readFile(store.resolve("baseline.json"), "utf8")),
  );
  if (baseline.baselineHash !== calculateBaselineHash(baseline))
    throw new Error("Durable baseline hash mismatch");
  return baseline;
}

export async function writeFinalizationRecord(options: {
  store: ArtifactStore;
  state: RunState;
  appliedEnvelopeHash: string;
  now?: Date;
}): Promise<FinalizationRecord> {
  const projection = JSON.parse(
    canonicalJson({
      ranking: options.state.ranking,
      arenaOutcome: options.state.arenaOutcome,
      patchQualityFacts: options.state.patchQualityFacts,
      patchQualityVerdict: options.state.patchQualityVerdict,
      patchRecommendation: options.state.patchRecommendation,
      reviewPrompt: options.state.reviewPrompt,
      coverageAssessment: options.state.coverageAssessment,
      contestants: Object.fromEntries(
        (["a", "b"] as const).map((contestantId) => {
          const contestant = options.state.contestants[contestantId];
          if (!contestant)
            throw new Error(`Missing contestant ${contestantId}`);
          return [
            contestantId,
            {
              checks: contestant.checks,
              finalPatchPath: contestant.finalPatchPath,
              status: contestant.status,
              finalHealth: contestant.finalHealth,
              patchSize: contestant.patchSize,
            },
          ];
        }),
      ),
    }),
  ) as unknown;
  const draft = {
    version: 1 as const,
    runId: options.state.runId,
    createdAt: (options.now ?? new Date()).toISOString(),
    appliedEnvelopeHash: options.appliedEnvelopeHash,
    projection,
    finalizationHash: "0".repeat(64),
  };
  draft.finalizationHash = calculateFinalizationHash(draft);
  const record = FinalizationRecordSchema.parse(draft);
  await options.store.writeImmutableJson("finalization.json", record);
  return record;
}

async function readFinalizationRecord(
  store: ArtifactStore,
): Promise<FinalizationRecord> {
  const record = FinalizationRecordSchema.parse(
    JSON.parse(await readFile(store.resolve("finalization.json"), "utf8")),
  );
  if (record.finalizationHash !== calculateFinalizationHash(record))
    throw new Error("Finalization record hash mismatch");
  return record;
}

export async function sealRoundEnvelope(options: {
  store: ArtifactStore;
  result: RoundResult;
  priorEnvelopeHash: string | null;
  now?: Date;
}): Promise<RoundEnvelope> {
  const delta = options.result.replay.artifacts.find(
    (artifact) => artifact.id === options.result.replay.stateDeltaArtifactId,
  );
  if (!delta || delta.kind !== "round_state_delta")
    throw new Error("Round result has no state-delta artifact");
  const deltaBytes = await readDurableArtifact(options.store, delta.path);
  if (sha256(deltaBytes) !== delta.sha256)
    throw new Error("Cannot seal a round with a corrupt state delta");
  const draft = {
    version: 3 as const,
    runId: options.result.runId,
    roundId: options.result.roundId,
    sealedAt: (options.now ?? new Date()).toISOString(),
    priorEnvelopeHash: options.priorEnvelopeHash,
    snapshotHash: options.result.replay.snapshotHash,
    replayHash: options.result.replay.replayHash,
    stateDelta: delta,
    artifacts: options.result.replay.artifacts,
    result: options.result,
    envelopeHash: "0".repeat(64),
  };
  draft.envelopeHash = calculateEnvelopeHash(draft);
  const envelope = RoundEnvelopeSchema.parse(draft);
  await options.store.writeImmutableJson(
    `rounds/${String(envelope.roundId)}/envelope.json`,
    envelope,
  );
  return envelope;
}

async function readEnvelopeAt(
  store: ArtifactStore,
  roundId: 1 | 2 | 3 | "recovery" | "reconciliation",
): Promise<RoundEnvelope | undefined> {
  try {
    const envelope = RoundEnvelopeSchema.parse(
      JSON.parse(
        await readFile(
          store.resolve(`rounds/${String(roundId)}/envelope.json`),
          "utf8",
        ),
      ),
    );
    if (envelope.envelopeHash !== calculateEnvelopeHash(envelope))
      throw new Error(`Round ${String(roundId)} envelope hash mismatch`);
    if (
      envelope.result.replay.replayHash !==
      calculateReplayHash(envelope.result.replay)
    )
      throw new Error(`Round ${String(roundId)} replay hash mismatch`);
    const snapshot = RoundSnapshotSchema.parse(
      JSON.parse(
        await readFile(
          store.resolve(`rounds/${String(roundId)}/snapshot.json`),
          "utf8",
        ),
      ),
    );
    if (
      snapshot.snapshotHash !== calculateSnapshotHash(snapshot) ||
      snapshot.snapshotHash !== envelope.snapshotHash ||
      snapshot.runId !== envelope.runId ||
      snapshot.roundId !== envelope.roundId
    )
      throw new Error(`Round ${String(roundId)} snapshot hash mismatch`);
    for (const artifact of envelope.artifacts) {
      const bytes = await readDurableArtifact(store, artifact.path);
      if (sha256(bytes) !== artifact.sha256)
        throw new Error(
          `Round ${String(roundId)} artifact hash mismatch: ${artifact.id}`,
        );
    }
    return envelope;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readEnvelopeChain(
  store: ArtifactStore,
): Promise<RoundEnvelope[]> {
  const envelopes: RoundEnvelope[] = [];
  let missingEarlier = false;
  for (const roundId of [1, 2, 3, "recovery", "reconciliation"] as const) {
    const envelope = await readEnvelopeAt(store, roundId);
    if (!envelope) {
      // Normal rounds are contiguous authority. Recovery is optional, so a
      // reconciliation envelope may legitimately follow round 3 directly.
      if (typeof roundId === "number") missingEarlier = true;
      continue;
    }
    if (missingEarlier)
      throw new Error(`Broken envelope chain before round ${String(roundId)}`);
    const previous = envelopes.at(-1);
    if (envelope.priorEnvelopeHash !== (previous?.envelopeHash ?? null))
      throw new Error(
        `Broken envelope digest chain at round ${String(roundId)}`,
      );
    if (envelope.runId !== store.runId)
      throw new Error("Envelope run identity mismatch");
    if (
      envelope.result.replay.priorReplayHash !== (previous?.replayHash ?? null)
    )
      throw new Error(`Broken replay digest chain at round ${String(roundId)}`);
    envelopes.push(envelope);
    if (envelope.result.status !== "completed") break;
  }
  return envelopes;
}

function envelopeMatchesLedger(
  ledger: AppliedEnvelope,
  envelope: RoundEnvelope,
): boolean {
  return (
    ledger.roundId === envelope.roundId &&
    ledger.snapshotHash === envelope.snapshotHash &&
    ledger.replayHash === envelope.replayHash &&
    ledger.envelopeHash === envelope.envelopeHash
  );
}

export async function applyEnvelopeExactlyOnce(options: {
  store: ArtifactStore;
  state: RunState;
  envelope: RoundEnvelope;
  ledger: readonly AppliedEnvelope[];
}): Promise<{ applied: boolean; ledger: AppliedEnvelope[] }> {
  const existing = options.ledger.find(
    (entry) => entry.roundId === options.envelope.roundId,
  );
  if (existing) {
    if (!envelopeMatchesLedger(existing, options.envelope))
      throw new Error(
        `Conflicting applied envelope for round ${String(options.envelope.roundId)}`,
      );
    return { applied: false, ledger: [...options.ledger] };
  }
  if (options.envelope.result.status !== "completed")
    return { applied: false, ledger: [...options.ledger] };
  const expectedPrevious = options.ledger.at(-1);
  if (
    options.envelope.priorEnvelopeHash !==
    (expectedPrevious?.envelopeHash ?? null)
  )
    throw new Error("Cannot apply an out-of-order round envelope");
  const deltaBytes = await readDurableArtifact(
    options.store,
    options.envelope.stateDelta.path,
  );
  if (sha256(deltaBytes) !== options.envelope.stateDelta.sha256)
    throw new Error("Round-state delta artifact is corrupt");
  const delta = RoundStateDeltaSchema.parse(
    JSON.parse(deltaBytes.toString("utf8")) as unknown,
  );
  applyCompletedRound(options.state, options.envelope.result, delta);
  return {
    applied: true,
    ledger: [
      ...options.ledger,
      {
        roundId: options.envelope.roundId,
        snapshotHash: options.envelope.snapshotHash,
        replayHash: options.envelope.replayHash,
        envelopeHash: options.envelope.envelopeHash,
      },
    ],
  };
}

export async function reconstructRunState(options: {
  store: ArtifactStore;
  summary: RunSummaryV5 | RunSummaryV6 | RunSummaryV7;
}): Promise<RunState> {
  const baseline = await readBaseline(options.store);
  if (options.summary.baseline) {
    const baselineBytes = await readFile(
      options.store.resolve("baseline.json"),
    );
    if (sha256(baselineBytes) !== options.summary.baseline.sha256)
      throw new Error("result.json baseline pointer hash mismatch");
  }
  if (baseline.runId !== options.summary.runId)
    throw new Error("Baseline run identity mismatch");
  const baselineState = structuredClone(baseline.state) as {
    schemaVersion?: unknown;
  };
  const state =
    baselineState.schemaVersion === 4
      ? RunStateV4Schema.parse(baselineState)
      : baselineState.schemaVersion === 5
        ? RunStateV5Schema.parse(baselineState)
        : RunStateV6Schema.parse(baselineState);
  let ledger: AppliedEnvelope[] = [];
  const envelopes = await readEnvelopeChain(options.store);
  for (const [index, expected] of options.summary.appliedEnvelopes.entries()) {
    const envelope = envelopes[index];
    if (!envelope || !envelopeMatchesLedger(expected, envelope))
      throw new Error(
        "result.json applied-envelope ledger conflicts with history",
      );
    const application = await applyEnvelopeExactlyOnce({
      store: options.store,
      state,
      envelope,
      ledger,
    });
    ledger = application.ledger;
  }
  if (ledger.length !== options.summary.appliedEnvelopes.length)
    throw new Error(
      "result.json applied-envelope ledger conflicts with history",
    );

  state.status = options.summary.status;
  state.stage = options.summary.stage as RunState["stage"];
  if (options.summary.currentRound !== undefined)
    state.currentRound = options.summary.currentRound;
  state.updatedAt = options.summary.updatedAt;
  if (options.summary.completedAt)
    state.completedAt = options.summary.completedAt;
  state.warnings = [...options.summary.warnings];
  state.artifacts = { ...options.summary.artifacts };
  if (options.summary.outcome)
    state.arenaOutcome = options.summary.outcome as never;
  if (options.summary.recommendation)
    state.patchRecommendation = options.summary.recommendation as never;
  if (options.summary.coverageAssessment)
    state.coverageAssessment = options.summary.coverageAssessment as never;
  if (options.summary.coverageDecision)
    state.coverageDecision = options.summary.coverageDecision as never;
  for (const compact of options.summary.contestants) {
    const contestant = state.contestants[compact.id];
    if (!contestant) continue;
    contestant.status = compact.status as typeof contestant.status;
    contestant.finalHealth = compact.health;
    if (compact.patchPath) contestant.finalPatchPath = compact.patchPath;
  }
  if (options.summary.finalization) {
    const bytes = await readFile(options.store.resolve("finalization.json"));
    if (sha256(bytes) !== options.summary.finalization.sha256)
      throw new Error("result.json finalization pointer hash mismatch");
    const finalization = await readFinalizationRecord(options.store);
    if (finalization.runId !== state.runId)
      throw new Error("Finalization run identity mismatch");
    if (
      finalization.appliedEnvelopeHash !==
      options.summary.appliedEnvelopes.at(-1)?.envelopeHash
    )
      throw new Error("Finalization does not match the applied envelope head");
    const projection = finalization.projection as {
      ranking?: RunState["ranking"];
      arenaOutcome?: RunState["arenaOutcome"];
      patchQualityFacts?: RunState["patchQualityFacts"];
      patchQualityVerdict?: RunState["patchQualityVerdict"];
      patchRecommendation?: RunState["patchRecommendation"];
      reviewPrompt?: RunState["reviewPrompt"];
      coverageAssessment?: RunState["coverageAssessment"];
      contestants?: Record<
        "a" | "b",
        {
          checks: CheckResult[];
          finalPatchPath?: string;
          status: string;
          finalHealth: number;
          patchSize: number;
        }
      >;
    };
    if (projection.ranking) state.ranking = projection.ranking;
    if (projection.arenaOutcome) state.arenaOutcome = projection.arenaOutcome;
    if (projection.patchQualityFacts)
      state.patchQualityFacts = projection.patchQualityFacts;
    if (projection.patchQualityVerdict)
      state.patchQualityVerdict = projection.patchQualityVerdict;
    if (projection.patchRecommendation)
      state.patchRecommendation = projection.patchRecommendation;
    if (projection.reviewPrompt) state.reviewPrompt = projection.reviewPrompt;
    if (projection.coverageAssessment)
      state.coverageAssessment = projection.coverageAssessment;
    for (const contestantId of ["a", "b"] as const) {
      const compact = projection.contestants?.[contestantId];
      const contestant = state.contestants[contestantId];
      if (!compact || !contestant) continue;
      contestant.checks = compact.checks;
      contestant.status = compact.status as typeof contestant.status;
      contestant.finalHealth = compact.finalHealth;
      contestant.patchSize = compact.patchSize;
      if (compact.finalPatchPath)
        contestant.finalPatchPath = compact.finalPatchPath;
    }
  }
  const previousRunDirectory = state.artifacts.runDirectory;
  if (
    previousRunDirectory &&
    previousRunDirectory !== options.store.runDirectory
  ) {
    const relocate = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(relocate);
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const [key, entry] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (
          typeof entry === "string" &&
          (entry === previousRunDirectory ||
            entry.startsWith(`${previousRunDirectory}${path.sep}`))
        ) {
          (value as Record<string, unknown>)[key] =
            `${options.store.runDirectory}${entry.slice(previousRunDirectory.length)}`;
        } else {
          relocate(entry);
        }
      }
    };
    relocate(state);
  }
  return state.schemaVersion === 4
    ? RunStateV4Schema.parse(state)
    : state.schemaVersion === 5
      ? RunStateV5Schema.parse(state)
      : RunStateV6Schema.parse(state);
}

export async function buildRunSummary(options: {
  store: ArtifactStore;
  state: RunState;
  appliedEnvelopes: readonly AppliedEnvelope[];
  provenance?: RunSummaryV7["provenance"];
}): Promise<RunSummaryV6 | RunSummaryV7> {
  if (options.state.schemaVersion !== 5 && options.state.schemaVersion !== 6)
    throw new Error(
      "Only v5/v6 runtime state may be written as a durable summary",
    );
  const baselinePath = options.store.resolve("baseline.json");
  let baseline: { path: string; sha256: string } | undefined;
  try {
    const bytes = await readFile(baselinePath);
    baseline = { path: baselinePath, sha256: sha256(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const finalizationPath = options.store.resolve("finalization.json");
  let finalization: { path: string; sha256: string } | undefined;
  try {
    const bytes = await readFile(finalizationPath);
    finalization = { path: finalizationPath, sha256: sha256(bytes) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const contestants = await Promise.all(
    (["a", "b"] as const).map(async (id) => {
      const contestant = options.state.contestants[id];
      if (!contestant) throw new Error(`Missing contestant ${id}`);
      const patchPath =
        contestant.finalPatchPath ?? contestant.currentPatchPath;
      let patchSha256: string | undefined;
      if (patchPath) {
        try {
          patchSha256 = sha256(await readFile(patchPath));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return {
        id,
        provider: contestant.provider,
        role: contestant.role,
        status: contestant.status,
        health: contestant.finalHealth,
        ...(patchPath ? { patchPath } : {}),
        ...(patchSha256 ? { patchSha256 } : {}),
      };
    }),
  );
  const schemaVersion = options.state.schemaVersion === 6 ? 7 : 6;
  const summary = {
    schemaVersion,
    runId: options.state.runId,
    harnessVersion: options.state.harnessVersion,
    status: options.state.status,
    stage: options.state.stage,
    ...(options.state.currentRound !== undefined
      ? { currentRound: options.state.currentRound }
      : {}),
    startedAt: options.state.startedAt,
    updatedAt: options.state.updatedAt,
    ...(options.state.completedAt
      ? { completedAt: options.state.completedAt }
      : {}),
    runSpecHash: options.state.runSpecHash,
    ...(baseline ? { baseline } : {}),
    ...(finalization ? { finalization } : {}),
    contestants,
    ...(options.state.arenaOutcome
      ? { outcome: options.state.arenaOutcome }
      : {}),
    ...(options.state.patchRecommendation
      ? { recommendation: options.state.patchRecommendation }
      : {}),
    ...(options.state.coverageAssessment
      ? { coverageAssessment: options.state.coverageAssessment }
      : {}),
    ...(options.state.coverageDecision
      ? { coverageDecision: options.state.coverageDecision }
      : {}),
    warnings: options.state.warnings,
    artifacts: options.state.artifacts,
    appliedEnvelopes: options.appliedEnvelopes,
    provenance: options.provenance ?? {
      assisted: false,
      competitivelyComparable: true,
      driftApprovalHashes: [],
    },
  };
  return schemaVersion === 7
    ? RunSummaryV7Schema.parse(summary)
    : RunSummaryV6Schema.parse(summary);
}

export async function writeCheckpoint(options: {
  store: ArtifactStore;
  state: RunState;
  envelope: RoundEnvelope;
  now?: Date;
}): Promise<CheckpointDescriptor> {
  const stateProjection = {
    stage: options.state.stage,
    ...(options.state.currentRound !== undefined
      ? { currentRound: options.state.currentRound }
      : {}),
    contestants: (["a", "b"] as const).map((contestantId) => {
      const contestant = options.state.contestants[contestantId];
      if (!contestant) throw new Error(`Missing contestant ${contestantId}`);
      return {
        contestantId,
        status: contestant.status,
        health: contestant.finalHealth,
        permanentRecoil: contestant.healthLedger.permanentRecoil,
        activeDefects: contestant.healthLedger.activeDefects,
        replacementCredits: contestant.replacementCredits,
        patch: path.basename(
          contestant.currentPatchPath ?? contestant.finalPatchPath ?? "none",
        ),
      };
    }),
    attacks: options.state.attacks.map((attack) => ({
      id: attack.id,
      status: attack.status,
      rootDefectId: attack.rootDefectId,
      targets: attack.targets,
    })),
  };
  const draft = {
    version: 1 as const,
    runId: options.state.runId,
    roundId: options.envelope.roundId,
    envelopeHash: options.envelope.envelopeHash,
    snapshotHash: options.envelope.snapshotHash,
    replayHash: options.envelope.replayHash,
    stateHash: calculateCanonicalHash(stateProjection),
    createdAt: options.envelope.sealedAt,
    checkpointHash: "0".repeat(64),
  };
  draft.checkpointHash = calculateCheckpointHash(draft);
  const descriptor = CheckpointDescriptorSchema.parse(draft);
  await options.store.writeImmutableJson(
    `checkpoints/${String(descriptor.roundId)}.json`,
    descriptor,
  );
  return descriptor;
}
