import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { planBrowserValidation } from "../../src/browser/planner.js";
import { FightConfigSchema } from "../../src/core/types.js";
import {
  discoverCapabilities,
  resolvePermissionPolicy,
} from "../../src/permissions/policy.js";
import type { ReconnaissanceSnapshot } from "../../src/task/task-contract.js";
import {
  buildRunSpec,
  collectFightReconnaissance,
} from "../../src/task/task-contract.js";

function config(overrides: Record<string, unknown> = {}) {
  return FightConfigSchema.parse({
    task: "Change parser behavior",
    agents: ["codex", "claude"],
    attackVerifier: "codex",
    rounds: 3,
    maxAttacksPerRound: 3,
    testCommand: "npm test",
    repositoryRoot: "/repo",
    artifactRoot: "/repo/.agent-arena/runs",
    permissionMode: "confirm",
    nonInteractiveApproval: true,
    limits: {
      implementationMs: 1,
      reviewMs: 1,
      attackMs: 1,
      verifierMs: 1,
      repairMs: 1,
    },
    ...overrides,
  });
}

function reconnaissance(
  files: Record<string, string> = {},
): ReconnaissanceSnapshot {
  const snapshot = {
    version: 1 as const,
    task: "task",
    acceptanceCriteria: [],
    request: {
      repositoryRoot: "/repo",
      specPaths: [],
      issueReferences: [],
      pullRequestReferences: [],
      taskReferences: [],
    },
    capturedAt: "2026-08-18T12:00:00.000Z",
    sources: [],
    repositoryEvidence: Object.entries(files).map(([path, content]) => ({
      path,
      content,
      contentHash: "a".repeat(64),
      byteLength: Buffer.byteLength(content),
    })),
    resolvedPullRequests: {},
    inputHash: "b".repeat(64),
  };
  return snapshot;
}

describe("browser validation planner", () => {
  it("requires browser validation from task evidence even without tooling", () => {
    const plan = planBrowserValidation(
      config({ task: "Fix responsive dialog focus behavior" }),
      reconnaissance(),
    );
    expect(plan).toMatchObject({
      requirement: "required",
      unavailableReason: "startup_command_missing",
      capabilityId: "browser_dom_validation",
      role: "harness_only",
      enforcement: "advisory",
    });
  });

  it.each([
    "Improve accessibility",
    "Make the controls accessible",
    "Fix rendering on the settings page",
    "Correct the rendered detail view",
  ])("requires browser validation for documented task wording: %s", (task) => {
    expect(
      planBrowserValidation(config({ task }), reconnaissance()),
    ).toMatchObject({
      requirement: "required",
      enforcement: "advisory",
    });
  });

  it("makes repository-only frontend evidence optional", () => {
    const plan = planBrowserValidation(
      config(),
      reconnaissance({
        "package.json": '{"dependencies":{"react":"19"}}',
      }),
    );
    expect(plan?.requirement).toBe("optional");
  });

  it("recognizes frozen route metadata as optional browser evidence", () => {
    const plan = planBrowserValidation(
      config(),
      reconnaissance({
        "src/routes.ts": "export const routes = [{ path: '/settings' }]",
      }),
    );

    expect(plan).toMatchObject({
      requirement: "optional",
      unavailableReason: "startup_command_missing",
    });
  });

  it("recognizes literal frontend and custom browser scripts", () => {
    const plan = planBrowserValidation(
      config(),
      reconnaissance({
        "package.json":
          '{"scripts":{"dev":"vite","test:browser":"node browser-tests.mjs"}}',
      }),
    );

    expect(plan).toMatchObject({
      requirement: "optional",
      unavailableReason: "base_url_missing",
    });
  });

  it("omits browser validation for a backend-only task and repository", () => {
    expect(
      planBrowserValidation(
        config({ task: "Fix database transaction retry" }),
        reconnaissance({ "package.json": '{"dependencies":{"pg":"8"}}' }),
      ),
    ).toBeUndefined();
  });

  it("uses an exact explicit profile before repository inference", () => {
    const plan = planBrowserValidation(
      config({
        task: "Fix mobile navigation",
        browserProfile: {
          runner: "playwright",
          startupCommand: "npm run dev",
          healthUrl: "http://127.0.0.1:4173/health",
          baseUrl: "http://127.0.0.1:4173",
          testCommand: "npm run test:e2e",
          projects: ["chromium"],
          allowedOrigins: ["http://127.0.0.1:4173"],
        },
      }),
      reconnaissance({ "pnpm-workspace.yaml": "packages: ['apps/*']" }),
    );
    expect(plan?.profile).toMatchObject({
      source: "arena_configuration",
      runner: "playwright",
      projects: ["chromium"],
    });
  });

  it("does not auto-approve the advisory native browser boundary", () => {
    const fightConfig = config({
      task: "Fix mobile navigation",
      permissionMode: "auto",
      reducedValidationAccepted: true,
      permissionAllow: {
        browser_dom_validation: {
          mode: "auto",
          role: "harness_only",
          scopes: [],
        },
      },
      browserProfile: {
        runner: "playwright",
        startupCommand: "npm start",
        healthUrl: "http://127.0.0.1:4173/health",
        baseUrl: "http://127.0.0.1:4173",
        testCommand: "npm run test:e2e",
        projects: [],
        allowedOrigins: ["http://127.0.0.1:4173"],
      },
    });
    const policy = resolvePermissionPolicy(
      fightConfig,
      discoverCapabilities(fightConfig, reconnaissance()),
    );

    expect(
      policy.capabilities.find(
        (capability) => capability.id === "browser_dom_validation",
      ),
    ).toMatchObject({ enforcement: "advisory", status: "denied" });
  });

  it("refuses to choose among monorepo applications", () => {
    const plan = planBrowserValidation(
      config({ task: "Fix UI layout" }),
      reconnaissance({
        "package.json":
          '{"workspaces":["apps/*"],"dependencies":{"react":"19"}}',
      }),
    );
    expect(plan?.unavailableReason).toBe("ambiguous_monorepo");
  });

  it("resolves literal Playwright configuration and package scripts", () => {
    const plan = planBrowserValidation(
      config({ task: "Fix keyboard interaction" }),
      reconnaissance({
        "package.json":
          '{"dependencies":{"@playwright/test":"1"},"scripts":{"dev":"vite","test:e2e":"playwright test"}}',
        "playwright.config.ts":
          "export default { webServer: { command: 'npm run dev', url: 'http://localhost:4173' }, use: { baseURL: 'http://localhost:4173' }, projects: [{ name: 'chromium' }] }",
      }),
    );
    expect(plan?.profile).toMatchObject({
      source: "playwright_configuration",
      startupCommand: "npm run dev",
      testCommand: "npm run test:e2e",
      nativeSuiteMode: "self_managed",
      baseUrl: "http://localhost:4173",
      projects: ["chromium"],
      allowedOrigins: ["http://localhost:4173"],
    });
  });

  it("requires a separate exact capability for an external origin", () => {
    const fightConfig = config({
      task: "Fix browser navigation",
      browserProfile: {
        runner: "custom",
        startupCommand: "npm start",
        healthUrl: "https://example.com/health",
        baseUrl: "https://example.com",
        testCommand: "npm run browser",
        projects: [],
        allowedOrigins: ["https://example.com"],
      },
    });
    const recon = reconnaissance();
    expect(planBrowserValidation(fightConfig, recon)?.profile?.baseUrl).toBe(
      "https://example.com",
    );
    const originCapability = discoverCapabilities(fightConfig, recon).find(
      (capability) => capability.id.startsWith("browser_origin_"),
    );
    expect(originCapability?.requirement).toBe("required");
    expect(originCapability?.scopes).toEqual(["origin:https://example.com"]);
    expect(() =>
      resolvePermissionPolicy(fightConfig, [
        {
          id: "browser_dom_validation",
          reason: "external origin",
          risk: "medium",
          requirement: "required",
          role: "harness_only",
          enforcement: "advisory",
          scopes: [],
          available: false,
        },
      ]),
    ).toThrow("Required capabilities were not approved");
  });

  it("does not approve browser execution when a required origin was denied", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-browser-origin-"));
    const fightConfig = config({
      task: "Fix browser navigation",
      repositoryRoot: root,
      artifactRoot: path.join(root, "runs"),
      browserProfile: {
        runner: "custom",
        startupCommand: "npm start",
        healthUrl: "https://example.com/health",
        baseUrl: "https://example.com",
        testCommand: "npm run browser",
        projects: [],
        allowedOrigins: ["https://example.com"],
      },
    });
    const recon = await collectFightReconnaissance(fightConfig, {
      now: new Date("2026-08-18T12:00:00Z"),
    });
    const requests = discoverCapabilities(fightConfig, recon);
    const browser = requests.find(
      (capability) => capability.id === "browser_dom_validation",
    );
    const origin = requests.find((capability) =>
      capability.id.startsWith("browser_origin_"),
    );
    if (!browser || !origin) throw new Error("Browser capabilities missing");
    const runSpec = await buildRunSpec({
      runId: "denied-browser-origin",
      baseCommit: "a".repeat(40),
      config: fightConfig,
      permissions: {
        defaultMode: "confirm",
        reducedValidationAccepted: true,
        capabilities: [
          { ...browser, mode: "confirm", status: "approved" },
          { ...origin, mode: "deny", status: "denied" },
        ],
      },
      repositoryRoot: root,
      sourceDirectory: path.join(root, "sources"),
      reconnaissance: recon,
    });

    expect(runSpec.browserValidation).toMatchObject({
      decision: "denied",
      approvedScopes: [],
    });
  });

  it("scopes an explicit dynamic port to the approved loopback host", () => {
    const fightConfig = config({
      task: "Fix responsive navigation",
      browserProfile: {
        runner: "playwright",
        startupCommand: "npm start",
        healthUrl: "http://127.0.0.1:4173/health",
        baseUrl: "http://127.0.0.1:4173",
        testCommand: "npm run browser",
        portMode: "dynamic",
        projects: [],
        allowedOrigins: ["http://127.0.0.1:4173"],
      },
    });
    const capability = discoverCapabilities(fightConfig, reconnaissance()).find(
      (entry) => entry.id === "browser_dom_validation",
    );
    expect(capability?.scopes).toContain("loopback:http://127.0.0.1:dynamic");
    expect(capability?.scopes).not.toContain("origin:http://127.0.0.1:4173");
  });

  it("freezes the resolved plan, commands, scopes, and decision in RunSpec", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-browser-spec-"));
    const fightConfig = config({
      task: "Fix responsive dialog focus",
      repositoryRoot: root,
      artifactRoot: path.join(root, "runs"),
      browserProfile: {
        runner: "playwright",
        startupCommand: "npm run dev",
        healthUrl: "http://127.0.0.1:4173/health",
        baseUrl: "http://127.0.0.1:4173",
        testCommand: "npm run test:e2e",
        projects: ["chromium"],
        allowedOrigins: ["http://127.0.0.1:4173"],
      },
    });
    const recon = await collectFightReconnaissance(fightConfig, {
      now: new Date("2026-08-18T12:00:00Z"),
    });
    const scopes = [
      "command:npm run dev",
      "command:npm run test:e2e",
      "origin:http://127.0.0.1:4173",
    ];
    const runSpec = await buildRunSpec({
      runId: "browser-run",
      baseCommit: "a".repeat(40),
      config: fightConfig,
      permissions: {
        defaultMode: "confirm",
        reducedValidationAccepted: false,
        capabilities: [
          {
            id: "browser_dom_validation",
            reason: "task requires browser behavior",
            risk: "medium",
            requirement: "required",
            role: "harness_only",
            enforcement: "advisory",
            mode: "confirm",
            scopes,
            status: "approved",
          },
        ],
      },
      repositoryRoot: root,
      sourceDirectory: path.join(root, "sources"),
      reconnaissance: recon,
    });
    expect(runSpec.browserValidation).toMatchObject({
      requirement: "required",
      decision: "approved",
      approvedScopes: scopes,
      profile: { runner: "playwright" },
    });
    expect(runSpec.commands.map((command) => command.kind)).toContain(
      "browser_test",
    );
  });
});
