import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execa } from "execa";
import { describe, expect, it, vi } from "vitest";
import {
  CommandAgentAdapter,
  CommandCaseBuilder,
  CommandHouseScout,
  RuleBasedVerifier,
  type AttackInput,
  type ImplementInput,
  type RepairInput,
  type ReviewInput,
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
import { cleanupRunWorktrees } from "../../src/commands/cleanup-worktrees.js";
import { resolveCoverage } from "../../src/commands/resolve-coverage.js";
import {
  AgentInvocationSchema,
  FightConfigSchema,
  type PatchQualityFacts,
} from "../../src/core/types.js";
import { recordReviewDecision, reviewRun } from "../../src/review/service.js";
import {
  buildRunSpec,
  collectFightReconnaissance,
  type IssueResolver,
} from "../../src/task/task-contract.js";
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
import { resolvePermissionPolicy } from "../../src/permissions/policy.js";
import type { PatchQualityVerifierInput } from "../../src/quality/verifier.js";
import {
  PatchCaptureIntegrityError,
  WorktreeManager,
} from "../../src/repo/git.js";
import { readWorktreeManifest } from "../../src/repo/worktree-manifest.js";

const fixtureAgent = fileURLToPath(
  new URL("../fixtures/fake-agent.mjs", import.meta.url),
);
const requiredValidationOutcomes = fileURLToPath(
  new URL("../fixtures/required-validation-outcomes.mjs", import.meta.url),
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
    effortMode: "medium",
    fixedRounds: true,
    rounds: 3,
    maxAttacksPerRound: 3,
    infrastructureRecoveryRound: true,
    maxHeldOutCasesPerDefect: 0,
    testCommand: "node --test",
    // This fixture has no external dependencies; make that intentional under
    // the frozen bootstrap contract rather than relying on discovery.
    bootstrap: "none",
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

class DeterministicTimedReviewAdapter extends CommandAgentAdapter {
  private readonly reviewAttempts = new Map<string, number>();

  constructor(
    id: "codex" | "claude",
    private readonly retryBeforeSalvage: boolean,
  ) {
    super({ id, executable: process.execPath, args: [fixtureAgent] });
  }

  override async review(input: ReviewInput) {
    const invocation = await super.review(input);
    const attempt = (this.reviewAttempts.get(input.worktree) ?? 0) + 1;
    this.reviewAttempts.set(input.worktree, attempt);
    if (this.retryBeforeSalvage && attempt === 1) {
      await rm(path.join(input.worktree, ".agent-arena-submission.json"), {
        force: true,
      });
      return invocation;
    }
    if (!invocation.command) throw new Error("Expected review command record");
    return AgentInvocationSchema.parse({
      ...invocation,
      status: "timed_out",
      command: {
        ...invocation.command,
        timedOut: true,
        failureClass: "agent_submission",
        deadline: {
          expiredAt: invocation.finishedAt,
          graceMs: 0,
          cleanupDurationMs: 0,
          cleanupComplete: true,
          signalEscalation: [],
          remainingDescendants: [],
        },
      },
    });
  }
}

class DeterministicTimedImplementationAdapter extends CommandAgentAdapter {
  retryBeforeSalvage = false;
  implementationCalls = 0;
  cleanupComplete = true;

  override async implement(input: ImplementInput) {
    const invocation = await super.implement(input);
    this.implementationCalls += 1;
    if (this.retryBeforeSalvage && this.implementationCalls === 1) {
      await rm(invocation.submissionPath!);
    }
    if (!invocation.command) throw new Error("Expected implementation command");
    return AgentInvocationSchema.parse({
      ...invocation,
      status: this.cleanupComplete ? "timed_out" : "infrastructure_error",
      command: {
        ...invocation.command,
        timedOut: true,
        ...(this.cleanupComplete
          ? {}
          : { failureClass: "arena_infrastructure" as const }),
        deadline: {
          kind: "idle",
          expiredAt: invocation.finishedAt,
          elapsedMs: invocation.durationMs,
          graceMs: 0,
          cleanupDurationMs: 0,
          cleanupComplete: this.cleanupComplete,
          signalEscalation: [],
          remainingDescendants: [],
        },
        termination: {
          ...invocation.command.termination,
          cause: "timeout",
          timeoutType: "wall_clock",
        },
      },
    });
  }
}

class ConvergedEmptyLaneAdapter extends CommandAgentAdapter {
  readonly seenPrompts: string[] = [];

  override async implement(input: ImplementInput) {
    const invocation = await super.implement(input);
    await writeFile(
      path.join(input.worktree, "src", "slug.mjs"),
      'export function slug(value) {\n  return value.trim().toLowerCase().replace(/\\s+/g, "-");\n}\n',
    );
    return invocation;
  }

  override async review(input: ReviewInput) {
    this.seenPrompts.push(input.prompt);
    const invocation = await super.review(input);
    await writeFile(
      path.join(input.worktree, ".agent-arena-submission.json"),
      JSON.stringify({ version: 2, findings: [] }),
    );
    return invocation;
  }

  override async attack(input: AttackInput) {
    this.seenPrompts.push(input.prompt);
    const invocation = await super.attack(input);
    await writeFile(
      path.join(input.worktree, ".agent-arena-submission.json"),
      JSON.stringify({ version: 2, sharedSupportPaths: [], attacks: [] }),
    );
    return invocation;
  }
}

class QualityFactsFixtureAdapter extends ConvergedEmptyLaneAdapter {
  constructor(
    id: "codex" | "claude",
    private readonly variant: "more-production" | "more-tests",
  ) {
    super({ id, executable: process.execPath, args: [fixtureAgent] });
  }

  override async implement(input: ImplementInput) {
    const invocation = await super.implement(input);
    const moreProduction = this.variant === "more-production";
    await writeFile(
      path.join(input.worktree, "src", "slug.mjs"),
      moreProduction
        ? 'function collapseWhitespace(value) {\n  return value.replace(/\\s+/g, "-");\n}\n\nexport function slug(value) {\n  const normalized = value.trim().toLowerCase();\n  return collapseWhitespace(normalized);\n}\n'
        : 'export function slug(value) {\n  return value.trim().toLowerCase().replace(/\\s+/g, "-");\n}\n',
    );
    const assertions = moreProduction
      ? ['assert.equal(slug("Alpha   Beta"), "alpha-beta");']
      : [
          'assert.equal(slug("Alpha   Beta"), "alpha-beta");',
          'assert.equal(slug(" Alpha Beta "), "alpha-beta");',
          'assert.equal(slug("Alpha\\tBeta"), "alpha-beta");',
          'assert.equal(slug("ALPHA BETA"), "alpha-beta");',
          'assert.equal(slug("Alpha    Beta"), "alpha-beta");',
          'assert.equal(slug("Alpha\\nBeta"), "alpha-beta");',
          'assert.equal(slug("Alpha \\t Beta"), "alpha-beta");',
          'assert.equal(slug("alpha beta gamma"), "alpha-beta-gamma");',
          'assert.equal(slug("  alpha  beta  "), "alpha-beta");',
          'assert.equal(slug("SINGLE"), "single");',
          'assert.equal(slug("already-slugged"), "already-slugged");',
          'assert.equal(slug(""), "");',
        ];
    await writeFile(
      path.join(input.worktree, "test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        'import { slug } from "./src/slug.mjs";',
        "",
        'test("root-level regression coverage", () => {',
        ...assertions.map((assertion) => `  ${assertion}`),
        "});",
        "",
      ].join("\n"),
    );
    return invocation;
  }
}

class FlawedEmptyLaneAdapter extends ConvergedEmptyLaneAdapter {
  override async implement(input: ImplementInput) {
    const invocation = await super.implement(input);
    await writeFile(
      path.join(input.worktree, "src", "slug.mjs"),
      'import { normalizeInput } from "arena-runtime-helper";\nexport function slug(value) {\n  return normalizeInput(value).trim().toLowerCase().replaceAll(" ", "-");\n}\n',
    );
    return invocation;
  }

  override async repair(input: RepairInput) {
    const invocation = await super.repair(input);
    await writeFile(
      path.join(input.worktree, "src", "slug.mjs"),
      'import { normalizeInput } from "arena-runtime-helper";\nexport function slug(value) {\n  return normalizeInput(value).trim().toLowerCase().replace(/\\s+/g, "-");\n}\n',
    );
    return invocation;
  }
}

class SharedTargetAdapter extends ConvergedEmptyLaneAdapter {
  override async implement(input: ImplementInput) {
    const invocation = await super.implement(input);
    await writeFile(
      path.join(input.worktree, "src", "slug.mjs"),
      'export function slug(value) {\n  return value.trim().toLowerCase().replaceAll(" ", "-");\n}\n',
    );
    return invocation;
  }

  override async repair(input: RepairInput) {
    const invocation = await super.repair(input);
    await writeFile(
      path.join(input.worktree, "src", "slug.mjs"),
      'export function slug(value) {\n  return value.trim().toLowerCase().replace(/\\s+/g, "-");\n}\n',
    );
    return invocation;
  }
}

class FreshEvidenceAdapter extends CommandAgentAdapter {
  override async review(input: ReviewInput) {
    const invocation = await super.review(input);
    const findings =
      input.round === 1
        ? [
            {
              trust: "reviewer_hypothesis",
              invariant: "Every whitespace run becomes one separator",
              observations: [
                {
                  trust: "reviewer_hypothesis",
                  statement:
                    "The target replaces individual spaces instead of whitespace runs.",
                  provenance: {
                    kind: "code_inspection",
                    references: ["src/slug.mjs:1"],
                  },
                },
              ],
              code_locations: [
                {
                  path: "src/slug.mjs",
                  line_start: 1,
                  line_end: 3,
                  symbol: "slug",
                },
              ],
              trigger_sequence: [
                "Call slug with three consecutive spaces",
                "Observe multiple separators",
              ],
              oracle: {
                expected_behavior:
                  "Collapse every run of whitespace to one hyphen",
                task_source_ids: ["task-user"],
                task_source_rationale:
                  "The acceptance criterion states this behavior exactly.",
              },
              confidence: 98,
              required_capability_ids: [],
              regression_test_plan: {
                summary: "Add a repeated-whitespace regression.",
                suggested_paths: ["test/arena-repeated-whitespace.test.mjs"],
                focused_command:
                  "node --test test/arena-repeated-whitespace.test.mjs",
              },
            },
          ]
        : [];
    await writeFile(
      path.join(input.worktree, ".agent-arena-submission.json"),
      JSON.stringify({ version: 2, findings }),
    );
    return invocation;
  }

  override async attack(input: AttackInput) {
    const invocation = await super.attack(input);
    if (input.round !== 1) {
      await writeFile(
        path.join(input.worktree, ".agent-arena-submission.json"),
        JSON.stringify({ version: 2, sharedSupportPaths: [], attacks: [] }),
      );
      return invocation;
    }
    const testPath = "test/arena-repeated-whitespace.test.mjs";
    await writeFile(
      path.join(input.worktree, testPath),
      'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slug } from "../src/slug.mjs";\ntest("collapses repeated whitespace", () => assert.equal(slug("Alpha   Beta"), "alpha-beta"));\n',
    );
    await writeFile(
      path.join(input.worktree, ".agent-arena-submission.json"),
      JSON.stringify({
        version: 2,
        sharedSupportPaths: [],
        attacks: [
          {
            rank: 1,
            claim: "Repeated whitespace is not collapsed",
            impact: "Valid titles produce malformed public slugs",
            oracle: {
              expectedBehavior:
                "Collapse every run of whitespace to one hyphen",
              rationale:
                "The acceptance criterion states this behavior exactly.",
            },
            proposedSeverity: "high",
            confidence: 98,
            focusedCommand:
              "node --test test/arena-repeated-whitespace.test.mjs",
            paths: [testPath],
            requiredCapabilities: [],
          },
        ],
      }),
    );
    return invocation;
  }
}

class SharedDefectAdapter extends FreshEvidenceAdapter {
  override async implement(input: ImplementInput) {
    const invocation = await super.implement(input);
    await writeFile(
      path.join(input.worktree, "src", "slug.mjs"),
      'export function slug(value) {\n  return value.trim().toLowerCase().replaceAll(" ", "-");\n}\n',
    );
    return invocation;
  }

  override async repair(input: RepairInput) {
    const invocation = await super.repair(input);
    await writeFile(
      path.join(input.worktree, "src", "slug.mjs"),
      'export function slug(value) {\n  return value.trim().toLowerCase().replace(/\\s+/g, "-");\n}\n',
    );
    return invocation;
  }
}

class DependencyAddingAdapter extends CommandAgentAdapter {
  override async implement(input: ImplementInput) {
    const invocation = await super.implement(input);
    const packagePath = path.join(input.worktree, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    packageJson.dependencies = {
      ...packageJson.dependencies,
      "arena-fixture-dependency": "file:vendor/fixture-dependency",
    };
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    const dependencyRoot = path.join(
      input.worktree,
      "vendor",
      "fixture-dependency",
    );
    await mkdir(dependencyRoot, { recursive: true });
    await writeFile(
      path.join(dependencyRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "arena-fixture-dependency",
          version: "1.0.0",
          type: "module",
          exports: "./index.js",
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(dependencyRoot, "index.js"),
      'export const fixtureDependency = "installed";\n',
    );
    await writeFile(
      path.join(input.worktree, "test", "dependency.test.mjs"),
      'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { fixtureDependency } from "arena-fixture-dependency";\ntest("installs dependencies introduced by a contestant patch", () => assert.equal(fixtureDependency, "installed"));\n',
    );
    await execa("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
      cwd: input.worktree,
    });
    return invocation;
  }
}

async function createDependencySlugRepository(): Promise<string> {
  const repositoryRoot = await createSlugRepository();
  const runtimeRoot = path.join(repositoryRoot, "vendor", "runtime-helper");
  const testRoot = path.join(repositoryRoot, "vendor", "test-helper");
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(testRoot, { recursive: true });
  await writeFile(
    path.join(runtimeRoot, "package.json"),
    JSON.stringify({
      name: "arena-runtime-helper",
      version: "1.0.0",
      type: "module",
      exports: "./index.js",
    }),
  );
  await writeFile(
    path.join(runtimeRoot, "index.js"),
    "export const normalizeInput = (value) => value;\n",
  );
  await writeFile(
    path.join(testRoot, "package.json"),
    JSON.stringify({
      name: "arena-test-helper",
      version: "1.0.0",
      type: "module",
      exports: "./index.js",
    }),
  );
  await writeFile(
    path.join(testRoot, "index.js"),
    'import assert from "node:assert/strict";\nexport const assertSlug = (actual, expected) => assert.equal(actual, expected);\n',
  );
  const packagePath = path.join(repositoryRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  packageJson.dependencies = {
    "arena-runtime-helper": "file:vendor/runtime-helper",
  };
  packageJson.devDependencies = {
    "arena-test-helper": "file:vendor/test-helper",
  };
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(
    path.join(repositoryRoot, "src", "slug.mjs"),
    'import { normalizeInput } from "arena-runtime-helper";\nexport function slug(value) {\n  return normalizeInput(value).trim().toLowerCase().replace(" ", "-");\n}\n',
  );
  await writeFile(
    path.join(repositoryRoot, "test", "slug.test.mjs"),
    'import test from "node:test";\nimport { assertSlug } from "arena-test-helper";\nimport { slug } from "../src/slug.mjs";\ntest("creates a basic slug", () => assertSlug(slug("Hello World"), "hello-world"));\n',
  );
  await execa("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
    cwd: repositoryRoot,
  });
  await execa("git", ["add", "."], { cwd: repositoryRoot });
  await execa("git", ["commit", "-qm", "add dependency fixtures"], {
    cwd: repositoryRoot,
  });
  return repositoryRoot;
}

describe("fake-adapter fight on a mocked real issue", () => {
  it("retains and reports every successfully created fight worktree", async () => {
    const repositoryRoot = await createSlugRepository();
    const config = FightConfigSchema.parse({
      ...duelConfig(repositoryRoot),
      keepWorktrees: true,
      effortMode: "ultra-low",
      fixedRounds: true,
      rounds: 1,
      selectionEnabled: false,
    });
    const outcome = await new Arena({
      adapters: {
        codex: new ConvergedEmptyLaneAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
        claude: new ConvergedEmptyLaneAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("codex"),
    }).fight(config);

    const manifestPath = outcome.state.artifacts.worktreeManifest!;
    const manifest = await readWorktreeManifest(manifestPath);
    expect(outcome.state.status).toBe("complete");
    expect(manifest.retentionEnabled).toBe(true);
    expect(manifest.worktrees.length).toBeGreaterThan(6);
    expect(
      manifest.worktrees.every((entry) => entry.state === "retained"),
    ).toBe(true);
    expect(manifest.worktrees.map((entry) => entry.purpose)).toEqual(
      expect.arrayContaining([
        "preflight-baseline-worktree",
        "implementation-worktree:a",
        "implementation-worktree:b",
        "initial-validation-worktree:a",
        "initial-validation-worktree:b",
        "final-validation-worktree:a",
        "final-validation-worktree:b",
      ]),
    );
    expect(outcome.summary).toContain("Retained worktree:");
    expect(outcome.summary).toContain("Worktree manifest:");
    expect(await readFile(outcome.state.artifacts.battle!, "utf8")).toContain(
      "## Retained worktrees",
    );
    expect(
      await readFile(outcome.state.artifacts.battleHtml!, "utf8"),
    ).toContain("Retained worktrees");

    const cleanup = await cleanupRunWorktrees({
      runId: outcome.state.runId,
      repositoryRoot,
      artifactRoot: config.artifactRoot,
    });
    expect(cleanup.failed).toEqual([]);
    expect(cleanup.removed).toHaveLength(manifest.worktrees.length);
  }, 60_000);

  it("provisions dependencies after applying each contestant patch", async () => {
    const repositoryRoot = await createSlugRepository();
    const config = FightConfigSchema.parse({
      ...duelConfig(repositoryRoot),
      bootstrap: "auto",
      effortMode: "ultra-low",
      fixedRounds: false,
      rounds: 1,
    });
    const outcome = await new Arena({
      adapters: {
        codex: new DependencyAddingAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
        claude: new DependencyAddingAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("codex"),
    }).fight(config);

    for (const contestant of Object.values(outcome.state.contestants)) {
      expect(contestant.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "initial-required",
            status: "passed",
          }),
        ]),
      );
    }
    const provisioningRoot = path.join(
      repositoryRoot,
      ".agent-arena",
      "runs",
      outcome.state.runId,
      "provisioning",
    );
    const provisioning = await Promise.all(
      (await readdir(provisioningRoot)).map(
        async (name) =>
          JSON.parse(
            await readFile(path.join(provisioningRoot, name), "utf8"),
          ) as {
            cache?: { disposition?: string };
            commandResult?: unknown;
          },
      ),
    );
    expect(
      provisioning.some((record) => record.cache?.disposition === "reused"),
    ).toBe(true);
    expect(
      provisioning.filter((record) => record.commandResult).length,
    ).toBeLessThan(provisioning.length);
    const summary = JSON.parse(
      await readFile(outcome.state.artifacts.result!, "utf8"),
    ) as {
      implementationEligibility?: Array<{
        contestantId: string;
        eligible: boolean;
        validation?: { outcome: string; attempts: unknown[] };
      }>;
    };
    expect(summary.implementationEligibility).toHaveLength(2);
    expect(
      summary.implementationEligibility?.map((entry) => ({
        contestantId: entry.contestantId,
        eligible: entry.eligible,
        outcome: entry.validation?.outcome,
        attemptCount: entry.validation?.attempts.length,
      })),
    ).toEqual([
      {
        contestantId: "a",
        eligible: true,
        outcome: "passed",
        attemptCount: 1,
      },
      {
        contestantId: "b",
        eligible: true,
        outcome: "passed",
        attemptCount: 1,
      },
    ]);
    const completedEvent = (
      await readFile(
        path.join(
          repositoryRoot,
          ".agent-arena",
          "runs",
          outcome.state.runId,
          "events.ndjson",
        ),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            implementationEligibility?: unknown;
          },
      )
      .findLast((event) => event.type === "battle_completed");
    expect(completedEvent?.implementationEligibility).toEqual(
      summary.implementationEligibility,
    );
    expect(await readFile(outcome.state.artifacts.battle!, "utf8")).toContain(
      "Implementation eligibility and required-validation attempts",
    );
    expect(
      await readFile(outcome.state.artifacts.battleHtml!, "utf8"),
    ).toContain("Implementation eligibility and required-validation attempts");
  }, 60_000);

  it("provisions runtime and test dependencies for final focused checks", async () => {
    const repositoryRoot = await createDependencySlugRepository();
    const config = FightConfigSchema.parse({
      ...duelConfig(repositoryRoot),
      acceptanceCriteria: ["Collapse every run of whitespace to one hyphen"],
      bootstrap: "auto",
      testCommand: "npm test",
      effortMode: "ultra-low",
      fixedRounds: true,
      rounds: 1,
      selectionEnabled: false,
    });
    const outcome = await new Arena({
      adapters: {
        codex: new FreshEvidenceAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
        claude: new FlawedEmptyLaneAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("codex"),
    }).fight(config);

    expect(outcome.state.status).toBe("complete");
    expect(
      outcome.state.coverageAssessment?.confidence,
      JSON.stringify({
        coverage: outcome.state.coverageAssessment,
        checks: outcome.state.contestants.b!.checks,
      }),
    ).toBe("full_confidence");
    expect(
      outcome.state.contestants.b!.checks.some(
        (check) =>
          check.id.startsWith("final-") &&
          check.kind === "focused" &&
          check.status === "passed",
      ),
      JSON.stringify({
        checks: outcome.state.contestants.b!.checks,
        attacks: outcome.state.attacks,
        warnings: outcome.state.warnings,
      }),
    ).toBe(true);
  }, 60_000);

  it("keeps coverage provisional when final focused setup fails", async () => {
    const repositoryRoot = await createDependencySlugRepository();
    await writeFile(
      path.join(repositoryRoot, "bootstrap.mjs"),
      'import { execFileSync } from "node:child_process";\nimport path from "node:path";\nconst name = path.basename(process.cwd());\nif (/^final-[ab]-(?!attempt-)/u.test(name)) process.exit(127);\nexecFileSync("npm", ["ci", "--ignore-scripts"], { stdio: "inherit" });\n',
    );
    await execa("git", ["add", "bootstrap.mjs"], { cwd: repositoryRoot });
    await execa("git", ["commit", "-qm", "add controlled bootstrap"], {
      cwd: repositoryRoot,
    });
    const config = FightConfigSchema.parse({
      ...duelConfig(repositoryRoot),
      acceptanceCriteria: ["Collapse every run of whitespace to one hyphen"],
      bootstrap: { command: "node bootstrap.mjs" },
      testCommand: "npm test",
      effortMode: "ultra-low",
      fixedRounds: true,
      rounds: 1,
      selectionEnabled: false,
    });
    const arena = new Arena({
      adapters: {
        codex: new FreshEvidenceAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
        claude: new FlawedEmptyLaneAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("codex"),
    });
    await expect(arena.fight(config)).rejects.toThrow(
      "Bootstrap infrastructure failed for final-case-worktree",
    );
    const [runId] = await readdir(
      path.join(repositoryRoot, ".agent-arena", "runs"),
    );
    const state = JSON.parse(
      await readFile(
        path.join(
          repositoryRoot,
          ".agent-arena",
          "runs",
          runId!,
          "result.json",
        ),
        "utf8",
      ),
    ) as {
      status: string;
      coverageAssessment?: {
        confidence: string;
        counts: { unresolved: number };
        reasonCodes: string[];
      };
    };

    expect(state.status).toBe("inconclusive");
    expect(state.coverageAssessment).toMatchObject({
      confidence: "provisional",
      counts: { unresolved: 1 },
    });
    expect(state.coverageAssessment?.reasonCodes).toContain(
      "final_reproducer_infrastructure",
    );
  }, 60_000);

  it("stops a tiny converged fight after one round but continues fresh evidence", async () => {
    const convergedRoot = await createSlugRepository();
    const convergedConfig = FightConfigSchema.parse({
      ...duelConfig(convergedRoot),
      effortMode: "ultra-low",
      fixedRounds: false,
      rounds: 1,
    });
    const converged = await new Arena({
      adapters: {
        codex: new ConvergedEmptyLaneAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
        claude: new ConvergedEmptyLaneAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("codex"),
    }).fight(convergedConfig);

    expect(converged.state.adaptiveDecisions).toHaveLength(1);
    expect(converged.state.adaptiveDecisions[0]).toMatchObject({
      version: 3,
      round: 1,
      action: "stop",
      reason: "adaptive_convergence",
      convergence: { passed: true },
      signal: {
        competitiveLandings: 0,
        sharedDefects: 0,
        explicitEmptyLanes: 2,
        lowSignal: true,
        consecutiveLowSignalCount: 1,
      },
    });
    expect(converged.state.adaptiveCompletion).toMatchObject({
      kind: "adaptive_coverage",
      reason: "adaptive_convergence",
    });
    expect(converged.state.arenaOutcome).toMatchObject({
      version: 2,
      kind: "non_discriminating",
      decisionBasis: "no_differentiator",
      competitiveLandingCount: 0,
      sharedDefectCount: 0,
    });
    expect(converged.state.arenaOutcome).not.toHaveProperty("championId");
    expect(converged.state.ranking).toMatchObject({
      winner: null,
      draw: false,
      order: ["a", "b"],
    });
    expect(converged.state.patchRecommendation).toMatchObject({
      reason: "no_differentiator",
    });
    expect(converged.state.patchRecommendation).not.toHaveProperty(
      "contestantId",
    );
    const completionEvent = (
      await readFile(converged.state.artifacts.events!, "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => ArenaEventSchema.parse(JSON.parse(line)))
      .find((event) => event.type === "battle_completed");
    expect(completionEvent).toMatchObject({
      type: "battle_completed",
      status: "complete",
      outcomeKind: "non_discriminating",
      decisionBasis: "no_differentiator",
      competitiveLandingCount: 0,
      sharedDefectCount: 0,
      explicitEmptyLaneCount: 2,
    });
    expect(completionEvent).not.toHaveProperty("championId");
    const durableResult = JSON.parse(
      await readFile(converged.state.artifacts.result!, "utf8"),
    ) as {
      schemaVersion: number;
      outcome?: Record<string, unknown>;
      adaptiveDecisions?: Array<{
        version?: unknown;
        signal?: {
          lowSignal?: unknown;
          consecutiveLowSignalCount?: unknown;
        };
      }>;
    };
    expect(durableResult).toMatchObject({
      schemaVersion: 11,
      outcome: {
        version: 2,
        kind: "non_discriminating",
        decisionBasis: "no_differentiator",
      },
    });
    expect(durableResult.outcome).not.toHaveProperty("championId");
    expect(durableResult.adaptiveDecisions?.[0]).toMatchObject({
      version: 3,
      signal: {
        lowSignal: true,
        consecutiveLowSignalCount: 1,
      },
    });

    const evidenceRoot = await createSlugRepository();
    const evidenceConfig = FightConfigSchema.parse({
      ...duelConfig(evidenceRoot),
      acceptanceCriteria: [
        "Collapse every run of whitespace to one hyphen",
        "Return a lowercase slug",
      ],
      effortMode: "ultra-low",
      fixedRounds: false,
      rounds: 1,
    });
    const evidence = await new Arena({
      adapters: {
        codex: new FreshEvidenceAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
        claude: new CommandAgentAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("codex"),
    }).fight(evidenceConfig);

    expect(evidence.state.adaptiveDecisions.length).toBeGreaterThan(1);
    expect(evidence.state.adaptiveDecisions[0]).toMatchObject({
      round: 1,
      action: "continue",
      reason: "extension_qualified",
      extensionQualified: true,
    });
    expect(evidence.state.adaptiveDecisions.at(-1)?.action).toBe("stop");
  }, 60_000);

  it("uses a fresh anonymized judge comparison only to recommend a non-discriminating patch", async () => {
    const repositoryRoot = await createSlugRepository();
    const config = FightConfigSchema.parse({
      ...duelConfig(repositoryRoot),
      effortMode: "ultra-low",
      fixedRounds: false,
      rounds: 1,
    });
    const compare = vi.fn((input: PatchQualityVerifierInput) => {
      const facts = input.patches.map((patch) => patch.facts);
      expect(facts.every((entry) => entry.version === 2)).toBe(true);
      const current = facts.map((entry) => {
        if (entry.version !== 2) throw new Error("Expected v2 quality facts");
        return entry as Omit<
          Extract<PatchQualityFacts, { version: 2 }>,
          "contestantId"
        >;
      });
      const smallerTotal = [...current].sort(
        (left, right) =>
          left.totals.normalizedLines - right.totals.normalizedLines,
      )[0]!;
      const strongerTests = current.find((entry) => entry !== smallerTotal)!;
      expect(
        smallerTotal.categories.production.normalizedLines,
      ).toBeGreaterThan(strongerTests.categories.production.normalizedLines);
      expect(smallerTotal.categories.test.normalizedLines).toBeLessThan(
        strongerTests.categories.test.normalizedLines,
      );
      expect(
        current.every((entry) =>
          entry.categories.test.paths.includes("test.mjs"),
        ),
      ).toBe(true);
      return Promise.resolve({
        version: 1 as const,
        verdict: "patch_b" as const,
        criteria: [],
        rationale: ["Patch B keeps the narrower production boundary."],
      });
    });
    const outcome = await new Arena({
      adapters: {
        codex: new QualityFactsFixtureAdapter("codex", "more-production"),
        claude: new QualityFactsFixtureAdapter("claude", "more-tests"),
      },
      verifier: new RuleBasedVerifier("codex"),
      qualityVerifier: { id: "fixture-quality", compare },
    }).fight(config);

    expect(compare).toHaveBeenCalledOnce();
    const input = compare.mock.calls[0]![0];
    expect(input).not.toHaveProperty("runSpec");
    expect(input.taskContract.task).toBe("Normalize slug whitespace.");
    expect(Object.keys(input.finalValidation).sort()).toEqual([
      "patch_a",
      "patch_b",
    ]);
    expect(input.patches.map((patch) => patch.label).sort()).toEqual([
      "patch_a",
      "patch_b",
    ]);
    expect(input.patches[0].facts).not.toHaveProperty("contestantId");
    expect(outcome.state.arenaOutcome).toMatchObject({
      kind: "non_discriminating",
      decisionBasis: "independent_patch_quality",
    });
    expect(outcome.state.arenaOutcome).not.toHaveProperty("championId");
    expect(outcome.state.patchRecommendation?.contestantId).toMatch(/^[ab]$/u);
    expect(outcome.state.patchRecommendation?.reason).toBe(
      "implementation_quality",
    );
    expect(
      outcome.state.reviewPrompt?.choices.flatMap((choice) => choice.badges),
    ).not.toContain("arena_champion");
    const review = await reviewRun({
      runId: outcome.state.runId,
      repositoryRoot,
    });
    const firstChoice = review.choices[0];
    if (!firstChoice) throw new Error("Expected a reviewable patch");
    await expect(
      recordReviewDecision({
        runId: outcome.state.runId,
        repositoryRoot,
        promptId: review.promptId,
        decision: "accept",
        selection: "champion",
        expectedBaseCommit: review.baseCommit,
        approval: {
          channel: "api",
          promptId: review.promptId,
          provenance: {
            kind: "direct_tty",
            confirmedPatchSha256: firstChoice.patchSha256,
          },
        },
        idempotencyKey: "non-discriminating-champion-unavailable",
      }),
    ).rejects.toThrow("missing or ineligible");
  }, 60_000);

  it("persists independently verified repair state for a contestant-authored shared defect", async () => {
    const repositoryRoot = await createSlugRepository();
    const config = FightConfigSchema.parse({
      ...duelConfig(repositoryRoot),
      acceptanceCriteria: ["Collapse every run of whitespace to one hyphen"],
      effortMode: "ultra-low",
      fixedRounds: true,
      rounds: 1,
      selectionEnabled: false,
    });
    const outcome = await new Arena({
      adapters: {
        codex: new SharedDefectAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
        claude: new SharedTargetAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("codex"),
    }).fight(config);

    const shared = outcome.state.attacks.find(
      (entry) => entry.status === "shared_defect",
    );
    expect(shared).toMatchObject({
      origin: { kind: "contestant", contestant: "a" },
      targets: ["a", "b"],
      sharedRepairStatus: { a: "repaired", b: "repaired" },
    });
    expect(outcome.state.arenaOutcome).toMatchObject({
      kind: "non_discriminating",
      sharedDefectCount: 1,
    });
    expect(outcome.state.patchRecommendation).toMatchObject({
      reason: "no_differentiator",
    });
    const sharedEvent = (
      await readFile(outcome.state.artifacts.events!, "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => ArenaEventSchema.parse(JSON.parse(line)))
      .find(
        (event) =>
          event.type === "attack_resolved" && event.attackId === shared?.id,
      );
    expect(sharedEvent).toMatchObject({
      type: "attack_resolved",
      status: "shared_defect",
      evidenceClass: "shared",
    });
  }, 60_000);

  it("pivots a planned second round and stops after two consecutive low-signal rounds", async () => {
    const repositoryRoot = await createSlugRepository();
    const config = FightConfigSchema.parse({
      ...duelConfig(repositoryRoot),
      effortMode: "medium",
      fixedRounds: false,
      rounds: 2,
      selectionEnabled: false,
    });
    const codex = new ConvergedEmptyLaneAdapter({
      id: "codex",
      executable: process.execPath,
      args: [fixtureAgent],
    });
    const claude = new ConvergedEmptyLaneAdapter({
      id: "claude",
      executable: process.execPath,
      args: [fixtureAgent],
    });
    const outcome = await new Arena({
      adapters: { codex, claude },
      verifier: new RuleBasedVerifier("codex"),
    }).fight(config);

    expect(outcome.state.adaptiveDecisions).toHaveLength(2);
    const [firstDecision, secondDecision] = outcome.state.adaptiveDecisions;
    expect(firstDecision).toMatchObject({
      round: 1,
      action: "continue",
      reason: "planned_rounds_remaining",
    });
    expect(
      firstDecision && "signal" in firstDecision
        ? firstDecision.signal
        : undefined,
    ).toMatchObject({
      lowSignal: true,
      consecutiveLowSignalCount: 1,
    });
    expect(secondDecision).toMatchObject({
      round: 2,
      action: "stop",
      reason: "repeated_low_signal",
    });
    expect(
      secondDecision && "signal" in secondDecision
        ? secondDecision.signal
        : undefined,
    ).toMatchObject({
      lowSignal: true,
      consecutiveLowSignalCount: 2,
    });
    const secondRoundPrompts = [
      ...codex.seenPrompts,
      ...claude.seenPrompts,
    ].filter((prompt) => prompt.includes("# Round 2 brief"));
    expect(secondRoundPrompts.length).toBeGreaterThan(0);
    expect(
      secondRoundPrompts.every((prompt) =>
        prompt.includes("# Required low-signal pivot"),
      ),
    ).toBe(true);
    expect(
      secondRoundPrompts.every((prompt) =>
        prompt.includes("Do not repeat a prior claim"),
      ),
    ).toBe(true);
    expect(outcome.state.adaptiveCompletion).toMatchObject({
      reason: "repeated_low_signal",
    });
  }, 60_000);

  it("keeps a non-discriminating battle complete when the quality comparison fails twice", async () => {
    const repositoryRoot = await createSlugRepository();
    const config = FightConfigSchema.parse({
      ...duelConfig(repositoryRoot),
      effortMode: "low",
      fixedRounds: false,
      rounds: 1,
    });
    const compare = vi.fn((input: PatchQualityVerifierInput) => {
      void input;
      return Promise.reject(new Error("fixture quality transport failure"));
    });
    const outcome = await new Arena({
      adapters: {
        codex: new ConvergedEmptyLaneAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
        claude: new ConvergedEmptyLaneAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("codex"),
      qualityVerifier: { id: "fixture-failing-quality", compare },
    }).fight(config);

    expect(compare).toHaveBeenCalledTimes(2);
    expect(outcome.state.status).toBe("complete");
    expect(outcome.state.arenaOutcome).toMatchObject({
      kind: "non_discriminating",
      decisionBasis: "no_differentiator",
    });
    expect(outcome.state.patchRecommendation).toMatchObject({
      reason: "no_differentiator",
      qualityVerdict: "inconclusive",
    });
    expect(outcome.state.patchRecommendation).not.toHaveProperty(
      "contestantId",
    );
    expect(outcome.state.failureRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "model_invocation",
          subject: "quality-verifier",
          terminalDisposition: "advisory_unavailable",
          attempts: [
            expect.objectContaining({ attempt: 1, status: "failed" }),
            expect.objectContaining({ attempt: 2, status: "failed" }),
          ],
        }),
      ]),
    );
  }, 60_000);

  it("leaves low-effort equivalent and selection-disabled battles unrecommended", async () => {
    const equivalentRoot = await createSlugRepository();
    const equivalentCompare = vi.fn((input: PatchQualityVerifierInput) => {
      void input;
      return Promise.resolve({
        version: 1 as const,
        verdict: "equivalent" as const,
        criteria: [],
        rationale: ["The anonymized implementations are equivalent."],
      });
    });
    const equivalent = await new Arena({
      adapters: {
        codex: new ConvergedEmptyLaneAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
        claude: new ConvergedEmptyLaneAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("codex"),
      qualityVerifier: {
        id: "fixture-equivalent-quality",
        compare: equivalentCompare,
      },
    }).fight(
      FightConfigSchema.parse({
        ...duelConfig(equivalentRoot),
        effortMode: "low",
        fixedRounds: false,
        rounds: 1,
      }),
    );
    expect(equivalentCompare).toHaveBeenCalledOnce();
    expect(equivalent.state.status).toBe("complete");
    expect(equivalent.state.arenaOutcome).toMatchObject({
      kind: "non_discriminating",
    });
    expect(equivalent.state.patchRecommendation).toMatchObject({
      reason: "no_differentiator",
      qualityVerdict: "equivalent",
    });
    expect(equivalent.state.patchRecommendation).not.toHaveProperty(
      "contestantId",
    );
    const equivalentReview = await reviewRun({
      runId: equivalent.state.runId,
      repositoryRoot: equivalentRoot,
    });
    const explicitChoice = equivalentReview.choices.find(
      (choice) => choice.contestantId === "a",
    );
    if (!explicitChoice) throw new Error("Expected explicit patch A choice");
    await expect(
      recordReviewDecision({
        runId: equivalent.state.runId,
        repositoryRoot: equivalentRoot,
        promptId: equivalentReview.promptId,
        decision: "accept",
        selection: "a",
        expectedPatchSha256: explicitChoice.patchSha256,
        expectedBaseCommit: equivalentReview.baseCommit,
        approval: {
          channel: "api",
          promptId: equivalentReview.promptId,
          provenance: {
            kind: "direct_tty",
            confirmedPatchSha256: explicitChoice.patchSha256,
          },
        },
        idempotencyKey: "non-discriminating-explicit-choice",
      }),
    ).resolves.toMatchObject({
      status: "accepted",
      selectedContestantId: "a",
      selectionSource: "contestant",
    });

    const disabledRoot = await createSlugRepository();
    const disabledCompare = vi.fn((input: PatchQualityVerifierInput) => {
      void input;
      return Promise.reject(
        new Error("selection-disabled comparator must not run"),
      );
    });
    const disabled = await new Arena({
      adapters: {
        codex: new ConvergedEmptyLaneAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
        claude: new ConvergedEmptyLaneAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("codex"),
      qualityVerifier: {
        id: "fixture-disabled-quality",
        compare: disabledCompare,
      },
    }).fight(
      FightConfigSchema.parse({
        ...duelConfig(disabledRoot),
        effortMode: "low",
        fixedRounds: false,
        rounds: 1,
        selectionEnabled: false,
      }),
    );
    expect(disabledCompare).not.toHaveBeenCalled();
    expect(disabled.state.status).toBe("complete");
    expect(disabled.state.arenaOutcome).toMatchObject({
      kind: "non_discriminating",
    });
    expect(disabled.state.patchRecommendation).toMatchObject({
      reason: "no_differentiator",
      qualityVerdict: "inconclusive",
    });
    expect(disabled.state.patchRecommendation).not.toHaveProperty(
      "contestantId",
    );
  }, 60_000);

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
      effortMode: "medium",
      fixedRounds: true,
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
    expect(
      events.filter(
        (event) =>
          event.type === "invocation_started" &&
          event.stage === "collect_attacks",
      ),
    ).toHaveLength(6);
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
      effortMode: "medium",
      fixedRounds: true,
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

  it("keeps a trailing-blank-line implementation applicable and eligible", async () => {
    const repositoryRoot = await createSlugRepository();
    const sourcePath = path.join(repositoryRoot, "src", "slug.mjs");
    await writeFile(sourcePath, `${await readFile(sourcePath, "utf8")}\n`);
    await execa("git", ["add", "src/slug.mjs"], { cwd: repositoryRoot });
    await execa("git", ["commit", "-qm", "preserve trailing blank line"], {
      cwd: repositoryRoot,
    });

    const outcome = await new Arena({
      adapters: {
        codex: new CommandAgentAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
          environment: {
            AGENT_ARENA_TRAILING_BLANK_IMPLEMENTATION: "1",
          },
        }),
        claude: new CommandAgentAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
          environment: { AGENT_ARENA_EMPTY_IMPLEMENTATION: "1" },
        }),
      },
      verifier: new RuleBasedVerifier("claude"),
    }).fight(duelConfig(repositoryRoot));

    expect(outcome.state.status).toBe("complete");
    expect(outcome.state.terminalOutcome).toMatchObject({
      kind: "forfeit",
      reasonCode: "implementation_empty_patch",
      eligibleContestantIds: ["a"],
    });
    expect(outcome.state.contestants.a?.checks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "apply", status: "failed" }),
      ]),
    );
    const patchPath = outcome.state.contestants.a?.currentPatchPath;
    expect(patchPath).toBeDefined();
    expect((await readFile(patchPath!)).subarray(-2)).toEqual(
      Buffer.from(" \n"),
    );
  });

  it.each([false, true])(
    "seals patch capture integrity failures before finalizing source worktrees (keepWorktrees=%s)",
    async (keepWorktrees) => {
      const repositoryRoot = await createSlugRepository();
      const events: string[] = [];
      const capture = vi
        .spyOn(WorktreeManager.prototype, "capturePatch")
        .mockImplementation((worktree) => {
          events.push(`verify:${path.basename(worktree)}`);
          return Promise.reject(
            new PatchCaptureIntegrityError("injected verification failure"),
          );
        });
      // Deliberately retain the prototype implementation before replacing it.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const originalRemove = WorktreeManager.prototype.remove;
      const remove = vi
        .spyOn(WorktreeManager.prototype, "remove")
        .mockImplementation(function (this: WorktreeManager, worktree) {
          if (path.basename(worktree).startsWith("implement-")) {
            events.push(`remove:${path.basename(worktree)}`);
          }
          return originalRemove.call(this, worktree);
        });

      try {
        const outcome = await new Arena({
          adapters: {
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
          },
          verifier: new RuleBasedVerifier("claude"),
        }).fight({ ...duelConfig(repositoryRoot), keepWorktrees });

        expect(outcome.state.status).toBe("inconclusive");
        expect(outcome.state.terminalOutcome).toMatchObject({
          phase: "pre_review",
          kind: "inconclusive",
          reasonCode: "harness_infrastructure_failure",
        });
        expect(outcome.state.terminalOutcome?.kind).not.toBe("forfeit");
        expect(
          Object.values(outcome.state.contestants).flatMap(
            (contestant) => contestant.checks,
          ),
        ).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "apply", status: "failed" }),
          ]),
        );
        const lastVerification = events.reduce(
          (latest, event, index) =>
            event.startsWith("verify:") ? index : latest,
          -1,
        );
        const firstRemoval = events.findIndex((event) =>
          event.startsWith("remove:"),
        );
        expect(lastVerification).toBeGreaterThanOrEqual(0);
        expect(firstRemoval).toBeGreaterThan(lastVerification);
        const manifest = await readWorktreeManifest(
          outcome.state.artifacts.worktreeManifest!,
        );
        expect(manifest.executions.every((entry) => entry.finalizedAt)).toBe(
          true,
        );
        expect(manifest.worktrees.length).toBeGreaterThanOrEqual(3);
        for (const entry of manifest.worktrees) {
          expect(entry.state).toBe(keepWorktrees ? "retained" : "removed");
          if (keepWorktrees) {
            await expect(readdir(entry.path)).resolves.toContain("src");
            expect(outcome.summary).toContain(entry.path);
          } else {
            await expect(readdir(entry.path)).rejects.toMatchObject({
              code: "ENOENT",
            });
          }
        }
        if (keepWorktrees) {
          const cleanup = await cleanupRunWorktrees({
            runId: outcome.state.runId,
            repositoryRoot,
          });
          expect(cleanup.failed).toEqual([]);
          expect(cleanup.removed).toHaveLength(manifest.worktrees.length);
        }
      } finally {
        capture.mockRestore();
        remove.mockRestore();
      }
    },
  );

  it("seals target-relative overlay integrity failures as inconclusive", async () => {
    const repositoryRoot = await createSlugRepository();
    const capture = vi
      .spyOn(WorktreeManager.prototype, "capturePatchAgainstSnapshot")
      .mockRejectedValue(
        new PatchCaptureIntegrityError("injected overlay verification failure"),
      );

    try {
      const outcome = await new Arena({
        adapters: {
          codex: new CommandAgentAdapter({
            id: "codex",
            executable: process.execPath,
            args: [fixtureAgent],
            environment: { AGENT_ARENA_FAKE_DIRECT_ATTACK: "1" },
          }),
          claude: new CommandAgentAdapter({
            id: "claude",
            executable: process.execPath,
            args: [fixtureAgent],
            environment: { AGENT_ARENA_FAKE_DIRECT_ATTACK: "1" },
          }),
        },
        verifier: new RuleBasedVerifier("claude"),
      }).fight({ ...duelConfig(repositoryRoot), rounds: 1 });

      expect(capture).toHaveBeenCalled();
      expect(outcome.state.status).toBe("inconclusive");
      expect(outcome.state.terminalOutcome).toMatchObject({
        phase: "pre_review",
        kind: "inconclusive",
        reasonCode: "harness_infrastructure_failure",
      });
      expect(outcome.state.patchRecommendation).toBeUndefined();
    } finally {
      capture.mockRestore();
    }
  });

  it("isolates a provider-declared missing attack path without failing the fight", async () => {
    const repositoryRoot = await createSlugRepository();
    const outcome = await new Arena({
      adapters: {
        codex: new CommandAgentAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
          environment: { AGENT_ARENA_FAKE_MISSING_ATTACK_PATH: "1" },
        }),
        claude: new CommandAgentAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("claude"),
    }).fight({ ...duelConfig(repositoryRoot), rounds: 1 });

    expect(outcome.state.status).toBe("complete");
    expect(outcome.state.terminalOutcome).toBeUndefined();
    expect(outcome.state.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Attack rank 1 from a was rejected without suppressing siblings: git add -N -- test/arena-missing-attack.test.mjs failed: fatal: pathspec",
        ),
      ]),
    );
    expect(outcome.state.attackInvocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attacker: "a",
          submissionStatus: "submitted",
          attackCount: 0,
        }),
      ]),
    );
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
      effortMode: "medium",
      fixedRounds: true,
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
      effortMode: "medium",
      fixedRounds: true,
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

  it("does not award a forfeit when provider MCP configuration prevents implementation", async () => {
    const repositoryRoot = await createSlugRepository();
    const brokenProvider = new CommandAgentAdapter({
      id: "codex",
      executable: process.execPath,
      args: [
        "-e",
        'console.error("Error loading config.toml: invalid transport\\nin `mcp_servers.cua_repl`"); process.exit(1)',
      ],
    });

    const outcome = await new Arena({
      adapters: {
        codex: brokenProvider,
        claude: new CommandAgentAdapter({
          id: "claude",
          executable: process.execPath,
          args: ["-e", "setInterval(() => undefined, 1_000)"],
        }),
      },
      verifier: new RuleBasedVerifier("claude"),
    }).fight(duelConfig(repositoryRoot));

    expect(outcome.state.status).toBe("inconclusive");
    expect(outcome.state.terminalOutcome).toMatchObject({
      version: 2,
      phase: "pre_review",
      kind: "inconclusive",
      status: "inconclusive",
      reasonCode: "provider_transport_failure",
      affectedContestantIds: ["a"],
      eligibleContestantIds: [],
      contestants: [
        expect.objectContaining({
          contestantId: "a",
          eligible: false,
          reasonCode: "provider_transport_failure",
        }),
        expect.objectContaining({
          contestantId: "b",
          eligible: false,
          reasonCode: "peer_cancelled_due_to_transport",
        }),
      ],
    });
    expect(outcome.state.patchRecommendation).toBeUndefined();
    expect(outcome.state.ranking).toBeUndefined();
    expect(outcome.state.attacks).toEqual([]);
  });

  it("retains a peer failure completed before an MCP transport failure", async () => {
    const repositoryRoot = await createSlugRepository();
    const delayedBrokenProvider = new CommandAgentAdapter({
      id: "codex",
      executable: process.execPath,
      args: [
        "-e",
        'setTimeout(() => { console.error("Error loading config.toml: invalid transport\\nin `mcp_servers.cua_repl`"); process.exit(1); }, 150)',
      ],
    });
    const failedPeer = new CommandAgentAdapter({
      id: "claude",
      executable: process.execPath,
      args: ["-e", "process.exit(1)"],
    });

    const outcome = await new Arena({
      adapters: {
        codex: delayedBrokenProvider,
        claude: failedPeer,
      },
      verifier: new RuleBasedVerifier("claude"),
    }).fight(duelConfig(repositoryRoot));

    expect(outcome.state.status).toBe("inconclusive");
    expect(outcome.state.terminalOutcome).toMatchObject({
      version: 2,
      phase: "pre_review",
      kind: "inconclusive",
      reasonCode: "provider_transport_failure",
      affectedContestantIds: ["a"],
      eligibleContestantIds: [],
      contestants: [
        expect.objectContaining({
          contestantId: "a",
          eligible: false,
          reasonCode: "provider_transport_failure",
        }),
        expect.objectContaining({
          contestantId: "b",
          eligible: false,
          reasonCode: "implementation_failed",
        }),
      ],
    });
  });

  it("does not blame a successful peer whose validation is skipped by an MCP transport failure", async () => {
    const repositoryRoot = await createSlugRepository();
    const delayedBrokenProvider = new CommandAgentAdapter({
      id: "codex",
      executable: process.execPath,
      args: [
        "-e",
        'setTimeout(() => { console.error("Error loading config.toml: invalid transport\\nin `mcp_servers.cua_repl`"); process.exit(1); }, 1000)',
      ],
    });

    const outcome = await new Arena({
      adapters: {
        codex: delayedBrokenProvider,
        claude: new CommandAgentAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("claude"),
    }).fight(duelConfig(repositoryRoot));

    expect(outcome.state.status).toBe("inconclusive");
    expect(outcome.state.terminalOutcome).toMatchObject({
      version: 2,
      phase: "pre_review",
      kind: "inconclusive",
      reasonCode: "provider_transport_failure",
      affectedContestantIds: ["a"],
      eligibleContestantIds: [],
      contestants: [
        expect.objectContaining({
          contestantId: "a",
          eligible: false,
          reasonCode: "provider_transport_failure",
        }),
        expect.objectContaining({
          contestantId: "b",
          eligible: false,
          reasonCode: "peer_validation_skipped_due_to_transport",
        }),
      ],
    });
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

  it.each([false, true])(
    "salvages a valid implementation submission before an idle deadline (retry: %s)",
    async (retryBeforeSalvage) => {
      const repositoryRoot = await createSlugRepository();
      const config = duelConfig(repositoryRoot);
      const adapter = new DeterministicTimedImplementationAdapter({
        id: "codex",
        executable: process.execPath,
        args: [fixtureAgent],
        providerStream: "codex",
      });
      adapter.retryBeforeSalvage = retryBeforeSalvage;
      const outcome = await new Arena({
        adapters: {
          codex: adapter,
          claude: new CommandAgentAdapter({
            id: "claude",
            executable: process.execPath,
            args: [fixtureAgent],
          }),
        },
        verifier: new RuleBasedVerifier("claude"),
      }).fight(config);

      const implementation = outcome.state.contestants.a?.implementation;
      expect(implementation).toMatchObject({ status: "timed_out" });
      expect(outcome.state.contestants.a?.patchSize).toBeGreaterThan(0);
      expect(
        outcome.state.contestants.a?.checks.find(
          (check) => check.id === "initial-required",
        )?.status,
      ).toBe("passed");
      expect(outcome.state.terminalOutcome).toBeUndefined();
      const failures = outcome.state.failureRecords.filter(
        (failure) => failure.subject === "implementation:a",
      );
      expect(failures).toHaveLength(1);
      const failure = failures[0]!;
      expect(failure).toMatchObject({
        stage: "implementation",
        contestantId: "a",
        category: "timeout",
        terminalDisposition: "recovered",
      });
      expect(adapter.implementationCalls).toBe(retryBeforeSalvage ? 2 : 1);
      expect(
        failure.attempts.map((attempt) => ({
          attempt: attempt.attempt,
          status: attempt.status,
        })),
      ).toEqual(
        retryBeforeSalvage
          ? [
              { attempt: 1, status: "failed" },
              { attempt: 2, status: "succeeded" },
            ]
          : [{ attempt: 1, status: "succeeded" }],
      );
      for (const attempt of failure.attempts) {
        expect(attempt.timeout).toMatchObject({
          kind: "idle",
          policy: { softTimeoutMs: 900_000, absoluteTimeoutMs: 2_700_000 },
          termination: { cause: "timeout" },
        });
        expect(attempt.timeout?.elapsedMs).toBeGreaterThanOrEqual(0);
        expect(attempt.diagnosticArtifactRefs).toContainEqual(
          expect.stringContaining(
            `implementation-a-attempt-${String(attempt.attempt)}`,
          ),
        );
      }
      const persisted: unknown = JSON.parse(
        await readFile(
          path.join(
            path.dirname(outcome.state.artifacts.result!),
            "failures",
            `${failure.failureId}.json`,
          ),
          "utf8",
        ),
      );
      expect(persisted).toEqual(failure);
    },
    30_000,
  );

  it("does not salvage a submission when deadline cleanup is incomplete", async () => {
    const repositoryRoot = await createSlugRepository();
    const adapter = new DeterministicTimedImplementationAdapter({
      id: "codex",
      executable: process.execPath,
      args: [fixtureAgent],
    });
    adapter.cleanupComplete = false;

    const outcome = await new Arena({
      adapters: {
        codex: adapter,
        claude: new CommandAgentAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("claude"),
    }).fight(duelConfig(repositoryRoot));

    expect(adapter.implementationCalls).toBe(2);
    expect(outcome.state.contestants.a?.patchSize).toBe(0);
    expect(outcome.state.terminalOutcome).toMatchObject({
      kind: "inconclusive",
      reasonCode: "harness_infrastructure_failure",
      affectedContestantIds: ["a"],
    });
  });

  it.each([false, true])(
    "keeps unstable validation inconclusive after implementation salvage (retry: %s)",
    async (retryBeforeSalvage) => {
      const repositoryRoot = await createSlugRepository();
      const statePath = path.join(repositoryRoot, "validation-invocations.txt");
      const config = FightConfigSchema.parse({
        ...duelConfig(repositoryRoot),
        testCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(requiredValidationOutcomes)} ${JSON.stringify(statePath)} timeout-then-all-pass`,
      });
      config.limits.attackMs = 1000;
      config.phaseOverrides.attack = true;
      const adapter = new DeterministicTimedImplementationAdapter({
        id: "codex",
        executable: process.execPath,
        args: [fixtureAgent],
      });
      adapter.retryBeforeSalvage = retryBeforeSalvage;
      const outcome = await new Arena({
        adapters: {
          codex: adapter,
          claude: new CommandAgentAdapter({
            id: "claude",
            executable: process.execPath,
            args: [fixtureAgent],
          }),
        },
        verifier: new RuleBasedVerifier("claude"),
      }).fight(config);
      expect(adapter.implementationCalls).toBe(retryBeforeSalvage ? 2 : 1);
      const terminal = outcome.state.terminalOutcome;
      if (!terminal || terminal.version !== 2)
        throw new Error("Expected a v2 terminal outcome");
      expect(
        terminal.contestants.find(
          (contestant) => contestant.contestantId === "a",
        )?.validation?.outcome,
      ).toBe("unstable");
      expect(outcome.state.status).toBe("inconclusive");
      expect(outcome.state.terminalOutcome).toMatchObject({
        kind: "inconclusive",
        reasonCode: "initial_validation_unstable",
        eligibleContestantIds: ["b"],
      });
      const persisted = JSON.parse(
        await readFile(outcome.state.artifacts.result!, "utf8"),
      ) as { terminalOutcome: unknown };
      expect(persisted.terminalOutcome).toEqual(outcome.state.terminalOutcome);
    },
    30_000,
  );

  it("retries runner-shaped validation once and persists unstable and deterministic evidence", async () => {
    const repositoryRoot = await createSlugRepository();
    const statePath = path.join(repositoryRoot, "validation-invocations.txt");
    const config = FightConfigSchema.parse({
      ...duelConfig(repositoryRoot),
      testCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(requiredValidationOutcomes)} ${JSON.stringify(statePath)}`,
    });
    config.limits.attackMs = 150;
    config.phaseOverrides.attack = true;

    const outcome = await new Arena({
      adapters: {
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
      },
      verifier: new RuleBasedVerifier("claude"),
    }).fight(config);

    expect(outcome.state.status).toBe("inconclusive");
    expect(outcome.state.terminalOutcome).toMatchObject({
      version: 2,
      kind: "inconclusive",
      reasonCode: "initial_validation_unstable",
    });
    const terminal = outcome.state.terminalOutcome;
    if (!terminal || terminal.version !== 2)
      throw new Error("Expected a v2 terminal outcome");
    const unstable = terminal.contestants[0]?.validation;
    const deterministic = terminal.contestants[1]?.validation;
    expect(terminal.contestants[0]).toMatchObject({
      contestantId: "a",
      eligible: false,
      reasonCode: "initial_validation_unstable",
    });
    expect(terminal.contestants[1]).toMatchObject({
      contestantId: "b",
      eligible: false,
      reasonCode: "initial_validation_failed",
    });
    expect(unstable?.outcome).toBe("unstable");
    expect(deterministic?.outcome).toBe("deterministic_failure");
    expect(unstable?.attempts[0]).toMatchObject({
      timedOut: true,
      termination: { cause: "timeout", timeoutType: "wall_clock" },
    });
    expect(unstable?.attempts[1]).toMatchObject({
      exitCode: 0,
      timedOut: false,
    });
    expect(unstable?.attempts[0]?.cwd).not.toBe(unstable?.attempts[1]?.cwd);
    expect(deterministic?.attempts).toHaveLength(1);
    expect(deterministic?.attempts[0]?.exitCode).toBe(2);
    expect(deterministic?.attempts[0]?.failureExcerpt).toContain("TS7030");
    expect(outcome.state.failureRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "required_validation",
          terminalDisposition: "validation_unstable",
          attempts: [
            expect.objectContaining({ attempt: 1, status: "failed" }),
            expect.objectContaining({ attempt: 2, status: "succeeded" }),
          ],
        }),
      ]),
    );
    const summary = JSON.parse(
      await readFile(outcome.state.artifacts.result!, "utf8"),
    ) as { terminalOutcome: unknown };
    expect(summary.terminalOutcome).toEqual(outcome.state.terminalOutcome);
    expect(await readFile(outcome.state.artifacts.battle!, "utf8")).toContain(
      "required validation — unstable",
    );
    expect(
      await readFile(outcome.state.artifacts.battleHtml!, "utf8"),
    ).toContain("Validation evidence");
  }, 60_000);

  it("records a deterministic nonzero validation retry as failed", async () => {
    const repositoryRoot = await createSlugRepository();
    const statePath = path.join(repositoryRoot, "validation-invocations.txt");
    const config = FightConfigSchema.parse({
      ...duelConfig(repositoryRoot),
      testCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(requiredValidationOutcomes)} ${JSON.stringify(statePath)} timeout-then-deterministic`,
    });
    config.limits.attackMs = 150;
    config.phaseOverrides.attack = true;

    const outcome = await new Arena({
      adapters: {
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
      },
      verifier: new RuleBasedVerifier("claude"),
    }).fight(config);

    expect(outcome.state.status).toBe("inconclusive");
    expect(outcome.state.terminalOutcome).toMatchObject({
      version: 2,
      kind: "inconclusive",
      reasonCode: "initial_validation_unstable",
    });
    expect(outcome.state.failureRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "required_validation",
          terminalDisposition: "validation_unstable",
          attempts: [
            expect.objectContaining({ attempt: 1, status: "failed" }),
            expect.objectContaining({ attempt: 2, status: "failed" }),
          ],
        }),
      ]),
    );
    const terminal = outcome.state.terminalOutcome;
    if (!terminal || terminal.version !== 2)
      throw new Error("Expected a v2 terminal outcome");
    const deterministicRetry = terminal.contestants[0]?.validation?.attempts[1];
    expect(deterministicRetry?.exitCode).toBe(2);
    expect(deterministicRetry?.failureExcerpt).toContain("TS7030");
  }, 60_000);

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
          environment: {
            AGENT_ARENA_FAKE_UNKNOWN_REVIEW_FIELD_ALWAYS: "1",
          },
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

    const invalidReviews = outcome.state.reviewInvocations.filter(
      (entry) => entry.round === 1 && entry.reviewer === "a",
    );
    expect(invalidReviews).toHaveLength(2);
    for (const invalidReview of invalidReviews)
      expect(invalidReview).toMatchObject({
        parseOutcome: "invalid",
        submissionStatus: "invalid_submission",
      });
    const parsedReview = JSON.parse(
      await readFile(invalidReviews.at(-1)!.parsedArtifactPath!, "utf8"),
    ) as { rejections: Array<{ code: string }> };
    expect(parsedReview.rejections).toEqual([
      expect.objectContaining({ code: "unknown_field" }),
    ]);
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

  it("records salvaged review deadlines after direct completion and a retry", async () => {
    const repositoryRoot = await createSlugRepository();
    const config = duelConfig(repositoryRoot);
    const outcome = await new Arena({
      adapters: {
        codex: new DeterministicTimedReviewAdapter("codex", true),
        claude: new DeterministicTimedReviewAdapter("claude", false),
      },
      verifier: new RuleBasedVerifier("claude"),
    }).fight(config);

    const reviews = outcome.state.reviewInvocations.filter(
      (entry) => entry.submissionStatus === "submitted",
    );
    expect(reviews).toHaveLength(6);
    expect(reviews.every((review) => review.salvagedAtDeadline)).toBe(true);
    expect(
      reviews.every((review) => review.invocation.status === "timed_out"),
    ).toBe(true);
    expect(
      reviews.every(
        (review) =>
          review.diagnosticArtifactRefs?.some((ref) =>
            ref.endsWith(".stdout.log"),
          ) &&
          review.diagnosticArtifactRefs.some((ref) =>
            ref.endsWith(".stderr.log"),
          ),
      ),
    ).toBe(true);
    expect(
      outcome.state.failureRecords.filter(
        (record) =>
          record.category === "timeout" &&
          record.terminalDisposition === "recovered",
      ),
    ).toHaveLength(6);
    expect(
      outcome.state.failureRecords.filter(
        (record) =>
          record.category === "invalid_output" &&
          record.terminalDisposition === "recovered",
      ),
    ).toHaveLength(3);
  }, 30_000);

  it("keeps accepted review findings without retrying malformed siblings", async () => {
    const repositoryRoot = await createSlugRepository();
    const config = duelConfig(repositoryRoot);
    const outcome = await new Arena({
      adapters: {
        codex: new CommandAgentAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
          environment: { AGENT_ARENA_FAKE_PARTIAL_REVIEW: "1" },
        }),
        claude: new CommandAgentAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("claude"),
    }).fight(config);

    const reviews = outcome.state.reviewInvocations.filter(
      (entry) => entry.round === 1 && entry.reviewer === "a",
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      submissionStatus: "submitted",
      findingCount: 1,
      parseOutcome: "partial",
    });
    expect(reviews[0]?.artifactPath).toBeTruthy();
    expect(
      outcome.state.attackInvocations.some(
        (entry) => entry.round === 1 && entry.attacker === "a",
      ),
    ).toBe(true);
  }, 30_000);

  it("canonicalizes test-run review provenance without another provider invocation", async () => {
    const repositoryRoot = await createSlugRepository();
    const config = FightConfigSchema.parse({
      ...duelConfig(repositoryRoot),
      rounds: 1,
    });
    const outcome = await new Arena({
      adapters: {
        codex: new CommandAgentAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
          environment: { AGENT_ARENA_FAKE_TEST_RUN_ALIAS: "1" },
        }),
        claude: new CommandAgentAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("claude"),
    }).fight(config);

    const reviews = outcome.state.reviewInvocations.filter(
      (entry) => entry.round === 1 && entry.reviewer === "a",
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      submissionStatus: "submitted",
      findingCount: 1,
      parseOutcome: "valid",
    });
    const parsed = JSON.parse(
      await readFile(reviews[0]!.parsedArtifactPath!, "utf8"),
    ) as {
      normalizations: Array<{
        path: string;
        original: string;
        normalized: string;
        rule: string;
      }>;
    };
    expect(parsed.normalizations).toContainEqual({
      path: "$.findings[0].observations[0].provenance.kind",
      original: "test-run",
      normalized: "test_run",
      rule: "v1.review.provenance.test_run_alias",
    });
    expect(await readFile(reviews[0]!.rawArtifactPath!, "utf8")).toContain(
      '"kind":"test-run"',
    );
    const packet = EvidenceHandoffPacketSchema.parse(
      JSON.parse(await readFile(reviews[0]!.artifactPath!, "utf8")),
    );
    expect(packet.findings[0]?.observations[0]?.provenance.kind).toBe(
      "test_run",
    );
    expect(
      outcome.state.submissionArtifacts
        .filter((artifact) => artifact.kind === "review")
        .reduce(
          (total, artifact) =>
            total + (artifact.schemaRejectedFindingCount ?? 0),
          0,
        ),
    ).toBe(0);
    expect(
      outcome.state.attackInvocations.some(
        (entry) =>
          entry.round === 1 && entry.attacker === "a" && entry.target === "b",
      ),
    ).toBe(true);
  }, 30_000);

  it("retries wholly ambiguous review provenance with focused schema feedback", async () => {
    const repositoryRoot = await createSlugRepository();
    const config = FightConfigSchema.parse({
      ...duelConfig(repositoryRoot),
      rounds: 1,
    });
    const outcome = await new Arena({
      adapters: {
        codex: new CommandAgentAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
          environment: { AGENT_ARENA_FAKE_AMBIGUOUS_REVIEW_ONCE: "1" },
        }),
        claude: new CommandAgentAdapter({
          id: "claude",
          executable: process.execPath,
          args: [fixtureAgent],
        }),
      },
      verifier: new RuleBasedVerifier("claude"),
    }).fight(config);

    const reviews = outcome.state.reviewInvocations.filter(
      (entry) => entry.round === 1 && entry.reviewer === "a",
    );
    expect(reviews).toHaveLength(2);
    expect(reviews[0]).toMatchObject({
      submissionStatus: "invalid_submission",
      parseOutcome: "invalid",
      findingCount: 0,
    });
    expect(reviews[1]).toMatchObject({
      submissionStatus: "submitted",
      parseOutcome: "valid",
      findingCount: 1,
    });
    const retryPrompt = await readFile(
      path.join(
        outcome.state.artifacts.runDirectory!,
        "prompts",
        "round-1-review-a-attempt-2.md",
      ),
      "utf8",
    );
    expect(
      JSON.parse(retryPrompt.split("# Targeted review schema retry\n")[1]!),
    ).toEqual({
      invalid_fields: [
        {
          path: "$.findings[0].observations[0].provenance.kind",
          received: '"test_execution"',
        },
      ],
      allowed_provenance_kinds: [
        "code_inspection",
        "task_source",
        "test_inspection",
        "test_run",
        "tool_summary",
        "other",
      ],
    });
    expect(
      outcome.state.submissionArtifacts
        .filter((artifact) => artifact.kind === "review")
        .reduce(
          (total, artifact) =>
            total + (artifact.schemaRejectedFindingCount ?? 0),
          0,
        ),
    ).toBe(1);
  }, 30_000);

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

  it("keeps validation and blocker refresh allowances independent", async () => {
    const repositoryRoot = await createSlugRepository();
    const config = duelConfig(repositoryRoot);
    const beforeExpiry = new Date("2026-08-24T20:00:00.000Z");
    const firstExpiry = new Date("2026-08-24T20:01:00.000Z");
    const secondExpiry = new Date("2026-08-24T20:02:00.000Z");
    const betweenExpiries = new Date("2026-08-24T20:01:30.000Z");
    const afterExpiries = new Date("2026-08-24T20:02:30.000Z");
    let clock = beforeExpiry;
    const permissions = resolvePermissionPolicy(config);
    const approved = permissions.capabilities.filter(
      (capability) => capability.status === "approved",
    );
    expect(approved.length).toBeGreaterThanOrEqual(2);
    approved[0]!.expiresAt = firstExpiry.toISOString();
    approved[1]!.expiresAt = secondExpiry.toISOString();
    const reconnaissance = await collectFightReconnaissance(config, {
      now: beforeExpiry,
    });
    const baseCommit = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
    ).stdout;
    const runSpec = await buildRunSpec({
      runId: "permission-refresh-parent",
      baseCommit,
      config,
      permissions,
      repositoryRoot,
      reconnaissance,
      sourceDirectory: path.join(config.artifactRoot, "parent-sources"),
      now: beforeExpiry,
    });
    const codex = new CommandAgentAdapter({
      id: "codex",
      executable: process.execPath,
      args: [fixtureAgent],
      environment: { AGENT_ARENA_FAKE_BLOCKER_ONCE: "1" },
    });
    const claude = new CommandAgentAdapter({
      id: "claude",
      executable: process.execPath,
      args: [fixtureAgent],
    });
    const originalCodexReview = codex.review.bind(codex);
    vi.spyOn(codex, "review").mockImplementation(async (input) => {
      const invocation = await originalCodexReview(input);
      if (
        input.round === 2 &&
        input.prompt.includes("# Targeted validation refresh")
      )
        clock = afterExpiries;
      return invocation;
    });
    const originalClaudeReview = claude.review.bind(claude);
    vi.spyOn(claude, "review").mockImplementation(async (input) => {
      const invocation = await originalClaudeReview(input);
      if (
        input.round === 2 &&
        !input.prompt.includes("# Targeted validation refresh")
      )
        clock = betweenExpiries;
      return invocation;
    });
    const outcome = await new Arena({
      adapters: { codex, claude },
      verifier: new RuleBasedVerifier("claude"),
      now: () => clock,
    }).fightReplacement(config, {
      parentRunId: "permission-refresh-parent",
      restartOrdinal: 1,
      runSpec,
      permissions,
      reconnaissance,
    });
    const store = new ArtifactStore(config.artifactRoot, outcome.state.runId, {
      durableV5: true,
    });
    const refreshedLane = await readHandoffLifecycle(
      store,
      "round_2",
      "a-to-b",
    );

    expect(refreshedLane.map((record) => record.state)).toEqual([
      "created",
      "refresh_required",
      "validated",
      "refresh_required",
      "validated",
      "completed_empty",
    ]);
    expect(refreshedLane[1]).toMatchObject({
      event: "validation",
      reason_code: "permission_fingerprint_mismatch",
      attempt: 1,
    });
    expect(refreshedLane[2]).toMatchObject({
      event: "refresh",
      reason_code: "refresh_valid",
      attempt: 2,
    });
    expect(refreshedLane[3]).toMatchObject({
      event: "blocking",
      attempt: 1,
    });
    expect(refreshedLane[4]).toMatchObject({
      event: "refresh",
      reason_code: "blocker_refreshed",
      attempt: 2,
    });
    expect(
      outcome.state.reviewInvocations.find(
        (entry) =>
          entry.round === 2 &&
          entry.reviewer === "a" &&
          entry.detail?.includes("Targeted validation refresh completed"),
      ),
    ).toMatchObject({ parseOutcome: "valid", submissionStatus: "submitted" });
    expect(
      outcome.state.reviewInvocations.find(
        (entry) =>
          entry.round === 2 &&
          entry.reviewer === "a" &&
          entry.detail?.includes("Targeted blocker refresh completed"),
      ),
    ).toMatchObject({ parseOutcome: "valid", submissionStatus: "submitted" });
    expect(outcome.state.warnings.join("\n")).not.toContain(
      "Trusted handoff validation refresh remained invalid",
    );
    expect(outcome.state.warnings.join("\n")).not.toContain(
      "Trusted handoff refresh failed for a against b",
    );
    expect(
      outcome.state.coverageAssessment?.requiredLanes.find(
        (lane) => lane.id === "round-2:a->b",
      ),
    ).toMatchObject({
      finalState: "completed",
      evidenceBasis: "explicit_empty",
      reasonCodes: [],
    });
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
    expect(
      outcome.state.reviewInvocations.find(
        (entry) =>
          entry.round === 2 &&
          entry.reviewer === "a" &&
          entry.detail?.includes("Targeted blocker refresh completed"),
      ),
    ).toMatchObject({
      parseOutcome: "valid",
      submissionStatus: "submitted",
    });
    expect(
      outcome.state.coverageAssessment?.requiredLanes.find(
        (lane) => lane.id === "round-2:a->b",
      ),
    ).toMatchObject({
      finalState: "completed",
      evidenceBasis: "explicit_empty",
      reasonCodes: [],
    });
  });

  it("ends an invalid trusted-handoff blocker in coverage loss without correction", async () => {
    const repositoryRoot = await createSlugRepository();
    const config = duelConfig(repositoryRoot);
    const outcome = await new Arena({
      adapters: {
        codex: new CommandAgentAdapter({
          id: "codex",
          executable: process.execPath,
          args: [fixtureAgent],
          environment: { AGENT_ARENA_FAKE_INVALID_BLOCKER: "1" },
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
      "coverage_loss",
    ]);
    expect(lifecycle.at(-1)).toMatchObject({
      event: "coverage_loss",
      reason_code: "invalid_blocker",
      attempt: 1,
    });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      submissionStatus: "invalid_submission",
      attackCount: 0,
      parseOutcome: "invalid",
    });
    expect(invocations[0]?.handoffPacketId).toBeTruthy();
    expect(invocations[0]?.handoffPacketDigest).toHaveLength(64);
    expect(invocations[0]?.handoffTargetFingerprint).toHaveLength(64);
    expect(outcome.state.coverageAssessment).toMatchObject({
      confidence: "provisional",
    });
    expect(
      outcome.state.reviewInvocations.some(
        (entry) =>
          entry.round === 2 &&
          entry.reviewer === "a" &&
          entry.detail?.includes("Targeted blocker refresh completed"),
      ),
    ).toBe(false);
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
      effortMode: "medium",
      fixedRounds: true,
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
    expect(result).toMatchObject({ schemaVersion: 11, stage: "complete" });
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
    expect(outcome.state.schemaVersion).toBe(10);
    if (outcome.state.schemaVersion !== 10)
      throw new Error("expected v10 state");
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
      effortMode: "medium",
      fixedRounds: true,
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
