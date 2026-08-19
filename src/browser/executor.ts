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
import { mandatoryBrowserProbes } from "../contracts/browser.js";

export type BrowserNativeSuiteResult = Omit<
  BrowserProbeResult,
  "contextId" | "requiredCapabilityIds"
>;

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
  runNativeSuite(): Promise<BrowserNativeSuiteResult>;
  stop(): Promise<void>;
}

export interface BrowserAdapter {
  runner: "playwright" | "cypress" | "custom";
  launch(input: {
    plan: BrowserPlan & { profile: NonNullable<BrowserPlan["profile"]> };
    worktree: string;
    artifactDirectory: string;
    signal: AbortSignal;
    deadlineAt: number;
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

function runtimeOriginsApproved(options: {
  plan: BrowserPlan & { profile: NonNullable<BrowserPlan["profile"]> };
  approvedOrigins: string[];
  dynamicLoopbackApproved: boolean;
}): boolean {
  const baseOrigin = new URL(options.plan.profile.baseUrl).origin;
  return [options.plan.profile.baseUrl, options.plan.profile.healthUrl].every(
    (value) => {
      const origin = new URL(value).origin;
      return (
        options.approvedOrigins.includes(origin) ||
        (options.dynamicLoopbackApproved &&
          options.plan.profile.portMode === "dynamic" &&
          origin === baseOrigin)
      );
    },
  );
}

async function beforeDeadline<T>(
  operation: () => Promise<T>,
  deadlineAt: number,
  signal: AbortSignal,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0)
    throw new BrowserInfrastructureError(
      "Browser validation exceeded its stage budget",
      "timed_out",
      "harness_configuration",
    );
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new BrowserInfrastructureError(
                "Browser validation exceeded its stage budget",
                "timed_out",
                "harness_configuration",
              ),
            ),
          remainingMs,
        );
      }),
      new Promise<never>((_resolve, reject) => {
        abort = () =>
          reject(
            new BrowserInfrastructureError(
              "Browser validation was interrupted",
              "interrupted",
            ),
          );
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

export async function executeBrowserValidation(options: {
  plan: BrowserPlan;
  decision: "approved" | "denied" | "unavailable" | "provisioning_failed";
  adapter?: BrowserAdapter;
  worktree: string;
  artifactDirectory: string;
  selectedProbes: BrowserProbeRequest[];
  approvedOrigins: string[];
  dynamicLoopbackApproved?: boolean;
  timeoutMs: number;
  nativeSuiteCache?: Map<string, BrowserNativeSuiteResult>;
  nativeSuiteCacheKey?: string;
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
  const adapter = options.adapter;
  const profile = options.plan.profile;
  if (
    !runtimeOriginsApproved({
      plan: { ...options.plan, profile: options.plan.profile },
      approvedOrigins: options.approvedOrigins,
      dynamicLoopbackApproved: options.dynamicLoopbackApproved ?? false,
    })
  )
    return unverified("unapproved_origin", 0);

  const deadlineAt = Date.now() + options.timeoutMs;
  let lastReason: BrowserUnavailableReason = "launch_failure";
  let lastAttribution: "harness_transport" | "harness_configuration" =
    "harness_transport";
  const artifacts: BrowserArtifact[] = [];
  for (const attempt of [1, 2] as const) {
    if (options.signal.aborted) return unverified("interrupted", attempt - 1);
    let session: BrowserSession | undefined;
    try {
      session = await beforeDeadline(
        () =>
          adapter.launch({
            plan: { ...options.plan, profile },
            worktree: options.worktree,
            artifactDirectory: options.artifactDirectory,
            signal: options.signal,
            deadlineAt,
          }),
        deadlineAt,
        options.signal,
      );
      const activeSession = session;
      artifacts.push(...session.artifacts);
      try {
        await beforeDeadline(
          () => activeSession.waitUntilReady(),
          deadlineAt,
          options.signal,
        );
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
      const cachedNativeResult = options.nativeSuiteCacheKey
        ? options.nativeSuiteCache?.get(options.nativeSuiteCacheKey)
        : undefined;
      const nativeResult =
        cachedNativeResult ??
        (await beforeDeadline(
          () => activeSession.runNativeSuite(),
          deadlineAt,
          options.signal,
        ));
      if (
        !cachedNativeResult &&
        options.nativeSuiteCacheKey &&
        nativeResult.status !== "unverified"
      )
        options.nativeSuiteCache?.set(
          options.nativeSuiteCacheKey,
          nativeResult,
        );
      probes.push({
        ...nativeResult,
        probeId: "arena-repository-native",
        family: "visual_regression",
        profile: "repository_native",
        contextId: nativeContextId,
        requiredCapabilityIds: ["browser_dom_validation"],
      });
      const seenProbeIds = new Set<string>();
      const requests = [
        ...mandatoryBrowserProbes(),
        ...options.selectedProbes,
      ].filter((request) => {
        if (seenProbeIds.has(request.id)) return false;
        seenProbeIds.add(request.id);
        return true;
      });
      for (const request of requests) {
        const contextId = randomUUID();
        const result = await beforeDeadline(
          () =>
            activeSession.runProbe({
              request,
              contextId,
              freshStorage: true,
              allowedOrigins: options.approvedOrigins,
            }),
          deadlineAt,
          options.signal,
        );
        probes.push({
          ...result,
          probeId: request.id,
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
        nativeSuiteCacheHit: Boolean(cachedNativeResult),
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
