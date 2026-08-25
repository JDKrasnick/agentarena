import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
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

  it("applies the frozen MCP allowlist without changing global configuration", () => {
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
    const args = providerCommand("codex", undefined, policy).args;

    expect(args).not.toContain("mcp_servers.selected.enabled=true");
    expect(args).toContain("mcp_servers.omitted.enabled=false");
  });

  it("refuses Codex MCP names that its dotted configuration path cannot isolate", () => {
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

    expect(() => providerCommand("codex", undefined, policy)).toThrow(
      /cannot be isolated safely/,
    );
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
});

describe("implementation transport classification", () => {
  async function invoke(script: string, timeoutMs = 2_000) {
    const worktree = await mkdtemp(path.join(os.tmpdir(), "arena-adapter-"));
    return new CommandAgentAdapter({
      id: "codex",
      executable: process.execPath,
      args: ["-e", script],
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
});

describe("provider connectivity probing", () => {
  async function probe(script: string) {
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
