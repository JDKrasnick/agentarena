import {
  PermissionPolicySchema,
  type CapabilityDecision,
  type FightConfig,
  type PermissionPolicy,
} from "../core/types.js";
import type { ReconnaissanceSnapshot } from "../task/task-contract.js";
import {
  browserExternalOrigins,
  browserCapabilityScopes,
  planBrowserValidation,
} from "../browser/planner.js";

const HARD_DENIES = new Set([
  "production_credentials",
  "production_deploy",
  "ssh_agent",
  "unrelated_home_files",
  "destructive_cloud_write",
]);

export interface CapabilityRequest {
  id: string;
  reason: string;
  risk: "low" | "medium" | "high" | "critical";
  requirement: "required" | "optional";
  role: "agent" | "harness_only" | "both";
  enforcement: "enforced" | "brokered" | "advisory";
  scopes: string[];
  available?: boolean;
}

export function discoverCapabilities(
  config: FightConfig,
  reconnaissance?: ReconnaissanceSnapshot,
): CapabilityRequest[] {
  const requests: CapabilityRequest[] = [
    {
      id: "native_subprocess_execution",
      reason:
        "Provider and repository subprocesses run as the current OS account; approval acknowledges native launch risk but neither authorizes task-irrelevant access nor technically prevents access to ambient files, environment variables, network destinations, credentials, or configured provider integrations",
      risk: "high",
      requirement: "required",
      role: "both",
      enforcement: "advisory",
      scopes: [
        "current OS account filesystem",
        "current OS account process environment",
        "host network stack",
        "configured provider integrations",
      ],
    },
    {
      id: "repository_read_write",
      reason: "Contestants must inspect and edit isolated Git worktrees",
      risk: "medium",
      requirement: "required",
      role: "agent",
      enforcement: "advisory",
      scopes: [config.repositoryRoot],
    },
    {
      id: "local_test_execution",
      reason: `Required validation command: ${config.testCommand}`,
      risk: "medium",
      requirement: "required",
      role: "both",
      enforcement: "advisory",
      scopes: [config.repositoryRoot],
    },
  ];
  if (
    config.issueReferences.length > 0 ||
    config.pullRequestReferences.length > 0
  ) {
    requests.push({
      id: "github_read",
      reason: "Snapshot official issue content",
      risk: "low",
      requirement: "required",
      role: "harness_only",
      enforcement: "brokered",
      scopes: [...config.issueReferences, ...config.pullRequestReferences],
    });
  }
  if (config.integrationProfile) {
    for (const id of config.integrationProfile.capabilityIds) {
      requests.push({
        id,
        reason: "Configured integration profile",
        risk: "medium",
        requirement: "optional",
        role: "harness_only",
        enforcement: "brokered",
        scopes: config.integrationProfile.services,
      });
    }
  }
  if (reconnaissance) {
    const browser = planBrowserValidation(config, reconnaissance);
    if (browser) {
      const profile = browser.profile;
      requests.push({
        id: browser.capabilityId,
        reason: profile
          ? `Browser/DOM validation via ${profile.runner}; Arena probes broker approved origins, while native command execution is advisory; startup ${profile.startupCommand}; health ${profile.healthUrl}; base ${profile.baseUrl}; tests ${profile.testCommand}; native suite ${profile.nativeSuiteMode ?? "reuse_started_service"}; projects ${profile.projects.join(", ") || "default"}; evidence ${browser.evidence.map((entry) => entry.location).join(", ")}`
          : `Browser/DOM validation is ${browser.requirement} but unavailable: ${browser.unavailableReason}`,
        risk: "medium",
        requirement: browser.requirement,
        role: browser.role,
        enforcement: browser.enforcement,
        scopes: browserCapabilityScopes(browser),
        available: Boolean(profile),
      });
      for (const origin of browserExternalOrigins(browser)) {
        const required = Boolean(
          profile &&
          [profile.baseUrl, profile.healthUrl]
            .map((value) => new URL(value).origin)
            .includes(origin),
        );
        requests.push({
          id: `browser_origin_${Buffer.from(origin).toString("hex").slice(0, 24)}`,
          reason: `Allow the browser harness to reach the exact external origin ${origin}`,
          risk: "high",
          requirement: required ? "required" : "optional",
          role: "harness_only",
          enforcement: "brokered",
          scopes: [`origin:${origin}`],
        });
      }
    }
  }
  return requests;
}

function decide(
  request: CapabilityRequest,
  config: FightConfig,
): CapabilityDecision {
  if (request.available === false) {
    const { available: _available, ...decision } = request;
    void _available;
    return { ...decision, mode: config.permissionMode, status: "unavailable" };
  }
  const { available: _available, ...decisionRequest } = request;
  void _available;
  if (
    HARD_DENIES.has(request.id) ||
    config.permissionDeny.includes(request.id)
  ) {
    return { ...decisionRequest, mode: "deny", status: "denied" };
  }
  const explicit = config.permissionAllow[request.id];
  const mode = explicit?.mode ?? config.permissionMode;
  const scopes = explicit?.scopes.length ? explicit.scopes : request.scopes;
  const role = explicit?.role ?? request.role;

  if (mode === "deny")
    return { ...decisionRequest, scopes, role, mode, status: "denied" };
  if (mode === "auto") {
    const exactAllow = explicit !== undefined;
    const safeBoundary =
      request.enforcement === "enforced" || request.enforcement === "brokered";
    return {
      ...decisionRequest,
      scopes,
      role,
      mode,
      status: exactAllow && safeBoundary ? "approved" : "denied",
    };
  }
  return {
    ...decisionRequest,
    scopes,
    role,
    mode,
    status: config.nonInteractiveApproval ? "approved" : "unavailable",
  };
}

export function resolvePermissionPolicy(
  config: FightConfig,
  requests = discoverCapabilities(config),
): PermissionPolicy {
  const capabilities = requests.map((request) => decide(request, config));
  const blockedRequired = capabilities.filter(
    (capability) =>
      capability.requirement === "required" && capability.status !== "approved",
  );
  if (blockedRequired.length > 0 && !config.reducedValidationAccepted) {
    const names = blockedRequired.map((capability) => capability.id).join(", ");
    throw new Error(
      `Required capabilities were not approved: ${names}. Approve them or explicitly accept reduced validation.`,
    );
  }
  return PermissionPolicySchema.parse({
    defaultMode: config.permissionMode,
    capabilities,
    reducedValidationAccepted: config.reducedValidationAccepted,
  });
}

export function capabilityStatus(
  policy: PermissionPolicy,
  capabilityId: string,
): CapabilityDecision | undefined {
  return policy.capabilities.find(
    (capability) => capability.id === capabilityId,
  );
}

export function assertDirectCapabilitiesAllowed(
  policy: PermissionPolicy,
  declaredCapabilityIds: readonly string[],
  requestedCapabilityIds: readonly string[],
): void {
  for (const capabilityId of requestedCapabilityIds) {
    if (!declaredCapabilityIds.includes(capabilityId)) {
      throw new Error(
        `Neutral case requested undeclared capability ${capabilityId}`,
      );
    }
    const capability = capabilityStatus(policy, capabilityId);
    if (
      capability?.status !== "approved" ||
      (capability.role !== "agent" && capability.role !== "both")
    ) {
      throw new Error(
        `Neutral case cannot directly use capability ${capabilityId}`,
      );
    }
  }
}
