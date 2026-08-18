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
