import { describe, expect, it } from "vitest";
import { FightConfigSchema } from "../../src/core/types.js";
import {
  resolvePermissionPolicy,
  type CapabilityRequest,
} from "../../src/permissions/policy.js";

const base = FightConfigSchema.parse({
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
  permissionMode: "auto",
  permissionAllow: {},
  permissionDeny: [],
  reducedValidationAccepted: false,
  nonInteractiveApproval: false,
  keepWorktrees: false,
  limits: {
    implementationMs: 1,
    attackMs: 1,
    verifierMs: 1,
    repairMs: 1,
  },
});

describe("permission policy", () => {
  const advisory: CapabilityRequest = {
    id: "shell",
    reason: "tests",
    risk: "medium",
    requirement: "required",
    role: "agent",
    enforcement: "advisory",
    scopes: ["/tmp/repo"],
  };

  it("never auto-approves advisory access", () => {
    const config = FightConfigSchema.parse({
      ...base,
      permissionAllow: {
        shell: { mode: "auto", scopes: ["/tmp/repo"], role: "agent" },
      },
    });
    expect(() => resolvePermissionPolicy(config, [advisory])).toThrow(
      /Required capabilities/,
    );
  });

  it("allows a persisted reduced validation contract for a denial", () => {
    const config = FightConfigSchema.parse({
      ...base,
      reducedValidationAccepted: true,
    });
    const policy = resolvePermissionPolicy(config, [advisory]);
    expect(policy.capabilities[0]?.status).toBe("denied");
  });

  it("requires an exact safe allowlist match", () => {
    const brokered = {
      ...advisory,
      id: "github_read",
      enforcement: "brokered" as const,
    };
    const config = FightConfigSchema.parse({
      ...base,
      permissionAllow: {
        github_read: { mode: "auto", scopes: ["issues"], role: "harness_only" },
      },
    });
    expect(
      resolvePermissionPolicy(config, [brokered]).capabilities[0]?.status,
    ).toBe("approved");
  });
});
