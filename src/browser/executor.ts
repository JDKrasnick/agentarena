import { randomUUID } from "node:crypto";
import path from "node:path";
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
    /**
     * True for the mandatory smoke probes the harness injects. These assert
     * only uncaught runtime errors and the family invariant; console noise and
     * blocked third-party origins stay diagnostic, because the repository never
     * opted into that policy. Contestant-selected probes declare their own
     * expected behavior and keep the stricter reading.
     */
    harnessOwned: boolean;
  }): Promise<Omit<BrowserProbeResult, "contextId" | "requiredCapabilityIds">>;
  runNativeSuite(): Promise<BrowserNativeSuiteResult>;
  stop(): Promise<void>;
}

export interface BrowserAdapter {
  runner: "playwright" | "cypress" | "custom";
  resolveRuntime?(input: {
    plan: BrowserPlan & { profile: NonNullable<BrowserPlan["profile"]> };
    approvedOrigins: string[];
    dynamicLoopbackApproved: boolean;
    signal: AbortSignal;
    deadlineAt: number;
  }): Promise<{
    plan: BrowserPlan & { profile: NonNullable<BrowserPlan["profile"]> };
    approvedOrigins: string[];
  }>;
  runNativeSuiteStandalone?(input: {
    plan: BrowserPlan & { profile: NonNullable<BrowserPlan["profile"]> };
    worktree: string;
    artifactDirectory: string;
    signal: AbortSignal;
    deadlineAt: number;
  }): Promise<BrowserNativeSuiteResult>;
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
  onTimeout?: () => void,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    onTimeout?.();
    throw new BrowserInfrastructureError(
      "Browser validation exceeded its stage budget",
      "timed_out",
      "harness_configuration",
    );
  }
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new BrowserInfrastructureError(
              "Browser validation exceeded its stage budget",
              "timed_out",
              "harness_configuration",
            ),
          );
          onTimeout?.();
        }, remainingMs);
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
  let completedNativeResult: BrowserNativeSuiteResult | undefined;
  let completedNativeProbe: BrowserProbeResult | undefined;
  const completedProbes = new Map<string, BrowserProbeResult>();
  const seenProbeIds = new Set<string>();
  const mandatoryProbeIds = new Set(
    mandatoryBrowserProbes().map((request) => request.id),
  );
  const requests = [
    ...mandatoryBrowserProbes(),
    ...options.selectedProbes,
  ].filter((request) => {
    if (seenProbeIds.has(request.id)) return false;
    seenProbeIds.add(request.id);
    return true;
  });
  const accumulatedInfrastructureResult = (
    reason: BrowserUnavailableReason,
    provisionAttempts: number,
    failureAttribution: "harness_transport" | "harness_configuration",
  ): BrowserValidationResult => {
    const probes = [
      completedNativeProbe,
      ...requests.map((request) => completedProbes.get(request.id)),
    ].filter((probe): probe is BrowserProbeResult => probe !== undefined);
    const hasFunctionalFailure = probes.some(
      (probe) => probe.status === "failed",
    );
    return BrowserValidationResultSchema.parse({
      status: hasFunctionalFailure ? "failed" : "unverified",
      provisionAttempts,
      reason: hasFunctionalFailure ? "application_failure" : reason,
      probes,
      artifacts,
      failureAttribution: hasFunctionalFailure
        ? "contestant_application"
        : failureAttribution,
    });
  };
  for (const attempt of [1, 2] as const) {
    if (options.signal.aborted) return unverified("interrupted", attempt - 1);
    const attemptController = new AbortController();
    const attemptSignal = AbortSignal.any([
      options.signal,
      attemptController.signal,
    ]);
    const attemptArtifactDirectory = path.join(
      options.artifactDirectory,
      `attempt-${String(attempt)}`,
    );
    let session: BrowserSession | undefined;
    let launchPromise: Promise<BrowserSession> | undefined;
    try {
      const runtime = adapter.resolveRuntime
        ? await beforeDeadline(
            () =>
              adapter.resolveRuntime!({
                plan: { ...options.plan, profile },
                approvedOrigins: options.approvedOrigins,
                dynamicLoopbackApproved:
                  options.dynamicLoopbackApproved ?? false,
                signal: attemptSignal,
                deadlineAt,
              }),
            deadlineAt,
            attemptSignal,
            () => attemptController.abort(),
          )
        : {
            plan: { ...options.plan, profile },
            approvedOrigins: options.approvedOrigins,
          };
      // Distinguish cross-lane reuse from an attempt-1 result carried into
      // attempt 2 of this same invocation; only the former is a cache hit.
      const sharedNativeResult = options.nativeSuiteCacheKey
        ? options.nativeSuiteCache?.get(options.nativeSuiteCacheKey)
        : undefined;
      const cachedNativeResult = completedNativeResult ?? sharedNativeResult;
      const nativeSuiteCacheHit = Boolean(
        !completedNativeResult && sharedNativeResult,
      );
      let nativeResult = cachedNativeResult;
      if (profile.nativeSuiteMode === "self_managed" && !nativeResult) {
        if (!adapter.runNativeSuiteStandalone)
          throw new BrowserInfrastructureError(
            "The browser adapter cannot run a self-managed native suite",
            "tool_missing",
            "harness_configuration",
          );
        nativeResult = await beforeDeadline(
          () =>
            adapter.runNativeSuiteStandalone!({
              plan: runtime.plan,
              worktree: options.worktree,
              artifactDirectory: path.join(
                attemptArtifactDirectory,
                "native-suite-standalone",
              ),
              signal: attemptSignal,
              deadlineAt,
            }),
          deadlineAt,
          attemptSignal,
          () => attemptController.abort(),
        );
        artifacts.push(...nativeResult.artifacts);
        if (nativeResult.status === "unverified")
          throw new BrowserInfrastructureError(
            nativeResult.detail ??
              "Repository-native browser suite was unverified",
            nativeResult.reason ?? "launch_failure",
          );
        if (options.nativeSuiteCacheKey)
          options.nativeSuiteCache?.set(
            options.nativeSuiteCacheKey,
            nativeResult,
          );
        completedNativeResult = nativeResult;
      }
      launchPromise = adapter.launch({
        plan: runtime.plan,
        worktree: options.worktree,
        artifactDirectory: attemptArtifactDirectory,
        signal: attemptSignal,
        deadlineAt,
      });
      session = await beforeDeadline(
        () => launchPromise!,
        deadlineAt,
        attemptSignal,
        () => attemptController.abort(),
      );
      const activeSession = session;
      artifacts.push(...session.artifacts);
      try {
        await beforeDeadline(
          () => activeSession.waitUntilReady(),
          deadlineAt,
          attemptSignal,
          () => attemptController.abort(),
        );
      } catch (error) {
        throw error instanceof BrowserInfrastructureError
          ? error
          : new BrowserInfrastructureError(
              error instanceof Error ? error.message : String(error),
              "health_failure",
            );
      }

      if (!nativeResult)
        nativeResult = await beforeDeadline(
          () => activeSession.runNativeSuite(),
          deadlineAt,
          attemptSignal,
          () => attemptController.abort(),
        );
      if (!cachedNativeResult && profile.nativeSuiteMode !== "self_managed")
        artifacts.push(...nativeResult.artifacts);
      if (nativeResult.status === "unverified") {
        throw new BrowserInfrastructureError(
          nativeResult.detail ??
            "Repository-native browser suite was unverified",
          nativeResult.reason ?? "launch_failure",
        );
      }
      if (
        !cachedNativeResult &&
        profile.nativeSuiteMode !== "self_managed" &&
        options.nativeSuiteCacheKey
      )
        options.nativeSuiteCache?.set(
          options.nativeSuiteCacheKey,
          nativeResult,
        );
      completedNativeResult = nativeResult;
      completedNativeProbe ??= {
        ...nativeResult,
        probeId: "arena-repository-native",
        family: "visual_regression",
        profile: "repository_native",
        contextId: randomUUID(),
        requiredCapabilityIds: ["browser_dom_validation"],
      };
      for (const request of requests) {
        if (completedProbes.has(request.id)) continue;
        const contextId = randomUUID();
        const result = await beforeDeadline(
          () =>
            activeSession.runProbe({
              request,
              contextId,
              freshStorage: true,
              allowedOrigins: runtime.approvedOrigins,
              harnessOwned: mandatoryProbeIds.has(request.id),
            }),
          deadlineAt,
          attemptSignal,
          () => attemptController.abort(),
        );
        artifacts.push(...result.artifacts);
        if (result.status === "unverified") {
          throw new BrowserInfrastructureError(
            result.detail ?? `Browser probe ${request.id} was unverified`,
            result.reason ?? "launch_failure",
          );
        }
        completedProbes.set(request.id, {
          ...result,
          probeId: request.id,
          family: request.family,
          profile: request.profile,
          contextId,
          requiredCapabilityIds: ["browser_dom_validation"],
        });
      }
      const probes = [
        completedNativeProbe,
        ...requests.map((request) => completedProbes.get(request.id)),
      ].filter((probe): probe is BrowserProbeResult => probe !== undefined);
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
        nativeSuiteCacheHit,
        probes,
        artifacts,
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
      if (!session && launchPromise) {
        void launchPromise
          .then((lateSession) => lateSession.stop())
          .catch(() => undefined);
      }
      if (options.signal.aborted || lastReason === "interrupted")
        return BrowserValidationResultSchema.parse({
          ...unverified(lastReason, attempt, artifacts),
          failureAttribution: lastAttribution,
        });
      if (lastReason === "timed_out" || lastReason === "unapproved_origin")
        return accumulatedInfrastructureResult(
          lastReason,
          attempt,
          lastAttribution,
        );
    } finally {
      attemptController.abort();
      if (session) await Promise.resolve(session.stop()).catch(() => undefined);
    }
  }
  return accumulatedInfrastructureResult(lastReason, 2, lastAttribution);
}
