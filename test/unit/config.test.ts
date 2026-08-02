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
        "models: [claude-sonnet, gemini-flash]",
        "attack_verifier_model: verifier-from-yaml",
        "quality_verifier_model: quality-from-yaml",
        "harness_maintainer_model: maintainer-from-yaml",
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
      models: "gpt-arena,claude-opus",
      permissionMode: "confirm",
      verifierModel: "verifier-from-cli",
    });
    expect(config.testCommand).toBe("pnpm test");
    expect(config.contestants).toMatchObject([
      { id: "a", provider: "codex", model: "gpt-arena" },
      { id: "b", provider: "claude", model: "claude-opus" },
    ]);
    expect(config.limits.implementationMs).toBe(60_000);
    expect(config.permissionMode).toBe("confirm");
    expect(config).toMatchObject({
      attackVerifierModel: "verifier-from-cli",
      qualityVerifierModel: "quality-from-yaml",
      harnessMaintainerModel: "maintainer-from-yaml",
    });
  });

  it("leaves models unset when neither CLI nor YAML selects them", async () => {
    const config = await loadFightConfig({
      task: "do work",
      repositoryRoot: process.cwd(),
      testCommand: "true",
      agents: "codex,claude",
    });

    expect(config.contestants.map((contestant) => contestant.model)).toEqual([
      undefined,
      undefined,
    ]);
    expect(config.attackVerifierModel).toBeUndefined();
    expect(config.qualityVerifierModel).toBeUndefined();
    expect(config.harnessMaintainerModel).toBeUndefined();
  });

  it("rejects blank internal role models", async () => {
    await expect(
      loadFightConfig({
        task: "do work",
        repositoryRoot: process.cwd(),
        testCommand: "true",
        verifierModel: "   ",
      }),
    ).rejects.toThrow();
  });

  it("rejects partial model selections", async () => {
    await expect(
      loadFightConfig({
        task: "do work",
        repositoryRoot: process.cwd(),
        testCommand: "true",
        models: "gpt-arena,",
      }),
    ).rejects.toThrow(
      "Exactly two non-empty comma-separated models are required",
    );
  });

  it("allows duplicate providers in separate contestant slots", async () => {
    await expect(
      loadFightConfig({
        task: "do work",
        repositoryRoot: process.cwd(),
        testCommand: "true",
        agents: "codex,codex",
      }),
    ).resolves.toMatchObject({
      contestants: [
        { id: "a", provider: "codex" },
        { id: "b", provider: "codex" },
      ],
    });
  });

  it("normalizes catch-up and siege roles into stable slots", async () => {
    const catchUp = await loadFightConfig({
      task: "Recreate PR #9",
      repositoryRoot: process.cwd(),
      testCommand: "true",
      mode: "catch_up",
      pullRequestReferences: ["9"],
      challenger: "claude",
      incumbent: "codex",
    });
    expect(catchUp).toMatchObject({
      mode: "catch_up",
      contestants: [
        {
          id: "a",
          provider: "codex",
          role: "incumbent",
          startingPatch: "pull_request",
        },
        { id: "b", provider: "claude", role: "challenger" },
      ],
    });

    const siege = await loadFightConfig({
      task: "Defend PR #9",
      repositoryRoot: process.cwd(),
      testCommand: "true",
      mode: "siege",
      pullRequestReferences: ["9"],
      attacker: "codex",
      defender: "gemini",
    });
    expect(siege).toMatchObject({
      mode: "siege",
      contestants: [
        { id: "a", provider: "codex", role: "attacker" },
        {
          id: "b",
          provider: "gemini",
          role: "defender",
          startingPatch: "pull_request",
        },
      ],
    });
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
