import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
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
        enforcement: "advisory",
        probeFamilies: [
          "interaction",
          "responsive",
          "semantics",
          "dom_security",
        ],
        profile: {
          source: "arena_configuration",
          runner: "playwright",
          startupCommand: "node test/fixtures/browser-app/server.mjs",
          healthUrl: `${origin}/health`,
          baseUrl: origin,
          testCommand: "node test/fixtures/browser-app/native-test.mjs",
          portMode: "dynamic",
          projects: ["repository-native"],
          allowedOrigins: [origin],
        },
      };
      const controller = new AbortController();
      controllers.push(controller);
      const adapter = createBuiltInBrowserAdapters().playwright;
      expect(adapter).toBeDefined();
      const reservedStaticPort = createServer();
      await new Promise<void>((resolve) =>
        reservedStaticPort.listen(port, "127.0.0.1", resolve),
      );
      const verified = await executeBrowserValidation({
        plan,
        decision: "approved",
        adapter: adapter!,
        worktree: process.cwd(),
        artifactDirectory: path.join(artifacts, "verified"),
        approvedOrigins: [origin],
        dynamicLoopbackApproved: true,
        timeoutMs: 30_000,
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
          {
            id: "same-origin-websocket",
            family: "interaction",
            profile: "desktop",
            expectedBehavior: "Approved same-origin WebSockets remain usable",
            actions: [
              { kind: "goto", path: "/same-origin-websocket" },
              { kind: "assert_text", text: "socket-ready" },
            ],
          },
        ],
        signal: controller.signal,
      });
      expect(verified.status).toBe("verified");
      expect(verified.probes).toHaveLength(8);

      const fixedPortCollision = await executeBrowserValidation({
        plan: {
          ...plan,
          profile: { ...plan.profile!, portMode: "fixed" },
        },
        decision: "approved",
        adapter: adapter!,
        worktree: process.cwd(),
        artifactDirectory: path.join(artifacts, "fixed-port-collision"),
        approvedOrigins: [origin],
        timeoutMs: 30_000,
        selectedProbes: [],
        signal: controller.signal,
      });
      expect(fixedPortCollision).toMatchObject({
        status: "unverified",
        reason: "launch_failure",
        provisionAttempts: 2,
        failureAttribution: "harness_configuration",
      });
      await new Promise<void>((resolve) =>
        reservedStaticPort.close(() => resolve()),
      );
      await expect(fetch(`${origin}/health`)).rejects.toThrow();

      const invalidNavigation = await executeBrowserValidation({
        plan,
        decision: "approved",
        adapter: adapter!,
        worktree: process.cwd(),
        artifactDirectory: path.join(artifacts, "invalid-navigation"),
        approvedOrigins: [origin],
        dynamicLoopbackApproved: true,
        timeoutMs: 30_000,
        selectedProbes: [
          {
            id: "invalid-navigation",
            family: "interaction",
            profile: "desktop",
            expectedBehavior: "Probe navigation remains within the app",
            actions: [{ kind: "goto", path: "https://blocked.example/" }],
          },
        ],
        signal: controller.signal,
      });
      expect(invalidNavigation).toMatchObject({
        status: "unverified",
        reason: "unapproved_origin",
        provisionAttempts: 1,
        failureAttribution: "harness_configuration",
      });
      await expect(fetch(`${origin}/health`)).rejects.toThrow();

      const blocked = await executeBrowserValidation({
        plan,
        decision: "approved",
        adapter: adapter!,
        worktree: process.cwd(),
        artifactDirectory: path.join(artifacts, "blocked"),
        approvedOrigins: [origin],
        dynamicLoopbackApproved: true,
        timeoutMs: 30_000,
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

      let unauthorizedWebSocketReachedServer = false;
      const websocketServer = createHttpServer();
      websocketServer.on("upgrade", (_request, socket) => {
        unauthorizedWebSocketReachedServer = true;
        socket.destroy();
      });
      const websocketPort = await new Promise<number>((resolve, reject) => {
        websocketServer.once("error", reject);
        websocketServer.listen(0, "127.0.0.1", () => {
          const address = websocketServer.address();
          if (!address || typeof address === "string")
            reject(new Error("No WebSocket test port"));
          else resolve(address.port);
        });
      });
      try {
        const blockedWebSocket = await executeBrowserValidation({
          plan,
          decision: "approved",
          adapter: adapter!,
          worktree: process.cwd(),
          artifactDirectory: path.join(artifacts, "blocked-websocket"),
          approvedOrigins: [origin],
          dynamicLoopbackApproved: true,
          timeoutMs: 30_000,
          selectedProbes: [
            {
              id: "blocked-websocket",
              family: "runtime_dom_integrity",
              profile: "desktop",
              expectedBehavior: "No undeclared WebSocket dependency",
              actions: [
                {
                  kind: "goto",
                  path: `/external-websocket?port=${String(websocketPort)}`,
                },
              ],
            },
          ],
          signal: controller.signal,
        });
        expect(blockedWebSocket.status).toBe("failed");
        expect(blockedWebSocket.probes.at(-1)?.blockedOrigins).toContain(
          `ws://127.0.0.1:${String(websocketPort)}`,
        );
        expect(unauthorizedWebSocketReachedServer).toBe(false);
      } finally {
        await new Promise<void>((resolve) =>
          websocketServer.close(() => resolve()),
        );
      }

      const domProbe = (pathName: string) => ({
        id: `dom-security-${pathName}`,
        family: "dom_security" as const,
        profile: "desktop" as const,
        expectedBehavior: "User-authored HTML remains inert",
        actions: [
          { kind: "goto" as const, path: `/${pathName}` },
          { kind: "fill_dom_xss_canary" as const, label: "Message" },
          {
            kind: "click" as const,
            role: "button",
            name: "Render",
          },
        ],
      });
      const vulnerableDom = await executeBrowserValidation({
        plan,
        decision: "approved",
        adapter: adapter!,
        worktree: process.cwd(),
        artifactDirectory: path.join(artifacts, "dom-xss-vulnerable"),
        approvedOrigins: [origin],
        dynamicLoopbackApproved: true,
        timeoutMs: 30_000,
        selectedProbes: [domProbe("dom-xss-vulnerable")],
        signal: controller.signal,
      });
      expect(vulnerableDom.probes.at(-1)).toMatchObject({
        status: "failed",
        detail: "The inert DOM-XSS canary was interpreted as markup",
      });

      const safeDom = await executeBrowserValidation({
        plan,
        decision: "approved",
        adapter: adapter!,
        worktree: process.cwd(),
        artifactDirectory: path.join(artifacts, "dom-xss-safe"),
        approvedOrigins: [origin],
        dynamicLoopbackApproved: true,
        timeoutMs: 30_000,
        selectedProbes: [domProbe("dom-xss-safe")],
        signal: controller.signal,
      });
      expect(safeDom.probes.at(-1)).toMatchObject({ status: "verified" });
    });
  },
);
