import { randomUUID } from "node:crypto";
import type { BrowserPlan } from "./planner.js";
import {
  BrowserValidationResultSchema,
  type BrowserArtifact,
  type BrowserProbeResult,
  type BrowserUnavailableReason,
  type BrowserValidationResult,
} from "./results.js";

export interface BrowserSession {
  toolVersion: string;
  browserVersion: string;
  artifacts: BrowserArtifact[];
  waitUntilReady(): Promise<void>;
  runProbe(input: {
    family: BrowserPlan["probeFamilies"][number];
    profile: "desktop" | "mobile" | "reflow_320" | "repository";
    contextId: string;
    freshStorage: true;
    allowedOrigins: string[];
  }): Promise<Omit<BrowserProbeResult, "contextId" | "requiredCapabilityIds">>;
  stop(): Promise<void>;
}

export interface BrowserAdapter {
  runner: "playwright" | "cypress" | "custom";
  launch(input: {
    plan: BrowserPlan & { profile: NonNullable<BrowserPlan["profile"]> };
    worktree: string;
    signal: AbortSignal;
  }): Promise<BrowserSession>;
}

type BrowserLauncher = BrowserAdapter["launch"];

export class PlaywrightBrowserAdapter implements BrowserAdapter {
  readonly runner = "playwright" as const;
  constructor(private readonly launcher: BrowserLauncher) {}
  launch(input: Parameters<BrowserLauncher>[0]): ReturnType<BrowserLauncher> {
    return this.launcher(input);
  }
}

export class CypressBrowserAdapter implements BrowserAdapter {
  readonly runner = "cypress" as const;
  constructor(private readonly launcher: BrowserLauncher) {}
  launch(input: Parameters<BrowserLauncher>[0]): ReturnType<BrowserLauncher> {
    return this.launcher(input);
  }
}

export class CustomBrowserAdapter implements BrowserAdapter {
  readonly runner = "custom" as const;
  constructor(private readonly launcher: BrowserLauncher) {}
  launch(input: Parameters<BrowserLauncher>[0]): ReturnType<BrowserLauncher> {
    return this.launcher(input);
  }
}

function unverified(
  reason: BrowserUnavailableReason,
  provisionAttempts: number,
  artifacts: BrowserArtifact[] = [],
): BrowserValidationResult {
  return BrowserValidationResultSchema.parse({
    status: "unverified",
    provisionAttempts,
    reason,
    probes: [],
    artifacts,
  });
}

export async function executeBrowserValidation(options: {
  plan: BrowserPlan;
  decision: "approved" | "denied" | "unavailable" | "provisioning_failed";
  adapter?: BrowserAdapter;
  worktree: string;
  signal: AbortSignal;
}): Promise<BrowserValidationResult> {
  if (options.decision === "denied") return unverified("denied", 0);
  if (!options.plan.profile || options.decision !== "approved")
    return unverified("profile_unavailable", 0);
  if (
    !options.adapter ||
    options.adapter.runner !== options.plan.profile.runner
  )
    return unverified("tool_missing", 0);

  let lastReason: BrowserUnavailableReason = "launch_failure";
  const artifacts: BrowserArtifact[] = [];
  for (const attempt of [1, 2] as const) {
    if (options.signal.aborted) return unverified("interrupted", attempt - 1);
    let session: BrowserSession | undefined;
    try {
      session = await options.adapter.launch({
        plan: { ...options.plan, profile: options.plan.profile },
        worktree: options.worktree,
        signal: options.signal,
      });
      artifacts.push(...session.artifacts);
      try {
        await session.waitUntilReady();
      } catch {
        lastReason = "health_failure";
        continue;
      }

      const probes: BrowserProbeResult[] = [];
      const profiles = [
        "desktop",
        "mobile",
        "reflow_320",
        ...(options.plan.profile.projects.length
          ? (["repository"] as const)
          : []),
      ] as const;
      for (const family of options.plan.probeFamilies) {
        for (const profile of profiles) {
          const contextId = randomUUID();
          const result = await session.runProbe({
            family,
            profile,
            contextId,
            freshStorage: true,
            allowedOrigins: options.plan.profile.allowedOrigins,
          });
          probes.push({
            ...result,
            family,
            profile,
            contextId,
            requiredCapabilityIds: ["browser_dom_validation"],
          });
        }
      }
      const status = probes.some((probe) => probe.status === "failed")
        ? "failed"
        : probes.some((probe) => probe.status === "unverified")
          ? "unverified"
          : "verified";
      return BrowserValidationResultSchema.parse({
        status,
        provisionAttempts: attempt,
        toolVersion: session.toolVersion,
        browserVersion: session.browserVersion,
        probes,
        artifacts: [
          ...artifacts,
          ...probes.flatMap((probe) => probe.artifacts),
        ],
      });
    } catch {
      lastReason = options.signal.aborted ? "interrupted" : "launch_failure";
      if (options.signal.aborted)
        return unverified(lastReason, attempt, artifacts);
    } finally {
      if (session) await Promise.resolve(session.stop()).catch(() => undefined);
    }
  }
  return unverified(lastReason, 2, artifacts);
}
