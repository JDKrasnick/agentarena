import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadFightConfig } from "../../src/config/load-config.js";

describe("configuration", () => {
  it("lets CLI values override YAML and normalizes duration limits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-config-"));
    await writeFile(
      path.join(root, "agent-arena.yaml"),
      [
        "test: npm test",
        "agents: [claude, gemini]",
        "limits:",
        "  implementation_minutes: 1",
        "permissions:",
        "  default: deny",
      ].join("\n"),
    );
    const config = await loadFightConfig({
      task: "do work",
      repositoryRoot: root,
      testCommand: "pnpm test",
      agents: "codex,claude",
      permissionMode: "confirm",
    });
    expect(config.testCommand).toBe("pnpm test");
    expect(config.agents).toEqual(["codex", "claude"]);
    expect(config.limits.implementationMs).toBe(60_000);
    expect(config.permissionMode).toBe("confirm");
  });

  it("rejects duplicate contestants", async () => {
    await expect(
      loadFightConfig({
        task: "do work",
        repositoryRoot: process.cwd(),
        testCommand: "true",
        agents: "codex,codex",
      }),
    ).rejects.toThrow(/different agents/);
  });

  it("rejects unknown YAML keys instead of silently ignoring typos", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-config-typo-"));
    await writeFile(
      path.join(root, "agent-arena.yaml"),
      "test: npm test\ntset: misspelled\n",
    );
    await expect(
      loadFightConfig({
        task: "do work",
        repositoryRoot: root,
      }),
    ).rejects.toThrow(/Unrecognized key/);
  });
});
