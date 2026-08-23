import { describe, expect, it } from "vitest";
import { FightConfigSchema } from "../../src/core/types.js";
import {
  assertDirectCapabilitiesAllowed,
  discoverCapabilities,
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

  it("discloses ambient native subprocess authority as required and advisory", () => {
    const native = discoverCapabilities(base).find(
      (capability) => capability.id === "native_subprocess_execution",
    );
    expect(native?.reason).toContain("current OS account");
    expect(native).toMatchObject({
      id: "native_subprocess_execution",
      risk: "high",
      requirement: "required",
      role: "both",
      enforcement: "advisory",
      scopes: [
        "current OS account filesystem",
        "current OS account process environment",
        "host network stack",
        "configured provider integrations",
      ],
    });
  });

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

  it("allows neutral cases to use only declared direct capabilities", () => {
    const policy = {
      defaultMode: "confirm" as const,
      reducedValidationAccepted: false,
      capabilities: [
        {
          ...advisory,
          mode: "confirm" as const,
          status: "approved" as const,
        },
        {
          ...advisory,
          id: "postgres_test",
          role: "harness_only" as const,
          enforcement: "brokered" as const,
          mode: "confirm" as const,
          status: "approved" as const,
        },
      ],
    };

    expect(() =>
      assertDirectCapabilitiesAllowed(policy, ["shell"], ["shell"]),
    ).not.toThrow();
    expect(() =>
      assertDirectCapabilitiesAllowed(policy, [], ["shell"]),
    ).toThrow(/undeclared capability shell/);
    expect(() =>
      assertDirectCapabilitiesAllowed(
        policy,
        ["postgres_test"],
        ["postgres_test"],
      ),
    ).toThrow(/cannot directly use capability postgres_test/);
  });
});
