import { describe, expect, it } from "vitest";
import {
  infrastructureReviewCommand,
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

  it("keeps mirror-match infrastructure reviews on each contestant model", () => {
    const first = infrastructureReviewCommand({
      agent: "codex",
      model: "gpt-first",
    });
    const second = infrastructureReviewCommand({
      agent: "codex",
      model: "gpt-second",
    });

    expect(first.args).toEqual(
      expect.arrayContaining(["--model", "gpt-first"]),
    );
    expect(second.args).toEqual(
      expect.arrayContaining(["--model", "gpt-second"]),
    );
  });
});
