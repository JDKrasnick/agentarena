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
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("failed");
    expect(result.provisionAttempts).toBe(1);
    expect(browser.launch).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(runNativeSuite).toHaveBeenCalledOnce();
    expect(runProbe).toHaveBeenCalledTimes(5);
    expect(new Set(result.probes.map((probe) => probe.contextId)).size).toBe(6);
    expect(
      runProbe.mock.calls.slice(0, 3).map(([input]) => input.request.id),
    ).toEqual([
      "arena-runtime-smoke",
      "arena-semantics-smoke",
      "arena-reflow-smoke",
    ]);
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
      timeoutMs: 10_000,
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
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ status: "unverified", reason: "denied" });
    expect(browser.launch).not.toHaveBeenCalled();
  });

  it("does not launch when the runtime origin was not approved", async () => {
    const browser = adapter({} as BrowserSession);
    const result = await executeBrowserValidation({
      plan,
      decision: "approved",
      adapter: browser.value,
      worktree: "/worktree/a",
      artifactDirectory: "/artifacts/a",
      selectedProbes: [],
      approvedOrigins: [],
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "unverified",
      reason: "unapproved_origin",
      provisionAttempts: 0,
    });
    expect(browser.launch).not.toHaveBeenCalled();
  });

  it("bounds the complete browser lifecycle by the stage timeout", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const browser = adapter({
      toolVersion: "1",
      browserVersion: "1",
      artifacts: [],
      waitUntilReady: vi.fn(() => new Promise<void>(() => undefined)),
      runProbe: vi.fn(),
      runNativeSuite: vi.fn(),
      stop,
    });
    const startedAt = Date.now();
    const result = await executeBrowserValidation({
      plan,
      decision: "approved",
      adapter: browser.value,
      worktree: "/worktree/a",
      artifactDirectory: "/artifacts/a",
      selectedProbes: [],
      approvedOrigins: ["http://127.0.0.1:4173"],
      timeoutMs: 25,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ status: "unverified", reason: "timed_out" });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(browser.launch).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("reuses a frozen native-suite result by content key", async () => {
    const runNativeSuite = vi.fn().mockResolvedValue({
      family: "visual_regression" as const,
      profile: "repository_native" as const,
      status: "verified" as const,
      blockedOrigins: [],
      artifacts: [],
    });
    const session: BrowserSession = {
      toolVersion: "1",
      browserVersion: "1",
      artifacts: [],
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
      runProbe: vi
        .fn<BrowserSession["runProbe"]>()
        .mockImplementation(({ request }) =>
          Promise.resolve({
            family: request.family,
            profile: request.profile,
            status: "verified",
            blockedOrigins: [],
            artifacts: [],
          }),
        ),
      runNativeSuite,
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const browser = adapter(session);
    const nativeSuiteCache = new Map();
    const options = {
      plan,
      decision: "approved" as const,
      adapter: browser.value,
      worktree: "/worktree/a",
      artifactDirectory: "/artifacts/a",
      selectedProbes: [],
      approvedOrigins: ["http://127.0.0.1:4173"],
      timeoutMs: 10_000,
      nativeSuiteCache,
      nativeSuiteCacheKey: "frozen-tree-and-command",
      signal: new AbortController().signal,
    };

    const first = await executeBrowserValidation(options);
    const second = await executeBrowserValidation(options);

    expect(runNativeSuite).toHaveBeenCalledOnce();
    expect(nativeSuiteCache.size).toBe(1);
    expect(first.nativeSuiteCacheHit).toBe(false);
    expect(second.nativeSuiteCacheHit).toBe(true);
    expect(first.probes.map((probe) => probe.probeId)).toEqual([
      "arena-repository-native",
      "arena-runtime-smoke",
      "arena-semantics-smoke",
      "arena-reflow-smoke",
    ]);
  });
});
