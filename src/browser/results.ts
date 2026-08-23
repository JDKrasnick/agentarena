import type {
  BrowserProbeResult,
  BrowserValidationResult,
} from "../contracts/browser.js";

export {
  BrowserArtifactSchema,
  BrowserProbeResultSchema,
  BrowserProbeRequestSchema,
  BrowserUnavailableReasonSchema,
  BrowserValidationResultSchema,
} from "../contracts/browser.js";
export type {
  BrowserArtifact,
  BrowserProbeResult,
  BrowserProbeRequest,
  BrowserUnavailableReason,
  BrowserValidationResult,
} from "../contracts/browser.js";

export function findBrowserProbeResult(
  result: BrowserValidationResult,
  probeId: string,
): BrowserProbeResult | undefined {
  return result.probes.find((probe) => probe.probeId === probeId);
}

export function browserRepairEvidencePasses(
  result: BrowserValidationResult,
  probeId: string,
): boolean | undefined {
  const probe = findBrowserProbeResult(result, probeId);
  if (!probe || probe.status === "unverified") return undefined;
  return probe.status === "verified";
}

export function attributeBrowserResult(
  baseline: BrowserValidationResult | undefined,
  result: BrowserValidationResult,
): BrowserValidationResult {
  const baselinePassed = baseline?.status === "verified";
  const candidateLifecycleFailure =
    result.status === "unverified" &&
    (result.reason === "server_command_failure" ||
      result.reason === "health_failure");
  if (baselinePassed && candidateLifecycleFailure)
    return {
      ...result,
      status: "failed",
      failureAttribution: "contestant_application",
    };
  if (result.status === "failed")
    return {
      ...result,
      failureAttribution: baselinePassed
        ? "contestant_application"
        : "unattributed",
    };
  if (result.status === "unverified" && !baselinePassed)
    return {
      ...result,
      failureAttribution: baseline?.failureAttribution ?? "unattributed",
    };
  return result;
}
