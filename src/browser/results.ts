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
