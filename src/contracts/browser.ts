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
        portMode: z.enum(["fixed", "dynamic"]).optional(),
        nativeSuiteMode: z
          .enum(["reuse_started_service", "self_managed"])
          .optional(),
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
        "dynamic_port_mismatch",
      ])
      .optional(),
    capabilityId: z.literal("browser_dom_validation"),
    role: z.literal("harness_only"),
    // Keep brokered readable for completed v1 plans; new plans advertise the
    // weaker advisory boundary because they include a native repository command.
    enforcement: z.enum(["brokered", "advisory"]),
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

export const BrowserProbeActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("goto"), path: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("click"),
      role: z.string().min(1),
      name: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("fill"),
      label: z.string().min(1),
      value: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("fill_dom_xss_canary"),
      label: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("press"), key: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("reload") }).strict(),
  z
    .object({ kind: z.literal("assert_text"), text: z.string().min(1) })
    .strict(),
  z
    .object({
      kind: z.literal("assert_visible"),
      role: z.string().min(1),
      name: z.string().min(1),
    })
    .strict(),
  z
    .object({ kind: z.literal("assert_url"), value: z.string().min(1) })
    .strict(),
]);
export type BrowserProbeAction = z.infer<typeof BrowserProbeActionSchema>;

export const BrowserProbeRequestSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .refine((value) => !value.startsWith("arena-"), {
        message: "Probe IDs beginning with arena- are reserved by the harness",
      }),
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
    profile: z.enum(["desktop", "mobile", "reflow_320"]),
    expectedBehavior: z.string().min(1),
    actions: z.array(BrowserProbeActionSchema).min(1).max(20),
  })
  .strict()
  .superRefine((probe, context) => {
    const canaryActions = probe.actions.filter(
      (action) => action.kind === "fill_dom_xss_canary",
    );
    if (probe.family === "dom_security" && canaryActions.length === 0)
      context.addIssue({
        code: "custom",
        path: ["actions"],
        message:
          "A dom_security probe must include a fill_dom_xss_canary action",
      });
    if (probe.family !== "dom_security" && canaryActions.length > 0)
      context.addIssue({
        code: "custom",
        path: ["actions"],
        message:
          "fill_dom_xss_canary is available only for dom_security probes",
      });
  });
export type BrowserProbeRequest = z.infer<typeof BrowserProbeRequestSchema>;

export function mandatoryBrowserProbes(): BrowserProbeRequest[] {
  return [
    {
      id: "arena-runtime-smoke",
      family: "runtime_dom_integrity",
      profile: "desktop",
      expectedBehavior: "The root route renders without runtime or DOM errors",
      actions: [{ kind: "goto", path: "/" }],
    },
    {
      id: "arena-semantics-smoke",
      family: "semantics",
      profile: "desktop",
      expectedBehavior: "Root-route controls have accessible names",
      actions: [{ kind: "goto", path: "/" }],
    },
    {
      id: "arena-reflow-smoke",
      family: "responsive",
      profile: "reflow_320",
      expectedBehavior:
        "The root route has no horizontal overflow at 320 CSS pixels",
      actions: [{ kind: "goto", path: "/" }],
    },
  ];
}

export const BrowserUnavailableReasonSchema = z.enum([
  "denied",
  "tool_missing",
  "browser_missing",
  "launch_failure",
  "health_failure",
  "unapproved_origin",
  "interrupted",
  "timed_out",
  "profile_unavailable",
  "probe_not_selected",
  "server_command_failure",
  "application_failure",
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
      "result_manifest",
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
    probeId: z.string().min(1).optional(),
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
    profile: z.enum(["desktop", "mobile", "reflow_320", "repository_native"]),
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
    nativeSuiteCacheHit: z.boolean().optional(),
    probes: z.array(BrowserProbeResultSchema),
    artifacts: z.array(BrowserArtifactSchema),
    failureAttribution: z
      .enum([
        "harness_transport",
        "harness_configuration",
        "contestant_application",
        "unattributed",
      ])
      .optional(),
  })
  .strict();
export type BrowserValidationResult = z.infer<
  typeof BrowserValidationResultSchema
>;
