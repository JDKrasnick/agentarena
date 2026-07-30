import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  AgentIdSchema,
  FightConfigSchema,
  type FightConfig,
} from "../core/types.js";

const DurationLimitsSchema = z
  .object({
    implementation_minutes: z.number().positive().default(15),
    attack_minutes: z.number().positive().default(8),
    verifier_minutes: z.number().positive().default(2),
    repair_minutes: z.number().positive().default(8),
    rounds: z.literal(3).default(3),
    attacks_per_round: z.literal(3).default(3),
    infrastructure_recovery_round: z.literal(true).default(true),
    held_out_cases_per_defect: z.number().int().min(0).max(2).default(2),
  })
  .strict()
  .default({
    implementation_minutes: 15,
    attack_minutes: 8,
    verifier_minutes: 2,
    repair_minutes: 8,
    rounds: 3,
    attacks_per_round: 3,
    infrastructure_recovery_round: true,
    held_out_cases_per_defect: 2,
  });

const PermissionEntrySchema = z
  .object({
    mode: z.enum(["auto", "confirm", "deny"]).default("confirm"),
    scope: z.union([z.string(), z.array(z.string())]).default([]),
    role: z.enum(["agent", "harness_only", "both"]).default("both"),
  })
  .strict();

const FileConfigSchema = z
  .object({
    test: z.string().optional(),
    agents: z.array(AgentIdSchema).length(2).optional(),
    attack_verifier: AgentIdSchema.optional(),
    harness_maintainer: AgentIdSchema.optional(),
    acceptance_criteria: z.array(z.string()).default([]),
    specs: z.array(z.string()).default([]),
    sources: z
      .array(
        z.union([
          z
            .object({ github_issue: z.union([z.string(), z.number()]) })
            .strict(),
          z.object({ spec: z.string() }).strict(),
        ]),
      )
      .default([]),
    integration: z
      .object({
        setup: z.string(),
        check: z.string(),
        teardown: z.string(),
        services: z.array(z.string()).default([]),
        capability_ids: z.array(z.string()).default([]),
        steady_state_invariants: z.array(z.string()).default([]),
        fault_controls: z
          .array(
            z.enum([
              "latency",
              "timeout",
              "disconnect",
              "restart",
              "partial_response",
            ]),
          )
          .default([]),
      })
      .strict()
      .optional(),
    permissions: z
      .object({
        default: z.enum(["auto", "confirm", "deny"]).default("confirm"),
        allow: z.record(z.string(), PermissionEntrySchema).default({}),
        deny: z.array(z.string()).default([]),
        reduced_validation_accepted: z.boolean().default(false),
      })
      .strict()
      .default({
        default: "confirm",
        allow: {},
        deny: [],
        reduced_validation_accepted: false,
      }),
    limits: DurationLimitsSchema,
  })
  .strict();

export interface CliConfigOverrides {
  task: string;
  repositoryRoot?: string;
  artifactRoot?: string;
  configPath?: string;
  testCommand?: string;
  agents?: string;
  verifier?: string;
  maintainer?: string;
  permissionMode?: "auto" | "confirm" | "deny";
  specPaths?: string[];
  issueReferences?: string[];
  acceptanceCriteria?: string[];
  nonInteractiveApproval?: boolean;
  reducedValidationAccepted?: boolean;
  keepWorktrees?: boolean;
}

function minutes(value: number): number {
  return Math.round(value * 60_000);
}

function parseAgents(
  value: string | undefined,
  fallback: readonly string[],
): [string, string] {
  const agents = value
    ? value.split(",").map((agent) => agent.trim())
    : [...fallback];
  if (agents.length !== 2)
    throw new Error("Exactly two comma-separated agents are required");
  return [agents[0] ?? "", agents[1] ?? ""];
}

export async function loadFightConfig(
  overrides: CliConfigOverrides,
): Promise<FightConfig> {
  const repositoryRoot = path.resolve(
    overrides.repositoryRoot ?? process.cwd(),
  );
  const configPath = path.resolve(
    repositoryRoot,
    overrides.configPath ?? "agent-arena.yaml",
  );
  let fileValue: unknown = {};
  try {
    fileValue = parseYaml(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const file = FileConfigSchema.parse(fileValue ?? {});
  const sourceSpecs = file.sources.flatMap((source) =>
    "spec" in source ? [source.spec] : [],
  );
  const sourceIssues = file.sources.flatMap((source) =>
    "github_issue" in source ? [String(source.github_issue)] : [],
  );
  const explicitIssues = [
    ...sourceIssues,
    ...(overrides.issueReferences ?? []),
  ];
  const inferredIssues =
    explicitIssues.length === 0
      ? [...overrides.task.matchAll(/\bissue\s+#?(\d+)\b/gi)].flatMap(
          (match) => (match[1] ? [match[1]] : []),
        )
      : [];
  const agents = parseAgents(
    overrides.agents,
    file.agents ?? ["codex", "claude"],
  );
  const permissionAllow = Object.fromEntries(
    Object.entries(file.permissions.allow).map(([id, entry]) => [
      id,
      {
        mode: entry.mode,
        scopes: typeof entry.scope === "string" ? [entry.scope] : entry.scope,
        role: entry.role,
      },
    ]),
  );

  return FightConfigSchema.parse({
    task: overrides.task,
    acceptanceCriteria:
      overrides.acceptanceCriteria ?? file.acceptance_criteria,
    specPaths: [...file.specs, ...sourceSpecs, ...(overrides.specPaths ?? [])],
    issueReferences: [...explicitIssues, ...inferredIssues],
    agents,
    attackVerifier: overrides.verifier ?? file.attack_verifier ?? agents[0],
    harnessMaintainer:
      overrides.maintainer ?? file.harness_maintainer ?? agents[0],
    rounds: 3,
    maxAttacksPerRound: 3,
    infrastructureRecoveryRound: true,
    maxHeldOutCasesPerDefect: file.limits.held_out_cases_per_defect,
    testCommand: overrides.testCommand ?? file.test,
    ...(file.integration
      ? {
          integrationProfile: {
            setupCommand: file.integration.setup,
            checkCommand: file.integration.check,
            teardownCommand: file.integration.teardown,
            services: file.integration.services,
            capabilityIds: file.integration.capability_ids,
            steadyStateInvariants: file.integration.steady_state_invariants,
            faultControls: file.integration.fault_controls,
          },
        }
      : {}),
    repositoryRoot,
    artifactRoot: path.resolve(
      repositoryRoot,
      overrides.artifactRoot ?? ".agent-arena/runs",
    ),
    permissionMode: overrides.permissionMode ?? file.permissions.default,
    permissionAllow,
    permissionDeny: file.permissions.deny,
    reducedValidationAccepted:
      overrides.reducedValidationAccepted ??
      file.permissions.reduced_validation_accepted,
    nonInteractiveApproval: overrides.nonInteractiveApproval ?? false,
    keepWorktrees: overrides.keepWorktrees ?? false,
    limits: {
      implementationMs: minutes(file.limits.implementation_minutes),
      attackMs: minutes(file.limits.attack_minutes),
      verifierMs: minutes(file.limits.verifier_minutes),
      repairMs: minutes(file.limits.repair_minutes),
    },
  });
}
