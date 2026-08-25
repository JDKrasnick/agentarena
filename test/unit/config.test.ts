import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadFightConfig } from "../../src/config/load-config.js";

describe("configuration", () => {
  it("defaults review calls to ten minutes and rejects a higher limit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-config-review-"));
    await writeFile(path.join(root, "agent-arena.yaml"), "test: 'true'\n");
    await expect(
      loadFightConfig({ task: "review", repositoryRoot: root }),
    ).resolves.toMatchObject({ limits: { reviewMs: 600_000 } });

    await writeFile(
      path.join(root, "agent-arena.yaml"),
      "test: 'true'\nlimits:\n  review_minutes: 10.1\n",
    );
    await expect(
      loadFightConfig({ task: "review", repositoryRoot: root }),
    ).rejects.toThrow();
  });

  it("loads an explicit bounded browser profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-config-browser-"));
    await writeFile(
      path.join(root, "agent-arena.yaml"),
      [
        "test: npm test",
        "browser:",
        "  runner: playwright",
        "  startup: npm run dev",
        "  health_url: http://127.0.0.1:4173/health",
        "  base_url: http://127.0.0.1:4173",
        "  test: npm run test:e2e",
        "  port_mode: dynamic",
        "  native_suite_mode: self_managed",
        "  projects: [chromium]",
        "  allowed_origins: [http://127.0.0.1:4173]",
      ].join("\n"),
    );
    await expect(
      loadFightConfig({ task: "Fix mobile UI", repositoryRoot: root }),
    ).resolves.toMatchObject({
      browserProfile: {
        runner: "playwright",
        startupCommand: "npm run dev",
        testCommand: "npm run test:e2e",
        portMode: "dynamic",
        nativeSuiteMode: "self_managed",
        projects: ["chromium"],
      },
    });
  });

  it("lets CLI values override YAML and normalizes duration limits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-config-"));
    await writeFile(
      path.join(root, "agent-arena.yaml"),
      [
        "test: npm test",
        "agents: [claude, gemini]",
        "models: [claude-sonnet, gemini-flash]",
        "limits:",
        "  implementation_minutes: 1",
        "  review_minutes: 6",
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
    });
    expect(config.testCommand).toBe("pnpm test");
    expect(config.contestants).toMatchObject([
      { id: "a", provider: "codex", model: "gpt-arena" },
      { id: "b", provider: "claude", model: "claude-opus" },
    ]);
    expect(config.limits.implementationMs).toBe(60_000);
    expect(config.limits.reviewMs).toBe(360_000);
    expect(config.permissionMode).toBe("confirm");
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

  it("accepts the legacy recovery flag once without persisting it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-config-legacy-"));
    await writeFile(
      path.join(root, "agent-arena.yaml"),
      [
        "test: npm test",
        "limits:",
        "  infrastructure_recovery_round: false",
      ].join("\n"),
    );
    const config = await loadFightConfig({
      task: "do work",
      repositoryRoot: root,
    });
    expect(config).not.toHaveProperty("infrastructureRecoveryRound");
    expect(
      config.configWarnings.filter((warning) =>
        warning.includes("infrastructure_recovery_round"),
      ),
    ).toHaveLength(1);
  });
});
