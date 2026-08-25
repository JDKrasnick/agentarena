import { describe, expect, it } from "vitest";
import {
  applyMcpReadiness,
  freezeMcpPolicy,
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

  it("blocks an unavailable required server unless reduced validation excludes it", () => {
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
    expect(() =>
      applyMcpReadiness(initial, new Map([["codex", "unavailable"]]), false),
    ).toThrow(/Required MCP servers are unavailable/);

    const reduced = applyMcpReadiness(
      initial,
      new Map([["codex", "unavailable"]]),
      true,
    );
    expect(
      reduced.servers.find((server) => server.name === "expo"),
    ).toMatchObject({ decision: "excluded", requirement: "required" });
    expect(reduced.coverageGaps).toHaveLength(1);
  });
});
