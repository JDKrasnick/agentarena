import { sha256 } from "../core/ids.js";
import type {
  AgentId,
  ContestantId,
  FightConfig,
  PermissionPolicy,
  RoundId,
  RoundPromptManifest,
  TaskContract,
} from "../core/types.js";
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

export interface PromptContext {
  agent: AgentId | ContestantId;
  stage: "implement" | "attack" | "repair";
  round?: RoundId;
  contract: TaskContract;
  config: FightConfig;
  permissions: PermissionPolicy;
  methodSelection?: MethodSelection;
  opponentPatch?: string;
  evidence?: string;
  currentHealth?: number;
  priorOutcomes?: string;
}

export function composePrompt(context: PromptContext): string {
  const common = [
    "# Agent Arena role",
    `Agent: ${context.agent}`,
    `Stage: ${context.stage}`,
    "",
    "# Immutable task contract",
    JSON.stringify(context.contract, null, 2),
    "",
    `Required validation command: ${context.config.testCommand}`,
    `Time limit: ${String(context.config.limits[`${context.stage === "implement" ? "implementation" : context.stage}Ms`])} ms`,
    "",
    "# Capability manifest",
    JSON.stringify(context.permissions.capabilities, null, 2),
    "",
    "Edit only the assigned worktree. Do not commit. Do not access production credentials or unrelated files.",
    "Never request or print raw secrets; request capabilities by ID.",
    "The harness decides whether checks pass. Every expected value must cite a task-contract source.",
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
      '{"version":1,"hypotheses":[{"category":"contract_logic","invariant":"...","probe":"...","requiredCapabilities":[],"confidence":90}],"attacks":[{"rank":1,"claim":"...","impact":"...","oracle":{"expectedBehavior":"...","sourceId":"task-user","sourceLocation":"task text","rationale":"..."},"proposedSeverity":"high","confidence":90,"focusedCommand":"npm test -- test/file.test.ts","requiredCapabilities":[],"paths":["test/file.test.ts"]}]}',
      "Attack ranks must be unique and contiguous. Attacks cannot share paths. Production code changes are forbidden.",
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
  if (context.evidence)
    common.push("", "# Validated evidence", context.evidence);
  if (context.currentHealth !== undefined) {
    common.push("", `Current health: ${String(context.currentHealth)} HP`);
  }
  if (context.priorOutcomes)
    common.push("", "# Prior outcomes", context.priorOutcomes);
  return `${common.join("\n")}\n`;
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
