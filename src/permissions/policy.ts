import {
  PermissionPolicySchema,
  type CapabilityDecision,
  type FightConfig,
  type PermissionPolicy,
} from "../core/types.js";

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
}

export function discoverCapabilities(config: FightConfig): CapabilityRequest[] {
  const requests: CapabilityRequest[] = [
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
  if (config.issueReferences.length > 0) {
    requests.push({
      id: "github_read",
      reason: "Snapshot official issue content",
      risk: "low",
      requirement: "required",
      role: "harness_only",
      enforcement: "brokered",
      scopes: config.issueReferences,
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
  return requests;
}

function decide(
  request: CapabilityRequest,
  config: FightConfig,
): CapabilityDecision {
  if (
    HARD_DENIES.has(request.id) ||
    config.permissionDeny.includes(request.id)
  ) {
    return { ...request, mode: "deny", status: "denied" };
  }
  const explicit = config.permissionAllow[request.id];
  const mode = explicit?.mode ?? config.permissionMode;
  const scopes = explicit?.scopes.length ? explicit.scopes : request.scopes;
  const role = explicit?.role ?? request.role;

  if (mode === "deny")
    return { ...request, scopes, role, mode, status: "denied" };
  if (mode === "auto") {
    const exactAllow = explicit !== undefined;
    const safeBoundary =
      request.enforcement === "enforced" || request.enforcement === "brokered";
    return {
      ...request,
      scopes,
      role,
      mode,
      status: exactAllow && safeBoundary ? "approved" : "denied",
    };
  }
  return {
    ...request,
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
