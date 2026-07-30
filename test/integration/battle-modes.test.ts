import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { CommandAgentAdapter, RuleBasedVerifier } from "../../src/agents/adapter.js";
import { Arena } from "../../src/core/arena.js";
import { FightConfigSchema } from "../../src/core/types.js";
import { freezePullRequest } from "../../src/task/pr-fixture.js";
import type { PullRequestResolver } from "../../src/task/task-contract.js";
import { createSlugRepository } from "../helpers/repository.js";

const fixtureAgent = fileURLToPath(
  new URL("../fixtures/fake-agent.mjs", import.meta.url),
);

async function fixturePullRequest(repositoryRoot: string): Promise<PullRequestResolver> {
  const baseCommit = (
    await execa("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
  ).stdout;
  await writeFile(
    path.join(repositoryRoot, "src", "slug.mjs"),
    'export function slug(value) {\n  return value.trim().toLowerCase().replaceAll(" ", "-");\n}\n',
  );
  await execa("git", ["add", "."], { cwd: repositoryRoot });
  await execa("git", ["commit", "-m", "[codex] PR implementation"], {
    cwd: repositoryRoot,
  });
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
        title: "[codex] Normalize slugs",
        body: "Collapse every run of whitespace to one hyphen.",
        author: "codex-bot",
        comments: [],
        baseBranch: "main",
        baseCommit,
        headBranch: "codex/slug",
        headRepository: "acme/slug",
        headCommit,
        commits: [],
        linkedIssues: [],
      }),
  };
}

function adapters() {
  return {
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
            { id: "a", provider: "codex", role: "incumbent", startingPatch: "pull_request" },
            { id: "b", provider: "claude", role: "challenger", startingPatch: "none" },
          ]
        : [
            { id: "a", provider: "codex", role: "attacker", startingPatch: "none" },
            { id: "b", provider: "claude", role: "defender", startingPatch: "pull_request" },
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
    const outcome = await new Arena({
      adapters: adapters(),
      verifier: new RuleBasedVerifier("codex"),
      pullRequestResolver,
      freezePullRequest: (options) =>
        freezePullRequest({
          ...options,
          fetchCommit: (_root, _repository, commit) => Promise.resolve(commit),
        }),
    }).fight(config(repositoryRoot, "catch_up"));

    expect(outcome.state.status).toBe("complete");
    expect(outcome.state.pullRequestFixture?.head.commit).toBeTruthy();
    expect(outcome.state.contestants.a?.implementation).toBeUndefined();
    const challengerPrompt = await readFile(
      outcome.state.contestants.b!.implementation!.promptPath,
      "utf8",
    );
    expect(challengerPrompt).not.toContain('replaceAll(" ", "-")');
    expect(outcome.state.contestants.a?.checks[0]?.id).toBe("initial-required");
  });

  it("runs a siege with test-only attacker evidence and makes only the defender reviewable", async () => {
    const repositoryRoot = await createSlugRepository();
    const pullRequestResolver = await fixturePullRequest(repositoryRoot);
    const outcome = await new Arena({
      adapters: adapters(),
      verifier: new RuleBasedVerifier("codex"),
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
        attack.origin.kind === "contestant" &&
        attack.origin.contestant === "a",
    );
    expect(attackerAttack?.targets).toEqual(["b"]);
    expect(attackerAttack?.status).toBe("landed");
    expect(outcome.state.contestants.b?.healthEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "heal" })]),
    );
    expect(outcome.state.reviewPrompt?.choices).toHaveLength(1);
    expect(outcome.state.reviewPrompt?.choices[0]?.contestantId).toBe("b");
    expect(outcome.state.patchRecommendation).toBeUndefined();
  });
});
