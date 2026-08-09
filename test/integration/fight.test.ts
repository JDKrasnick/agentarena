import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { execa } from "execa";
import { describe, expect, it, vi } from "vitest";
import {
  CommandAgentAdapter,
  CommandCaseBuilder,
  CommandHarnessMaintainer,
  CommandHouseScout,
  CommandInfrastructureReviewer,
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
import { FightConfigSchema } from "../../src/core/types.js";
import { recordReviewDecision, reviewRun } from "../../src/review/service.js";
import type { IssueResolver } from "../../src/task/task-contract.js";
import { createSlugRepository } from "../helpers/repository.js";

const fixtureAgent = fileURLToPath(
  new URL("../fixtures/fake-agent.mjs", import.meta.url),
);

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
    const outcome = await new Arena({
      adapters: { codex: adapter },
      verifier: new RuleBasedVerifier("codex"),
      caseBuilder: new CommandCaseBuilder("codex", {
        executable: process.execPath,
        args: [fixtureAgent],
      }),
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

  it("completes when one implementation times out without a patch", async () => {
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
    const outcome = await new Arena({
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
    }).fight(config);

    expect(outcome.state.status).toBe("complete");
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
    vi.spyOn(failed, "implement").mockImplementation((input) =>
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
    expect(run).toHaveBeenCalledOnce();
    expect(outcome.state.attacks).toEqual([]);
    expect(outcome.state.contestants.a?.currentPatchPath).toBeUndefined();
    run.mockRestore();
  });

  it("runs three rounds, lands and heals evidence, recoils a miss, and writes replayable artifacts", async () => {
    const repositoryRoot = await createSlugRepository();
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
        setupCommand:
          "node -e \"require('node:fs').writeFileSync('.arena-service', 'ready')\"",
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
    const outcome = await new Arena({
      adapters,
      verifier: new RuleBasedVerifier("codex"),
      houseScout: new CommandHouseScout("codex", {
        executable: process.execPath,
        args: [fixtureAgent],
      }),
      caseBuilder: new CommandCaseBuilder("codex", {
        executable: process.execPath,
        args: [fixtureAgent],
      }),
      issueResolver,
    }).fight(config);

    expect(outcome.state.status).toBe("complete");
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
    const reviewArtifactPath = outcome.state.reviewInvocations.find(
      (invocation) => invocation.reviewer === "a" && invocation.round === 1,
    )?.artifactPath;
    const reviewArtifact = JSON.parse(
      await readFile(reviewArtifactPath!, "utf8"),
    ) as {
      targetPatchSha256: string;
      findings: Array<{ invariant: string }>;
    };
    expect(reviewArtifact.targetPatchSha256).toHaveLength(64);
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
    expect(attackPrompt).toContain("Compact target-specific review packet");
    expect(attackPrompt).toContain("run of whitespace");
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
      targets: ["b"],
    });
    expect(house?.rank).toBeUndefined();
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
    ).toHaveLength(6);

    const result = JSON.parse(
      await readFile(
        path.join(outcome.state.artifacts.runDirectory!, "result.json"),
        "utf8",
      ),
    ) as { schemaVersion: number; stage: string };
    expect(result).toMatchObject({ schemaVersion: 4, stage: "complete" });
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
    expect(report).toContain("Winner: **a**");
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
    expect(outcome.state.schemaVersion).toBe(4);
    if (outcome.state.schemaVersion !== 4) throw new Error("expected v4 state");
    expect(outcome.state.runSpecHash).toBe(runSpec.contentHash);
    const issueSnapshot = runSpec.task.sources.find(
      (source) => source.kind === "issue",
    );
    expect(await readFile(issueSnapshot!.snapshotPath, "utf8")).toContain(
      "service-maintainer",
    );

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

  it("grants a no-fault credit for verifier infrastructure and executes one bounded recovery round", async () => {
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
      infrastructureReviewer: new CommandInfrastructureReviewer({
        codex: { executable: process.execPath, args: [fixtureAgent] },
        claude: { executable: process.execPath, args: [fixtureAgent] },
      }),
      harnessMaintainer: new CommandHarnessMaintainer("codex", {
        executable: process.execPath,
        args: [fixtureAgent],
      }),
    }).fight(config);
    const credit = outcome.state.contestants.a?.replacementCredits[0];
    expect(credit).toMatchObject({
      reason: "accepted_infrastructure",
      status: "spent",
    });
    expect(outcome.state.contestants.a?.rounds.at(-1)?.round).toBe("recovery");
    expect(
      outcome.state.attacks.find(
        (attack) => attack.id === credit?.sourceAttackId,
      )?.status,
    ).toBe("infrastructure_error");
    expect(
      outcome.state.attacks.find(
        (attack) => attack.id === credit?.sourceAttackId,
      )?.infrastructureReview,
    ).toBe("accept");
    expect(outcome.state.harnessOverlays).toEqual([
      expect.objectContaining({
        scopes: ["diagnostic"],
        status: "approved",
      }),
    ]);
  });
});
