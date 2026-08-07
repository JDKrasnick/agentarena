import { describe, expect, it } from "vitest";
import {
  ContestantFeedbackSchema,
  RoundReplaySchema,
  RoundResultSchema,
  RoundSnapshotSchema,
  RunSpecSchema,
} from "../../src/contracts/round.js";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

function runSpec() {
  return {
    version: 1 as const,
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
    replacementCredits: [],
    status: "active" as const,
  };
}

function snapshot() {
  return {
    version: 1 as const,
    runId: "run-1",
    roundId: 1 as const,
    snapshotHash: HASH,
    runSpec: runSpec(),
    contestants: [contestant("a"), contestant("b")] as const,
    knownDefects: [],
    priorReplayHash: null,
  };
}

function replay() {
  return {
    version: 1 as const,
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
    artifacts: [],
    replayHash: OTHER_HASH,
  };
}

function feedback() {
  return {
    version: 1 as const,
    runId: "run-1",
    roundId: 1 as const,
    contestantId: "a" as const,
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
        reason: "the target passed",
        recoil: 5,
      },
    ],
    healedDefectIds: ["defect-1"],
    unresolvedDefectIds: [],
  };
}

function roundTrip<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  const parsed = schema.parse(value);
  return schema.parse(JSON.parse(JSON.stringify(parsed)) as unknown);
}

describe("round boundary contracts", () => {
  it("round-trips all five versioned contracts", () => {
    expect(roundTrip(RunSpecSchema, runSpec()).version).toBe(1);
    expect(roundTrip(RoundSnapshotSchema, snapshot()).roundId).toBe(1);
    expect(roundTrip(RoundReplaySchema, replay()).replayHash).toBe(OTHER_HASH);
    expect(
      roundTrip(RoundResultSchema, {
        version: 1,
        runId: "run-1",
        roundId: 1,
        status: "completed",
        resultingContestants: [contestant("a"), contestant("b")],
        replay: replay(),
      }).status,
    ).toBe("completed");
    expect(roundTrip(ContestantFeedbackSchema, feedback()).contestantId).toBe(
      "a",
    );
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
    expect(() => RunSpecSchema.parse({ ...runSpec(), version: 2 })).toThrow();
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
        version: 1,
        runId: "run-1",
        roundId: 2,
        status: "completed",
        resultingContestants: [contestant("a"), contestant("b")],
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
        version: 1,
        runId: "run-1",
        roundId: 1,
        status: "completed",
        resultingContestants: [contestant("b"), contestant("a")],
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

  it("requires available replacement-credit state for recovery rounds", () => {
    expect(() =>
      RoundSnapshotSchema.parse({ ...snapshot(), roundId: "recovery" }),
    ).toThrow(/available credit/);
    const recovery = {
      ...snapshot(),
      roundId: "recovery" as const,
      contestants: [
        {
          ...contestant("a"),
          status: "downed" as const,
          replacementCredits: [
            {
              id: "credit-1",
              sourceAttackId: "attack-1",
              issuedRound: 3 as const,
              reason: "final_infrastructure" as const,
              status: "available" as const,
            },
          ],
        },
        contestant("b"),
      ] as const,
    };
    expect(() => RoundSnapshotSchema.parse(recovery)).not.toThrow();
    expect(roundTrip(RoundSnapshotSchema, recovery).roundId).toBe("recovery");
    expect(() =>
      RoundSnapshotSchema.parse({
        ...recovery,
        contestants: [
          { ...recovery.contestants[0], status: "eliminated" },
          recovery.contestants[1],
        ],
      }),
    ).toThrow(/available credit/);
  });

  it("requires every outcome to include a replay and failure diagnostics", () => {
    const base = {
      version: 1,
      runId: "run-1",
      roundId: 1,
      resultingContestants: [contestant("a"), contestant("b")],
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
    ).toThrow(/Only a landed or duplicate/);
  });
});
