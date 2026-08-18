import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/store.js";
import {
  calculateReplayHash,
  calculateSnapshotHash,
  RoundReplaySchema,
  RoundResultSchema,
  RoundSnapshotSchema,
  type RoundResult,
} from "../../src/contracts/round.js";
import { projectRoundStateDelta } from "../../src/core/round-state-delta.js";
import {
  appendRecoveryEvent,
  readRecoveryEvents,
} from "../../src/recovery/events.js";
import {
  applyEnvelopeExactlyOnce,
  calculateEnvelopeHash,
  readEnvelopeChain,
  sealRoundEnvelope,
  writeBaseline,
  writeCheckpoint,
  writeFinalizationRecord,
} from "../../src/recovery/durable.js";
import { makeRunState } from "../helpers/run-state.js";

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-durable-"));
  const store = new ArtifactStore(root, "run-12345678", { durableV5: true });
  await store.initialize();
  const before = makeRunState({
    runDirectory: store.runDirectory,
    repositoryRoot: root,
  });
  before.status = "running";
  before.stage = "preflight";
  before.completedAt = undefined;
  before.currentRound = undefined;
  before.warnings = [];
  for (const contestant of Object.values(before.contestants)) {
    contestant.rounds = [];
    contestant.checks = [];
    contestant.healthEvents = [];
    contestant.finalHealth = 100;
    contestant.status = "survived";
  }
  await store.writeText("patches/a.diff", "a patch\n");
  await store.writeText("patches/b.diff", "b patch\n");
  const after = structuredClone(before);
  after.stage = "validate_repairs";
  after.currentRound = 1;
  after.updatedAt = "2026-08-08T01:00:00.000Z";
  after.warnings.push("sealed warning");
  const delta = projectRoundStateDelta(before, after, 1);
  const snapshotDraft = {
    version: 4 as const,
    runId: before.runId,
    roundId: 1 as const,
    snapshotHash: "0".repeat(64),
    runSpec: {
      version: 1 as const,
      runId: before.runId,
      task: {
        task: "fixture task",
        acceptanceCriteria: [],
        sources: [
          {
            id: "task",
            kind: "user_task" as const,
            origin: "fixture",
            retrievedAt: "2026-08-08T00:00:00.000Z",
            contentHash: "1".repeat(64),
            snapshotPath: store.resolve("sources/task.md"),
          },
        ],
        createdAt: "2026-08-08T00:00:00.000Z",
      },
      baseCommit: before.config.baseCommit,
      topology: {
        mode: "duel" as const,
        contestants: [
          {
            id: "a" as const,
            provider: "codex",
            role: "solver" as const,
            startingPatch: "none" as const,
          },
          {
            id: "b" as const,
            provider: "claude",
            role: "solver" as const,
            startingPatch: "none" as const,
          },
        ],
      },
      commands: [
        {
          id: "required",
          kind: "required" as const,
          command: "npm test",
          timeoutMs: 1000,
          required: true,
        },
      ],
      budgets: {
        implementationMs: 1000,
        reviewMs: 1000,
        attackMs: 1000,
        verifierMs: 1000,
        repairMs: 1000,
      },
      permissions: {
        mode: "confirm" as const,
        reducedValidationAccepted: false,
        capabilities: [],
      },
      contentHash: "2".repeat(64),
    },
    contestants: (["a", "b"] as const).map((contestantId) => ({
      contestantId,
      patch: {
        path: store.resolve(`patches/${contestantId}.diff`),
        sha256: sha256(`${contestantId} patch\n`),
      },
      health: 100,
      permanentRecoil: 0,
      activeDefects: [],
      status: "active" as const,
    })),
    knownDefects: [],
    failureRecords: [],
    priorReplayHash: null,
  };
  snapshotDraft.snapshotHash = calculateSnapshotHash(snapshotDraft);
  const snapshot = RoundSnapshotSchema.parse(snapshotDraft);
  await store.writeImmutableJson("rounds/1/snapshot.json", snapshot);
  const deltaPath = await store.writeImmutableJson(
    "rounds/1/state-delta.json",
    delta,
  );
  const deltaBytes = await readFile(deltaPath);
  const deltaArtifact = {
    id: "delta-1",
    kind: "round_state_delta" as const,
    path: deltaPath,
    sha256: sha256(deltaBytes),
  };
  const replayDraft = {
    version: 4 as const,
    runId: before.runId,
    roundId: 1 as const,
    snapshotHash: snapshot.snapshotHash,
    priorReplayHash: null,
    invocations: [],
    attacks: [],
    checks: [],
    repairs: [],
    scoreEvents: [],
    diagnostics: [],
    failureRecords: [],
    artifacts: [deltaArtifact],
    stateDeltaArtifactId: deltaArtifact.id,
    replayHash: "0".repeat(64),
  };
  replayDraft.replayHash = calculateReplayHash(replayDraft);
  const replay = RoundReplaySchema.parse(replayDraft);
  const contestants = (["a", "b"] as const).map((contestantId) => ({
    contestantId,
    patch: {
      path: store.resolve(`patches/${contestantId}.diff`),
      sha256: sha256(`${contestantId} patch\n`),
    },
    health: 100,
    permanentRecoil: 0,
    activeDefects: [],
    status: "active" as const,
  }));
  const resultFor = (status: RoundResult["status"]): RoundResult => {
    const diagnostic = {
      code: `round-${status}`,
      severity: "error" as const,
      message: status,
      artifactIds: [],
    };
    const exceptionalReplayDraft = {
      ...replay,
      diagnostics: [diagnostic],
      replayHash: "0".repeat(64),
    };
    exceptionalReplayDraft.replayHash = calculateReplayHash(
      exceptionalReplayDraft,
    );
    const exceptionalReplay = RoundReplaySchema.parse(exceptionalReplayDraft);
    return RoundResultSchema.parse(
      status === "completed"
        ? {
            version: 4,
            status,
            runId: before.runId,
            roundId: 1,
            resultingContestants: contestants,
            failureRecords: [],
            replay,
          }
        : {
            version: 4,
            status,
            runId: before.runId,
            roundId: 1,
            resultingContestants: contestants,
            failureRecords: [],
            replay: exceptionalReplay,
            diagnostics: [diagnostic],
          },
    );
  };
  return { store, before, after, resultFor };
}

describe("durable round recovery", () => {
  it.each(["completed", "inconclusive", "cancelled", "failed"] as const)(
    "seals an immutable hashed %s envelope",
    async (status) => {
      const { store, resultFor } = await fixture();
      const envelope = await sealRoundEnvelope({
        store,
        result: resultFor(status),
        priorEnvelopeHash: null,
        now: new Date("2026-08-08T02:00:00.000Z"),
      });
      expect(envelope.result.status).toBe(status);
      expect(envelope.envelopeHash).toBe(calculateEnvelopeHash(envelope));
      expect(await readEnvelopeChain(store)).toEqual([envelope]);
    },
  );

  it("reads and applies completed pre-V4 durable envelopes", async () => {
    const { store, before, resultFor } = await fixture();
    const current = await sealRoundEnvelope({
      store,
      result: resultFor("completed"),
      priorEnvelopeHash: null,
    });

    const snapshot = JSON.parse(
      await readFile(store.resolve("rounds/1/snapshot.json"), "utf8"),
    ) as Record<string, unknown>;
    snapshot.version = 3;
    Reflect.deleteProperty(snapshot, "failureRecords");
    snapshot.reconciliationQueue = [];
    snapshot.contestants = (
      snapshot.contestants as Record<string, unknown>[]
    ).map((contestant) => ({ ...contestant, replacementCredits: [] }));
    snapshot.snapshotHash = calculateSnapshotHash(snapshot);
    await store.writeJson("rounds/1/snapshot.json", snapshot);

    const delta = JSON.parse(
      await readFile(store.resolve("rounds/1/state-delta.json"), "utf8"),
    ) as Record<string, unknown>;
    delta.version = 3;
    Reflect.deleteProperty(delta, "failureRecords");
    delta.harnessOverlays = [];
    delta.reconciliationQueue = [];
    const deltaText = `${JSON.stringify(delta, null, 2)}\n`;
    await store.writeText("rounds/1/state-delta.json", deltaText);

    const envelope = structuredClone(current) as unknown as Record<
      string,
      unknown
    >;
    envelope.version = 3;
    envelope.snapshotHash = snapshot.snapshotHash;
    const result = envelope.result as Record<string, unknown>;
    result.version = 3;
    result.reconciliationQueue = [];
    Reflect.deleteProperty(result, "failureRecords");
    result.resultingContestants = (
      result.resultingContestants as Record<string, unknown>[]
    ).map((contestant) => ({ ...contestant, replacementCredits: [] }));
    const replay = result.replay as Record<string, unknown>;
    replay.version = 3;
    replay.snapshotHash = snapshot.snapshotHash;
    replay.reconciliationQueue = [];
    Reflect.deleteProperty(replay, "failureRecords");
    const updateDeltaArtifact = (artifact: Record<string, unknown>) =>
      artifact.id === "delta-1"
        ? { ...artifact, sha256: sha256(deltaText) }
        : artifact;
    replay.artifacts = (replay.artifacts as Record<string, unknown>[]).map(
      updateDeltaArtifact,
    );
    replay.replayHash = calculateReplayHash(replay);
    envelope.replayHash = replay.replayHash;
    envelope.stateDelta = updateDeltaArtifact(
      envelope.stateDelta as Record<string, unknown>,
    );
    envelope.artifacts = (envelope.artifacts as Record<string, unknown>[]).map(
      updateDeltaArtifact,
    );
    envelope.envelopeHash = calculateEnvelopeHash(envelope);
    await store.writeJson("rounds/1/envelope.json", envelope);

    const [legacy] = await readEnvelopeChain(store);
    expect(legacy?.version).toBe(3);
    const state = structuredClone(before);
    const application = await applyEnvelopeExactlyOnce({
      store,
      state,
      envelope: legacy!,
      ledger: [],
    });
    expect(application.applied).toBe(true);
    expect(state.warnings).toEqual(["sealed warning"]);

    delta.roundId = "recovery";
    delta.coordinator = {
      ...(delta.coordinator as Record<string, unknown>),
      currentRound: "recovery",
    };
    const recoveryDeltaText = `${JSON.stringify(delta, null, 2)}\n`;
    await store.writeText("rounds/1/state-delta.json", recoveryDeltaText);
    const recoveryEnvelope = structuredClone(legacy) as unknown as Record<
      string,
      unknown
    >;
    recoveryEnvelope.roundId = "recovery";
    recoveryEnvelope.stateDelta = {
      ...(recoveryEnvelope.stateDelta as Record<string, unknown>),
      sha256: sha256(recoveryDeltaText),
    };
    const recoveryResult = recoveryEnvelope.result as Record<string, unknown>;
    recoveryResult.roundId = "recovery";
    (recoveryResult.replay as Record<string, unknown>).roundId = "recovery";
    const recoveryState = structuredClone(before);
    await expect(
      applyEnvelopeExactlyOnce({
        store,
        state: recoveryState,
        envelope: recoveryEnvelope as never,
        ledger: [],
      }),
    ).resolves.toMatchObject({ applied: true });
  });

  it("applies an envelope once, no-ops an identical replay, and rejects a conflict", async () => {
    const { store, before, resultFor } = await fixture();
    const envelope = await sealRoundEnvelope({
      store,
      result: resultFor("completed"),
      priorEnvelopeHash: null,
    });
    const state = structuredClone(before);
    const first = await applyEnvelopeExactlyOnce({
      store,
      state,
      envelope,
      ledger: [],
    });
    expect(first.applied).toBe(true);
    expect(state.warnings).toEqual(["sealed warning"]);
    const second = await applyEnvelopeExactlyOnce({
      store,
      state,
      envelope,
      ledger: first.ledger,
    });
    expect(second.applied).toBe(false);
    expect(state.warnings).toEqual(["sealed warning"]);
    await expect(
      applyEnvelopeExactlyOnce({
        store,
        state,
        envelope,
        ledger: [
          {
            ...first.ledger[0]!,
            envelopeHash: "f".repeat(64),
          },
        ],
      }),
    ).rejects.toThrow(/Conflicting applied envelope/);
  });

  it.each(["inconclusive", "cancelled", "failed"] as const)(
    "does not advance state for a sealed %s envelope",
    async (status) => {
      const { store, before, resultFor } = await fixture();
      const envelope = await sealRoundEnvelope({
        store,
        result: resultFor(status),
        priorEnvelopeHash: null,
      });
      const state = structuredClone(before);
      const application = await applyEnvelopeExactlyOnce({
        store,
        state,
        envelope,
        ledger: [],
      });
      expect(application).toEqual({ applied: false, ledger: [] });
      expect(state).toEqual(before);
    },
  );

  it("rebuilds a v8 result from its immutable baseline and applied envelopes", async () => {
    const { store, before, resultFor } = await fixture();
    await writeBaseline({
      store,
      state: before,
      repositoryIdentity: "owner/repository",
    });
    const envelope = await sealRoundEnvelope({
      store,
      result: resultFor("completed"),
      priorEnvelopeHash: null,
    });
    const applied = structuredClone(before);
    const application = await applyEnvelopeExactlyOnce({
      store,
      state: applied,
      envelope,
      ledger: [],
    });
    applied.ranking = {
      winner: "a",
      draw: false,
      order: ["a", "b"],
      reason: "final fixture ranking",
    };
    applied.contestants.a!.checks.push({
      id: "final-required",
      kind: "required",
      status: "passed",
    });
    await writeFinalizationRecord({
      store,
      state: applied,
      appliedEnvelopeHash: envelope.envelopeHash,
    });
    await store.writeState(applied, application.ledger);
    const summary = JSON.parse(
      await readFile(store.resolve("result.json"), "utf8"),
    ) as { schemaVersion: number; appliedEnvelopes: unknown[] };
    expect(summary.schemaVersion).toBe(8);
    expect(summary.appliedEnvelopes).toHaveLength(1);
    const rebuilt = await store.readState();
    expect(rebuilt.warnings).toEqual(["sealed warning"]);
    expect(rebuilt.currentRound).toBe(1);
    expect(rebuilt.ranking?.reason).toBe("final fixture ranking");
    expect(rebuilt.contestants.a?.checks.at(-1)?.id).toBe("final-required");
  });

  it("writes the same checkpoint when recovery repeats after state application", async () => {
    const { store, before, resultFor } = await fixture();
    const envelope = await sealRoundEnvelope({
      store,
      result: resultFor("completed"),
      priorEnvelopeHash: null,
      now: new Date("2026-08-08T01:00:00.000Z"),
    });
    const state = structuredClone(before);
    await applyEnvelopeExactlyOnce({ store, state, envelope, ledger: [] });
    const first = await writeCheckpoint({
      store,
      state,
      envelope,
      now: new Date("2026-08-08T02:00:00.000Z"),
    });
    const retried = await writeCheckpoint({
      store,
      state,
      envelope,
      now: new Date("2026-08-08T03:00:00.000Z"),
    });
    expect(retried).toEqual(first);
  });

  it("continues event sequence numbers after one torn trailing NDJSON record", async () => {
    const { store } = await fixture();
    await appendRecoveryEvent({ store, type: "resume_started" });
    await appendRecoveryEvent({ store, type: "drift_detected" });
    await appendFile(
      store.resolve("events/lifecycle.ndjson"),
      '{"torn":',
      "utf8",
    );
    expect(await readRecoveryEvents(store)).toHaveLength(2);
    const continued = await appendRecoveryEvent({
      store,
      type: "resume_continued",
    });
    expect(continued.sequence).toBe(3);
    expect(
      (await readRecoveryEvents(store)).map((event) => event.sequence),
    ).toEqual([1, 2, 3]);
  });

  it("rejects tampered round artifacts", async () => {
    const { store, resultFor } = await fixture();
    await sealRoundEnvelope({
      store,
      result: resultFor("completed"),
      priorEnvelopeHash: null,
    });
    await store.writeJson("rounds/1/state-delta.json", { tampered: true });
    await expect(readEnvelopeChain(store)).rejects.toThrow(
      /artifact hash mismatch/,
    );
  });
});
