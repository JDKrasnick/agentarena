import { describe, expect, it, vi } from "vitest";
import {
  executeBrowserValidation,
  type BrowserAdapter,
  type BrowserSession,
} from "../../src/browser/executor.js";
import type { BrowserPlan } from "../../src/browser/planner.js";

const plan: BrowserPlan = {
  version: 1,
  requirement: "required",
  evidence: [
    { source: "task", location: "task", detail: "responsive behavior" },
  ],
  profile: {
    source: "arena_configuration",
    runner: "playwright",
    startupCommand: "npm run dev",
    healthUrl: "http://127.0.0.1:4173/health",
    baseUrl: "http://127.0.0.1:4173",
    testCommand: "npm run test:e2e",
    projects: ["chromium"],
    allowedOrigins: ["http://127.0.0.1:4173"],
  },
  capabilityId: "browser_dom_validation",
  role: "harness_only",
  enforcement: "brokered",
  probeFamilies: ["interaction", "responsive"],
};

function adapter(session: BrowserSession) {
  const launch = vi.fn<BrowserAdapter["launch"]>().mockResolvedValue(session);
  return { value: { runner: "playwright" as const, launch }, launch };
}

describe("browser validation executor", () => {
  it("uses fresh contexts and never retries functional failures", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const runProbe = vi
      .fn<BrowserSession["runProbe"]>()
      .mockImplementation(({ request }) =>
        Promise.resolve({
          family: request.family,
          profile: request.profile,
          status: request.family === "interaction" ? "failed" : "verified",
          blockedOrigins: [],
          artifacts: [],
        }),
      );
    const runNativeSuite = vi.fn().mockResolvedValue({
      family: "visual_regression",
      profile: "repository_native",
      status: "verified",
      blockedOrigins: [],
      artifacts: [],
    });
    const browser = adapter({
      toolVersion: "1.55.0",
      browserVersion: "140",
      artifacts: [],
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
      runProbe,
      runNativeSuite,
      stop,
    });

    const result = await executeBrowserValidation({
      plan,
      decision: "approved",
      adapter: browser.value,
      worktree: "/worktree/a",
      artifactDirectory: "/artifacts/a",
      selectedProbes: [
        {
          id: "interaction",
          family: "interaction",
          profile: "desktop",
          expectedBehavior: "The control responds",
          actions: [{ kind: "goto", path: "/" }],
        },
        {
          id: "responsive",
          family: "responsive",
          profile: "reflow_320",
          expectedBehavior: "The page reflows",
          actions: [{ kind: "goto", path: "/" }],
        },
      ],
      approvedOrigins: ["http://127.0.0.1:4173"],
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("failed");
    expect(result.provisionAttempts).toBe(1);
    expect(browser.launch).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(runNativeSuite).toHaveBeenCalledOnce();
    expect(runProbe).toHaveBeenCalledTimes(2);
    expect(new Set(result.probes.map((probe) => probe.contextId)).size).toBe(3);
    expect(
      result.probes.every((probe) => probe.requiredCapabilityIds.length),
    ).toBe(true);
  });

  it("retries health infrastructure once and tears down every process", async () => {
    const stops = [
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue(undefined),
    ];
    let attempt = 0;
    const launch = vi.fn<BrowserAdapter["launch"]>().mockImplementation(() => {
      const current = attempt++;
      return Promise.resolve({
        toolVersion: "1",
        browserVersion: "1",
        artifacts: [],
        waitUntilReady: vi.fn().mockRejectedValue(new Error("timeout")),
        runProbe: vi.fn(),
        runNativeSuite: vi.fn(),
        stop: stops[current]!,
      });
    });
    const browser: BrowserAdapter = {
      runner: "playwright",
      launch,
    };

    const result = await executeBrowserValidation({
      plan,
      decision: "approved",
      adapter: browser,
      worktree: "/worktree/a",
      artifactDirectory: "/artifacts/a",
      selectedProbes: [],
      approvedOrigins: ["http://127.0.0.1:4173"],
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "unverified",
      reason: "health_failure",
      provisionAttempts: 2,
    });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(stops[1]).toHaveBeenCalledOnce();
  });

  it("returns denied without launching tooling", async () => {
    const browser = adapter({} as BrowserSession);
    const result = await executeBrowserValidation({
      plan,
      decision: "denied",
      adapter: browser.value,
      worktree: "/worktree/a",
      artifactDirectory: "/artifacts/a",
      selectedProbes: [],
      approvedOrigins: ["http://127.0.0.1:4173"],
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ status: "unverified", reason: "denied" });
    expect(browser.launch).not.toHaveBeenCalled();
  });
});
