import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  AgentIdSchema,
  FightConfigSchema,
  type FightConfig,
  type TaskReference,
} from "../core/types.js";
import {
  EffortModeSchema,
  resolveEffortProfile,
  type EffortMode,
} from "../effort/policy.js";

const DurationLimitsSchema = z
  .object({
    implementation_minutes: z.number().positive().default(15),
    review_minutes: z.number().positive().max(10).default(10),
    attack_minutes: z.number().positive().default(8),
    verifier_minutes: z.number().positive().default(2),
    repair_minutes: z.number().positive().default(8),
    rounds: z.number().int().min(1).max(5).optional(),
    attacks_per_round: z.literal(3).default(3),
    /** @deprecated Accepted and ignored for legacy configuration. */
    infrastructure_recovery_round: z.boolean().optional(),
    /** @deprecated Ignored for new runs. */
    held_out_cases_per_defect: z.number().int().min(0).max(2).default(2),
  })
  .strict()
  .default({
    implementation_minutes: 15,
    review_minutes: 10,
    attack_minutes: 8,
    verifier_minutes: 2,
    repair_minutes: 8,
    attacks_per_round: 3,
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
    bootstrap: z
      .union([
        z.literal("auto"),
        z.literal("none"),
        z.object({ command: z.string().trim().min(1) }).strict(),
      ])
      .default("auto"),
    effort: EffortModeSchema.default("auto"),
    base_from_pr: z.union([z.string(), z.number()]).optional(),
    mode: z.enum(["duel", "siege", "catch_up"]).optional(),
    incumbent: AgentIdSchema.optional(),
    attacker: AgentIdSchema.optional(),
    defender: AgentIdSchema.optional(),
    challenger: AgentIdSchema.optional(),
    agents: z.array(AgentIdSchema).length(2).optional(),
    models: z.array(z.string().trim().min(1)).length(2).optional(),
    judge: AgentIdSchema.optional(),
    /** @deprecated Use `judge`. */
    attack_verifier: AgentIdSchema.optional(),
    /** @deprecated Ignored for new runs. */
    quality_verifier: AgentIdSchema.optional(),
    /** @deprecated Ignored for new runs. */
    harness_maintainer: AgentIdSchema.optional(),
    /** @deprecated Ignored for new runs. */
    house_scout: AgentIdSchema.optional(),
    acceptance_criteria: z.array(z.string()).default([]),
    specs: z.array(z.string()).default([]),
    sources: z
      .array(
        z.union([
          z
            .object({
              github_issue: z.union([z.string(), z.number()]),
              primary: z.boolean().optional(),
            })
            .strict(),
          z
            .object({
              github_pr: z.union([z.string(), z.number()]),
              primary: z.boolean().optional(),
            })
            .strict(),
          z
            .object({ spec: z.string(), primary: z.boolean().optional() })
            .strict(),
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
    browser: z
      .object({
        runner: z.enum(["playwright", "cypress", "custom"]),
        startup: z.string().trim().min(1),
        health_url: z.string().url(),
        base_url: z.string().url(),
        test: z.string().trim().min(1),
        teardown: z.string().trim().min(1).optional(),
        port_mode: z.enum(["fixed", "dynamic"]).default("fixed"),
        native_suite_mode: z
          .enum(["reuse_started_service", "self_managed"])
          .default("reuse_started_service"),
        projects: z.array(z.string().trim().min(1)).default([]),
        allowed_origins: z.array(z.string().url()).min(1),
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
    mcp: z
      .object({
        policy: z
          .enum(["keep_configured", "configure_selection", "leave_as_is"])
          .default("keep_configured"),
        servers: z
          .array(
            z
              .object({
                provider: AgentIdSchema,
                name: z.string().trim().min(1),
                role: z
                  .enum(["agent", "harness_only", "both"])
                  .default("agent"),
                requirement: z
                  .enum(["required", "optional"])
                  .default("optional"),
              })
              .strict(),
          )
          .default([]),
      })
      .strict()
      .default({ policy: "keep_configured", servers: [] }),
    limits: DurationLimitsSchema,
    selection: z
      .object({ enabled: z.boolean().default(true) })
      .strict()
      .default({ enabled: true }),
    review: z
      .object({ required_for_apply: z.boolean().default(true) })
      .strict()
      .default({ required_for_apply: true }),
    delivery: z
      .object({
        enabled: z.boolean().default(false),
        merge_enabled: z.boolean().default(false),
      })
      .strict()
      .default({ enabled: false, merge_enabled: false }),
  })
  .strict();

export interface CliConfigOverrides {
  task: string;
  repositoryRoot?: string;
  artifactRoot?: string;
  configPath?: string;
  testCommand?: string;
  agents?: string;
  models?: string;
  judge?: string;
  /** @deprecated Use `judge`. */
  verifier?: string;
  qualityVerifier?: string;
  maintainer?: string;
  permissionMode?: "auto" | "confirm" | "deny";
  specPaths?: string[];
  issueReferences?: string[];
  pullRequestReferences?: string[];
  baseFromPullRequest?: string;
  mode?: "duel" | "siege" | "catch_up";
  incumbent?: string;
  attacker?: string;
  defender?: string;
  challenger?: string;
  acceptanceCriteria?: string[];
  nonInteractiveApproval?: boolean;
  reviewMcp?: boolean;
  reducedValidationAccepted?: boolean;
  keepWorktrees?: boolean;
  effort?: EffortMode;
  rounds?: number;
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

function parseModels(
  value: string | undefined,
  fallback: readonly string[] | undefined,
): [string, string] | undefined {
  if (value === undefined && fallback === undefined) return undefined;
  const models = value
    ? value.split(",").map((model) => model.trim())
    : [...(fallback ?? [])];
  if (models.length !== 2 || models.some((model) => model.length === 0))
    throw new Error(
      "Exactly two non-empty comma-separated models are required",
    );
  return [models[0] ?? "", models[1] ?? ""];
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
  const configuredRounds = overrides.rounds ?? file.limits.rounds;
  const fileDeclaresEffort = Boolean(
    fileValue &&
    typeof fileValue === "object" &&
    Object.hasOwn(fileValue, "effort"),
  );
  const explicitlyConfiguredEffort =
    overrides.effort ?? (fileDeclaresEffort ? file.effort : undefined);
  if (configuredRounds !== undefined && explicitlyConfiguredEffort === "auto")
    throw new Error("--rounds cannot be combined with --effort auto");
  const effort =
    explicitlyConfiguredEffort ??
    (configuredRounds === undefined ? file.effort : "medium");
  const profile = resolveEffortProfile(effort === "auto" ? "medium" : effort);
  const rawLimits =
    fileValue &&
    typeof fileValue === "object" &&
    "limits" in fileValue &&
    fileValue.limits &&
    typeof fileValue.limits === "object"
      ? (fileValue.limits as Record<string, unknown>)
      : {};
  const phaseOverrides = {
    implementation: Object.hasOwn(rawLimits, "implementation_minutes"),
    review: Object.hasOwn(rawLimits, "review_minutes"),
    attack: Object.hasOwn(rawLimits, "attack_minutes"),
    judge: Object.hasOwn(rawLimits, "verifier_minutes"),
    repair: Object.hasOwn(rawLimits, "repair_minutes"),
  };
  const sourceSpecs = file.sources.flatMap((source) =>
    "spec" in source ? [source.spec] : [],
  );
  const sourceIssues = file.sources.flatMap((source) =>
    "github_issue" in source ? [String(source.github_issue)] : [],
  );
  const sourcePullRequests = file.sources.flatMap((source) =>
    "github_pr" in source ? [String(source.github_pr)] : [],
  );
  const explicitIssues = [
    ...sourceIssues,
    ...(overrides.issueReferences ?? []),
  ];
  const explicitPullRequests = [
    ...new Set([
      ...sourcePullRequests,
      ...(overrides.pullRequestReferences ?? []),
      ...((overrides.baseFromPullRequest ?? file.base_from_pr)
        ? [String(overrides.baseFromPullRequest ?? file.base_from_pr)]
        : []),
    ]),
  ];
  const inferredIssues =
    explicitIssues.length === 0
      ? [...overrides.task.matchAll(/\bissue\s+#?(\d+)\b/gi)].flatMap(
          (match) => (match[1] ? [match[1]] : []),
        )
      : [];
  const mode = overrides.mode ?? file.mode ?? "duel";
  const agents = parseAgents(
    overrides.agents,
    file.agents ?? ["codex", "claude"],
  );
  const models = parseModels(overrides.models, file.models);
  const challenger = overrides.challenger ?? file.challenger;
  const attacker = overrides.attacker ?? file.attacker;
  const defender = overrides.defender ?? file.defender;
  const incumbent = overrides.incumbent ?? file.incumbent;
  if (mode === "catch_up" && !challenger)
    throw new Error("Catch-up mode requires --challenger <agent>");
  if (mode === "siege" && (!attacker || !defender))
    throw new Error(
      "Siege mode requires --attacker <agent> and --defender <agent>",
    );
  if (mode !== "duel" && explicitPullRequests.length !== 1)
    throw new Error(
      `${mode === "siege" ? "Siege" : "Catch-up"} mode requires exactly one --pr <reference>`,
    );
  const contestants =
    mode === "catch_up"
      ? [
          {
            id: "a" as const,
            // The arena replaces this provisional value with either --incumbent
            // or confirmed frozen-PR attribution before an invocation occurs.
            provider: incumbent ?? challenger ?? agents[0],
            ...(models?.[0] ? { model: models[0] } : {}),
            role: "incumbent" as const,
            startingPatch: "pull_request" as const,
          },
          {
            id: "b" as const,
            provider: challenger ?? agents[1],
            ...(models?.[1] ? { model: models[1] } : {}),
            role: "challenger" as const,
            startingPatch: "none" as const,
          },
        ]
      : mode === "siege"
        ? [
            {
              id: "a" as const,
              provider: attacker ?? agents[0],
              ...(models?.[0] ? { model: models[0] } : {}),
              role: "attacker" as const,
              startingPatch: "none" as const,
            },
            {
              id: "b" as const,
              provider: defender ?? agents[1],
              ...(models?.[1] ? { model: models[1] } : {}),
              role: "defender" as const,
              startingPatch: "pull_request" as const,
            },
          ]
        : [
            {
              id: "a" as const,
              provider: agents[0],
              ...(models?.[0] ? { model: models[0] } : {}),
              role: "solver" as const,
              startingPatch: "none" as const,
            },
            {
              id: "b" as const,
              provider: agents[1],
              ...(models?.[1] ? { model: models[1] } : {}),
              role: "solver" as const,
              startingPatch: "none" as const,
            },
          ];
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
  const compatibilityWarnings = [
    ...(overrides.verifier || file.attack_verifier
      ? ["`attack_verifier`/`--verifier` is deprecated; use `judge`/`--judge`."]
      : []),
    ...(overrides.qualityVerifier || file.quality_verifier
      ? ["`quality_verifier` is obsolete and ignored for new runs."]
      : []),
    ...(overrides.maintainer || file.harness_maintainer
      ? ["`harness_maintainer` is obsolete and ignored for new runs."]
      : []),
    ...(file.house_scout
      ? ["`house_scout` is obsolete and ignored for new runs."]
      : []),
    ...(fileValue &&
    typeof fileValue === "object" &&
    "limits" in fileValue &&
    fileValue.limits &&
    typeof fileValue.limits === "object" &&
    Object.prototype.hasOwnProperty.call(
      fileValue.limits,
      "held_out_cases_per_defect",
    )
      ? ["`held_out_cases_per_defect` is obsolete and ignored for new runs."]
      : []),
    ...(fileValue &&
    typeof fileValue === "object" &&
    "limits" in fileValue &&
    fileValue.limits &&
    typeof fileValue.limits === "object" &&
    Object.prototype.hasOwnProperty.call(
      fileValue.limits,
      "infrastructure_recovery_round",
    )
      ? [
          "`limits.infrastructure_recovery_round` is obsolete and ignored; new runs use the configured effort policy or fixed round count.",
        ]
      : []),
  ];

  return FightConfigSchema.parse({
    task: overrides.task,
    mode,
    contestants,
    ...(incumbent ? { incumbentProvider: incumbent } : {}),
    acceptanceCriteria:
      overrides.acceptanceCriteria ?? file.acceptance_criteria,
    specPaths: [...file.specs, ...sourceSpecs, ...(overrides.specPaths ?? [])],
    issueReferences: [...explicitIssues, ...inferredIssues],
    pullRequestReferences: explicitPullRequests,
    ...((overrides.baseFromPullRequest ?? file.base_from_pr)
      ? {
          baseFromPullRequest: String(
            overrides.baseFromPullRequest ?? file.base_from_pr,
          ),
        }
      : {}),
    taskReferences: [
      ...file.sources.flatMap((source): TaskReference[] =>
        "github_issue" in source
          ? [
              {
                kind: "github_issue" as const,
                reference: String(source.github_issue),
                ...(source.primary !== undefined
                  ? { primary: source.primary }
                  : {}),
              },
            ]
          : "github_pr" in source
            ? [
                {
                  kind: "github_pull_request" as const,
                  reference: String(source.github_pr),
                  ...(source.primary !== undefined
                    ? { primary: source.primary }
                    : {}),
                },
              ]
            : [
                {
                  kind: "repo_spec" as const,
                  path: source.spec,
                  ...(source.primary !== undefined
                    ? { primary: source.primary }
                    : {}),
                },
              ],
      ),
      ...[...(overrides.issueReferences ?? []), ...inferredIssues].map(
        (reference) => ({
          kind: "github_issue" as const,
          reference,
        }),
      ),
      ...explicitPullRequests
        .filter((reference) => !sourcePullRequests.includes(reference))
        .map((reference) => ({
          kind: "github_pull_request" as const,
          reference,
        })),
      ...[...file.specs, ...(overrides.specPaths ?? [])].map((path) => ({
        kind: "repo_spec" as const,
        path,
      })),
    ],
    agents,
    judge:
      overrides.judge ??
      overrides.verifier ??
      file.judge ??
      file.attack_verifier ??
      agents[0],
    configWarnings: compatibilityWarnings,
    maxHeldOutCasesPerDefect: 0,
    effortMode: effort,
    fixedRounds: configuredRounds !== undefined,
    rounds: configuredRounds ?? profile.plannedRounds,
    maxAttacksPerRound: 3,
    testCommand: overrides.testCommand ?? file.test,
    bootstrap: file.bootstrap,
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
    ...(file.browser
      ? {
          browserProfile: {
            runner: file.browser.runner,
            startupCommand: file.browser.startup,
            healthUrl: file.browser.health_url,
            baseUrl: file.browser.base_url,
            testCommand: file.browser.test,
            ...(file.browser.teardown
              ? { teardownCommand: file.browser.teardown }
              : {}),
            portMode: file.browser.port_mode,
            nativeSuiteMode: file.browser.native_suite_mode,
            projects: file.browser.projects,
            allowedOrigins: file.browser.allowed_origins,
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
    mcp: file.mcp,
    reducedValidationAccepted:
      overrides.reducedValidationAccepted ??
      file.permissions.reduced_validation_accepted,
    nonInteractiveApproval: overrides.nonInteractiveApproval ?? false,
    keepWorktrees: overrides.keepWorktrees ?? false,
    selectionEnabled: file.selection.enabled,
    reviewRequiredForApply: file.review.required_for_apply,
    deliveryEnabled: file.delivery.enabled,
    mergeEnabled: file.delivery.merge_enabled,
    limits: {
      implementationMs: phaseOverrides.implementation
        ? minutes(file.limits.implementation_minutes)
        : profile.implementationMs,
      reviewMs: phaseOverrides.review
        ? minutes(file.limits.review_minutes)
        : profile.reviewMs,
      attackMs: phaseOverrides.attack
        ? minutes(file.limits.attack_minutes)
        : profile.attackMs,
      verifierMs: phaseOverrides.judge
        ? minutes(file.limits.verifier_minutes)
        : profile.judgeMs,
      repairMs: phaseOverrides.repair
        ? minutes(file.limits.repair_minutes)
        : profile.repairMs,
    },
    phaseOverrides,
  });
}
