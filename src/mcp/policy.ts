import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  PermissionPolicySchema,
  type AgentId,
  type FightConfig,
  type McpConfig,
  type PermissionPolicy,
} from "../core/types.js";
import { runProcess, type ProcessRequest } from "../runner/process-runner.js";

const McpAuthenticationSchema = z.enum([
  "ready",
  "not_required",
  "needs_authentication",
  "unknown",
]);

export const McpInventoryServerSchema = z
  .object({
    name: z.string().trim().min(1),
    enabled: z.boolean(),
    authentication: McpAuthenticationSchema,
    readiness: z.enum(["ready", "unavailable", "unknown"]),
  })
  .strict();
export type McpInventoryServer = z.infer<typeof McpInventoryServerSchema>;

export const McpProviderInventorySchema = z
  .object({
    provider: z.enum(["codex", "claude", "gemini"]),
    state: z.enum(["known", "unknown"]),
    servers: z.array(McpInventoryServerSchema),
    diagnosticArtifactRefs: z.array(z.string()),
  })
  .strict();
export type McpProviderInventory = z.infer<typeof McpProviderInventorySchema>;

export const FrozenMcpServerSchema = z
  .object({
    provider: z.enum(["codex", "claude", "gemini"]),
    name: z.string().trim().min(1),
    enabledInSnapshot: z.boolean(),
    authentication: McpAuthenticationSchema,
    readiness: z.enum(["ready", "unavailable", "unknown"]),
    role: z.enum(["agent", "harness_only", "both"]),
    requirement: z.enum(["required", "optional"]),
    decision: z.enum(["included", "excluded"]),
    reason: z.string().min(1),
  })
  .strict();
export type FrozenMcpServer = z.infer<typeof FrozenMcpServerSchema>;

export const FrozenMcpPolicySchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["keep_configured", "configure_selection", "leave_as_is"]),
    inventory: z.array(McpProviderInventorySchema),
    servers: z.array(FrozenMcpServerSchema),
    coverageGaps: z.array(z.string()),
    frozenAt: z.string().datetime(),
    policyHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type FrozenMcpPolicy = z.infer<typeof FrozenMcpPolicySchema>;

type InventoryRunner = (
  request: ProcessRequest,
) => ReturnType<typeof runProcess>;

function authFromLabel(label: string): McpInventoryServer["authentication"] {
  if (/needs authentication|not authenticated|login required/i.test(label))
    return "needs_authentication";
  if (/connected|authenticated|ready/i.test(label)) return "ready";
  if (/unsupported|none|not required/i.test(label)) return "not_required";
  return "unknown";
}

function readinessFromLabel(label: string): McpInventoryServer["readiness"] {
  if (/connected|\bready\b|✔/i.test(label)) return "ready";
  if (/failed|unavailable|needs authentication|✘|!/i.test(label))
    return "unavailable";
  return "unknown";
}

export function parseMcpInventory(
  provider: AgentId,
  output: string,
): McpInventoryServer[] {
  const servers = new Map<string, McpInventoryServer>();
  for (const sourceLine of output.split("\n")) {
    const line = sourceLine.trim();
    if (!line || /^Name\s+/i.test(line) || /checking MCP/i.test(line)) continue;
    if (provider === "codex") {
      const status = line.match(/\s(enabled|disabled)\s+(\S.*?)\s*$/i);
      const name = line.match(/^(\S+)/)?.[1];
      if (!status || !name) continue;
      servers.set(name, {
        name,
        enabled: status[1]?.toLowerCase() === "enabled",
        authentication: authFromLabel(status[2] ?? ""),
        readiness: "unknown",
      });
      continue;
    }
    const claude = line.match(/^(.+?):\s+.+?\s+-\s+(.+)$/);
    if (provider === "claude" && claude?.[1] && claude[2]) {
      const label = claude[2];
      servers.set(claude[1], {
        name: claude[1],
        enabled: !/disabled|pending approval/i.test(label),
        authentication: authFromLabel(label),
        readiness: readinessFromLabel(label),
      });
      continue;
    }
    const generic = line.match(/^(?:[-*]\s*)?([^:]+?)(?:\s*:\s*|\s+-\s+)(.+)$/);
    if (generic?.[1] && generic[2]) {
      const label = generic[2];
      servers.set(generic[1].trim(), {
        name: generic[1].trim(),
        enabled: !/disabled/i.test(label),
        authentication: authFromLabel(label),
        readiness: readinessFromLabel(label),
      });
    }
  }
  return [...servers.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export async function inventoryProviderMcp(options: {
  provider: AgentId;
  repositoryRoot: string;
  logRoot: string;
  signal?: AbortSignal;
  run?: InventoryRunner;
}): Promise<McpProviderInventory> {
  const executable = options.provider;
  const logPrefix = path.join(options.logRoot, `mcp-inventory-${executable}`);
  const result = await (options.run ?? runProcess)({
    executable,
    args: ["mcp", "list"],
    cwd: options.repositoryRoot,
    timeoutMs: 15_000,
    logPrefix,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const diagnostics = [result.stdoutPath, result.stderrPath];
  if (result.exitCode !== 0 || result.timedOut || result.failureClass) {
    return McpProviderInventorySchema.parse({
      provider: options.provider,
      state: "unknown",
      servers: [],
      diagnosticArtifactRefs: diagnostics,
    });
  }
  let output: string;
  try {
    const { readFile } = await import("node:fs/promises");
    output = await readFile(result.stdoutPath, "utf8");
  } catch {
    return McpProviderInventorySchema.parse({
      provider: options.provider,
      state: "unknown",
      servers: [],
      diagnosticArtifactRefs: diagnostics,
    });
  }
  return McpProviderInventorySchema.parse({
    provider: options.provider,
    state: "known",
    servers: parseMcpInventory(options.provider, output),
    diagnosticArtifactRefs: diagnostics,
  });
}

function hashPolicy(value: Omit<FrozenMcpPolicy, "policyHash">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function freezeMcpPolicy(options: {
  config: McpConfig;
  inventory: readonly McpProviderInventory[];
  reducedValidationAccepted: boolean;
  now?: Date;
}): FrozenMcpPolicy {
  if (
    options.config.policy === "leave_as_is" &&
    options.inventory.some((entry) => entry.state === "unknown")
  ) {
    throw new Error(
      "MCP inventory is unknown for at least one provider; leave_as_is is unavailable. Use an explicit Arena MCP selection or stop.",
    );
  }
  const configured = new Map(
    options.config.servers.map((server) => [
      `${server.provider}\0${server.name}`,
      server,
    ]),
  );
  const normalizedInventory = options.inventory.map((provider) => ({
    ...provider,
    servers: [
      ...provider.servers,
      ...options.config.servers
        .filter(
          (server) =>
            server.provider === provider.provider &&
            !provider.servers.some((entry) => entry.name === server.name),
        )
        .map((server) => ({
          name: server.name,
          enabled: false,
          authentication: "unknown" as const,
          readiness: "unknown" as const,
        })),
    ],
  }));
  for (const provider of options.config.servers.map(
    (server) => server.provider,
  )) {
    if (!normalizedInventory.some((entry) => entry.provider === provider)) {
      normalizedInventory.push({
        provider,
        state: "unknown",
        servers: options.config.servers
          .filter((server) => server.provider === provider)
          .map((server) => ({
            name: server.name,
            enabled: false,
            authentication: "unknown" as const,
            readiness: "unknown" as const,
          })),
        diagnosticArtifactRefs: [],
      });
    }
  }
  const selectedKeys =
    options.config.policy === "leave_as_is"
      ? new Set(
          normalizedInventory.flatMap((provider) =>
            provider.servers
              .filter((server) => server.enabled)
              .map((server) => `${provider.provider}\0${server.name}`),
          ),
        )
      : new Set(configured.keys());
  const allKeys = new Set([
    ...selectedKeys,
    ...normalizedInventory.flatMap((provider) =>
      provider.servers.map((server) => `${provider.provider}\0${server.name}`),
    ),
  ]);
  const servers = [...allKeys]
    .map((key): FrozenMcpServer => {
      const [providerValue, name = ""] = key.split("\0");
      const provider = providerValue as AgentId;
      const inventoryServer = normalizedInventory
        .find((entry) => entry.provider === provider)
        ?.servers.find((server) => server.name === name);
      const requested = configured.get(key);
      const included = selectedKeys.has(key);
      const role = requested?.role ?? "agent";
      const requirement = requested?.requirement ?? "optional";
      return {
        provider,
        name,
        enabledInSnapshot: inventoryServer?.enabled ?? false,
        authentication: inventoryServer?.authentication ?? "unknown",
        readiness: inventoryServer?.readiness ?? "unknown",
        role,
        requirement,
        decision: included ? "included" : "excluded",
        reason: included
          ? options.config.policy === "leave_as_is"
            ? "Enabled in the approved discovered snapshot"
            : "Named in the explicit Arena MCP selection"
          : "Not selected for this run",
      };
    })
    .sort((left, right) =>
      `${left.provider}\0${left.name}`.localeCompare(
        `${right.provider}\0${right.name}`,
      ),
    );
  const enforceableServers = servers.map((server) => {
    if (server.decision === "included" && server.role === "harness_only")
      return {
        ...server,
        readiness: "unavailable" as const,
        reason:
          "Harness-only MCP execution is not implemented; the server is excluded from provider agent sessions",
      };
    if (server.provider === "claude" && server.decision === "included")
      return {
        ...server,
        readiness: "unavailable" as const,
        reason:
          "Claude named MCP selections cannot be isolated without explicit server definitions; the server is excluded from this run",
      };
    return server;
  });
  const unavailableRequired = enforceableServers.filter(
    (server) =>
      server.decision === "included" &&
      server.requirement === "required" &&
      server.readiness === "unavailable",
  );
  if (unavailableRequired.length && !options.reducedValidationAccepted) {
    throw new Error(
      `Required MCP servers are unavailable: ${unavailableRequired.map((server) => `${server.provider}/${server.name}`).join(", ")}. Reauthenticate explicitly or accept reduced validation with those servers excluded.`,
    );
  }
  const normalizedServers = enforceableServers.map((server) =>
    server.decision === "included" && server.readiness === "unavailable"
      ? {
          ...server,
          decision: "excluded" as const,
          reason: /cannot be isolated|not implemented/i.test(server.reason)
            ? server.reason
            : server.requirement === "required"
              ? "Required server unavailable under accepted reduced validation"
              : "Optional server unavailable during readiness checks",
        }
      : server,
  );
  const coverageGaps = normalizedServers
    .filter(
      (server) =>
        server.decision === "excluded" &&
        /unavailable|cannot be isolated|not implemented/i.test(server.reason),
    )
    .map(
      (server) =>
        `${server.provider}/${server.name} (${server.requirement}): ${server.reason}`,
    );
  const draft = {
    version: 1 as const,
    mode: options.config.policy,
    inventory: normalizedInventory,
    servers: normalizedServers,
    coverageGaps,
    frozenAt: (options.now ?? new Date()).toISOString(),
  };
  return FrozenMcpPolicySchema.parse({
    ...draft,
    policyHash: hashPolicy(draft),
  });
}

export function selectedMcpNames(
  policy: FrozenMcpPolicy,
  provider: AgentId,
): string[] {
  return policy.servers
    .filter(
      (server) =>
        server.provider === provider && server.decision === "included",
    )
    .map((server) => server.name);
}

/** MCP servers that a contestant or judge provider may use directly. */
export function agentMcpNames(
  policy: FrozenMcpPolicy,
  provider: AgentId,
): string[] {
  return policy.servers
    .filter(
      (server) =>
        server.provider === provider &&
        server.decision === "included" &&
        (server.role === "agent" || server.role === "both"),
    )
    .map((server) => server.name);
}

export function mcpServerIdentity(provider: AgentId, name: string): string {
  return `${provider}\0${name}`;
}

/** Restrict a readiness invocation to one selected server. */
export function isolateMcpPolicyForReadiness(
  policy: FrozenMcpPolicy,
  provider: AgentId,
  name: string,
): FrozenMcpPolicy {
  const draft = {
    ...policy,
    servers: policy.servers.map((server) =>
      server.provider === provider && server.name === name
        ? server
        : server.decision === "included"
          ? {
              ...server,
              decision: "excluded" as const,
              reason: "Excluded from this isolated MCP readiness probe",
            }
          : server,
    ),
    coverageGaps: [],
  };
  const { policyHash: _policyHash, ...withoutHash } = draft;
  void _policyHash;
  return FrozenMcpPolicySchema.parse({
    ...withoutHash,
    policyHash: hashPolicy(withoutHash),
  });
}

export function applyMcpReadiness(
  policy: FrozenMcpPolicy,
  readiness: ReadonlyMap<string, "ready" | "unavailable">,
  reducedValidationAccepted: boolean,
  now?: Date,
): FrozenMcpPolicy {
  const inventory = policy.inventory.map((provider) => ({
    ...provider,
    servers: provider.servers.map((server) => ({
      ...server,
      ...(policy.servers.some(
        (selected) =>
          selected.provider === provider.provider &&
          selected.name === server.name &&
          selected.decision === "included",
      ) && readiness.has(mcpServerIdentity(provider.provider, server.name))
        ? {
            readiness: readiness.get(
              mcpServerIdentity(provider.provider, server.name),
            )!,
          }
        : {}),
    })),
  }));
  return freezeMcpPolicy({
    config: {
      policy: policy.mode,
      servers: policy.servers
        .filter(
          (server) =>
            server.decision === "included" ||
            /unavailable|cannot be isolated|not implemented/i.test(
              server.reason,
            ),
        )
        .map((server) => ({
          provider: server.provider,
          name: server.name,
          role: server.role,
          requirement: server.requirement,
        })),
    },
    inventory,
    reducedValidationAccepted,
    ...(now ? { now } : {}),
  });
}

export function mcpProviders(config: FightConfig): AgentId[] {
  return [
    ...new Set([
      ...config.contestants.map((contestant) => contestant.provider),
      config.judge,
    ]),
  ];
}

export function mergeMcpPermissionPolicy(
  permissions: PermissionPolicy,
  mcp: FrozenMcpPolicy,
): PermissionPolicy {
  return PermissionPolicySchema.parse({
    ...permissions,
    capabilities: [
      ...permissions.capabilities.filter(
        (capability) => !capability.id.startsWith("mcp_server_"),
      ),
      ...mcp.servers.map((server) => ({
        id: `mcp_server_${server.provider}_${createHash("sha256").update(server.name).digest("hex").slice(0, 16)}`,
        reason: `${server.reason}; frozen by MCP policy ${mcp.policyHash}`,
        risk: "high" as const,
        requirement: server.requirement,
        role: server.role,
        enforcement: "advisory" as const,
        mode: permissions.defaultMode,
        scopes: [`provider:${server.provider}`, `server:${server.name}`],
        status:
          server.decision === "included"
            ? ("approved" as const)
            : ("unavailable" as const),
      })),
    ],
  });
}
