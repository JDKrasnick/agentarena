import { describe, expect, it } from "vitest";
import {
  calculateReplayHash,
  calculateSnapshotHash,
  type RoundResult,
  type RoundSnapshot,
  validateRoundSnapshot,
} from "../../src/contracts/round.js";
import { RoundEngine } from "../../src/core/round-engine.js";

const HASH = "a".repeat(64);

function snapshot(): RoundSnapshot {
  const draft = {
    version: 6 as const,
    runId: "run-1",
    roundId: 1 as const,
    snapshotHash: HASH,
    runSpec: {
      version: 2 as const,
      runId: "run-1",
      task: {
        task: "fix it",
        acceptanceCriteria: [],
        sources: [
          {
            id: "task",
            kind: "user_task" as const,
            origin: "cli",
            retrievedAt: "2026-08-08T00:00:00.000Z",
            contentHash: HASH,
            snapshotPath: "sources/task.md",
          },
        ],
        createdAt: "2026-08-08T00:00:00.000Z",
      },
      baseCommit: "b".repeat(40),
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
        ] as const,
      },
      commands: [
        {
          id: "test",
          kind: "required" as const,
          command: "npm test",
          timeoutMs: 1_000,
          required: true,
        },
      ],
      budgets: {
        implementationMs: 1_000,
        reviewMs: 1_000,
        attackMs: 1_000,
        verifierMs: 1_000,
        repairMs: 1_000,
        roundEnvelopeMs: 1_500_000,
        maxProviderCallsPerRound: 10,
        maxTokensPerRound: 1_500_000,
      },
      effort: {
        mode: "medium" as const,
        fixedRounds: false,
        profile: {
          tier: "medium" as const,
          plannedRounds: 2,
          maxRounds: 4,
          roundEnvelopeMs: 1_500_000,
          maxProviderCallsPerRound: 10,
          maxTokensPerRound: 1_500_000,
          implementationMs: 900_000,
          reviewMs: 240_000,
          attackMs: 300_000,
          judgeMs: 120_000,
          repairMs: 360_000,
        },
        phaseOverrides: {
          implementation: false,
          review: false,
          attack: false,
          judge: false,
          repair: false,
        },
      },
      permissions: {
        mode: "deny" as const,
        reducedValidationAccepted: false,
        capabilities: [],
      },
      contentHash: HASH,
    },
    contestants: [
      {
        contestantId: "a" as const,
        patch: null,
        health: 100,
        permanentRecoil: 0,
        activeDefects: [],
        status: "pending" as const,
      },
      {
        contestantId: "b" as const,
        patch: null,
        health: 100,
        permanentRecoil: 0,
        activeDefects: [],
        status: "pending" as const,
      },
    ] as const,
    knownDefects: [],
    failureRecords: [],
    priorReplayHash: null,
  };
  draft.snapshotHash = calculateSnapshotHash(draft);
  return validateRoundSnapshot(draft);
}

function result(
  accepted: RoundSnapshot,
  status: RoundResult["status"],
): RoundResult {
  const contestants = accepted.contestants.map((entry) => ({
    ...entry,
    patch: {
      path: `patches/${entry.contestantId}.diff`,
      sha256: HASH,
    },
    status: "active" as const,
  })) as [(typeof accepted.contestants)[0], (typeof accepted.contestants)[1]];
  const replay = {
    version: 6 as const,
    runId: accepted.runId,
    roundId: accepted.roundId,
    snapshotHash: accepted.snapshotHash,
    priorReplayHash: accepted.priorReplayHash,
    invocations: [],
    attacks: [],
    checks: [],
    repairs: [],
    scoreEvents: [],
    diagnostics: [],
    failureRecords: [],
    telemetryInvocations: [],
    artifacts: [
      {
        id: "delta",
        kind: "round_state_delta" as const,
        path: "rounds/1/state-delta.json",
        sha256: HASH,
      },
    ],
    stateDeltaArtifactId: "delta",
    replayHash: HASH,
  };
  replay.replayHash = calculateReplayHash(replay);
  const base = {
    version: 6 as const,
    runId: accepted.runId,
    roundId: accepted.roundId,
    resultingContestants: contestants,
    failureRecords: [],
    replay,
  };
  return status === "completed"
    ? { ...base, status }
    : {
        ...base,
        status,
        diagnostics: [
          {
            code: status,
            severity: "error" as const,
            message: `${status} round`,
            artifactIds: [],
          },
        ],
      };
}

describe("RoundEngine boundary", () => {
  it.each(["completed", "inconclusive", "cancelled", "failed"] as const)(
    "returns a validated %s result without advancing another round",
    async (status) => {
      const input = snapshot();
      let calls = 0;
      const engine = new RoundEngine({
        adapters: {},
        verifier: {} as never,
        executeRound: (accepted) => {
          calls += 1;
          return Promise.resolve(result(accepted, status));
        },
      });
      await expect(engine.run(input)).resolves.toMatchObject({ status });
      expect(calls).toBe(1);
    },
  );

  it("rejects tampered snapshots before invoking runtime services", async () => {
    let called = false;
    const engine = new RoundEngine({
      adapters: {},
      verifier: {} as never,
      executeRound: (accepted) => {
        called = true;
        return Promise.resolve(result(accepted, "completed"));
      },
    });
    const input = snapshot();
    await expect(
      engine.run({
        ...input,
        contestants: [
          { ...input.contestants[0], health: 99 },
          input.contestants[1],
        ],
      }),
    ).rejects.toThrow(/Snapshot hash/);
    expect(called).toBe(false);
  });
});
