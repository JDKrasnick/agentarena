import { describe, expect, it, vi } from "vitest";
import {
  executeBrowserValidation,
  type BrowserAdapter,
  type BrowserSession,
  type BrowserSessionActivity,
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
  enforcement: "advisory",
  probeFamilies: ["interaction", "responsive"],
};

function adapter(session: BrowserSession) {
  const launch = vi.fn<BrowserAdapter["launch"]>().mockResolvedValue(session);
  return { value: { runner: "playwright" as const, launch }, launch };
}

describe("browser validation executor", () => {
  it("announces a ready session and withdraws it after teardown", async () => {
    const events: string[] = [];
    const started = vi.fn((activity: BrowserSessionActivity) => {
      events.push(`started:${activity.url}`);
    });
    const finished = vi.fn(
      (activity: Pick<BrowserSessionActivity, "sessionId">) => {
        events.push(`finished:${activity.sessionId}`);
      },
    );
    const session: BrowserSession = {
      toolVersion: "1",
      browserVersion: "1",
      artifacts: [],
      waitUntilReady: vi.fn().mockImplementation(() => {
        events.push("ready");
        return Promise.resolve();
      }),
      runNativeSuite: vi.fn().mockResolvedValue({
        family: "visual_regression",
        profile: "repository_native",
        status: "verified",
        blockedOrigins: [],
        artifacts: [],
      }),
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
      stop: vi.fn().mockImplementation(() => {
        events.push("stopped");
        return Promise.resolve();
      }),
    };

    const result = await executeBrowserValidation({
      plan,
      decision: "approved",
      adapter: adapter(session).value,
      worktree: "/worktree/a",
      artifactDirectory: "/artifacts/a",
      selectedProbes: [],
      approvedOrigins: ["http://127.0.0.1:4173"],
      timeoutMs: 10_000,
      onSessionStarted: started,
      onSessionFinished: finished,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("verified");
    expect(started).toHaveBeenCalledOnce();
    expect(started.mock.calls[0]?.[0]).toMatchObject({
      url: "http://127.0.0.1:4173",
      runner: "playwright",
      attempt: 1,
    });
    expect(finished).toHaveBeenCalledWith({
      sessionId: started.mock.calls[0]?.[0].sessionId,
    });
    expect(events[0]).toBe("ready");
    expect(events.at(-2)).toBe("stopped");
    expect(events.at(-1)).toMatch(/^finished:/u);
  });

  it("runs self-managed native suites before starting the probe service", async () => {
    const events: string[] = [];
    const runtimeOrigin = "http://127.0.0.1:5184";
    const sessionNativeSuite = vi.fn();
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
      runNativeSuite: sessionNativeSuite,
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const selfManagedPlan: BrowserPlan = {
      ...plan,
      profile: {
        ...plan.profile!,
        nativeSuiteMode: "self_managed",
      },
    };
    const result = await executeBrowserValidation({
      plan: selfManagedPlan,
      decision: "approved",
      adapter: {
        runner: "playwright",
        resolveRuntime: vi
          .fn()
          .mockImplementation(
            (
              input: Parameters<
                NonNullable<BrowserAdapter["resolveRuntime"]>
              >[0],
            ) => {
              events.push("resolve");
              return Promise.resolve({
                plan: {
                  ...input.plan,
                  profile: {
                    ...input.plan.profile,
                    baseUrl: runtimeOrigin,
                    healthUrl: `${runtimeOrigin}/health`,
                  },
                },
                approvedOrigins: [runtimeOrigin],
              });
            },
          ),
        runNativeSuiteStandalone: vi
          .fn()
          .mockImplementation(
            (
              input: Parameters<
                NonNullable<BrowserAdapter["runNativeSuiteStandalone"]>
              >[0],
            ) => {
              events.push("native");
              expect(input.plan.profile.baseUrl).toBe(runtimeOrigin);
              return Promise.resolve({
                family: "visual_regression" as const,
                profile: "repository_native" as const,
                status: "verified" as const,
                blockedOrigins: [],
                artifacts: [],
              });
            },
          ),
        launch: vi
          .fn<BrowserAdapter["launch"]>()
          .mockImplementation((input) => {
            events.push("launch");
            expect(input.plan.profile.baseUrl).toBe(runtimeOrigin);
            return Promise.resolve(session);
          }),
      },
      worktree: "/worktree/a",
      artifactDirectory: "/artifacts/a",
      selectedProbes: [],
      approvedOrigins: ["http://127.0.0.1:4173"],
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("verified");
    expect(events).toEqual(["resolve", "native", "launch"]);
    expect(sessionNativeSuite).not.toHaveBeenCalled();
  });

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
    expect(launch.mock.calls.map(([input]) => input.artifactDirectory)).toEqual(
      ["/artifacts/a/attempt-1", "/artifacts/a/attempt-2"],
    );
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(stops[1]).toHaveBeenCalledOnce();
  });

  it("preserves completed functional failures when a later probe needs infrastructure retry", async () => {
    const calls: string[] = [];
    let launchAttempt = 0;
    const launch = vi.fn<BrowserAdapter["launch"]>().mockImplementation(() => {
      const currentAttempt = ++launchAttempt;
      return Promise.resolve({
        toolVersion: "1",
        browserVersion: "1",
        artifacts: [],
        waitUntilReady: vi.fn().mockResolvedValue(undefined),
        runNativeSuite: vi.fn().mockResolvedValue({
          family: "visual_regression",
          profile: "repository_native",
          status: "verified",
          blockedOrigins: [],
          artifacts: [],
        }),
        runProbe: vi
          .fn<BrowserSession["runProbe"]>()
          .mockImplementation(({ request }) => {
            calls.push(request.id);
            if (request.id === "arena-runtime-smoke")
              return Promise.resolve({
                family: request.family,
                profile: request.profile,
                status: "failed",
                reason: "application_failure",
                blockedOrigins: [],
                artifacts: [],
              });
            if (request.id === "arena-semantics-smoke" && currentAttempt === 1)
              return Promise.resolve({
                family: request.family,
                profile: request.profile,
                status: "unverified",
                reason: "launch_failure",
                blockedOrigins: [],
                artifacts: [],
              });
            return Promise.resolve({
              family: request.family,
              profile: request.profile,
              status: "verified",
              blockedOrigins: [],
              artifacts: [],
            });
          }),
        stop: vi.fn().mockResolvedValue(undefined),
      });
    });

    const result = await executeBrowserValidation({
      plan,
      decision: "approved",
      adapter: { runner: "playwright", launch },
      worktree: "/worktree/a",
      artifactDirectory: "/artifacts/a",
      selectedProbes: [],
      approvedOrigins: ["http://127.0.0.1:4173"],
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("failed");
    expect(result.provisionAttempts).toBe(2);
    expect(calls.filter((id) => id === "arena-runtime-smoke")).toHaveLength(1);
    expect(calls.filter((id) => id === "arena-semantics-smoke")).toHaveLength(
      2,
    );
    expect(
      result.probes.find((probe) => probe.probeId === "arena-runtime-smoke"),
    ).toMatchObject({ status: "failed", reason: "application_failure" });
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

  it("aborts a timed-out launch and tears down a session that resolves late", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    let resolveLaunch!: (session: BrowserSession) => void;
    const launch = vi.fn<BrowserAdapter["launch"]>().mockImplementation(
      () =>
        new Promise<BrowserSession>((resolve) => {
          resolveLaunch = resolve;
        }),
    );
    const browser: BrowserAdapter = { runner: "playwright", launch };

    const result = await executeBrowserValidation({
      plan,
      decision: "approved",
      adapter: browser,
      worktree: "/worktree/a",
      artifactDirectory: "/artifacts/a",
      selectedProbes: [],
      approvedOrigins: ["http://127.0.0.1:4173"],
      timeoutMs: 25,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      status: "unverified",
      reason: "timed_out",
      provisionAttempts: 1,
    });
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0]?.[0].signal.aborted).toBe(true);

    resolveLaunch({
      toolVersion: "1",
      browserVersion: "1",
      artifacts: [],
      waitUntilReady: vi.fn(),
      runProbe: vi.fn(),
      runNativeSuite: vi.fn(),
      stop,
    });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });

  it("retries an unverified native suite with distinct artifacts", async () => {
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
        waitUntilReady: vi.fn().mockResolvedValue(undefined),
        runNativeSuite: vi.fn().mockResolvedValue(
          current === 0
            ? {
                family: "visual_regression",
                profile: "repository_native",
                status: "unverified",
                reason: "launch_failure",
                blockedOrigins: [],
                artifacts: [
                  {
                    kind: "runner_result",
                    path: "/artifacts/a/attempt-1/native-suite.stderr.log",
                    failureOnly: false,
                  },
                ],
              }
            : {
                family: "visual_regression",
                profile: "repository_native",
                status: "verified",
                blockedOrigins: [],
                artifacts: [],
              },
        ),
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
        stop: stops[current]!,
      });
    });

    const result = await executeBrowserValidation({
      plan,
      decision: "approved",
      adapter: { runner: "playwright", launch },
      worktree: "/worktree/a",
      artifactDirectory: "/artifacts/a",
      selectedProbes: [],
      approvedOrigins: ["http://127.0.0.1:4173"],
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("verified");
    expect(result.provisionAttempts).toBe(2);
    expect(result.artifacts.map((artifact) => artifact.path)).toContain(
      "/artifacts/a/attempt-1/native-suite.stderr.log",
    );
    expect(launch.mock.calls.map(([input]) => input.artifactDirectory)).toEqual(
      ["/artifacts/a/attempt-1", "/artifacts/a/attempt-2"],
    );
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(stops[1]).toHaveBeenCalledOnce();
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

  it("marks only the mandatory smoke probes as harness owned", async () => {
    const harnessOwnedById = new Map<string, boolean>();
    const session: BrowserSession = {
      toolVersion: "1",
      browserVersion: "1",
      artifacts: [],
      waitUntilReady: vi.fn().mockResolvedValue(undefined),
      runProbe: vi
        .fn<BrowserSession["runProbe"]>()
        .mockImplementation(({ request, harnessOwned }) => {
          harnessOwnedById.set(request.id, harnessOwned);
          return Promise.resolve({
            family: request.family,
            profile: request.profile,
            status: "verified",
            blockedOrigins: [],
            artifacts: [],
          });
        }),
      runNativeSuite: vi.fn().mockResolvedValue({
        family: "visual_regression" as const,
        profile: "repository_native" as const,
        status: "verified" as const,
        blockedOrigins: [],
        artifacts: [],
      }),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    await executeBrowserValidation({
      plan,
      decision: "approved",
      adapter: adapter(session).value,
      worktree: "/worktree/a",
      artifactDirectory: "/artifacts/a",
      selectedProbes: [
        {
          id: "contestant-choice",
          family: "interaction",
          profile: "desktop",
          expectedBehavior: "No undeclared network dependency",
          actions: [{ kind: "goto", path: "/" }],
        },
      ],
      approvedOrigins: ["http://127.0.0.1:4173"],
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

    expect(Object.fromEntries(harnessOwnedById)).toEqual({
      "arena-runtime-smoke": true,
      "arena-semantics-smoke": true,
      "arena-reflow-smoke": true,
      "contestant-choice": false,
    });
  });

  it("reports a cache hit only for reuse across invocations", async () => {
    let readyCalls = 0;
    const session: BrowserSession = {
      toolVersion: "1",
      browserVersion: "1",
      artifacts: [],
      // Fail readiness once so attempt 2 carries attempt 1's native result.
      waitUntilReady: vi.fn().mockImplementation(() => {
        readyCalls += 1;
        return readyCalls === 1
          ? Promise.reject(new Error("health check failed"))
          : Promise.resolve(undefined);
      }),
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
      runNativeSuite: vi.fn().mockResolvedValue({
        family: "visual_regression" as const,
        profile: "repository_native" as const,
        status: "verified" as const,
        blockedOrigins: [],
        artifacts: [],
      }),
      stop: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeBrowserValidation({
      plan,
      decision: "approved",
      adapter: adapter(session).value,
      worktree: "/worktree/a",
      artifactDirectory: "/artifacts/a",
      selectedProbes: [],
      approvedOrigins: ["http://127.0.0.1:4173"],
      timeoutMs: 10_000,
      nativeSuiteCache: new Map(),
      nativeSuiteCacheKey: "frozen-tree-and-command",
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("verified");
    expect(result.provisionAttempts).toBe(2);
    expect(result.nativeSuiteCacheHit).toBe(false);
  });
});
