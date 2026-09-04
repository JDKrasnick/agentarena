import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  approveMcpPolicy,
  applyMcpReadiness,
  excludeMcpServers,
  FrozenMcpPolicySchema,
  freezeMcpPolicy,
  mergeMcpPermissionPolicy,
  mcpServerIdentity,
  parseMcpInventory,
  resolveCodexMcpRuntimeDefinition,
  reconstructMcpRuntimeForResume,
} from "../../src/mcp/policy.js";
import { providerCommand } from "../../src/agents/adapter.js";

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

  async function resolveDefinition(definition: unknown) {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-mcp-definition-"));
    await mkdir(path.join(root, "logs"));
    const stdoutPath = path.join(root, "definition.stdout.log");
    const stderrPath = path.join(root, "definition.stderr.log");
    await Promise.all([
      writeFile(stdoutPath, JSON.stringify(definition)),
      writeFile(stderrPath, ""),
    ]);
    return resolveCodexMcpRuntimeDefinition({
      name: "selected",
      repositoryRoot: root,
      logRoot: path.join(root, "logs"),
      run: () =>
        Promise.resolve({
          command: "codex mcp get selected --json",
          cwd: root,
          exitCode: 0,
          signal: null,
          timedOut: false,
          attempts: 1,
          durationMs: 1,
          stdoutPath,
          stderrPath,
        }),
    });
  }

  const definitionBase = {
    name: "selected",
    enabled: true,
    disabled_reason: null,
    enabled_tools: null,
    disabled_tools: null,
    startup_timeout_sec: null,
    tool_timeout_sec: null,
  };

  it("reconstructs only the frozen Codex exposure for resume", async () => {
    const policy = freezeMcpPolicy({
      config: {
        policy: "configure_selection",
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
    const requested: string[] = [];
    const runtime = await reconstructMcpRuntimeForResume({
      policyHash: policy.policyHash,
      policy,
      repositoryRoot: "/repo",
      logRoot: "/logs",
      resolveDefinition: (options) => {
        requested.push(options.name);
        return Promise.resolve({
          status: "resolved",
          definition: {
            provider: "codex",
            name: options.name,
            transport: {
              type: "stdio",
              command: "selected-server",
              args: [],
              env_vars: [],
              cwd: null,
            },
            enabled_tools: null,
            disabled_tools: null,
            startup_timeout_sec: null,
            tool_timeout_sec: null,
          },
        });
      },
    });

    expect(requested).toEqual(["expo"]);
    expect(runtime.policy).toBe(policy);
    expect(runtime.runtimeDefinitions.map((entry) => entry.name)).toEqual([
      "expo",
    ]);
    const command = providerCommand(
      "codex",
      undefined,
      runtime.policy,
      runtime.runtimeDefinitions,
    );
    expect(command.args).toEqual(
      expect.arrayContaining([
        "--ignore-user-config",
        "-c",
        "features.apps=false",
      ]),
    );
    expect(command.args.join(" ")).toContain("mcp_servers.expo=");
  });

  it("fails closed when a frozen Codex definition cannot be reconstructed", async () => {
    const policy = freezeMcpPolicy({
      config: {
        policy: "configure_selection",
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

    await expect(
      reconstructMcpRuntimeForResume({
        policyHash: policy.policyHash,
        policy,
        repositoryRoot: "/repo",
        logRoot: "/logs",
        resolveDefinition: () =>
          Promise.resolve({
            status: "unavailable",
            reason: "definition changed",
          }),
      }),
    ).rejects.toThrow(/cannot be reconstructed safely for resume/);
  });

  it("fails resume when the durable MCP policy is missing or mismatched", async () => {
    await expect(
      reconstructMcpRuntimeForResume({
        policyHash: "0".repeat(64),
        repositoryRoot: "/repo",
        logRoot: "/logs",
      }),
    ).rejects.toThrow(/missing the frozen MCP policy/);
    await expect(
      reconstructMcpRuntimeForResume({
        policyHash: "f".repeat(64),
        policy: freezeMcpPolicy({
          config: { policy: "configure_selection", servers: [] },
          inventory,
          reducedValidationAccepted: false,
        }),
        repositoryRoot: "/repo",
        logRoot: "/logs",
      }),
    ).rejects.toThrow(/does not match the RunSpec/);
  });

  it("rejects a resume policy whose contents no longer match its hash", async () => {
    const policy = freezeMcpPolicy({
      config: { policy: "configure_selection", servers: [] },
      inventory,
      reducedValidationAccepted: false,
    });

    await expect(
      reconstructMcpRuntimeForResume({
        policyHash: policy.policyHash,
        policy: { ...policy, coverageGaps: ["tampered"] },
        repositoryRoot: "/repo",
        logRoot: "/logs",
      }),
    ).rejects.toThrow(/failed its integrity check/);
  });

  it("resolves supported stdio definitions without environment material", async () => {
    const result = await resolveDefinition({
      ...definitionBase,
      transport: {
        type: "stdio",
        command: "node",
        args: ["server.mjs"],
        env: null,
        env_vars: [],
        cwd: null,
      },
    });

    expect(result).toMatchObject({
      status: "resolved",
      definition: {
        name: "selected",
        transport: { type: "stdio", env_vars: [] },
      },
    });
  });

  it("resolves supported HTTP definitions that use managed authentication", async () => {
    const result = await resolveDefinition({
      ...definitionBase,
      transport: {
        type: "streamable_http",
        url: "https://mcp.example.test/api",
        bearer_token_env_var: null,
        http_headers: null,
        env_http_headers: null,
      },
    });

    expect(result).toMatchObject({
      status: "resolved",
      definition: {
        transport: {
          type: "streamable_http",
          bearer_token_env_var: null,
        },
      },
    });
  });

  it.each([
    {
      type: "stdio",
      command: "node",
      args: [],
      env: { API_TOKEN: "literal-secret-sentinel" },
      env_vars: [],
      cwd: null,
    },
    {
      type: "streamable_http",
      url: "https://mcp.example.test/api",
      bearer_token_env_var: null,
      http_headers: { Authorization: "literal-secret-sentinel" },
      env_http_headers: null,
    },
  ])(
    "rejects inline credential-bearing transport fields",
    async (transport) => {
      const result = await resolveDefinition({ ...definitionBase, transport });

      expect(result).toEqual({
        status: "unavailable",
        reason:
          "Selected Codex MCP server definition is unsupported or requires credential material that cannot be isolated from the agent",
      });
      expect(JSON.stringify(result)).not.toContain("literal-secret-sentinel");
    },
  );

  it.each([
    {
      type: "stdio",
      command: "node",
      args: [],
      env: null,
      env_vars: ["MCP_TOKEN"],
      cwd: null,
    },
    {
      type: "streamable_http",
      url: "https://mcp.example.test/api",
      bearer_token_env_var: "MCP_TOKEN",
      http_headers: null,
      env_http_headers: null,
    },
    {
      type: "streamable_http",
      url: "https://mcp.example.test/api",
      bearer_token_env_var: null,
      http_headers: null,
      env_http_headers: { Authorization: "MCP_AUTH_HEADER" },
    },
  ])(
    "rejects environment-backed definitions that would expose credentials to the agent",
    async (transport) => {
      const result = await resolveDefinition({ ...definitionBase, transport });

      expect(result).toEqual({
        status: "unavailable",
        reason:
          "Selected Codex MCP server definition is unsupported or requires credential material that cannot be isolated from the agent",
      });
    },
  );

  it("rejects unsupported selected transports", async () => {
    const result = await resolveDefinition({
      ...definitionBase,
      transport: { type: "websocket", url: "wss://mcp.example.test" },
    });

    expect(result.status).toBe("unavailable");
  });

  it("rejects unsafe selected server names before invoking Codex", async () => {
    let invoked = false;
    const result = await resolveCodexMcpRuntimeDefinition({
      name: "unsafe.name",
      repositoryRoot: "/tmp",
      logRoot: "/tmp",
      run: () => {
        invoked = true;
        return Promise.reject(new Error("should not run"));
      },
    });

    expect(result.status).toBe("unavailable");
    expect(invoked).toBe(false);
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
