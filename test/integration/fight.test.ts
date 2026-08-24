import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, readdir, rm } from "node:fs/promises";
import { execa } from "execa";
import { describe, expect, it, vi } from "vitest";
import {
  CommandAgentAdapter,
  CommandCaseBuilder,
  CommandHouseScout,
  RuleBasedVerifier,
} from "../../src/agents/adapter.js";
import { Arena } from "../../src/core/arena.js";
import { RoundEngine } from "../../src/core/round-engine.js";
import {
  calculateReplayHash,
  RoundReplaySchema,
  RoundSnapshotSchema,
  RoundStateDeltaSchema,
} from "../../src/contracts/round.js";
import { applyAcceptedPatch } from "../../src/commands/apply.js";
import { resolveCoverage } from "../../src/commands/resolve-coverage.js";
import { FightConfigSchema } from "../../src/core/types.js";
import { recordReviewDecision, reviewRun } from "../../src/review/service.js";
import type { IssueResolver } from "../../src/task/task-contract.js";
import { createSlugRepository } from "../helpers/repository.js";
import { ArenaBattleControl } from "../../src/observability/control.js";
import { ArenaEventSchema } from "../../src/observability/events.js";
import { ArtifactStore } from "../../src/artifacts/store.js";
import {
  EvidenceHandoffPacketSchema,
  assertEvidenceHandoffPacketIntrinsic,
  canonicalHandoffJson,
} from "../../src/review/evidence-handoff.js";
import { readHandoffLifecycle } from "../../src/review/evidence-handoff-store.js";

const fixtureAgent = fileURLToPath(
  new URL("../fixtures/fake-agent.mjs", import.meta.url),
);

function duelConfig(repositoryRoot: string) {
  return FightConfigSchema.parse({
    task: "Normalize slug whitespace.",
    acceptanceCriteria: ["Collapse whitespace."],
    specPaths: [],
    issueReferences: [],
    agents: ["codex", "claude"],
    attackVerifier: "claude",
    harnessMaintainer: "claude",
    rounds: 3,
    maxAttacksPerRound: 3,
    infrastructureRecoveryRound: true,
    maxHeldOutCasesPerDefect: 0,
    testCommand: "node --test",
    repositoryRoot,
    artifactRoot: path.join(repositoryRoot, ".agent-arena", "runs"),
    permissionMode: "confirm",
    permissionAllow: {},
    permissionDeny: [],
    reducedValidationAccepted: false,
    nonInteractiveApproval: true,
    keepWorktrees: false,
    limits: {
      implementationMs: 10_000,
      attackMs: 10_000,
      verifierMs: 10_000,
      repairMs: 10_000,
    },
  });
}

describe("fake-adapter fight on a mocked real issue", () => {
  it("isolates two slots that use the same provider", async () => {
    const repositoryRoot = await createSlugRepository();
    const config = FightConfigSchema.parse({
      task: "Normalize slug whitespace.",
      acceptanceCriteria: ["Collapse whitespace."],
      specPaths: [],
      issueReferences: [],
      agents: ["codex", "codex"],
      attackVerifier: "codex",
      harnessMaintainer: "codex",
      rounds: 3,
      maxAttacksPerRound: 3,
      infrastructureRecoveryRound: true,
      maxHeldOutCasesPerDefect: 0,
      testCommand: "node --test",
      repositoryRoot,
      artifactRoot: path.join(repositoryRoot, ".agent-arena", "runs"),
      permissionMode: "confirm",
      permissionAllow: {},
      permissionDeny: [],
      reducedValidationAccepted: false,
      nonInteractiveApproval: true,
      keepWorktrees: false,
      limits: {
        implementationMs: 10_000,
        attackMs: 10_000,
        verifierMs: 10_000,
        repairMs: 10_000,
      },
    });
    const adapter = new CommandAgentAdapter({
      id: "codex",
      executable: process.execPath,
      args: [fixtureAgent],
    });
    const control = new ArenaBattleControl(new AbortController());
    control.queueSteering(
      "a",
      "Pay special attention to normalization boundaries",
    );
    const outcome = await new Arena({
      adapters: { codex: adapter },
      verifier: new RuleBasedVerifier("codex"),
      caseBuilder: new CommandCaseBuilder("codex", {
        executable: process.execPath,
        args: [fixtureAgent],
      }),
      battleControl: control,
    }).fight(config);

    expect(outcome.state.config.contestants).toMatchObject([
      { id: "a", provider: "codex" },
      { id: "b", provider: "codex" },
    ]);
    const a = outcome.state.contestants.a;
    const b = outcome.state.contestants.b;
    expect(a?.implementation?.promptPath).not.toBe(
      b?.implementation?.promptPath,
    );
    expect(a?.implementation?.transcriptPath).not.toBe(
      b?.implementation?.transcriptPath,
    );
    expect(a?.currentPatchPath).not.toBe(b?.currentPatchPath);
    expect(await readFile(a!.currentPatchPath!, "utf8")).not.toBe(
      await readFile(b!.currentPatchPath!, "utf8"),
    );
    expect(outcome.state.integrity).toBe("assisted");
    expect(outcome.state.operatorInterventions).toEqual([
      expect.objectContaining({
        contestantId: "a",
        status: "applied",
        appliedStage: "implement",
      }),
    ]);
    expect(outcome.state.operatorInterventions[0]?.promptHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(await readFile(a!.implementation!.promptPath, "utf8")).toContain(
      "Pay special attention to normalization boundaries",
    );
    const events = (await readFile(outcome.state.artifacts.events!, "utf8"))
      .trim()
      .split("\n")
      .map((line) => ArenaEventSchema.parse(JSON.parse(line)));
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_event, index) => index + 1),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "steering_applied",
          contestantId: "a",
        }),
        expect.objectContaining({
          type: "battle_completed",
          status: "complete",
        }),
      ]),
    );
    const durableSummary = JSON.parse(
      await readFile(outcome.state.artifacts.result!, "utf8"),
    ) as {
      provenance: { assisted: boolean; competitivelyComparable: boolean };
    };
    expect(durableSummary.provenance).toMatchObject({
      assisted: true,
      competitivelyComparable: false,
    });
    const attackBy = (slot: "a" | "b") =>
      outcome.state.attacks.find(
        (attack) =>
          attack.origin.kind === "contestant" &&
          attack.origin.contestant === slot,
      );
    const attackA = attackBy("a");
    const attackB = attackBy("b");
    if (!attackA || !attackB)
      throw new Error("both mirror attacks are required");
    expect(attackA.origin).toMatchObject({
      contestant: "a",
      provider: "codex",
    });
    expect(attackA.targets).toEqual(["b"]);
    expect(attackB.origin).toMatchObject({
      contestant: "b",
      provider: "codex",
    });
    expect(attackB.targets).toEqual(["a"]);
  });

  it("promotes the sole eligible implementation by pre-review forfeit", async () => {
    const repositoryRoot = await createSlugRepository();
    const config = FightConfigSchema.parse({
      task: "Normalize slug whitespace.",
      acceptanceCriteria: ["Collapse whitespace."],
      specPaths: [],
      issueReferences: [],
      agents: ["codex", "claude"],
      attackVerifier: "claude",
      harnessMaintainer: "claude",
      rounds: 3,
      maxAttacksPerRound: 3,
      infrastructureRecoveryRound: true,
      maxHeldOutCasesPerDefect: 0,
      testCommand: "node --test",
      repositoryRoot,
      artifactRoot: path.join(repositoryRoot, ".agent-arena", "runs"),
      permissionMode: "confirm",
      permissionAllow: {},
      permissionDeny: [],
      reducedValidationAccepted: false,
      nonInteractiveApproval: true,
      keepWorktrees: false,
      limits: {
        implementationMs: 10_000,
        attackMs: 10_000,
        verifierMs: 10_000,
        repairMs: 10_000,
      },
    });
    const arena = new Arena({
      adapters: {
        codex: new CommandAgentAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
          environment: { AGENT_ARENA_EMPTY_IMPLEMENTATION: "1" },
        }),
        claude: new CommandAgentAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("claude"),
    });
    const outcome = await arena.fight(config);

    expect(outcome.state.status).toBe("complete");
    expect(outcome.state.terminalOutcome).toMatchObject({
      version: 2,
      phase: "pre_review",
      kind: "forfeit",
      status: "completed",
      reasonCode: "implementation_empty_patch",
      eligibleContestantIds: ["b"],
      contestants: [
        expect.objectContaining({
          contestantId: "a",
          eligible: false,
          reasonCode: "implementation_empty_patch",
        }),
        expect.objectContaining({ contestantId: "b", eligible: true }),
      ],
    });
    expect(outcome.state.contestants.a).toMatchObject({
      status: "failed",
      finalHealth: 0,
      patchSize: 0,
    });
    expect(outcome.state.contestants.b).toMatchObject({
      status: "survived",
      finalHealth: 100,
    });
    expect(outcome.state.attacks).toEqual([]);
    expect(outcome.state.patchRecommendation).toMatchObject({
      contestantId: "b",
    });
    expect(outcome.state.ranking?.winner).toBe("b");
    expect(outcome.state.arenaOutcome?.championId).toBe("b");
    expect(outcome.state.patchQualityFacts.b?.patchSha256).toHaveLength(64);
    expect(outcome.state.reviewPrompt?.choices).toEqual([
      expect.objectContaining({ contestantId: "b", eligible: true }),
    ]);
    const terminalReport = await readFile(
      outcome.state.artifacts.battle!,
      "utf8",
    );
    expect(terminalReport).toContain("Pre-Review Result");
    expect(terminalReport).not.toMatch(/\bDraw\b|Arena champion|Attack-lane/);
    expect(
      await readdir(
        path.join(outcome.state.artifacts.runDirectory!, "quality"),
      ),
    ).toEqual([]);
    expect(
      await readdir(
        path.join(outcome.state.artifacts.runDirectory!, "coverage"),
      ),
    ).toEqual([]);

    const resumed = await arena.resume({
      runId: outcome.state.runId,
      repositoryRoot,
    });
    expect(resumed.state.terminalOutcome).toEqual(
      outcome.state.terminalOutcome,
    );
    expect(resumed.state.ranking?.winner).toBe("b");
    expect(resumed.state.contestants.a?.finalHealth).toBe(0);
    expect(resumed.state.patchQualityFacts.b?.patchSha256).toHaveLength(64);
    expect(resumed.state.reviewPrompt).toEqual(outcome.state.reviewPrompt);
  });

  it("keeps valid siblings when a same-round correction remains malformed", async () => {
    const repositoryRoot = await createSlugRepository();
    const config = FightConfigSchema.parse({
      task: "Normalize slug whitespace and lowercase input.",
      acceptanceCriteria: ["Collapse whitespace.", "Return lowercase slugs."],
      specPaths: [],
      issueReferences: [],
      agents: ["codex", "claude"],
      attackVerifier: "codex",
      harnessMaintainer: "codex",
      rounds: 3,
      maxAttacksPerRound: 3,
      infrastructureRecoveryRound: true,
      maxHeldOutCasesPerDefect: 0,
      testCommand: "node --test",
      repositoryRoot,
      artifactRoot: path.join(repositoryRoot, ".agent-arena", "runs"),
      permissionMode: "confirm",
      permissionAllow: {},
      permissionDeny: [],
      reducedValidationAccepted: false,
      nonInteractiveApproval: true,
      keepWorktrees: false,
      limits: {
        implementationMs: 10_000,
        attackMs: 10_000,
        verifierMs: 10_000,
        repairMs: 10_000,
      },
    });
    const outcome = await new Arena({
      adapters: {
        codex: new CommandAgentAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
          environment: {
            AGENT_ARENA_FAKE_RECONCILIATION: "1",
            AGENT_ARENA_FAKE_RETRY_ONCE: "1",
          },
        }),
        claude: new CommandAgentAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("codex"),
      caseBuilder: new CommandCaseBuilder("codex", {
        executable: process.execPath,
        args: [fixtureAgent],
      }),
    }).fight(config);

    expect(outcome.state.status).toBe("complete");
    expect(
      outcome.state.attacks.find(
        (attack) =>
          attack.round === 3 && attack.claim.includes("Uppercase input"),
      ),
    ).toMatchObject({
      origin: { kind: "contestant", contestant: "a" },
      rank: 1,
    });
    expect(outcome.state.submissionArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          round: 3,
          phase: "attack",
          actor: "a",
          kind: "attack",
          outcome: "partial",
        }),
      ]),
    );
    const parsingFailure = outcome.state.failureRecords.find(
      (record) =>
        record.stage === "parsing" &&
        record.contestantId === "a" &&
        record.terminalDisposition === "coverage_lost",
    );
    expect(parsingFailure).toMatchObject({
      terminalDisposition: "coverage_lost",
      attempts: [
        { attempt: 1, status: "failed" },
        { attempt: 2, status: "failed" },
      ],
    });
    expect(parsingFailure?.attempts[0]?.diagnosticArtifactRefs).not.toEqual(
      parsingFailure?.attempts[1]?.diagnosticArtifactRefs,
    );
    expect(outcome.state.failureRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "parsing",
          terminalDisposition: "recovered",
          attempts: [
            expect.objectContaining({ attempt: 1, status: "failed" }),
            expect.objectContaining({ attempt: 2, status: "succeeded" }),
          ],
        }),
      ]),
    );
  });

  it("returns an inconclusive round when implementation infrastructure fails", async () => {
    const run = vi.spyOn(RoundEngine.prototype, "run");
    const repositoryRoot = await createSlugRepository();
    const config = FightConfigSchema.parse({
      task: "Normalize slug whitespace.",
      acceptanceCriteria: ["Collapse whitespace."],
      specPaths: [],
      issueReferences: [],
      agents: ["codex", "claude"],
      attackVerifier: "claude",
      harnessMaintainer: "claude",
      rounds: 3,
      maxAttacksPerRound: 3,
      infrastructureRecoveryRound: true,
      maxHeldOutCasesPerDefect: 0,
      testCommand: "node --test",
      repositoryRoot,
      artifactRoot: path.join(repositoryRoot, ".agent-arena", "runs"),
      permissionMode: "confirm",
      permissionAllow: {},
      permissionDeny: [],
      reducedValidationAccepted: false,
      nonInteractiveApproval: true,
      keepWorktrees: false,
      limits: {
        implementationMs: 10_000,
        attackMs: 10_000,
        verifierMs: 10_000,
        repairMs: 10_000,
      },
    });
    const failed = new CommandAgentAdapter({
      id: "codex",
      executable: process.execPath,
      args: [fixtureAgent],
    });
    const implement = vi
      .spyOn(failed, "implement")
      .mockImplementation((input) =>
        Promise.resolve({
          agent: "codex",
          contestantId: input.contestantId,
          role: "solver",
          stage: "implement",
          startedAt: "2026-08-08T00:00:00.000Z",
          finishedAt: "2026-08-08T00:00:01.000Z",
          durationMs: 1_000,
          status: "infrastructure_error",
          promptPath: input.promptPath,
          transcriptPath: `${input.transcriptPrefix}.stderr.log`,
        }),
      );

    const outcome = await new Arena({
      adapters: {
        codex: failed,
        claude: new CommandAgentAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("claude"),
    }).fight(config);

    expect(outcome.state.status).toBe("inconclusive");
    expect(outcome.state.terminalOutcome).toMatchObject({
      phase: "pre_review",
      kind: "inconclusive",
      reasonCode: "harness_infrastructure_failure",
      eligibleContestantIds: [],
    });
    expect(run).toHaveBeenCalledOnce();
    expect(implement).toHaveBeenCalledTimes(2);
    expect(outcome.state.attacks).toEqual([]);
    expect(outcome.state.contestants.a?.currentPatchPath).toBeUndefined();
    expect(outcome.state.failureRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "implementation",
          terminalDisposition: "run_level_coverage_lost",
          attempts: [
            expect.objectContaining({ attempt: 1, status: "failed" }),
            expect.objectContaining({ attempt: 2, status: "failed" }),
          ],
        }),
      ]),
    );
    implement.mockRestore();
    run.mockRestore();
  });

  it("preserves implementation timeout as the pre-review reason", async () => {
    const repositoryRoot = await createSlugRepository();
    const timedOut = new CommandAgentAdapter({
      id: "codex",
      executable: process.execPath,
      args: [fixtureAgent],
    });
    vi.spyOn(timedOut, "implement").mockImplementation((input) =>
      Promise.resolve({
        agent: "codex",
        contestantId: input.contestantId,
        role: "solver",
        stage: "implement",
        startedAt: "2026-08-08T00:00:00.000Z",
        finishedAt: "2026-08-08T00:00:01.000Z",
        durationMs: 1_000,
        status: "timed_out",
        promptPath: input.promptPath,
        transcriptPath: `${input.transcriptPrefix}.stderr.log`,
      }),
    );

    const outcome = await new Arena({
      adapters: {
        codex: timedOut,
        claude: new CommandAgentAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("claude"),
    }).fight(duelConfig(repositoryRoot));

    expect(outcome.state.status).toBe("complete");
    expect(outcome.state.terminalOutcome).toMatchObject({
      kind: "forfeit",
      reasonCode: "implementation_timeout",
      affectedContestantIds: ["a"],
      eligibleContestantIds: ["b"],
    });
  });

  it("seals cancellation as a pre-review terminal outcome", async () => {
    const repositoryRoot = await createSlugRepository();
    const cancelledAdapter = (id: "codex" | "claude") => {
      const adapter = new CommandAgentAdapter({
        id,
        executable: process.execPath,
        args: [fixtureAgent],
      });
      vi.spyOn(adapter, "implement").mockImplementation((input) =>
        Promise.resolve({
          agent: id,
          contestantId: input.contestantId,
          role: "solver",
          stage: "implement",
          startedAt: "2026-08-08T00:00:00.000Z",
          finishedAt: "2026-08-08T00:00:01.000Z",
          durationMs: 1_000,
          status: "cancelled",
          promptPath: input.promptPath,
          transcriptPath: `${input.transcriptPrefix}.stderr.log`,
        }),
      );
      return adapter;
    };

    const outcome = await new Arena({
      adapters: {
        codex: cancelledAdapter("codex"),
        claude: cancelledAdapter("claude"),
      },
      verifier: new RuleBasedVerifier("claude"),
    }).fight(duelConfig(repositoryRoot));

    expect(outcome.state.status).toBe("cancelled");
    expect(outcome.state.terminalOutcome).toMatchObject({
      phase: "pre_review",
      kind: "cancelled",
      reasonCode: "external_cancellation",
      eligibleContestantIds: [],
    });
  });

  it("does not turn exhausted invalid review or attack output into an empty handoff", async () => {
    const repositoryRoot = await createSlugRepository();
    const config = duelConfig(repositoryRoot);
    const outcome = await new Arena({
      adapters: {
        codex: new CommandAgentAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
          environment: { AGENT_ARENA_FAKE_INVALID_REVIEW_ALWAYS: "1" },
        }),
        claude: new CommandAgentAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
          environment: { AGENT_ARENA_FAKE_INVALID_ATTACK_ALWAYS: "1" },
        }),
      },
      verifier: new RuleBasedVerifier("claude"),
    }).fight(config);
    const store = new ArtifactStore(config.artifactRoot, outcome.state.runId, {
      durableV5: true,
    });

    expect(
      outcome.state.reviewInvocations.find(
        (entry) => entry.round === 1 && entry.reviewer === "a",
      ),
    ).toMatchObject({
      parseOutcome: "invalid",
      submissionStatus: "invalid_submission",
    });
    await expect(
      readHandoffLifecycle(store, "round_1", "a-to-b"),
    ).resolves.toEqual([]);

    expect(
      outcome.state.attackInvocations.find(
        (entry) => entry.round === 1 && entry.attacker === "b",
      ),
    ).toMatchObject({ submissionStatus: "invalid_submission", attackCount: 0 });
    const attackLifecycle = await readHandoffLifecycle(
      store,
      "round_1",
      "b-to-a",
    );
    expect(attackLifecycle.map((record) => record.state)).toEqual([
      "created",
      "validated",
      "invalidated",
    ]);
    expect(attackLifecycle.map((record) => record.state)).not.toContain(
      "completed_empty",
    );
  });

  it("refreshes a blocker from a clean frozen target worktree", async () => {
    const repositoryRoot = await createSlugRepository();
    const config = duelConfig(repositoryRoot);
    const outcome = await new Arena({
      adapters: {
        codex: new CommandAgentAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
          environment: {
            AGENT_ARENA_FAKE_BLOCKER_ONCE: "1",
            AGENT_ARENA_FAKE_DIRTY_BLOCKER: "1",
          },
        }),
        claude: new CommandAgentAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("claude"),
    }).fight(config);
    const store = new ArtifactStore(config.artifactRoot, outcome.state.runId, {
      durableV5: true,
    });
    const lifecycle = await readHandoffLifecycle(store, "round_2", "a-to-b");

    expect(lifecycle.map((record) => record.state)).toEqual([
      "created",
      "validated",
      "refresh_required",
      "validated",
      "completed_empty",
    ]);
    expect(
      outcome.state.reviewInvocations.find(
        (entry) =>
          entry.round === 2 &&
          entry.reviewer === "a" &&
          entry.detail?.includes("Targeted blocker refresh completed"),
      ),
    ).toBeTruthy();
    expect(outcome.state.warnings.join("\n")).not.toContain(
      "Trusted handoff refresh failed for a against b",
    );
  });

  it("keeps blocker refresh independent from attack submission correction", async () => {
    const repositoryRoot = await createSlugRepository();
    const config = duelConfig(repositoryRoot);
    const outcome = await new Arena({
      adapters: {
        codex: new CommandAgentAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
          environment: { AGENT_ARENA_FAKE_INVALID_THEN_BLOCKER: "1" },
        }),
        claude: new CommandAgentAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("claude"),
    }).fight(config);
    const store = new ArtifactStore(config.artifactRoot, outcome.state.runId, {
      durableV5: true,
    });
    const lifecycle = await readHandoffLifecycle(store, "round_2", "a-to-b");
    const invocations = outcome.state.attackInvocations.filter(
      (entry) =>
        entry.round === 2 && entry.attacker === "a" && entry.target === "b",
    );

    expect(lifecycle.map((record) => record.state)).toEqual([
      "created",
      "validated",
      "refresh_required",
      "validated",
      "completed_empty",
    ]);
    expect(invocations).toHaveLength(3);
    expect(invocations.map((entry) => entry.submissionStatus)).toEqual([
      "invalid_submission",
      "not_submitted",
      "submitted",
    ]);
    for (const invocation of invocations) {
      expect(invocation.handoffPacketId).toBeTruthy();
      expect(invocation.handoffPacketDigest).toHaveLength(64);
      expect(invocation.handoffTargetFingerprint).toHaveLength(64);
    }
    expect(
      outcome.state.reviewInvocations.some(
        (entry) =>
          entry.round === 2 &&
          entry.reviewer === "a" &&
          entry.detail?.includes("Targeted blocker refresh completed"),
      ),
    ).toBe(true);
  });

  it("refreshes a valid review when no nonempty finding fits the packet ceiling", async () => {
    const repositoryRoot = await createSlugRepository();
    const config = duelConfig(repositoryRoot);
    const outcome = await new Arena({
      adapters: {
        codex: new CommandAgentAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
          environment: { AGENT_ARENA_FAKE_OVERSIZED_REVIEW_ONCE: "1" },
        }),
        claude: new CommandAgentAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("claude"),
    }).fight(config);
    const store = new ArtifactStore(config.artifactRoot, outcome.state.runId, {
      durableV5: true,
    });
    const lifecycle = await readHandoffLifecycle(store, "round_1", "a-to-b");

    expect(lifecycle.map((record) => record.state)).toEqual([
      "refresh_required",
      "validated",
      "consumed",
    ]);
    expect(lifecycle[0]).toMatchObject({
      event: "blocking",
      reason_code: "packet_size",
      attempt: 1,
    });
    expect(
      outcome.state.reviewInvocations.some(
        (entry) =>
          entry.round === 1 &&
          entry.reviewer === "a" &&
          entry.detail?.includes("Targeted packet-size refresh completed"),
      ),
    ).toBe(true);
    await expect(
      readdir(store.resolve("rounds/round_1/handoffs/a-to-b/blockers")),
    ).resolves.toHaveLength(1);
  });

  it("runs three rounds, lands and heals evidence, recoils a miss, and writes replayable artifacts", async () => {
    const repositoryRoot = await createSlugRepository();
    const integrationRetryMarker = `${repositoryRoot}-integration-retry`;
    const issueResolver: IssueResolver = {
      resolve(reference) {
        return Promise.resolve({
          origin: `https://github.com/acme/mock-slug-service/issues/${reference}`,
          title: "Normalize repeated whitespace in generated slugs",
          body: [
            "Customer titles with repeated spaces create unstable URLs.",
            "",
            "- [ ] Collapse every run of whitespace to one hyphen.",
            "- [ ] Preserve lowercase normalization.",
            "- [ ] Reject blank or whitespace-only titles.",
          ].join("\n"),
          comments: [
            {
              author: "service-maintainer",
              body: "This must cover tabs and repeated ordinary spaces without changing the public API.",
            },
          ],
        });
      },
    };
    const config = FightConfigSchema.parse({
      task: "Fix issue #241: slug() must lowercase input, collapse every whitespace run to one hyphen, and reject blank titles.",
      acceptanceCriteria: [],
      specPaths: [],
      issueReferences: ["241"],
      agents: ["codex", "claude"],
      attackVerifier: "codex",
      harnessMaintainer: "codex",
      rounds: 3,
      maxAttacksPerRound: 3,
      infrastructureRecoveryRound: true,
      maxHeldOutCasesPerDefect: 2,
      testCommand: "node --test",
      integrationProfile: {
        setupCommand: `node -e ${JSON.stringify(
          [
            "const fs = require('node:fs')",
            `const marker = ${JSON.stringify(integrationRetryMarker)}`,
            "if (fs.existsSync('.contaminated')) process.exit(2)",
            "if (!fs.existsSync(marker)) { fs.writeFileSync(marker, 'retry'); fs.writeFileSync('.contaminated', '1'); process.exit(1) }",
            "fs.writeFileSync('.arena-service', 'ready')",
          ].join("; "),
        )}`,
        checkCommand:
          "node -e \"if (!require('node:fs').existsSync('.arena-service')) process.exit(1)\"",
        teardownCommand:
          "node -e \"require('node:fs').rmSync('.arena-service', { force: true })\"",
        services: ["mock-slug-dependency"],
        capabilityIds: ["local_mock_service"],
        steadyStateInvariants: ["run-owned marker is ready"],
        faultControls: ["restart", "disconnect"],
      },
      repositoryRoot,
      artifactRoot: path.join(repositoryRoot, ".agent-arena", "runs"),
      permissionMode: "confirm",
      permissionAllow: {},
      permissionDeny: [],
      reducedValidationAccepted: false,
      nonInteractiveApproval: true,
      keepWorktrees: false,
      limits: {
        implementationMs: 10_000,
        attackMs: 10_000,
        verifierMs: 10_000,
        repairMs: 10_000,
      },
    });
    const adapters = {
      codex: new CommandAgentAdapter({
        id: "codex",
        executable: process.execPath,
        args: [fixtureAgent],
      }),
      claude: new CommandAgentAdapter({
        id: "claude",
        executable: process.execPath,
        args: [fixtureAgent],
      }),
    };
    const houseScout = new CommandHouseScout("codex", {
      executable: process.execPath,
      args: [fixtureAgent],
    });
    const scout = vi
      .spyOn(houseScout, "scout")
      .mockRejectedValueOnce(new Error("transient house scout outage"));
    const caseBuilder = new CommandCaseBuilder("codex", {
      executable: process.execPath,
      args: [fixtureAgent],
    });
    const originalBuild = caseBuilder.build.bind(caseBuilder);
    let heldOutFailedOnce = false;
    vi.spyOn(caseBuilder, "build").mockImplementation((input) => {
      if (
        !heldOutFailedOnce &&
        input.prompt.includes("Held-out sibling case builder")
      ) {
        heldOutFailedOnce = true;
        return Promise.reject(new Error("transient held-out builder outage"));
      }
      return originalBuild(input);
    });
    const outcome = await new Arena({
      adapters,
      verifier: new RuleBasedVerifier("codex"),
      houseScout,
      caseBuilder,
      issueResolver,
    }).fight(config);
    await rm(integrationRetryMarker, { force: true });

    expect(outcome.state.status).toBe("complete");
    expect(scout.mock.calls.length).toBeGreaterThan(1);
    const houseRetry = outcome.state.failureRecords.find((record) =>
      record.subject.startsWith("house-scout:"),
    );
    expect(houseRetry).toMatchObject({
      terminalDisposition: "recovered",
      attempts: [
        expect.objectContaining({ attempt: 1, status: "failed" }),
        expect.objectContaining({ attempt: 2, status: "succeeded" }),
      ],
    });
    const caseBuilderRetry = outcome.state.failureRecords.find((record) =>
      record.subject.startsWith("held-out-case-generation:"),
    );
    expect(caseBuilderRetry).toMatchObject({
      terminalDisposition: "recovered",
      attempts: [
        expect.objectContaining({ attempt: 1, status: "failed" }),
        expect.objectContaining({ attempt: 2, status: "succeeded" }),
      ],
    });
    expect(outcome.state.promptManifests).toHaveLength(3);
    expect(
      new Set(
        outcome.state.promptManifests.map((manifest) => manifest.promptHash),
      ).size,
    ).toBe(3);
    expect(outcome.state.attacks.map((attack) => attack.status)).toEqual(
      expect.arrayContaining(["landed", "blocked"]),
    );
    expect(outcome.state.attackInvocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attacker: "a",
          target: "b",
          submissionStatus: "submitted",
          attackCount: 1,
        }),
        expect.objectContaining({
          attacker: "b",
          target: "a",
          round: 2,
          submissionStatus: "not_submitted",
          attackCount: 0,
        }),
      ]),
    );
    for (const invocation of outcome.state.attackInvocations) {
      expect(invocation.handoffPacketId).toBeTruthy();
      expect(invocation.handoffPacketDigest).toHaveLength(64);
      expect(invocation.handoffTargetFingerprint).toHaveLength(64);
    }
    expect(
      outcome.state.attackInvocations.filter(
        (entry) =>
          entry.attacker === "b" && entry.target === "a" && entry.round === 2,
      ),
    ).toHaveLength(2);
    expect(outcome.state.reviewInvocations).toHaveLength(6);
    expect(outcome.state.reviewInvocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reviewer: "a",
          target: "b",
          round: 1,
          submissionStatus: "submitted",
          findingCount: 1,
        }),
      ]),
    );
    const packetIds = new Set<string>();
    for (const reviewInvocation of outcome.state.reviewInvocations) {
      expect(reviewInvocation.artifactPath).toBeTruthy();
      const packetBytes = await readFile(reviewInvocation.artifactPath!);
      const packet = assertEvidenceHandoffPacketIntrinsic(
        EvidenceHandoffPacketSchema.parse(
          JSON.parse(packetBytes.toString("utf8")),
        ),
      );
      expect(packetBytes.toString("utf8")).toBe(canonicalHandoffJson(packet));
      expect(packet.version).toBe(2);
      expect(packetIds.has(packet.packet_id)).toBe(false);
      packetIds.add(packet.packet_id);
      expect(packet.round_id).toBe(`round_${String(reviewInvocation.round)}`);
      expect(packet.reviewer_slot).toBe(reviewInvocation.reviewer);
      expect(packet.target_slot).toBe(reviewInvocation.target);
      const prompt = await readFile(
        path.join(
          outcome.state.artifacts.runDirectory!,
          "prompts",
          `round-${String(reviewInvocation.round)}-${reviewInvocation.reviewer}.md`,
        ),
        "utf8",
      );
      expect(prompt).toContain(
        `${canonicalHandoffJson(packet)}\n# Attack instructions`,
      );
      expect(prompt).not.toContain("diff --git");
      expect(prompt).not.toContain('"provider": "codex"');
      expect(prompt).not.toContain('"provider": "claude"');
    }
    expect(packetIds.size).toBe(6);
    const reviewArtifactPath = outcome.state.reviewInvocations.find(
      (invocation) => invocation.reviewer === "a" && invocation.round === 1,
    )?.artifactPath;
    const reviewArtifact = JSON.parse(
      await readFile(reviewArtifactPath!, "utf8"),
    ) as {
      version: number;
      packet_id: string;
      packet_digest: string;
      target_snapshot: { frozen_patch_sha256: string };
      findings: Array<{ invariant: string }>;
    };
    expect(reviewArtifact.version).toBe(2);
    expect(reviewArtifact.packet_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(reviewArtifact.packet_digest).toHaveLength(64);
    expect(reviewArtifact.target_snapshot.frozen_patch_sha256).toHaveLength(64);
    expect(reviewArtifact.findings[0]?.invariant).toContain(
      "run of whitespace",
    );
    const attackPrompt = await readFile(
      path.join(
        outcome.state.artifacts.runDirectory!,
        "prompts",
        "round-1-a.md",
      ),
      "utf8",
    );
    expect(attackPrompt).toContain("Trusted evidence handoff v2");
    expect(attackPrompt).toContain("run of whitespace");
    expect(attackPrompt).not.toContain("diff --git");
    expect(attackPrompt).not.toContain('"provider": "codex"');
    expect(attackPrompt).not.toContain('"provider": "claude"');
    expect(attackPrompt).toContain("CSS selectors are not accepted");
    const repairPrompt = await readFile(
      path.join(
        outcome.state.artifacts.runDirectory!,
        "prompts",
        "round-1-repair-b.md",
      ),
      "utf8",
    );
    expect(repairPrompt).not.toContain("suggestedMinimalRegressionTest");
    expect(
      outcome.state.attackInvocations.find(
        (invocation) => invocation.attacker === "a" && invocation.round === 3,
      ),
    ).toMatchObject({
      submissionStatus: "submitted",
      attackCount: 0,
    });
    const landed = outcome.state.attacks.find(
      (attack) => attack.status === "landed",
    );
    expect(landed?.severity).toBe("high");
    expect(landed?.caseBundle?.cases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          visibility: "held_out",
          category: "alternate_whitespace",
          status: "revealed",
        }),
      ]),
    );
    const house = outcome.state.attacks.find(
      (attack) => attack.origin.kind === "house",
    );
    expect(house).toMatchObject({
      status: "landed",
      severity: "medium",
      evidenceProvenance: "mechanical",
      adjudication: {
        verdict: "valid",
        evidenceBasis: "mechanical",
      },
      targets: ["b"],
    });
    expect(house?.rank).toBeUndefined();
    const houseAdjudication = JSON.parse(
      await readFile(
        path.join(
          outcome.state.artifacts.runDirectory!,
          "rounds",
          String(house!.round),
          "adjudications",
          `${house!.id}.json`,
        ),
        "utf8",
      ),
    ) as { evidenceBasis: string };
    expect(houseAdjudication.evidenceBasis).toBe("mechanical");
    expect(
      outcome.state.contestants.b?.healthEvents.map((event) => event.type),
    ).toEqual(expect.arrayContaining(["target_damage", "recoil", "heal"]));
    expect(outcome.state.contestants.b?.finalHealth).toBe(95);
    expect(outcome.state.contestants.b?.rounds[0]).toMatchObject({
      endingHealth: 65,
    });
    expect(outcome.state.ranking?.winner).toBe("a");
    expect(
      outcome.state.contestants.a?.checks.filter(
        (check) => check.kind === "service_health",
      ),
    ).toHaveLength(8);
    expect(outcome.state.failureRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "service",
          subject: "integration-a-setup",
          terminalDisposition: "recovered",
          attempts: [
            expect.objectContaining({ attempt: 1, status: "failed" }),
            expect.objectContaining({ attempt: 2, status: "succeeded" }),
          ],
        }),
      ]),
    );
    expect(outcome.state.warnings).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Integration profile did not pass symmetrically",
        ),
      ]),
    );

    const result = JSON.parse(
      await readFile(
        path.join(outcome.state.artifacts.runDirectory!, "result.json"),
        "utf8",
      ),
    ) as { schemaVersion: number; stage: string };
    expect(result).toMatchObject({ schemaVersion: 8, stage: "complete" });
    const roundDirectory = path.join(
      outcome.state.artifacts.runDirectory!,
      "rounds",
    );
    const roundOneSnapshot = RoundSnapshotSchema.parse(
      JSON.parse(
        await readFile(path.join(roundDirectory, "1", "snapshot.json"), "utf8"),
      ),
    );
    expect(roundOneSnapshot.contestants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ patch: null, status: "pending" }),
      ]),
    );
    const roundOneReplay = RoundReplaySchema.parse(
      JSON.parse(
        await readFile(path.join(roundDirectory, "1", "replay.json"), "utf8"),
      ),
    );
    expect(roundOneReplay.replayHash).toBe(calculateReplayHash(roundOneReplay));
    expect(roundOneReplay.invocations.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "implementation",
        "review",
        "attack",
        "case_generation",
        "verification",
        "repair",
      ]),
    );
    for (const contestant of roundOneSnapshot.contestants) {
      let health = contestant.health;
      for (const event of roundOneReplay.scoreEvents.filter(
        (entry) => entry.contestantId === contestant.contestantId,
      )) {
        health = Math.max(0, Math.min(100, health + event.amount));
        expect(event.healthAfter).toBe(health);
      }
    }
    expect(
      roundOneReplay.artifacts.find(
        (artifact) => artifact.id === roundOneReplay.stateDeltaArtifactId,
      ),
    ).toMatchObject({ kind: "round_state_delta" });
    const roundOneDelta = RoundStateDeltaSchema.parse(
      JSON.parse(
        await readFile(
          path.join(roundDirectory, "1", "state-delta.json"),
          "utf8",
        ),
      ),
    );
    expect(roundOneDelta.attacks.length).toBeGreaterThan(0);
    expect(roundOneDelta.checks.length).toBeGreaterThan(0);
    const roundTwoReplay = RoundReplaySchema.parse(
      JSON.parse(
        await readFile(path.join(roundDirectory, "2", "replay.json"), "utf8"),
      ),
    );
    expect(roundTwoReplay.priorReplayHash).toBe(roundOneReplay.replayHash);
    const roundTwoSnapshot = RoundSnapshotSchema.parse(
      JSON.parse(
        await readFile(path.join(roundDirectory, "2", "snapshot.json"), "utf8"),
      ),
    );
    for (const defect of roundTwoSnapshot.knownDefects) {
      const target = roundTwoSnapshot.contestants.find(
        (contestant) => contestant.contestantId === defect.target,
      );
      expect(defect.status).toBe(
        target?.activeDefects.some(
          (active) => active.defectId === defect.defectId,
        )
          ? "active"
          : "healed",
      );
    }
    const report = await readFile(
      path.join(outcome.state.artifacts.runDirectory!, "BATTLE.md"),
      "utf8",
    );
    expect(report).toContain("Provisional leader: **a**");
    expect(report).toContain("### Generation activity");
    expect(report).toContain("not_submitted");
    expect(report).toContain("Repeated whitespace is not collapsed");
    const runSpec = JSON.parse(
      await readFile(
        path.join(outcome.state.artifacts.runDirectory!, "run-spec.json"),
        "utf8",
      ),
    ) as {
      contentHash: string;
      task: { sources: Array<{ kind: string; snapshotPath: string }> };
    };
    expect(outcome.state.schemaVersion).toBe(7);
    if (outcome.state.schemaVersion !== 7) throw new Error("expected v7 state");
    expect(outcome.state.runSpecHash).toBe(runSpec.contentHash);
    const issueSnapshot = runSpec.task.sources.find(
      (source) => source.kind === "issue",
    );
    expect(await readFile(issueSnapshot!.snapshotPath, "utf8")).toContain(
      "service-maintainer",
    );

    await resolveCoverage({
      runId: outcome.state.runId,
      repositoryRoot,
      assessmentDigest:
        outcome.state.coverageAssessment?.assessmentDigest ?? "",
      decision: "accept-reduced",
    });
    const prompt = await reviewRun({
      runId: outcome.state.runId,
      repositoryRoot,
    });
    const selected = prompt.choices.find(
      (choice) => choice.contestantId === "a",
    )!;
    await recordReviewDecision({
      runId: outcome.state.runId,
      repositoryRoot,
      promptId: prompt.promptId,
      decision: "accept",
      selection: "a",
      expectedPatchSha256: selected.patchSha256,
      expectedBaseCommit: prompt.baseCommit,
      approval: {
        channel: "api",
        promptId: prompt.promptId,
        provenance: {
          kind: "direct_tty",
          confirmedPatchSha256: selected.patchSha256,
        },
      },
      idempotencyKey: "integration-review",
    });
    await expect(
      applyAcceptedPatch({
        runId: outcome.state.runId,
        repositoryRoot,
        expectedPatchSha256: selected.patchSha256,
        idempotencyKey: "integration-apply",
      }),
    ).resolves.toMatchObject({ testCommand: "node --test" });
    expect(
      (await execa("node", ["--test"], { cwd: repositoryRoot })).exitCode,
    ).toBe(0);
  });

  it("records judge-unable verifier infrastructure without an extra round", async () => {
    const repositoryRoot = await createSlugRepository();
    const config = FightConfigSchema.parse({
      task: "Fix issue #87: collapse every whitespace run while keeping lowercase slugs.",
      acceptanceCriteria: ["Collapse every whitespace run to one hyphen."],
      specPaths: [],
      issueReferences: [],
      agents: ["codex", "claude"],
      attackVerifier: "codex",
      harnessMaintainer: "codex",
      rounds: 3,
      maxAttacksPerRound: 3,
      infrastructureRecoveryRound: true,
      maxHeldOutCasesPerDefect: 0,
      testCommand: "node --test",
      repositoryRoot,
      artifactRoot: path.join(repositoryRoot, ".agent-arena", "runs"),
      permissionMode: "confirm",
      permissionAllow: {},
      permissionDeny: [],
      reducedValidationAccepted: false,
      nonInteractiveApproval: true,
      keepWorktrees: false,
      limits: {
        implementationMs: 10_000,
        attackMs: 10_000,
        verifierMs: 10_000,
        repairMs: 10_000,
      },
    });
    const adapters = {
      codex: new CommandAgentAdapter({
        id: "codex",
        executable: process.execPath,
        args: [fixtureAgent],
      }),
      claude: new CommandAgentAdapter({
        id: "claude",
        executable: process.execPath,
        args: [fixtureAgent],
      }),
    };
    const fallback = new RuleBasedVerifier("codex");
    const outcome = await new Arena({
      adapters,
      verifier: {
        id: "codex",
        assess(input) {
          if (input.attack.claim.includes("Repeated whitespace")) {
            return Promise.reject(new Error("mock verifier outage"));
          }
          return fallback.assess(input);
        },
      },
      caseBuilder: new CommandCaseBuilder("codex", {
        executable: process.execPath,
        args: [fixtureAgent],
      }),
    }).fight(config);
    expect(outcome.state.coverageAssessment).toMatchObject({
      confidence: "provisional",
    });
    expect(outcome.state.coverageAssessment?.reasonCodes).toContain(
      "attack_judge_unable",
    );
    expect(outcome.state.contestants.a?.rounds.at(-1)?.round).toBe(3);
    expect(
      outcome.state.attacks.some((attack) => attack.status === "judge_unable"),
    ).toBe(true);
    expect(outcome.state.failureRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ terminalDisposition: "judge_unable" }),
      ]),
    );
  });
});
