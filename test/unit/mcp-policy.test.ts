import { describe, expect, it } from "vitest";
import {
  approveMcpPolicy,
  applyMcpReadiness,
  excludeMcpServers,
  FrozenMcpPolicySchema,
  freezeMcpPolicy,
  mergeMcpPermissionPolicy,
  mcpServerIdentity,
  parseMcpInventory,
} from "../../src/mcp/policy.js";

describe("MCP preflight policy", () => {
  const inventory = [
    {
      provider: "codex" as const,
      state: "known" as const,
      servers: [
        {
          name: "expo",
          enabled: true,
          authentication: "unknown" as const,
          readiness: "unknown" as const,
        },
        {
          name: "unused",
          enabled: true,
          authentication: "not_required" as const,
          readiness: "unknown" as const,
        },
      ],
      diagnosticArtifactRefs: [],
    },
  ];

  it("parses the credential-redacted Codex table without retaining configuration", () => {
    const parsed = parseMcpInventory(
      "codex",
      "Name  Command  Args  Env  Cwd  Status  Auth\nexpo  -  -  TOKEN=*****  -  enabled  OAuth\nlocal  command  -  -  -  disabled  Unsupported\n",
    );

    expect(parsed).toEqual([
      {
        name: "expo",
        enabled: true,
        authentication: "unknown",
        readiness: "unknown",
      },
      {
        name: "local",
        enabled: false,
        authentication: "not_required",
        readiness: "unknown",
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain("TOKEN");
  });

  it("freezes only explicitly configured servers and omits all others", () => {
    const policy = freezeMcpPolicy({
      config: {
        policy: "keep_configured",
        servers: [
          {
            provider: "codex",
            name: "expo",
            role: "agent",
            requirement: "optional",
          },
        ],
      },
      inventory,
      reducedValidationAccepted: false,
      now: new Date("2026-08-25T00:00:00.000Z"),
    });

    expect(policy.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "expo", decision: "included" }),
        expect.objectContaining({ name: "unused", decision: "excluded" }),
      ]),
    );
    expect(policy.policyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects leave-as-is when inventory is unknown", () => {
    expect(() =>
      freezeMcpPolicy({
        config: { policy: "leave_as_is", servers: [] },
        inventory: [
          {
            provider: "claude",
            state: "unknown",
            servers: [],
            diagnosticArtifactRefs: [],
          },
        ],
        reducedValidationAccepted: false,
      }),
    ).toThrow(/leave_as_is is unavailable/);
  });

  it("excludes an unavailable required server and records the coverage gap", () => {
    const initial = freezeMcpPolicy({
      config: {
        policy: "configure_selection",
        servers: [
          {
            provider: "codex",
            name: "expo",
            role: "agent",
            requirement: "required",
          },
        ],
      },
      inventory,
      reducedValidationAccepted: false,
    });
    const resolved = applyMcpReadiness(
      initial,
      new Map([[mcpServerIdentity("codex", "expo"), "unavailable"]]),
      false,
    );
    expect(
      resolved.servers.find((server) => server.name === "expo"),
    ).toMatchObject({ decision: "excluded", requirement: "required" });
    expect(resolved.coverageGaps).toHaveLength(1);
  });

  it("excludes harness-only selections from provider agent sessions", () => {
    const policy = freezeMcpPolicy({
      config: {
        policy: "configure_selection",
        servers: [
          {
            provider: "gemini",
            name: "secrets",
            role: "harness_only",
            requirement: "optional",
          },
        ],
      },
      inventory: [
        {
          provider: "gemini",
          state: "known",
          servers: [
            {
              name: "secrets",
              enabled: true,
              authentication: "ready",
              readiness: "ready",
            },
          ],
          diagnosticArtifactRefs: [],
        },
      ],
      reducedValidationAccepted: false,
    });

    expect(policy.servers[0]).toMatchObject({
      role: "harness_only",
      decision: "excluded",
      readiness: "unavailable",
    });
    expect(policy.coverageGaps[0]).toContain(
      "Harness-only MCP execution is not implemented",
    );
  });

  it("excludes Claude selections that cannot be isolated from global configuration", () => {
    const policy = freezeMcpPolicy({
      config: {
        policy: "configure_selection",
        servers: [
          {
            provider: "claude",
            name: "github",
            role: "agent",
            requirement: "optional",
          },
        ],
      },
      inventory: [
        {
          provider: "claude",
          state: "known",
          servers: [
            {
              name: "github",
              enabled: true,
              authentication: "ready",
              readiness: "ready",
            },
          ],
          diagnosticArtifactRefs: [],
        },
      ],
      reducedValidationAccepted: false,
    });

    expect(policy.servers[0]).toMatchObject({
      provider: "claude",
      name: "github",
      decision: "excluded",
      readiness: "unavailable",
    });
    expect(policy.coverageGaps[0]).toContain("cannot be isolated");

    const afterReadiness = applyMcpReadiness(
      policy,
      new Map(),
      false,
      new Date("2026-08-25T01:00:00.000Z"),
    );
    expect(afterReadiness.servers[0]).toMatchObject({
      decision: "excluded",
      readiness: "unavailable",
    });
    expect(afterReadiness.coverageGaps[0]).toContain("cannot be isolated");
  });

  it("excludes required Claude selections that cannot be isolated", () => {
    const policy = freezeMcpPolicy({
      config: {
        policy: "keep_configured",
        servers: [
          {
            provider: "claude",
            name: "github",
            role: "agent",
            requirement: "required",
          },
        ],
      },
      inventory: [
        {
          provider: "claude",
          state: "known",
          servers: [
            {
              name: "github",
              enabled: true,
              authentication: "ready",
              readiness: "ready",
            },
          ],
          diagnosticArtifactRefs: [],
        },
      ],
      reducedValidationAccepted: false,
    });
    expect(policy.servers[0]).toMatchObject({
      decision: "excluded",
      requirement: "required",
      readiness: "unavailable",
    });
    expect(policy.coverageGaps).toHaveLength(1);
  });

  it("records an explicit decision bound to the final policy hash", () => {
    const policy = freezeMcpPolicy({
      config: { policy: "keep_configured", servers: [] },
      inventory,
      reducedValidationAccepted: false,
      now: new Date("2026-08-25T00:00:00.000Z"),
    });
    const approved = approveMcpPolicy(
      policy,
      "interactive",
      new Date("2026-08-25T01:00:00.000Z"),
    );

    expect(approved.policyHash).toBe(policy.policyHash);
    expect(approved.approval).toEqual({
      policyHash: policy.policyHash,
      mode: "interactive",
      acceptedAt: "2026-08-25T01:00:00.000Z",
    });
    expect(() =>
      FrozenMcpPolicySchema.parse({
        ...approved,
        approval: { ...approved.approval, policyHash: "0".repeat(64) },
      }),
    ).toThrow(/bind the frozen policy hash/);
  });

  it("refuses approval while a requested MCP connection is unresolved", () => {
    const unresolved = freezeMcpPolicy({
      config: {
        policy: "keep_configured",
        servers: [
          {
            provider: "codex",
            name: "expo",
            role: "agent",
            requirement: "optional",
          },
        ],
      },
      inventory,
      reducedValidationAccepted: false,
    });

    expect(() => approveMcpPolicy(unresolved, "interactive")).toThrow(
      /must be resolved before approval/,
    );
  });

  it("adds only ready included MCP servers to the run permission manifest", () => {
    const initial = freezeMcpPolicy({
      config: {
        policy: "keep_configured",
        servers: [
          {
            provider: "codex",
            name: "expo",
            role: "agent",
            requirement: "optional",
          },
        ],
      },
      inventory,
      reducedValidationAccepted: false,
    });
    const resolved = applyMcpReadiness(
      initial,
      new Map([[mcpServerIdentity("codex", "expo"), "ready"]]),
      false,
    );
    const permissions = mergeMcpPermissionPolicy(
      {
        defaultMode: "confirm",
        reducedValidationAccepted: false,
        capabilities: [],
      },
      approveMcpPolicy(resolved, "automatic_ready"),
    );

    expect(permissions.capabilities).toHaveLength(1);
    expect(permissions.capabilities[0]?.scopes).toContain("server:expo");
    expect(JSON.stringify(permissions)).not.toContain("server:unused");
  });

  it("excludes every selected MCP server when access is not approved", () => {
    const initial = freezeMcpPolicy({
      config: {
        policy: "keep_configured",
        servers: [
          {
            provider: "codex",
            name: "expo",
            role: "agent",
            requirement: "optional",
          },
        ],
      },
      inventory,
      reducedValidationAccepted: false,
    });
    const resolved = applyMcpReadiness(
      initial,
      new Map([[mcpServerIdentity("codex", "expo"), "ready"]]),
      false,
    );
    const excluded = approveMcpPolicy(
      excludeMcpServers(
        resolved,
        new Set([mcpServerIdentity("codex", "expo")]),
        new Date("2026-08-25T01:00:00.000Z"),
      ),
      "interactive",
      new Date("2026-08-25T01:00:01.000Z"),
    );

    expect(
      excluded.servers.find((server) => server.name === "expo"),
    ).toMatchObject({
      decision: "excluded",
      reason: "Not approved by the operator; excluded from this run",
    });
    expect(excluded.coverageGaps).toContain(
      "codex/expo (optional): Not approved by the operator; excluded from this run",
    );
    expect(excluded.approval?.mode).toBe("interactive");
  });
});
