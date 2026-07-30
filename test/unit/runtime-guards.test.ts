import { describe, expect, it } from "vitest";
import {
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
import { FightConfigSchema, TaskContractSchema } from "../../src/core/types.js";

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

const contract = TaskContractSchema.parse({
  version: 1,
  task: "task",
  acceptanceCriteria: ["works"],
  sources: [
    {
      id: "task-user",
      kind: "user_task",
      origin: "task",
      retrievedAt: "2026-01-01T00:00:00.000Z",
      contentHash: "hash",
      snapshotPath: "task.md",
      visibility: "shared",
    },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  contractHash: "contract",
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
      contract,
      config,
      permissions,
      methodSelection: roundOne,
    });
    const repeated = composePrompt({
      agent: "codex",
      stage: "attack",
      round: 1,
      contract,
      config,
      permissions,
      methodSelection: roundOne,
    });
    const second = composePrompt({
      agent: "codex",
      stage: "attack",
      round: 2,
      contract,
      config,
      permissions,
      methodSelection: roundTwo,
    });
    expect(first).toBe(repeated);
    expect(second).not.toBe(first);
    expect(
      createPromptManifest(1, roundOne, "seed", "one.md", first).promptHash,
    ).not.toBe(
      createPromptManifest(2, roundTwo, "seed", "two.md", second).promptHash,
    );
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
