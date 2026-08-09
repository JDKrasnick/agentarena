import { sha256 } from "../core/ids.js";
import type {
  AgentId,
  AttackReviewArtifact,
  AttackSubmission,
  ContestantId,
  FightConfig,
  PermissionPolicy,
  RoundId,
  RoundPromptManifest,
} from "../core/types.js";
import type { ContestantFeedback, RunSpec } from "../contracts/round.js";
import type { MethodSelection } from "../methods/catalog.js";

const COMMON_VERSION = "common@1";
const OVERLAY_VERSION: Record<RoundId, string> = {
  1: "round-1-contract@1",
  2: "round-2-systematic@1",
  3: "round-3-integration@1",
  recovery: "recovery@1",
};

const OVERLAYS: Record<RoundId, string> = {
  1: "Trace each acceptance criterion through observable behavior. Prefer focused examples, boundaries, negative cases, error paths, and regressions.",
  2: "Build a diverse concise hypothesis portfolio across state, lifecycle, data integrity, generated inputs, concurrency, cancellation, and cleanup. Commit only executable evidence.",
  3: "Exercise approved component boundaries, configuration, trust boundaries, dependency faults, retry/idempotency, recovery, and bounded resources. Degrade to local resilience probes when integration is unavailable.",
  recovery:
    "Use replacement credits only for new attacks against the post-round-3 patches. Another infrastructure failure makes the run inconclusive.",
};

function executionArchitecture(
  context: Pick<PromptContext, "agent" | "config" | "stage">,
  target?: ContestantId,
  phaseOverride?: "read_only_repository_review",
): string {
  const contestant = context.config.contestants.find(
    (candidate) => candidate.id === context.agent,
  );
  const worktreeState =
    phaseOverride === "read_only_repository_review"
      ? "clean battle base plus the opponent's frozen target patch; repository inspection and permitted diagnostics are allowed, but only the structured submission may change"
      : context.stage === "implement"
        ? "clean battle base; this contestant owns the implementation produced here"
        : context.stage === "attack"
          ? "clean battle base plus the opponent's frozen target patch; capture only a target-relative test overlay"
          : "this contestant's current implementation plus verifier-confirmed regression evidence";
  return JSON.stringify(
    {
      battleMode: context.config.mode,
      contestantSlot: context.agent,
      contestantRole: contestant?.role ?? "stage participant",
      ...(target ? { targetSlot: target } : {}),
      currentPhase: phaseOverride ?? context.stage,
      phaseSequence: [
        "freeze implementations",
        "read-only repository review",
        "focused regression-test generation",
        "deterministic execution and anonymized verifier assessment",
        "validated-evidence repair",
      ],
      worktreeState,
      repositoryContext:
        "The complete assigned repository is available in the current worktree. Read applicable AGENTS.md and provider instruction files, manifests, specifications, source, and existing tests before relying on architectural assumptions.",
      validationAuthority:
        "The harness owns execution and the verifier owns oracle, relevance, root-defect, and severity assessment.",
      informationBoundary:
        "Private implementation transcripts and raw reviewer reasoning never cross contestant lanes. Repair receives only verifier-confirmed regression evidence.",
      requiredValidationCommand: context.config.testCommand,
      declaredIntegrationTopology:
        context.config.integrationProfile ?? "none declared",
    },
    null,
    2,
  );
}

export function permissionContext(permissions: PermissionPolicy): string {
  return [
    JSON.stringify(permissions, null, 2),
    "",
    "Permission interpretation:",
    "- Use a capability only when status is approved and role is agent or both.",
    "- A harness_only capability is not directly available to this agent; request its harness-mediated check by capability ID.",
    "- denied, unavailable, and provisioning_failed capabilities are unavailable. Do not probe around the decision.",
    "- enforced means an external boundary applies; brokered means the harness mediates access; advisory is a disclosed policy boundary rather than an OS sandbox.",
    "- Never request, expose, or persist raw credentials. Request additional optional authority by capability ID and explain the task-relevant need.",
  ].join("\n");
}

export interface PromptContext {
  agent: AgentId | ContestantId;
  stage: "implement" | "attack" | "repair";
  round?: RoundId;
  runSpec: RunSpec;
  config: FightConfig;
  permissions: PermissionPolicy;
  methodSelection?: MethodSelection;
  target?: ContestantId;
  opponentPatch?: string;
  reviewPacket?: Omit<AttackReviewArtifact, "reviewer" | "target">;
  evidence?: string;
  currentHealth?: number;
  priorOutcomes?: string;
  contestantFeedback?: ContestantFeedback;
}

export function composePrompt(context: PromptContext): string {
  const common = [
    "# Agent Arena role",
    `Agent: ${context.agent}`,
    `Stage: ${context.stage}`,
    "",
    "# Immutable run specification",
    JSON.stringify(context.runSpec, null, 2),
    "",
    `Required validation command: ${context.config.testCommand}`,
    `Time limit: ${String(context.config.limits[`${context.stage === "implement" ? "implementation" : context.stage}Ms`])} ms`,
    "",
    "# Arena and repository execution architecture",
    executionArchitecture(context, context.target),
    "",
    "# Available permissions and enforcement",
    permissionContext(context.permissions),
    "",
    "Edit only the assigned worktree. Do not commit. Do not access production credentials or unrelated files.",
    "Never request or print raw secrets; request capabilities by ID.",
    "The harness decides whether checks pass. State the expected behavior and why the frozen task text supports it; source ID and location are optional compatibility metadata.",
    "Write structured output to .agent-arena-submission.json using the schema in this prompt.",
  ];
  if (context.stage === "implement" || context.stage === "repair") {
    common.push(
      "",
      "# Submission schema",
      '{"version":1,"explanation":"concise summary"}',
    );
  } else {
    common.push(
      "",
      "# Submission schema",
      '{"version":1,"attacks":[{"rank":1,"claim":"...","impact":"...","oracle":{"expectedBehavior":"...","rationale":"Explain how the frozen task text supports this behavior"},"proposedSeverity":"high","confidence":90,"reproduction":"Public API call, concrete input, and expected observable result","requiredCapabilities":[]}]}',
      "Attack ranks must be unique and contiguous. Submit a precise failure description; do not create or edit test files or production code.",
      'Immediately write {"version":1,"attacks":[]} to .agent-arena-submission.json before doing any other work, so a bounded phase always has an explicit result.',
      "The assigned worktree contains the frozen target patch. Start from the review packet, inspect the cited code and nearby tests as needed, and describe a deterministic public reproducer. Do not restart broad repository review.",
      "A neutral case judge will independently write and execute any regression test. As soon as a defect is described, update the structured submission before investigating another. Leaving attacks: [] is the correct result when no reviewed finding reproduces.",
    );
  }
  if (context.round !== undefined) {
    common.push(
      "",
      `# Round ${String(context.round)} brief`,
      OVERLAYS[context.round],
      "",
      "# Deterministic method pack",
      JSON.stringify(context.methodSelection ?? {}, null, 2),
    );
    if (context.round === 3) {
      common.push(
        "",
        "# Approved integration topology",
        context.config.integrationProfile
          ? JSON.stringify(context.config.integrationProfile, null, 2)
          : "No integration profile is available. Use local contract, security, and resilience probes without a health event.",
      );
    }
  }
  if (context.opponentPatch)
    common.push("", "# Frozen opponent patch", context.opponentPatch);
  if (context.reviewPacket) {
    common.push(
      "",
      "# Compact target-specific review packet",
      JSON.stringify(context.reviewPacket, null, 2),
    );
  }
  if (context.evidence)
    common.push("", "# Validated evidence", context.evidence);
  if (context.currentHealth !== undefined) {
    common.push("", `Current health: ${String(context.currentHealth)} HP`);
  }
  if (context.priorOutcomes)
    common.push("", "# Prior outcomes", context.priorOutcomes);
  if (context.contestantFeedback)
    common.push(
      "",
      "# Lane-safe committed feedback",
      JSON.stringify(context.contestantFeedback, null, 2),
    );
  return `${common.join("\n")}\n`;
}

export function composeAttackReviewPrompt(
  context: Omit<PromptContext, "stage" | "reviewPacket" | "evidence"> & {
    opponentPatch: string;
    target: ContestantId;
  },
): string {
  const architectureContext = {
    ...context,
    stage: "attack" as const,
  };
  return `${[
    "# Agent Arena read-only attack review",
    `Reviewer slot: ${context.agent}`,
    `Target slot: ${context.target}`,
    "",
    "# Immutable run specification",
    JSON.stringify(context.runSpec, null, 2),
    "",
    `Required validation command: ${context.config.testCommand}`,
    `Time limit: ${String(context.config.limits.reviewMs)} ms`,
    "",
    "# Arena and repository execution architecture",
    executionArchitecture(
      architectureContext,
      context.target,
      "read_only_repository_review",
    ),
    "",
    "# Available permissions and enforcement",
    permissionContext(context.permissions),
    "",
    "# Public review rules",
    "Use this phase for repository-wide investigation of the frozen target implementation. Read the relevant architecture, source, tests, specifications, manifests, and repository instructions.",
    "Run existing tests and read-only diagnostic commands when useful and permitted. Do not implement production changes or executable attacks in this phase.",
    "Do not expose or infer provider identity. Do not include private implementation-generation transcripts or raw chain-of-thought.",
    "Return concise, independently derived findings grounded in observable behavior and the frozen run specification.",
    "Write only .agent-arena-submission.json. Any other worktree change invalidates the review artifact.",
    "",
    "# Submission schema",
    '{"version":1,"findings":[{"invariant":"...","codeLocation":"src/file.ts:42 or symbol","triggerSequence":["first event","second event"],"expectedBehavior":"...","confidence":85,"suggestedMinimalRegressionTest":"Add test/arena-... exercising ..."}]}',
    "Zero findings is valid. Rank findings by confidence and keep the packet compact (at most 12).",
    "",
    `# Round ${String(context.round)} review brief`,
    context.round === undefined ? "" : OVERLAYS[context.round],
    "",
    "# Deterministic method pack",
    JSON.stringify(context.methodSelection ?? {}, null, 2),
    ...(context.contestantFeedback
      ? [
          "",
          "# Lane-safe committed feedback",
          JSON.stringify(context.contestantFeedback, null, 2),
        ]
      : []),
    "",
    "# Frozen target patch",
    context.opponentPatch,
  ].join("\n")}\n`;
}

export function composeNeutralCasePrompt(input: {
  runSpec: RunSpec;
  permissions: PermissionPolicy;
  failure: AttackSubmission["attacks"][number];
  outputPath: string;
}): string {
  return `${[
    "# Neutral case judge",
    "Independently create one deterministic, test-only regression case for this anonymized failure description.",
    "Use only the immutable run specification and the public reproduction. Do not inspect either contestant patch, infer contestant identity, modify production code, or broaden the stated behavior.",
    "The harness will run your case against both frozen patches and separately adjudicate the oracle.",
    "",
    "# Immutable run specification",
    JSON.stringify(input.runSpec, null, 2),
    "",
    "# Available permissions and enforcement",
    permissionContext(input.permissions),
    "",
    "# Failure description",
    JSON.stringify(input.failure, null, 2),
    "",
    "Use only directly available capabilities that the failure description declares. Do not introduce a new capability or directly use a harness_only capability.",
    `Write {"version":1,"cases":[{"category":"boundary","focusedCommand":"...","paths":["test/..."],"requiredCapabilities":[]}]} to ${input.outputPath}. Return cases: [] only when the description cannot be turned into a clearly supported deterministic test.`,
  ].join("\n")}\n`;
}

export function createPromptManifest(
  round: RoundId,
  selection: MethodSelection,
  seed: string,
  renderedPromptPath: string,
  renderedPrompt: string,
): RoundPromptManifest {
  return {
    round,
    profile: selection.profile,
    commonPromptVersion: COMMON_VERSION,
    overlayPromptVersion: OVERLAY_VERSION[round],
    methodPackIds: selection.methodPackIds,
    probeCardIds: selection.probeCardIds,
    toolVersions: { "agent-arena": "0.1.0" },
    seed,
    renderedPromptPath,
    promptHash: sha256(renderedPrompt),
  };
}
