import { z } from "zod";

export const BrowserEvidenceSchema = z
  .object({
    source: z.enum(["task", "repository", "configuration"]),
    location: z.string().min(1),
    detail: z.string().min(1),
  })
  .strict();

export const BrowserPlanSchema = z
  .object({
    version: z.literal(1),
    requirement: z.enum(["required", "optional"]),
    evidence: z.array(BrowserEvidenceSchema).min(1),
    profile: z
      .object({
        source: z.enum([
          "arena_configuration",
          "playwright_configuration",
          "cypress_configuration",
          "package_scripts",
        ]),
        runner: z.enum(["playwright", "cypress", "custom"]),
        startupCommand: z.string().min(1),
        healthUrl: z.string().url(),
        baseUrl: z.string().url(),
        testCommand: z.string().min(1),
        teardownCommand: z.string().min(1).optional(),
        projects: z.array(z.string().min(1)),
        allowedOrigins: z.array(z.string().url()).min(1),
      })
      .strict()
      .optional(),
    unavailableReason: z
      .enum([
        "ambiguous_monorepo",
        "startup_command_missing",
        "test_command_missing",
        "base_url_missing",
        "non_local_origin",
      ])
      .optional(),
    capabilityId: z.literal("browser_dom_validation"),
    role: z.literal("harness_only"),
    enforcement: z.literal("brokered"),
    probeFamilies: z.array(
      z.enum([
        "interaction",
        "responsive",
        "keyboard_focus",
        "semantics",
        "persistence",
        "runtime_dom_integrity",
        "dom_security",
        "visual_regression",
      ]),
    ),
  })
  .strict()
  .refine((plan) => plan.profile || plan.unavailableReason, {
    message: "Browser plan needs a profile or unavailable reason",
  });
export type BrowserPlan = z.infer<typeof BrowserPlanSchema>;

export const BrowserUnavailableReasonSchema = z.enum([
  "denied",
  "tool_missing",
  "browser_missing",
  "launch_failure",
  "health_failure",
  "unapproved_origin",
  "interrupted",
  "profile_unavailable",
]);
export type BrowserUnavailableReason = z.infer<
  typeof BrowserUnavailableReasonSchema
>;

export const BrowserArtifactSchema = z
  .object({
    kind: z.enum([
      "plan",
      "version",
      "startup_log",
      "health_log",
      "runner_result",
      "blocked_origin",
      "screenshot",
      "trace",
    ]),
    path: z.string().min(1),
    failureOnly: z.boolean().default(false),
  })
  .strict();
export type BrowserArtifact = z.infer<typeof BrowserArtifactSchema>;

export const BrowserProbeResultSchema = z
  .object({
    family: z.enum([
      "interaction",
      "responsive",
      "keyboard_focus",
      "semantics",
      "persistence",
      "runtime_dom_integrity",
      "dom_security",
      "visual_regression",
    ]),
    profile: z.enum(["desktop", "mobile", "reflow_320", "repository"]),
    status: z.enum(["verified", "failed", "unverified"]),
    contextId: z.string().min(1),
    requiredCapabilityIds: z.array(z.literal("browser_dom_validation")),
    reason: BrowserUnavailableReasonSchema.optional(),
    detail: z.string().optional(),
    blockedOrigins: z.array(z.string()).default([]),
    artifacts: z.array(BrowserArtifactSchema).default([]),
  })
  .strict();
export type BrowserProbeResult = z.infer<typeof BrowserProbeResultSchema>;

export const BrowserValidationResultSchema = z
  .object({
    status: z.enum(["verified", "failed", "unverified"]),
    provisionAttempts: z.number().int().min(0).max(2),
    reason: BrowserUnavailableReasonSchema.optional(),
    toolVersion: z.string().optional(),
    browserVersion: z.string().optional(),
    probes: z.array(BrowserProbeResultSchema),
    artifacts: z.array(BrowserArtifactSchema),
  })
  .strict();
export type BrowserValidationResult = z.infer<
  typeof BrowserValidationResultSchema
>;
