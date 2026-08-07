import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
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
