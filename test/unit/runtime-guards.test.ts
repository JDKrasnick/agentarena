import { describe, expect, it } from "vitest";
import {
  composeAttackReviewPrompt,
  composeNeutralCasePrompt,
  composePrompt,
  createPromptManifest,
} from "../../src/agents/prompts.js";
import { selectMethods } from "../../src/methods/catalog.js";
import { LeaseRegistry } from "../../src/permissions/leases.js";
import {
  changedPathsFromPatch,
  isAllowedAttackPath,
} from "../../src/repo/git.js";
import { redact } from "../../src/runner/process-runner.js";
import { FightConfigSchema } from "../../src/core/types.js";
import { RunSpecSchema } from "../../src/contracts/round.js";

const config = FightConfigSchema.parse({
  task: "task",
  agents: ["codex", "claude"],
  attackVerifier: "codex",
  harnessMaintainer: "codex",
  rounds: 3,
  maxAttacksPerRound: 3,
  infrastructureRecoveryRound: true,
  maxHeldOutCasesPerDefect: 2,
  testCommand: "npm test",
  repositoryRoot: "/tmp/repo",
  artifactRoot: "/tmp/repo/.agent-arena/runs",
  permissionMode: "confirm",
  permissionAllow: {},
  permissionDeny: [],
  reducedValidationAccepted: false,
  nonInteractiveApproval: true,
  keepWorktrees: false,
  limits: {
    implementationMs: 1_000,
    attackMs: 1_000,
    verifierMs: 1_000,
    repairMs: 1_000,
  },
});

const runSpec = RunSpecSchema.parse({
  version: 1,
  runId: "run-1",
  task: {
    task: "task",
    acceptanceCriteria: ["works"],
    sources: [
      {
        id: "task-user",
        kind: "user_task",
        origin: "task",
        retrievedAt: "2026-01-01T00:00:00.000Z",
        contentHash: "a".repeat(64),
        snapshotPath: "task.md",
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  baseCommit: "b".repeat(40),
  topology: { mode: "duel", contestants: config.contestants },
  commands: [
    {
      id: "required-test",
      kind: "required",
      command: "npm test",
      timeoutMs: 1_000,
      required: true,
    },
  ],
  budgets: config.limits,
  permissions: {
    mode: "confirm",
    reducedValidationAccepted: false,
    capabilities: [],
  },
  contentHash: "c".repeat(64),
});

const permissions = {
  defaultMode: "confirm" as const,
  reducedValidationAccepted: false,
  capabilities: [],
};

describe("runtime guards and deterministic prompts", () => {
  it("redacts explicit and credential-shaped secrets", () => {
    expect(
      redact("token=super-secret-value ghp_abcdefghijklmnopqrstuvwxyz", [
        "super-secret-value",
      ]),
    ).toBe("token=[REDACTED] [REDACTED_CREDENTIAL]");
  });

  it("expires run-scoped leases", () => {
    const registry = new LeaseRegistry();
    registry.issue(
      {
        id: "service",
        reason: "test",
        risk: "low",
        requirement: "optional",
        role: "harness_only",
        enforcement: "brokered",
        mode: "confirm",
        scopes: ["fixture"],
        status: "approved",
      },
      new Date("2026-01-01T00:00:01Z"),
    );
    expect(
      registry.get("service", new Date("2026-01-01T00:00:00Z"))?.status,
    ).toBe("active");
    expect(
      registry.get("service", new Date("2026-01-01T00:00:02Z"))?.status,
    ).toBe("expired");
  });

  it("keeps prompt composition stable while round overlays and hashes differ", () => {
    const roundOne = selectMethods(1, ["typescript"], []);
    const roundTwo = selectMethods(2, ["typescript"], []);
    const first = composePrompt({
      agent: "codex",
      stage: "attack",
      round: 1,
      runSpec,
      config,
      permissions,
      methodSelection: roundOne,
      allowMissingReviewPacket: true,
    });
    const repeated = composePrompt({
      agent: "codex",
      stage: "attack",
      round: 1,
      runSpec,
      config,
      permissions,
      methodSelection: roundOne,
      allowMissingReviewPacket: true,
    });
    const second = composePrompt({
      agent: "codex",
      stage: "attack",
      round: 2,
      runSpec,
      config,
      permissions,
      methodSelection: roundTwo,
      allowMissingReviewPacket: true,
    });
    expect(first).toBe(repeated);
    expect(second).not.toBe(first);
    expect(roundTwo.methodPackIds).toEqual(
      expect.arrayContaining([
        "versioned-contract-compatibility@1",
        "policy-wiring-lifecycle@1",
      ]),
    );
    expect(second).toContain(
      "These are advisory options: pursue them only when the changed surfaces make them relevant",
    );
    expect(second).toContain("genuine prior-version fixture");
    expect(second).toContain(
      "failure, retry, recovery, persistence, and resume",
    );
    expect(
      createPromptManifest(1, roundOne, "seed", "one.md", first).promptHash,
    ).not.toBe(
      createPromptManifest(2, roundTwo, "seed", "two.md", second).promptHash,
    );
  });

  it("injects execution architecture and enforceable permission semantics into review", () => {
    const reviewPermissions = {
      defaultMode: "confirm" as const,
      reducedValidationAccepted: false,
      capabilities: [
        {
          id: "local_test_execution",
          reason: "Run repository tests",
          risk: "medium" as const,
          requirement: "required" as const,
          role: "agent" as const,
          enforcement: "advisory" as const,
          mode: "confirm" as const,
          scopes: ["assigned worktree"],
          status: "approved" as const,
        },
        {
          id: "postgres_test",
          reason: "Validate transaction boundaries",
          risk: "medium" as const,
          requirement: "optional" as const,
          role: "harness_only" as const,
          enforcement: "brokered" as const,
          mode: "confirm" as const,
          scopes: ["run-owned database"],
          status: "approved" as const,
        },
        {
          id: "production_credentials",
          reason: "Production access is outside the battle contract",
          risk: "critical" as const,
          requirement: "optional" as const,
          role: "agent" as const,
          enforcement: "enforced" as const,
          mode: "deny" as const,
          scopes: [],
          status: "denied" as const,
        },
      ],
    };
    const prompt = composeAttackReviewPrompt({
      agent: "a",
      target: "b",
      round: 2,
      runSpec,
      config,
      permissions: reviewPermissions,
      methodSelection: selectMethods(
        2,
        ["typescript"],
        ["local_test_execution"],
      ),
      priorOutcomes:
        '[{"id":"attack-1","status":"landed","rootDefectId":"atomicity"}]',
    });

    expect(prompt).toContain('"battleMode": "duel"');
    expect(prompt).toContain('"currentPhase": "read_only_repository_review"');
    expect(prompt).toContain('"targetSlot": "b"');
    expect(prompt).toContain('"id": "postgres_test"');
    expect(prompt).toContain('"role": "harness_only"');
    expect(prompt).toContain(
      "A harness_only capability is not directly available",
    );
    expect(prompt).toContain('"id": "production_credentials"');
    expect(prompt).toContain('"status": "denied"');
    expect(prompt).toContain("Do not probe around the decision");
    expect(prompt).not.toContain("# Previously adjudicated defects");
    expect(prompt).not.toContain('"rootDefectId":"atomicity"');
    expect(prompt).not.toContain("diff --git");
  });

  it("binds neutral case generation to declared direct capabilities", () => {
    const prompt = composeNeutralCasePrompt({
      runSpec,
      permissions: {
        defaultMode: "confirm",
        reducedValidationAccepted: false,
        capabilities: [
          {
            id: "local_test_execution",
            reason: "Run repository tests",
            risk: "medium",
            requirement: "required",
            role: "agent",
            enforcement: "advisory",
            mode: "confirm",
            scopes: ["assigned worktree"],
            status: "approved",
          },
          {
            id: "postgres_test",
            reason: "Harness-managed database",
            risk: "medium",
            requirement: "optional",
            role: "harness_only",
            enforcement: "brokered",
            mode: "confirm",
            scopes: ["run-owned database"],
            status: "approved",
          },
        ],
      },
      failure: {
        rank: 1,
        claim: "Repeated whitespace produces repeated separators",
        impact: "Generated slugs violate the task contract",
        oracle: {
          expectedBehavior: "Whitespace runs collapse to one separator",
          sourceId: "task-user",
          sourceLocation: "task",
          rationale: "The task requires normalized slugs",
        },
        proposedSeverity: "medium",
        confidence: 90,
        reproduction: "Call slug with three spaces",
        requiredCapabilities: ["local_test_execution"],
      },
      outputPath: "/tmp/cases.json",
    });

    expect(prompt).toContain('"id": "local_test_execution"');
    expect(prompt).toContain('"id": "postgres_test"');
    expect(prompt).toContain('"role": "harness_only"');
    expect(prompt).toContain(
      "Do not introduce a new capability or directly use a harness_only capability",
    );
    expect(prompt).toContain('"requiredCapabilities":[]');
  });

  it("recognizes test-only patches and rejects production paths", () => {
    const patch = "+++ b/test/slug.test.ts\n+++ b/src/slug.ts\n";
    expect(changedPathsFromPatch(patch)).toEqual([
      "test/slug.test.ts",
      "src/slug.ts",
    ]);
    expect(
      changedPathsFromPatch(
        'diff --git "a/test/space name.test.ts" "b/test/space name.test.ts"\n',
      ),
    ).toEqual(["test/space name.test.ts"]);
    expect(isAllowedAttackPath("test/slug.test.ts")).toBe(true);
    expect(isAllowedAttackPath("src/slug.ts")).toBe(false);
  });
});
