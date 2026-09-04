import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  codexMcpInlineTable,
  CommandAgentAdapter,
  parseModelSubmission,
  providerCommand,
} from "../../src/agents/adapter.js";

describe("provider model selection", () => {
  it.each([
    ["codex", "gpt-arena"],
    ["claude", "claude-opus"],
    ["gemini", "gemini-pro"],
  ] as const)("passes the selected model to %s", (provider, model) => {
    expect(providerCommand(provider, model).args).toEqual(
      expect.arrayContaining(["--model", model]),
    );
  });

  it("does not override the provider default when no model is selected", () => {
    expect(providerCommand("codex").args).not.toContain("--model");
  });

  it("resolves the Codex default-family alias to its ChatGPT CLI model ID", () => {
    const command = providerCommand("codex", "gpt-5.6");

    expect(command.args).toEqual(
      expect.arrayContaining(["--model", "gpt-5.6-sol"]),
    );
    expect(command.model).toBe("gpt-5.6-sol");
  });

  it("applies the frozen MCP allowlist without leaking its definition", async () => {
    const policy = {
      version: 1 as const,
      mode: "configure_selection" as const,
      inventory: [
        {
          provider: "codex" as const,
          state: "known" as const,
          servers: [
            {
              name: "selected",
              enabled: true,
              authentication: "ready" as const,
              readiness: "ready" as const,
            },
            {
              name: "omitted",
              enabled: true,
              authentication: "ready" as const,
              readiness: "ready" as const,
            },
          ],
          diagnosticArtifactRefs: [],
        },
      ],
      servers: [
        {
          provider: "codex" as const,
          name: "selected",
          enabledInSnapshot: true,
          authentication: "ready" as const,
          readiness: "ready" as const,
          role: "agent" as const,
          requirement: "required" as const,
          decision: "included" as const,
          reason: "selected",
        },
        {
          provider: "codex" as const,
          name: "omitted",
          enabledInSnapshot: true,
          authentication: "ready" as const,
          readiness: "ready" as const,
          role: "agent" as const,
          requirement: "optional" as const,
          decision: "excluded" as const,
          reason: "omitted",
        },
      ],
      coverageGaps: [],
      frozenAt: "2026-08-25T00:00:00.000Z",
      policyHash: "0".repeat(64),
    };
    const command = providerCommand("codex", undefined, policy, [
      {
        provider: "codex",
        name: "selected",
        transport: {
          type: "stdio",
          command: "selected-server",
          args: ["--safe"],
          env_vars: [],
          cwd: null,
        },
        enabled_tools: null,
        disabled_tools: null,
        startup_timeout_sec: null,
        tool_timeout_sec: null,
      },
    ]);
    const args = command.args;

    expect(args).toEqual(
      expect.arrayContaining([
        "--ignore-user-config",
        "-c",
        "features.apps=false",
      ]),
    );
    expect(args.join(" ")).toContain("mcp_servers.selected=");
    expect(args.join(" ")).not.toContain("omitted");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--full-auto");
    expect(command.displayCommand).not.toContain("selected-server");
    expect(command.secrets).toEqual(
      expect.arrayContaining(["selected-server", "--safe"]),
    );
    expect(command.mcpExposure).toEqual({
      version: 1,
      policyHash: "0".repeat(64),
      isolationMode: "codex_ignore_user_config",
      appsDisabled: true,
      exposedServerNames: ["selected"],
    });

    const root = await mkdtemp(path.join(os.tmpdir(), "arena-mcp-adapter-"));
    const adapter = new CommandAgentAdapter({
      id: "codex",
      ...command,
      executable: "definitely-missing-agent-arena-executable",
    });
    const probe = await adapter.probeConnectivity({
      cwd: root,
      transcriptPrefix: path.join(root, "probe"),
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    });
    const diagnostics = [
      probe.command.command,
      probe.command.failureExcerpt ?? "",
      await readFile(probe.command.stderrPath, "utf8"),
    ].join("\n");
    expect(diagnostics).not.toContain("selected-server");
    expect(diagnostics).not.toContain("--safe");
  });

  it("does not reference unsafe unselected Codex MCP names", () => {
    const policy = {
      version: 1 as const,
      mode: "keep_configured" as const,
      inventory: [
        {
          provider: "codex" as const,
          state: "known" as const,
          servers: [
            {
              name: "unsafe.name",
              enabled: true,
              authentication: "ready" as const,
              readiness: "ready" as const,
            },
          ],
          diagnosticArtifactRefs: [],
        },
      ],
      servers: [],
      coverageGaps: [],
      frozenAt: "2026-08-25T00:00:00.000Z",
      policyHash: "0".repeat(64),
    };

    const args = providerCommand("codex", undefined, policy).args;
    expect(args.join(" ")).not.toContain("unsafe.name");
    expect(args).toContain("--full-auto");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("refuses to treat an unknown Codex inventory as an empty allowlist", () => {
    const policy = {
      version: 1 as const,
      mode: "keep_configured" as const,
      inventory: [
        {
          provider: "codex" as const,
          state: "unknown" as const,
          servers: [],
          diagnosticArtifactRefs: [],
        },
      ],
      servers: [],
      coverageGaps: [],
      frozenAt: "2026-08-25T00:00:00.000Z",
      policyHash: "0".repeat(64),
    };

    expect(() => providerCommand("codex", undefined, policy)).toThrow(
      /inventory is unknown/,
    );
  });

  it("refuses a nonempty Claude MCP policy that cannot be strictly isolated", () => {
    const policy = {
      version: 1 as const,
      mode: "configure_selection" as const,
      inventory: [],
      servers: [
        {
          provider: "claude" as const,
          name: "github",
          enabledInSnapshot: true,
          authentication: "ready" as const,
          readiness: "ready" as const,
          role: "agent" as const,
          requirement: "optional" as const,
          decision: "included" as const,
          reason: "selected",
        },
      ],
      coverageGaps: [],
      frozenAt: "2026-08-25T00:00:00.000Z",
      policyHash: "0".repeat(64),
    };

    expect(() => providerCommand("claude", undefined, policy)).toThrow(
      /strict-mcp-config/,
    );
  });

  it("keeps harness-only MCP selections out of every provider tool catalog", () => {
    const server = {
      name: "secrets",
      enabled: true,
      authentication: "ready" as const,
      readiness: "ready" as const,
    };
    const selection = {
      name: server.name,
      enabledInSnapshot: true,
      authentication: server.authentication,
      readiness: server.readiness,
      role: "harness_only" as const,
      requirement: "optional" as const,
      decision: "included" as const,
      reason: "selected",
    };
    const base = {
      version: 1 as const,
      mode: "configure_selection" as const,
      coverageGaps: [],
      frozenAt: "2026-08-25T00:00:00.000Z",
      policyHash: "0".repeat(64),
    };
    const codex = providerCommand("codex", undefined, {
      ...base,
      inventory: [
        {
          provider: "codex" as const,
          state: "known" as const,
          servers: [server],
          diagnosticArtifactRefs: [],
        },
      ],
      servers: [{ provider: "codex" as const, ...selection }],
    });
    const claude = providerCommand("claude", undefined, {
      ...base,
      inventory: [
        {
          provider: "claude" as const,
          state: "known" as const,
          servers: [server],
          diagnosticArtifactRefs: [],
        },
      ],
      servers: [{ provider: "claude" as const, ...selection }],
    });
    const gemini = providerCommand("gemini", undefined, {
      ...base,
      inventory: [
        {
          provider: "gemini" as const,
          state: "known" as const,
          servers: [server],
          diagnosticArtifactRefs: [],
        },
      ],
      servers: [{ provider: "gemini" as const, ...selection }],
    });

    expect(codex.args).toContain("--ignore-user-config");
    expect(codex.args.join(" ")).not.toContain("mcp_servers.secrets");
    expect(claude.args).toEqual(
      expect.arrayContaining(["--strict-mcp-config"]),
    );
    expect(gemini.args).toEqual(
      expect.arrayContaining(["--allowed-mcp-server-names", ""]),
    );
  });

  it("refuses a selected Codex server without a validated runtime definition", () => {
    const policy = {
      version: 1 as const,
      mode: "configure_selection" as const,
      inventory: [
        {
          provider: "codex" as const,
          state: "known" as const,
          servers: [
            {
              name: "selected",
              enabled: true,
              authentication: "ready" as const,
              readiness: "ready" as const,
            },
          ],
          diagnosticArtifactRefs: [],
        },
      ],
      servers: [
        {
          provider: "codex" as const,
          name: "selected",
          enabledInSnapshot: true,
          authentication: "ready" as const,
          readiness: "ready" as const,
          role: "agent" as const,
          requirement: "required" as const,
          decision: "included" as const,
          reason: "selected",
        },
      ],
      coverageGaps: [],
      frozenAt: "2026-08-25T00:00:00.000Z",
      policyHash: "0".repeat(64),
    };

    expect(() => providerCommand("codex", undefined, policy)).toThrow(
      /no unique validated runtime definition/,
    );
  });

  it("serializes supported HTTP credential references without literal headers", () => {
    const table = codexMcpInlineTable({
      provider: "codex",
      name: "remote",
      transport: {
        type: "streamable_http",
        url: "https://mcp.example.test/api",
        bearer_token_env_var: "MCP_BEARER_TOKEN",
        env_http_headers: { "X-Api-Key": "MCP_API_KEY" },
      },
      enabled_tools: ["resources/list"],
      disabled_tools: null,
      startup_timeout_sec: 5,
      tool_timeout_sec: null,
    });

    expect(table).toContain('bearer_token_env_var="MCP_BEARER_TOKEN"');
    expect(table).toContain('env_http_headers={"X-Api-Key"="MCP_API_KEY"}');
    expect(table).not.toContain("Authorization: Bearer");
  });
});

describe("implementation transport classification", () => {
  async function invoke(
    script: string,
    timeoutMs = 2_000,
    providerStream = false,
  ) {
    const worktree = await mkdtemp(path.join(os.tmpdir(), "arena-adapter-"));
    return new CommandAgentAdapter({
      id: "codex",
      executable: process.execPath,
      args: ["-e", script],
      ...(providerStream ? { providerStream: "codex" as const } : {}),
    }).implement({
      worktree,
      contestantId: "a",
      prompt: "implement",
      promptPath: path.join(worktree, "prompt.md"),
      transcriptPrefix: path.join(worktree, "implementation"),
      timeoutMs,
      signal: new AbortController().signal,
    });
  }

  it("lets a successful invocation contain harmless transport-like text", async () => {
    const invocation = await invoke(
      'console.log("transport closed after successful upload")',
    );

    expect(invocation.command?.transportFailures).toHaveLength(1);
    expect(invocation.status).toBe("succeeded");
  });

  it("lets transport evidence override a nonzero provider exit", async () => {
    const invocation = await invoke(
      'console.error("MCP OAuth authentication failed"); process.exit(8)',
    );

    expect(invocation.command?.transportFailures?.[0]?.kind).toBe("mcp_auth");
    expect(invocation.status).toBe("infrastructure_error");
  });

  it("does not let an incidental MCP warning override a usable terminal result", async () => {
    const invocation = await invoke(
      `require("node:fs").writeFileSync(process.env.AGENT_ARENA_SUBMISSION, JSON.stringify({version: 1, explanation: "usable"})); console.error("MCP OAuth refresh token expired"); process.exit(8)`,
    );

    expect(invocation.command?.exitCode).toBe(8);
    expect(invocation.command?.transportFailures?.[0]?.kind).toBe("mcp_auth");
    expect(invocation.status).toBe("succeeded");
  });

  it("classifies a harness-enforced deadline as timed out despite transport noise", async () => {
    const invocation = await invoke(
      'console.error("transport connection lost"); setInterval(() => undefined, 1000)',
      1_000,
    );

    expect(invocation.command?.timedOut).toBe(true);
    expect(invocation.command?.transportFailures).toHaveLength(1);
    expect(invocation.status).toBe("timed_out");
  });

  it("preserves a deadline when a usable submission was written before timeout", async () => {
    const invocation = await invoke(
      `require("node:fs").writeFileSync(process.env.AGENT_ARENA_SUBMISSION, JSON.stringify({version: 1, explanation: "usable"})); setInterval(() => undefined, 1000)`,
      1_000,
      true,
    );

    expect(invocation.command?.timedOut).toBe(true);
    expect(invocation.command?.deadline?.kind).toBe("idle");
    expect(invocation.status).toBe("timed_out");
  });
});

describe("provider connectivity probing", () => {
  async function probe(script: string, mcpServerName?: string) {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "arena-probe-"));
    return new CommandAgentAdapter({
      id: "codex",
      executable: process.execPath,
      args: ["-e", script],
    }).probeConnectivity({
      cwd,
      transcriptPrefix: path.join(cwd, "probe"),
      timeoutMs: 2_000,
      signal: new AbortController().signal,
      ...(mcpServerName ? { mcpServerName } : {}),
    });
  }

  it("requires the exact backend-authenticating sentinel", async () => {
    const [exact, empty, unrelated] = await Promise.all([
      probe('console.log("AGENT_ARENA_PROVIDER_HEALTH_OK")'),
      probe(""),
      probe('console.log("provider is probably healthy")'),
    ]);

    expect(exact.healthy).toBe(true);
    expect(empty.healthy).toBe(false);
    expect(unrelated.healthy).toBe(false);
    expect(unrelated.reason).toContain("did not return the exact");
  });

  it("fails a scoped MCP probe when that server reports a nonfatal auth error", async () => {
    const warning =
      "failed to refresh OAuth tokens for server expo: invalid_grant: expired refresh token";
    const result = await probe(
      `console.log("AGENT_ARENA_PROVIDER_HEALTH_OK"); console.error(${JSON.stringify(warning)})`,
      "expo",
    );

    expect(result.healthy).toBe(false);
    expect(result.transportFailures).toEqual([
      expect.objectContaining({ kind: "mcp_auth", detail: warning }),
    ]);
  });

  it("fails a scoped MCP probe when the selected server never becomes ready", async () => {
    const warning =
      "resources/list failed: MCP server 'google' was not ready for this step";
    const result = await probe(
      `console.log("AGENT_ARENA_PROVIDER_HEALTH_OK"); console.error(${JSON.stringify(warning)})`,
      "google",
    );

    expect(result.healthy).toBe(false);
    expect(result.transportFailures).toEqual([
      expect.objectContaining({ kind: "transport", detail: warning }),
    ]);
  });

  it("requires a scoped probe to perform read-only discovery against the named server", async () => {
    const script = `let input = ""; process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => { if (input.includes("read-only MCP discovery") && input.includes("google")) console.log("AGENT_ARENA_PROVIDER_HEALTH_OK"); });`;
    const result = await probe(script, "google");

    expect(result.healthy).toBe(true);
  });
});

describe("structured model-output recovery", () => {
  it("accepts an unambiguously formatted verdict", () => {
    const verdict = parseModelSubmission(
      z.object({ relevant: z.boolean(), severity: z.enum(["medium"]) }),
      'Here is the verdict:\n```json\n{"relevant": "yes", "severity": "Medium"}\n```',
    );

    expect(verdict).toEqual({ relevant: true, severity: "medium" });
  });

  it("does not fabricate missing required data", () => {
    expect(() =>
      parseModelSubmission(z.object({ rationale: z.string().min(1) }), "{}"),
    ).toThrow();
  });
});
