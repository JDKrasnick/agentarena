import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, rm, writeFile } from "node:fs/promises";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import {
  CommandAgentAdapter,
  CommandCaseBuilder,
  RuleBasedVerifier,
} from "../../src/agents/adapter.js";
import { ArtifactStore } from "../../src/artifacts/store.js";
import { applyAcceptedPatch } from "../../src/commands/apply.js";
import { Arena } from "../../src/core/arena.js";
import type {
  BrowserAdapter,
  BrowserSession,
} from "../../src/browser/executor.js";
import { FightConfigSchema, RunStateV7Schema } from "../../src/core/types.js";
import type { ArenaEvent } from "../../src/observability/events.js";
import { readBaseline } from "../../src/recovery/durable.js";
import { recordReviewDecision, reviewRun } from "../../src/review/service.js";
import { freezePullRequest } from "../../src/task/pr-fixture.js";
import type { PullRequestResolver } from "../../src/task/task-contract.js";
import { createSlugRepository } from "../helpers/repository.js";

const fixtureAgent = fileURLToPath(
  new URL("../fixtures/fake-agent.mjs", import.meta.url),
);

async function fixturePullRequest(
  repositoryRoot: string,
  implementation = 'export function slug(value) {\n  return value.trim().toLowerCase().replaceAll(" ", "-");\n}\n',
  attributed = true,
): Promise<PullRequestResolver> {
  const baseCommit = (
    await execa("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
  ).stdout;
  if (implementation) {
    await writeFile(
      path.join(repositoryRoot, "src", "slug.mjs"),
      implementation,
    );
    await execa("git", ["add", "."], { cwd: repositoryRoot });
    await execa("git", ["commit", "-m", "[codex] PR implementation"], {
      cwd: repositoryRoot,
    });
  }
  const headCommit = (
    await execa("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
  ).stdout;
  return {
    resolve: () =>
      Promise.resolve({
        origin: "https://github.com/acme/slug/pull/9",
        url: "https://github.com/acme/slug/pull/9",
        repository: "acme/slug",
        number: 9,
        title: attributed ? "[codex] Normalize slugs" : "Normalize slugs",
        body: "Collapse every run of whitespace to one hyphen.",
        author: attributed ? "codex-bot" : "octocat",
        comments: [],
        baseBranch: "main",
        baseCommit,
        headBranch: attributed ? "codex/slug" : "feature/slug",
        headRepository: "acme/slug",
        headCommit,
        commits: [],
        linkedIssues: [],
      }),
  };
}

function adapters(
  options: { skipDefenderRepair?: boolean; browserSiege?: boolean } = {},
) {
  return {
    codex: new CommandAgentAdapter({
      id: "codex",
      executable: process.execPath,
      args: [fixtureAgent],
      ...(options.browserSiege
        ? { environment: { AGENT_ARENA_FAKE_BROWSER_SIEGE: "1" } }
        : {}),
    }),
    claude: new CommandAgentAdapter({
      id: "claude",
      executable: process.execPath,
      args: [fixtureAgent],
      ...(options.skipDefenderRepair
        ? { environment: { AGENT_ARENA_FAKE_SKIP_REPAIR: "1" } }
        : {}),
    }),
  };
}

function slugBrowserAdapter(): BrowserAdapter {
  return {
    runner: "playwright",
    async launch(input): Promise<BrowserSession> {
      const source = await readFile(
        path.join(input.worktree, "src", "slug.mjs"),
        "utf8",
      );
      const repeatedWhitespaceBroken =
        source.includes('replaceAll(" ", "-")') &&
        !source.includes('replace("   ", "-")');
      return {
        toolVersion: "fake-browser-1",
        browserVersion: "fake-chromium-1",
        artifacts: [],
        waitUntilReady: () => Promise.resolve(),
        runNativeSuite: () =>
          Promise.resolve({
            family: "visual_regression",
            profile: "repository_native",
            status: "verified",
            blockedOrigins: [],
            artifacts: [],
          }),
        runProbe: ({ request, harnessOwned }) => {
          const failed =
            !harnessOwned &&
            request.id === "slug-browser-whitespace" &&
            repeatedWhitespaceBroken;
          return Promise.resolve({
            family: request.family,
            profile: request.profile,
            status: failed ? "failed" : "verified",
            ...(failed ? { reason: "application_failure" as const } : {}),
            blockedOrigins: [],
            artifacts: [],
          });
        },
        stop: () => Promise.resolve(),
      };
    },
  };
}

function config(repositoryRoot: string, mode: "catch_up" | "siege") {
  return FightConfigSchema.parse({
    task: "Collapse every run of whitespace to one hyphen.",
    mode,
    acceptanceCriteria: ["Collapse every run of whitespace to one hyphen."],
    specPaths: [],
    issueReferences: [],
    pullRequestReferences: ["9"],
    contestants:
      mode === "catch_up"
        ? [
            {
              id: "a",
              provider: "codex",
              role: "incumbent",
              startingPatch: "pull_request",
            },
            {
              id: "b",
              provider: "claude",
              role: "challenger",
              startingPatch: "none",
            },
          ]
        : [
            {
              id: "a",
              provider: "codex",
              role: "attacker",
              startingPatch: "none",
            },
            {
              id: "b",
              provider: "claude",
              role: "defender",
              startingPatch: "pull_request",
            },
          ],
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
}

describe("PR battle modes", () => {
  it("keeps the frozen incumbent patch out of the challenger implementation phase", async () => {
    const repositoryRoot = await createSlugRepository();
    const pullRequestResolver = await fixturePullRequest(repositoryRoot);
    const arena = new Arena({
      adapters: adapters(),
      verifier: new RuleBasedVerifier("codex"),
      caseBuilder: new CommandCaseBuilder("codex", {
        executable: process.execPath,
        args: [fixtureAgent],
      }),
      pullRequestResolver,
      freezePullRequest: (options) =>
        freezePullRequest({
          ...options,
          fetchCommit: (_root, _repository, commit) => Promise.resolve(commit),
        }),
    });
    const outcome = await arena.fight(config(repositoryRoot, "catch_up"));

    expect(outcome.state.status).toBe("complete");
    expect(outcome.state.pullRequestFixture?.head.commit).toBeTruthy();
    expect(outcome.summary).toContain(
      "Incumbent attribution: confirmed (codex)",
    );
    expect(outcome.state.contestants.a?.implementation).toBeUndefined();
    const challengerPrompt = await readFile(
      outcome.state.contestants.b!.implementation!.promptPath,
      "utf8",
    );
    expect(challengerPrompt).not.toContain('replaceAll(" ", "-")');
    expect(outcome.state.contestants.a?.checks[0]?.id).toBe("initial-required");
    expect(outcome.state.coverageAssessment?.confidence).toBe("provisional");
    expect(outcome.state.reviewPrompt).toBeUndefined();
    expect(await readFile(outcome.state.artifacts.battle!, "utf8")).toContain(
      "| bot_author | pull_request.author | codex-bot |",
    );

    const store = new ArtifactStore(
      path.join(repositoryRoot, ".agent-arena", "runs"),
      outcome.state.runId,
      { durableV5: true },
    );
    const baseline = await readBaseline(store);
    const baselineState = RunStateV7Schema.parse(
      structuredClone(baseline.state),
    );
    await Promise.all([
      rm(store.resolve("rounds"), { recursive: true, force: true }),
      rm(store.resolve("checkpoints"), { recursive: true, force: true }),
      rm(store.resolve("feedback"), { recursive: true, force: true }),
      rm(store.resolve("quality"), { recursive: true, force: true }),
      rm(store.resolve("coverage"), { recursive: true, force: true }),
      rm(store.resolve("finalization.json"), { force: true }),
      rm(store.resolve("review-prompt.json"), { force: true }),
    ]);
    await store.initialize();
    await store.writeState(baselineState, []);

    const resumed = await arena.resume({
      runId: outcome.state.runId,
      repositoryRoot,
    });
    expect(resumed.state.status).toBe("complete");
    expect(resumed.state.contestants.a?.currentPatchPath).toBe(
      resumed.state.pullRequestFixture?.patchPath,
    );
    expect(resumed.state.contestants.a?.checks[0]?.id).toBe("initial-required");
  });

  it("does not award a catch-up forfeit when the challenger is ineligible", async () => {
    const repositoryRoot = await createSlugRepository();
    const pullRequestResolver = await fixturePullRequest(repositoryRoot);
    const outcome = await new Arena({
      adapters: {
        codex: adapters().codex,
        claude: new CommandAgentAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
          environment: { AGENT_ARENA_EMPTY_IMPLEMENTATION: "1" },
        }),
      },
      verifier: new RuleBasedVerifier("codex"),
      pullRequestResolver,
      freezePullRequest: (options) =>
        freezePullRequest({
          ...options,
          fetchCommit: (_root, _repository, commit) => Promise.resolve(commit),
        }),
    }).fight(config(repositoryRoot, "catch_up"));

    expect(outcome.state.status).toBe("inconclusive");
    expect(outcome.state.terminalOutcome).toMatchObject({
      phase: "pre_review",
      kind: "inconclusive",
      reasonCode: "implementation_empty_patch",
      eligibleContestantIds: ["a"],
    });
    expect(outcome.state.patchRecommendation).toBeUndefined();
    expect(outcome.state.reviewPrompt).toBeUndefined();
  });

  it("runs a siege with test-only attacker evidence and makes only the defender reviewable", async () => {
    const repositoryRoot = await createSlugRepository();
    const pullRequestResolver = await fixturePullRequest(repositoryRoot);
    const outcome = await new Arena({
      adapters: adapters(),
      verifier: new RuleBasedVerifier("codex"),
      caseBuilder: new CommandCaseBuilder("codex", {
        executable: process.execPath,
        args: [fixtureAgent],
      }),
      pullRequestResolver,
      freezePullRequest: (options) =>
        freezePullRequest({
          ...options,
          fetchCommit: (_root, _repository, commit) => Promise.resolve(commit),
        }),
    }).fight(config(repositoryRoot, "siege"));

    expect(outcome.state.status).toBe("complete");
    expect(outcome.state.contestants.a?.implementation).toBeUndefined();
    expect(outcome.state.contestants.a?.finalPatchPath).toBeUndefined();
    const attackerAttack = outcome.state.attacks.find(
      (attack) =>
        attack.origin.kind === "contestant" && attack.origin.contestant === "a",
    );
    expect(attackerAttack?.targets).toEqual(["b"]);
    expect(attackerAttack?.status).toBe("landed");
    expect(attackerAttack?.adjudication).toMatchObject({
      verdict: "valid",
      evidenceBasis: "mechanical",
    });
    const attackerAdjudication = JSON.parse(
      await readFile(
        path.join(
          outcome.state.artifacts.runDirectory!,
          "rounds",
          String(attackerAttack!.round),
          "adjudications",
          `${attackerAttack!.id}.json`,
        ),
        "utf8",
      ),
    ) as { evidenceBasis: string };
    expect(attackerAdjudication.evidenceBasis).toBe("mechanical");
    const replay = JSON.parse(
      await readFile(
        path.join(
          outcome.state.artifacts.runDirectory!,
          "rounds",
          String(attackerAttack!.round),
          "replay.json",
        ),
        "utf8",
      ),
    ) as {
      repairs: Array<{
        contestantId: string;
        status: string;
        healedDefectIds: string[];
      }>;
      scoreEvents: Array<{
        contestantId: string;
        type: string;
        defectId?: string;
      }>;
    };
    const healedEvent = replay.scoreEvents.find(
      (event) => event.contestantId === "b" && event.type === "heal",
    );
    expect(healedEvent?.defectId).toBe(attackerAttack?.rootDefectId);
    expect(replay.repairs).toContainEqual(
      expect.objectContaining({
        contestantId: "b",
        status: "repaired",
        healedDefectIds: [attackerAttack!.rootDefectId!],
      }),
    );
    expect(outcome.state.contestants.b?.healthEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "heal" })]),
    );
    expect(outcome.state.reviewPrompt?.choices).toHaveLength(1);
    expect(outcome.state.reviewPrompt?.choices[0]?.contestantId).toBe("b");
    expect(outcome.state.patchRecommendation).toBeUndefined();
    expect(outcome.state.ranking).toMatchObject({
      winner: null,
      draw: true,
    });

    const prompt = await reviewRun({
      runId: outcome.state.runId,
      repositoryRoot,
    });
    const defender = prompt.choices[0];
    if (!defender) throw new Error("Siege defender must be reviewable");
    await recordReviewDecision({
      runId: outcome.state.runId,
      repositoryRoot,
      promptId: prompt.promptId,
      decision: "accept",
      selection: defender.contestantId,
      expectedPatchSha256: defender.patchSha256,
      expectedBaseCommit: prompt.baseCommit,
      approval: {
        channel: "cli",
        promptId: prompt.promptId,
        provenance: {
          kind: "direct_tty",
          confirmedPatchSha256: defender.patchSha256,
        },
      },
      idempotencyKey: "accept-siege-defender",
    });
    await execa("git", ["reset", "--hard", prompt.baseCommit], {
      cwd: repositoryRoot,
    });
    const applied = await applyAcceptedPatch({
      runId: outcome.state.runId,
      repositoryRoot,
      expectedPatchSha256: defender.patchSha256,
      idempotencyKey: "apply-siege-defender",
    });
    expect(applied.contestantId).toBe("b");
    expect(
      await readFile(path.join(repositoryRoot, "src", "slug.mjs"), "utf8"),
    ).toContain('replace("   ", "-").replaceAll(" ", "-")');
  });

  it("runs and heals browser-only evidence through the asymmetric siege lane", async () => {
    const repositoryRoot = await createSlugRepository();
    const pullRequestResolver = await fixturePullRequest(repositoryRoot);
    const observedEvents: ArenaEvent[] = [];
    const battleConfig = FightConfigSchema.parse({
      ...config(repositoryRoot, "siege"),
      task: "Render browser-entered titles with every whitespace run collapsed to one hyphen.",
      acceptanceCriteria: [
        "Three spaces entered through the browser produce one hyphen.",
      ],
      browserProfile: {
        runner: "playwright",
        startupCommand: "node server.mjs",
        healthUrl: "http://127.0.0.1:4173/health",
        baseUrl: "http://127.0.0.1:4173",
        testCommand: "node --test",
        portMode: "fixed",
        nativeSuiteMode: "reuse_started_service",
        projects: [],
        allowedOrigins: ["http://127.0.0.1:4173"],
      },
    });
    const outcome = await new Arena({
      adapters: adapters({ browserSiege: true }),
      verifier: new RuleBasedVerifier("codex"),
      browserAdapters: { playwright: slugBrowserAdapter() },
      observer: { publish: (event) => void observedEvents.push(event) },
      pullRequestResolver,
      freezePullRequest: (options) =>
        freezePullRequest({
          ...options,
          fetchCommit: (_root, _repository, commit) => Promise.resolve(commit),
        }),
    }).fight(battleConfig);

    const browserAttack = outcome.state.attacks.find(
      (candidate) => candidate.evidenceKind === "browser_probe",
    );
    expect(browserAttack).toMatchObject({
      status: "landed",
      damageActive: false,
    });
    expect(typeof browserAttack?.rootDefectId).toBe("string");
    expect(browserAttack?.outcomeReason).not.toContain("house attack");
    expect(browserAttack?.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        "baseline-browser-probe",
        "target-browser-probe",
      ]),
    );
    expect(
      browserAttack?.checks.some((check) => check.kind === "focused"),
    ).toBe(false);
    expect(browserAttack?.browserArtifactRefs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /browser\/attacks\/.+\/baseline-1-result\.json$/u,
        ),
        expect.stringMatching(/browser\/attacks\/.+\/target-1-result\.json$/u),
      ]),
    );
    expect(outcome.state.contestants.b?.healthEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "target_damage", amount: -30 }),
        expect.objectContaining({ type: "heal", amount: 30 }),
      ]),
    );
    expect(outcome.state.contestants.b?.browserValidation?.status).toBe(
      "verified",
    );
    const report = await readFile(outcome.state.artifacts.battle!, "utf8");
    expect(report).toContain("browser artifact 1");
    expect(report).not.toContain("Both patches block the house attack");
    const browserStarts = observedEvents.filter(
      (event) => event.type === "browser_session_started",
    );
    const browserFinishes = observedEvents.filter(
      (event) => event.type === "browser_session_finished",
    );
    expect(browserStarts.length).toBeGreaterThan(0);
    expect(
      browserStarts.some(
        (event) =>
          event.label.includes("target") &&
          event.url === "http://127.0.0.1:4173" &&
          event.runner === "playwright",
      ),
    ).toBe(true);
    expect(browserFinishes.map((event) => event.sessionId).sort()).toEqual(
      browserStarts.map((event) => event.sessionId).sort(),
    );
  });

  it("awards an unresolved siege defect to the attacker", async () => {
    const repositoryRoot = await createSlugRepository();
    const pullRequestResolver = await fixturePullRequest(repositoryRoot);
    const outcome = await new Arena({
      adapters: adapters({ skipDefenderRepair: true }),
      verifier: new RuleBasedVerifier("codex"),
      caseBuilder: new CommandCaseBuilder("codex", {
        executable: process.execPath,
        args: [fixtureAgent],
      }),
      pullRequestResolver,
      freezePullRequest: (options) =>
        freezePullRequest({
          ...options,
          fetchCommit: (_root, _repository, commit) => Promise.resolve(commit),
        }),
    }).fight(config(repositoryRoot, "siege"));

    expect(outcome.state.ranking).toMatchObject({
      winner: "a",
      draw: false,
    });
    expect(outcome.state.contestants.a?.finalHealth).toBe(100);
    expect(outcome.state.contestants.b?.finalHealth).toBe(70);
    expect(
      outcome.state.contestants.b?.healthLedger.activeDefects,
    ).toHaveLength(1);
  });

  it("recoils a missed siege attack and awards the fight to the defender", async () => {
    const repositoryRoot = await createSlugRepository();
    const pullRequestResolver = await fixturePullRequest(
      repositoryRoot,
      'export function slug(value) {\n  return value.trim().toLowerCase().replace(/\\s+/g, "-");\n}\n',
    );
    const outcome = await new Arena({
      adapters: adapters(),
      verifier: new RuleBasedVerifier("codex"),
      caseBuilder: new CommandCaseBuilder("codex", {
        executable: process.execPath,
        args: [fixtureAgent],
      }),
      pullRequestResolver,
      freezePullRequest: (options) =>
        freezePullRequest({
          ...options,
          fetchCommit: (_root, _repository, commit) => Promise.resolve(commit),
        }),
    }).fight(config(repositoryRoot, "siege"));

    expect(outcome.state.ranking).toMatchObject({
      winner: "b",
      draw: false,
    });
    expect(outcome.state.contestants.a?.finalHealth).toBe(95);
    expect(outcome.state.contestants.b?.finalHealth).toBe(100);
    expect(outcome.state.contestants.a?.healthLedger.permanentRecoil).toBe(5);
  });

  it("rejects an empty frozen PR patch before the battle starts", async () => {
    const repositoryRoot = await createSlugRepository();
    const pullRequestResolver = await fixturePullRequest(repositoryRoot, "");
    const arena = new Arena({
      adapters: adapters(),
      verifier: new RuleBasedVerifier("codex"),
      pullRequestResolver,
      freezePullRequest: (options) =>
        freezePullRequest({
          ...options,
          fetchCommit: (_root, _repository, commit) => Promise.resolve(commit),
        }),
    });

    await expect(arena.fight(config(repositoryRoot, "siege"))).rejects.toThrow(
      "Frozen PR patch is empty",
    );
  });

  it("requires an explicit incumbent provider when PR attribution is unknown", async () => {
    const repositoryRoot = await createSlugRepository();
    const pullRequestResolver = await fixturePullRequest(
      repositoryRoot,
      'export function slug(value) {\n  return value.trim().toLowerCase().replace(/\\s+/g, "-");\n}\n',
      false,
    );
    const arena = new Arena({
      adapters: adapters(),
      verifier: new RuleBasedVerifier("codex"),
      pullRequestResolver,
      freezePullRequest: (options) =>
        freezePullRequest({
          ...options,
          fetchCommit: (_root, _repository, commit) => Promise.resolve(commit),
        }),
    });

    await expect(
      arena.fight(config(repositoryRoot, "catch_up")),
    ).rejects.toThrow("pass --incumbent <agent>");
  });
});
