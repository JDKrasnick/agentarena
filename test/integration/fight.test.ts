import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import {
  CommandAgentAdapter,
  CommandCaseBuilder,
  CommandHarnessMaintainer,
  CommandHouseScout,
  CommandInfrastructureReviewer,
  RuleBasedVerifier,
} from "../../src/agents/adapter.js";
import { Arena } from "../../src/core/arena.js";
import { applyAcceptedPatch } from "../../src/commands/apply.js";
import { FightConfigSchema } from "../../src/core/types.js";
import { recordReviewDecision, reviewRun } from "../../src/review/service.js";
import type { IssueResolver } from "../../src/task/task-contract.js";
import { createSlugRepository } from "../helpers/repository.js";

const fixtureAgent = fileURLToPath(
  new URL("../fixtures/fake-agent.mjs", import.meta.url),
);

describe("fake-adapter fight on a mocked real issue", () => {
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
      targets: ["codex", "claude"],
    });
    expect(house?.rank).toBeUndefined();
    expect(
      outcome.state.contestants.claude?.healthEvents.map((event) => event.type),
    ).toEqual(expect.arrayContaining(["target_damage", "recoil", "heal"]));
    expect(
      outcome.state.contestants.codex?.healthEvents
        .filter((event) => event.attackId === house?.id)
        .map((event) => event.type),
    ).toEqual(["target_damage", "heal"]);
    expect(outcome.state.contestants.claude?.finalHealth).toBe(95);
    expect(outcome.state.contestants.claude?.rounds[0]).toMatchObject({
      endingHealth: 65,
    });
    expect(outcome.state.ranking?.winner).toBe("codex");
    expect(
      outcome.state.contestants.codex?.checks.filter(
        (check) => check.kind === "service_health",
      ),
    ).toHaveLength(6);

    const result = JSON.parse(
      await readFile(
        path.join(outcome.state.artifacts.runDirectory!, "result.json"),
        "utf8",
      ),
    ) as { schemaVersion: number; stage: string };
    expect(result).toMatchObject({ schemaVersion: 2, stage: "complete" });
    const report = await readFile(
      path.join(outcome.state.artifacts.runDirectory!, "BATTLE.md"),
      "utf8",
    );
    expect(report).toContain("Winner: **codex**");
    expect(report).toContain("Repeated whitespace is not collapsed");
    const taskContract = JSON.parse(
      await readFile(
        path.join(outcome.state.artifacts.runDirectory!, "task-contract.json"),
        "utf8",
      ),
    ) as { sources: Array<{ kind: string; snapshotPath: string }> };
    const issueSnapshot = taskContract.sources.find(
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
      (choice) => choice.contestantId === "codex",
    )!;
    await recordReviewDecision({
      runId: outcome.state.runId,
      repositoryRoot,
      promptId: prompt.promptId,
      decision: "accept",
      selection: "codex",
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
      await readFile(path.join(repositoryRoot, "src", "slug.mjs"), "utf8"),
    ).toContain('throw new Error("Blank title")');
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
      infrastructureReviewer: new CommandInfrastructureReviewer({
        codex: { executable: process.execPath, args: [fixtureAgent] },
        claude: { executable: process.execPath, args: [fixtureAgent] },
      }),
      harnessMaintainer: new CommandHarnessMaintainer("codex", {
        executable: process.execPath,
        args: [fixtureAgent],
      }),
    }).fight(config);
    const credit = outcome.state.contestants.codex?.replacementCredits[0];
    expect(credit).toMatchObject({
      reason: "accepted_infrastructure",
      status: "spent",
    });
    expect(outcome.state.contestants.codex?.rounds.at(-1)?.round).toBe(
      "recovery",
    );
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
