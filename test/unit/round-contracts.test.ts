import { describe, expect, it } from "vitest";
import {
  calculateReplayHash,
  calculateSnapshotHash,
  canonicalJson,
  ContestantFeedbackSchema,
  RoundReplaySchema,
  RoundResultSchema,
  RoundSnapshotSchema,
  RunSpecSchema,
  validateRoundResult,
  validateRoundSnapshot,
} from "../../src/contracts/round.js";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

function runSpec() {
  return {
    version: 2 as const,
    runId: "run-1",
    task: {
      task: "fix the defect",
      acceptanceCriteria: ["the regression is fixed"],
      sources: [
        {
          id: "source-1",
          kind: "user_task" as const,
          origin: "cli",
          retrievedAt: "2026-08-07T12:00:00.000Z",
          contentHash: HASH,
          snapshotPath: "sources/task.md",
        },
      ],
      createdAt: "2026-08-07T12:00:00.000Z",
    },
    baseCommit: "c".repeat(40),
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
        id: "required-test",
        kind: "required" as const,
        command: "npm test",
        timeoutMs: 60_000,
        required: true,
      },
    ],
    budgets: {
      implementationMs: 60_000,
      reviewMs: 60_000,
      attackMs: 60_000,
      verifierMs: 60_000,
      repairMs: 60_000,
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
      mode: "confirm" as const,
      reducedValidationAccepted: false,
      capabilities: [
        {
          id: "local-tests",
          reason: "run tests",
          risk: "low" as const,
          requirement: "required" as const,
          role: "both" as const,
          enforcement: "advisory" as const,
          decision: "approved" as const,
          scopes: ["assigned worktree"],
        },
      ],
    },
    contentHash: HASH,
  };
}

function contestant(contestantId: "a" | "b") {
  return {
    contestantId,
    patch: {
      path: `patches/${contestantId}.diff`,
      sha256: contestantId === "a" ? HASH : OTHER_HASH,
    },
    health: 100,
    permanentRecoil: 0,
    activeDefects: [],
    status: "active" as const,
  };
}

function snapshot() {
  return {
    version: 6 as const,
    runId: "run-1",
    roundId: 1 as const,
    snapshotHash: HASH,
    runSpec: runSpec(),
    contestants: [contestant("a"), contestant("b")] as const,
    knownDefects: [],
    failureRecords: [],
    priorReplayHash: null,
  };
}

function replay() {
  return {
    version: 6 as const,
    runId: "run-1",
    roundId: 1 as const,
    snapshotHash: HASH,
    priorReplayHash: null,
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
        id: "round-state-delta-1",
        kind: "round_state_delta" as const,
        path: "rounds/1/state-delta.json",
        sha256: HASH,
      },
    ],
    stateDeltaArtifactId: "round-state-delta-1",
    replayHash: OTHER_HASH,
  };
}

function feedback() {
  return {
    version: 1 as const,
    runId: "run-1",
    roundId: 1 as const,
    contestantId: "a" as const,
    phase: "attack" as const,
    health: { starting: 100, afterAttacks: 85, ending: 100 },
    acceptedIncomingAttacks: [
      {
        attackId: "attack-1",
        defectId: "defect-1",
        severity: "medium" as const,
        damage: 15,
        claim: "boundary input fails",
        visibleReproducers: [
          {
            artifactId: "case-1",
            command: "npm test -- boundary",
            expectedBehavior: "the boundary is accepted",
          },
        ],
      },
    ],
    ownAttackOutcomes: [
      {
        attackId: "attack-2",
        target: "b" as const,
        status: "missed" as const,
        reason: "target_did_not_fail" as const,
        recoil: 5,
      },
    ],
    healedDefectIds: ["defect-1"],
    unresolvedDefectIds: [],
    capabilityRestrictions: [],
    evidencePointers: [],
  };
}

function roundTrip<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  const parsed = schema.parse(value);
  return schema.parse(JSON.parse(JSON.stringify(parsed)) as unknown);
}

describe("round boundary contracts", () => {
  it("round-trips all five versioned contracts", () => {
    expect(roundTrip(RunSpecSchema, runSpec()).version).toBe(2);
    expect(roundTrip(RoundSnapshotSchema, snapshot()).roundId).toBe(1);
    expect(roundTrip(RoundReplaySchema, replay()).replayHash).toBe(OTHER_HASH);
    expect(
      roundTrip(RoundResultSchema, {
        version: 6,
        runId: "run-1",
        roundId: 1,
        status: "completed",
        resultingContestants: [contestant("a"), contestant("b")],
        failureRecords: [],
        replay: replay(),
      }).status,
    ).toBe("completed");
    expect(roundTrip(ContestantFeedbackSchema, feedback()).contestantId).toBe(
      "a",
    );
  });

  it("round-trips superseded defects and their adjudication links", () => {
    const superseded = {
      defectId: "defect-1",
      firstAttackId: "attack-1",
      firstAdjudicationId: "adjudication-1",
      baseSeverity: "high" as const,
      currentMultiplier: 1 as const,
      currentDamage: 30,
      evidenceHistory: [],
      status: "superseded" as const,
      supersededByAdjudicationId: "adjudication-2",
    };
    const contestantB = {
      ...contestant("b"),
      canonicalDefects: [superseded],
    };
    const snapshotValue = roundTrip(RoundSnapshotSchema, {
      ...snapshot(),
      roundId: 2,
      contestants: [contestant("a"), contestantB],
      knownDefects: [
        {
          defectId: superseded.defectId,
          attackId: superseded.firstAttackId,
          target: "b",
          severity: superseded.baseSeverity,
          damage: superseded.currentDamage,
          multiplier: superseded.currentMultiplier,
          status: superseded.status,
          supersededByAdjudicationId: superseded.supersededByAdjudicationId,
          visibleReproducerArtifactIds: [],
        },
      ],
      priorReplayHash: OTHER_HASH,
    });
    const resultValue = roundTrip(RoundResultSchema, {
      version: 6,
      runId: "run-1",
      roundId: 2,
      status: "completed",
      resultingContestants: [contestant("a"), contestantB],
      failureRecords: [],
      replay: {
        ...replay(),
        roundId: 2,
        priorReplayHash: OTHER_HASH,
      },
    });

    expect(snapshotValue.contestants[1].canonicalDefects?.[0]).toMatchObject(
      superseded,
    );
    expect(
      resultValue.resultingContestants[1].canonicalDefects?.[0],
    ).toMatchObject(superseded);
  });

  it("hashes canonical snapshot and replay JSON without their hash fields", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe(
      '{"a":{"x":3,"y":2},"z":1}',
    );
    const snapshotDraft = snapshot();
    snapshotDraft.snapshotHash = calculateSnapshotHash(snapshotDraft);
    const accepted = validateRoundSnapshot(snapshotDraft);
    const replayDraft = {
      ...replay(),
      snapshotHash: accepted.snapshotHash,
      priorReplayHash: accepted.priorReplayHash,
    };
    replayDraft.replayHash = calculateReplayHash(replayDraft);
    expect(
      validateRoundResult(
        {
          version: 6,
          runId: accepted.runId,
          roundId: accepted.roundId,
          status: "completed",
          resultingContestants: accepted.contestants,
          failureRecords: [],
          replay: replayDraft,
        },
        accepted,
      ).replay.replayHash,
    ).toBe(replayDraft.replayHash);

    expect(() =>
      validateRoundSnapshot({
        ...accepted,
        contestants: [
          { ...accepted.contestants[0], health: 99 },
          accepted.contestants[1],
        ],
      }),
    ).toThrow(/Snapshot hash/);
    expect(() =>
      validateRoundResult(
        {
          version: 6,
          runId: accepted.runId,
          roundId: accepted.roundId,
          status: "completed",
          resultingContestants: accepted.contestants,
          failureRecords: [],
          replay: {
            ...replayDraft,
            diagnostics: [
              {
                code: "tampered",
                severity: "warning",
                message: "changed after hashing",
                artifactIds: [],
              },
            ],
          },
        },
        accepted,
      ),
    ).toThrow();
  });

  it("permits pending production owners only in round 1", () => {
    const firstRound = {
      ...snapshot(),
      contestants: [
        { ...contestant("a"), patch: null, status: "pending" as const },
        contestant("b"),
      ] as const,
    };
    expect(() => RoundSnapshotSchema.parse(firstRound)).not.toThrow();
    expect(() =>
      RoundSnapshotSchema.parse({ ...firstRound, roundId: 2 }),
    ).toThrow(/Only round 1/);
    expect(() =>
      RoundResultSchema.parse({
        version: 6,
        runId: "run-1",
        roundId: 1,
        status: "completed",
        resultingContestants: firstRound.contestants,
        failureRecords: [],
        replay: replay(),
      }),
    ).toThrow(/cannot leave a contestant pending/);
  });

  it("records implementation invocations in round replays", () => {
    const value = replay();
    const withImplementation = {
      ...value,
      invocations: [
        {
          id: "implementation-a",
          kind: "implementation",
          actor: "contestant_a",
          status: "succeeded",
          startedAt: "2026-08-07T12:00:00.000Z",
          finishedAt: "2026-08-07T12:01:00.000Z",
          artifactIds: [],
        },
      ],
    };
    expect(
      RoundReplaySchema.parse(withImplementation).invocations[0]?.kind,
    ).toBe("implementation");
  });

  it("allows no acceptance criteria when none were explicitly supplied", () => {
    const spec = runSpec();
    expect(
      RunSpecSchema.parse({
        ...spec,
        task: { ...spec.task, acceptanceCriteria: [] },
      }).task.acceptanceCriteria,
    ).toEqual([]);
  });

  it("rejects unsupported versions, malformed hashes, and runtime values", () => {
    expect(() => RunSpecSchema.parse({ ...runSpec(), version: 3 })).toThrow();
    expect(() =>
      RunSpecSchema.parse({ ...runSpec(), contentHash: "not-a-hash" }),
    ).toThrow();
    expect(() =>
      RunSpecSchema.parse({ ...runSpec(), callback: () => undefined }),
    ).toThrow();
    expect(() =>
      RoundSnapshotSchema.parse({
        ...snapshot(),
        controller: new AbortController(),
      }),
    ).toThrow();
  });

  it("rejects inconsistent run and round identities", () => {
    expect(() =>
      RoundSnapshotSchema.parse({ ...snapshot(), runId: "another-run" }),
    ).toThrow(/runId/);
    expect(() =>
      RoundResultSchema.parse({
        version: 6,
        runId: "run-1",
        roundId: 2,
        status: "completed",
        resultingContestants: [contestant("a"), contestant("b")],
        failureRecords: [],
        replay: replay(),
      }),
    ).toThrow(/identities/);
    expect(() =>
      RoundSnapshotSchema.parse({
        ...snapshot(),
        contestants: [contestant("b"), contestant("a")],
      }),
    ).toThrow(/topology order/);
    expect(() =>
      RoundResultSchema.parse({
        version: 6,
        runId: "run-1",
        roundId: 1,
        status: "completed",
        resultingContestants: [contestant("b"), contestant("a")],
        failureRecords: [],
        replay: replay(),
      }),
    ).toThrow(/ordered a then b/);
  });

  it("rejects unsupported or misordered battle topologies", () => {
    const base = runSpec();
    expect(() =>
      RunSpecSchema.parse({
        ...base,
        topology: {
          ...base.topology,
          contestants: [...base.topology.contestants].reverse(),
        },
      }),
    ).toThrow(/ordered a then b/);
    expect(() =>
      RunSpecSchema.parse({
        ...base,
        topology: {
          mode: "siege",
          contestants: base.topology.contestants,
        },
      }),
    ).toThrow(/must match siege topology/);
  });

  it("represents a siege attacker without a production patch", () => {
    const base = snapshot();
    const siege = {
      ...base,
      runSpec: {
        ...base.runSpec,
        topology: {
          mode: "siege" as const,
          contestants: [
            {
              id: "a" as const,
              provider: "codex",
              role: "attacker" as const,
              startingPatch: "none" as const,
            },
            {
              id: "b" as const,
              provider: "claude",
              role: "defender" as const,
              startingPatch: "pull_request" as const,
            },
          ] as const,
        },
      },
      contestants: [
        { ...contestant("a"), patch: null },
        contestant("b"),
      ] as const,
    };
    expect(() => RoundSnapshotSchema.parse(siege)).not.toThrow();
    expect(() =>
      RoundSnapshotSchema.parse({
        ...siege,
        contestants: [contestant("a"), contestant("b")],
      }),
    ).toThrow(/test-only attacker/);
    expect(() =>
      RoundSnapshotSchema.parse({
        ...siege,
        contestants: [
          { ...contestant("a"), patch: null },
          { ...contestant("b"), patch: null },
        ],
      }),
    ).toThrow(/production-owning contestant/);
  });

  it("restricts current rounds to the five attack-repair rounds", () => {
    expect(() =>
      RoundSnapshotSchema.parse({ ...snapshot(), roundId: 5 }),
    ).not.toThrow();
    expect(() =>
      RoundSnapshotSchema.parse({ ...snapshot(), roundId: 6 }),
    ).toThrow();
    expect(() =>
      RoundSnapshotSchema.parse({ ...snapshot(), roundId: "recovery" }),
    ).toThrow();
    expect(() =>
      RoundSnapshotSchema.parse({ ...snapshot(), roundId: "reconciliation" }),
    ).toThrow();
  });

  it("requires every outcome to include a replay and failure diagnostics", () => {
    const base = {
      version: 6,
      runId: "run-1",
      roundId: 1,
      resultingContestants: [contestant("a"), contestant("b")],
      failureRecords: [],
    };
    expect(() =>
      RoundResultSchema.parse({ ...base, status: "completed" }),
    ).toThrow();
    expect(() =>
      RoundResultSchema.parse({
        ...base,
        status: "failed",
        replay: replay(),
        diagnostics: [],
      }),
    ).toThrow();
    expect(() =>
      RoundResultSchema.parse({
        ...base,
        status: "failed",
        replay: replay(),
        diagnostics: [
          {
            code: "provider-failed",
            severity: "error",
            message: "provider invocation failed",
            artifactIds: [],
          },
        ],
      }),
    ).not.toThrow();
  });

  it.each([
    "opponentTranscripts",
    "hiddenCases",
    "verifierReasoning",
    "privateRepairDetails",
  ])("does not expose %s in contestant feedback", (privateField) => {
    expect(() =>
      ContestantFeedbackSchema.parse({
        ...feedback(),
        [privateField]: ["private"],
      }),
    ).toThrow();
  });

  it("requires canonical defect IDs for landed and duplicate own attacks", () => {
    const base = feedback();
    expect(() =>
      ContestantFeedbackSchema.parse({
        ...base,
        ownAttackOutcomes: [
          {
            ...base.ownAttackOutcomes[0],
            status: "landed",
            recoil: 0,
          },
        ],
      }),
    ).toThrow(/canonical defect ID/);
    expect(() =>
      ContestantFeedbackSchema.parse({
        ...base,
        ownAttackOutcomes: [
          {
            ...base.ownAttackOutcomes[0],
            status: "landed",
            recoil: 0,
            defectId: "defect-2",
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      ContestantFeedbackSchema.parse({
        ...base,
        ownAttackOutcomes: [
          {
            ...base.ownAttackOutcomes[0],
            status: "duplicate",
            recoil: 10,
          },
        ],
      }),
    ).toThrow(/canonical defect ID/);
    expect(() =>
      ContestantFeedbackSchema.parse({
        ...base,
        ownAttackOutcomes: [
          {
            ...base.ownAttackOutcomes[0],
            status: "duplicate",
            recoil: 10,
            defectId: "defect-2",
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      ContestantFeedbackSchema.parse({
        ...base,
        ownAttackOutcomes: [
          {
            ...base.ownAttackOutcomes[0],
            defectId: "defect-2",
          },
        ],
      }),
    ).toThrow(/Only a landed, shared-defect, or duplicate/);
  });
});
