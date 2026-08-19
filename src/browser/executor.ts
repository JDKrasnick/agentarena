import { randomUUID } from "node:crypto";
import type { BrowserPlan } from "./planner.js";
import {
  BrowserValidationResultSchema,
  type BrowserArtifact,
  type BrowserProbeRequest,
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
    request: BrowserProbeRequest;
    contextId: string;
    freshStorage: true;
    allowedOrigins: string[];
  }): Promise<Omit<BrowserProbeResult, "contextId" | "requiredCapabilityIds">>;
  runNativeSuite(): Promise<
    Omit<BrowserProbeResult, "contextId" | "requiredCapabilityIds">
  >;
  stop(): Promise<void>;
}

export interface BrowserAdapter {
  runner: "playwright" | "cypress" | "custom";
  launch(input: {
    plan: BrowserPlan & { profile: NonNullable<BrowserPlan["profile"]> };
    worktree: string;
    artifactDirectory: string;
    signal: AbortSignal;
  }): Promise<BrowserSession>;
}

export class BrowserInfrastructureError extends Error {
  constructor(
    message: string,
    readonly reason: BrowserUnavailableReason,
    readonly attribution:
      "harness_transport" | "harness_configuration" = "harness_transport",
  ) {
    super(message);
  }
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
  artifactDirectory: string;
  selectedProbes: BrowserProbeRequest[];
  approvedOrigins: string[];
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
  let lastAttribution: "harness_transport" | "harness_configuration" =
    "harness_transport";
  const artifacts: BrowserArtifact[] = [];
  for (const attempt of [1, 2] as const) {
    if (options.signal.aborted) return unverified("interrupted", attempt - 1);
    let session: BrowserSession | undefined;
    try {
      session = await options.adapter.launch({
        plan: { ...options.plan, profile: options.plan.profile },
        worktree: options.worktree,
        artifactDirectory: options.artifactDirectory,
        signal: options.signal,
      });
      artifacts.push(...session.artifacts);
      try {
        await session.waitUntilReady();
      } catch (error) {
        lastReason =
          error instanceof BrowserInfrastructureError
            ? error.reason
            : "health_failure";
        lastAttribution =
          error instanceof BrowserInfrastructureError
            ? error.attribution
            : "harness_transport";
        continue;
      }

      const probes: BrowserProbeResult[] = [];
      const nativeContextId = randomUUID();
      const nativeResult = await session.runNativeSuite();
      probes.push({
        ...nativeResult,
        family: "visual_regression",
        profile: "repository_native",
        contextId: nativeContextId,
        requiredCapabilityIds: ["browser_dom_validation"],
      });
      for (const request of options.selectedProbes) {
        const contextId = randomUUID();
        const result = await session.runProbe({
          request,
          contextId,
          freshStorage: true,
          allowedOrigins: options.approvedOrigins,
        });
        probes.push({
          ...result,
          family: request.family,
          profile: request.profile,
          contextId,
          requiredCapabilityIds: ["browser_dom_validation"],
        });
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
        failureAttribution:
          status === "failed"
            ? "contestant_application"
            : status === "unverified"
              ? "unattributed"
              : undefined,
      });
    } catch (error) {
      lastReason = options.signal.aborted
        ? "interrupted"
        : error instanceof BrowserInfrastructureError
          ? error.reason
          : "launch_failure";
      lastAttribution =
        error instanceof BrowserInfrastructureError
          ? error.attribution
          : "harness_transport";
      if (options.signal.aborted)
        return unverified(lastReason, attempt, artifacts);
    } finally {
      if (session) await Promise.resolve(session.stop()).catch(() => undefined);
    }
  }
  return BrowserValidationResultSchema.parse({
    ...unverified(lastReason, 2, artifacts),
    failureAttribution: lastAttribution,
  });
}
