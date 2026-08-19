import { createServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuiltInBrowserAdapters } from "../../src/browser/builtin.js";
import { executeBrowserValidation } from "../../src/browser/executor.js";
import type { BrowserPlan } from "../../src/browser/planner.js";

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe.runIf(process.env.ARENA_REAL_BROWSER === "1")(
  "built-in browser lifecycle",
  () => {
    const controllers: AbortController[] = [];
    afterEach(() => controllers.splice(0).forEach((value) => value.abort()));

    it("starts, probes, records failures, and tears down Chromium", async () => {
      const port = await unusedPort();
      const origin = `http://127.0.0.1:${String(port)}`;
      const artifacts = await mkdtemp(path.join(os.tmpdir(), "arena-browser-"));
      const plan: BrowserPlan = {
        version: 1,
        requirement: "required",
        evidence: [{ source: "task", location: "fixture", detail: "UI task" }],
        capabilityId: "browser_dom_validation",
        role: "harness_only",
        enforcement: "brokered",
        probeFamilies: ["interaction", "responsive", "semantics"],
        profile: {
          source: "arena_configuration",
          runner: "playwright",
          startupCommand: "node test/fixtures/browser-app/server.mjs",
          healthUrl: `${origin}/health`,
          baseUrl: origin,
          testCommand: "node test/fixtures/browser-app/native-test.mjs",
          projects: ["repository-native"],
          allowedOrigins: [origin],
        },
      };
      const controller = new AbortController();
      controllers.push(controller);
      const adapter = createBuiltInBrowserAdapters().playwright;
      expect(adapter).toBeDefined();
      const verified = await executeBrowserValidation({
        plan,
        decision: "approved",
        adapter: adapter!,
        worktree: process.cwd(),
        artifactDirectory: path.join(artifacts, "verified"),
        approvedOrigins: [origin],
        selectedProbes: [
          {
            id: "desktop",
            family: "interaction",
            profile: "desktop",
            expectedBehavior: "Page renders",
            actions: [
              { kind: "goto", path: "/" },
              { kind: "assert_text", text: "browser-ready" },
            ],
          },
          {
            id: "mobile",
            family: "responsive",
            profile: "mobile",
            expectedBehavior: "Page reflows",
            actions: [{ kind: "goto", path: "/" }],
          },
          {
            id: "reflow",
            family: "responsive",
            profile: "reflow_320",
            expectedBehavior: "Page reflows at 320 CSS pixels",
            actions: [{ kind: "goto", path: "/" }],
          },
        ],
        signal: controller.signal,
      });
      expect(verified.status).toBe("verified");
      expect(verified.probes).toHaveLength(4);
      await expect(fetch(`${origin}/health`)).rejects.toThrow();

      const blocked = await executeBrowserValidation({
        plan,
        decision: "approved",
        adapter: adapter!,
        worktree: process.cwd(),
        artifactDirectory: path.join(artifacts, "blocked"),
        approvedOrigins: [origin],
        selectedProbes: [
          {
            id: "blocked-origin",
            family: "runtime_dom_integrity",
            profile: "desktop",
            expectedBehavior: "No undeclared network dependency",
            actions: [{ kind: "goto", path: "/external" }],
          },
        ],
        signal: controller.signal,
      });
      expect(blocked.status).toBe("failed");
      expect(blocked.failureAttribution).toBe("contestant_application");
      expect(blocked.probes.at(-1)?.blockedOrigins).toContain(
        "https://blocked.example",
      );
      expect(
        blocked.artifacts.some((artifact) => artifact.kind === "screenshot"),
      ).toBe(true);
      await expect(fetch(`${origin}/health`)).rejects.toThrow();
    });
  },
);
