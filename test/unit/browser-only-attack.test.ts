import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { browserProbeEvidencePatch } from "../../src/attacks/submission.js";
import type { PriorAdjudicationContext } from "../../src/attacks/challenges.js";
import {
  validateAttack,
  validateSiegeAttack,
} from "../../src/attacks/validate.js";
import type { AttackVerifier } from "../../src/agents/adapter.js";
import {
  AttackSubmissionV2Schema,
  FightConfigSchema,
  type Attack,
  type CapabilityDecision,
  type FightConfig,
  type PermissionPolicy,
} from "../../src/core/types.js";
import type {
  BrowserProbeRequest,
  BrowserValidationResult,
} from "../../src/contracts/browser.js";
import { WorktreeManager } from "../../src/repo/git.js";
import { createSlugRepository } from "../helpers/repository.js";

type ValidateBrowser = (
  worktree: string,
  probe: BrowserProbeRequest,
  subject: "baseline" | "author" | "target",
  nativeSuiteIdentityPaths: string[],
) => Promise<BrowserValidationResult>;

function browserCapability(
  overrides: Partial<CapabilityDecision> = {},
): PermissionPolicy {
  return {
    defaultMode: "confirm",
    reducedValidationAccepted: false,
    capabilities: [
      {
        id: "browser_dom_validation",
        reason: "Browser comparison",
        risk: "medium",
        requirement: "required",
        role: "harness_only",
        enforcement: "brokered",
        mode: "confirm",
        scopes: [],
        status: "approved",
        ...overrides,
      },
    ],
  };
}

/** Author passes, target fails, attributed to the contestant application. */
const symmetricReproduction: ValidateBrowser = (_worktree, probe, subject) =>
  Promise.resolve({
    status: subject === "author" ? "verified" : "failed",
    provisionAttempts: 1,
    probes: [
      {
        probeId: probe.id,
        family: probe.family,
        profile: probe.profile,
        status: subject === "author" ? "verified" : "failed",
        contextId: `${subject}-${probe.id}`,
        requiredCapabilityIds: ["browser_dom_validation"],
        blockedOrigins: [],
        artifacts: [],
      },
    ],
    artifacts: [
      {
        kind: "result_manifest",
        path: `/artifacts/${subject}-result.json`,
        failureOnly: false,
      },
    ],
    ...(subject === "target"
      ? {
          reason: "application_failure" as const,
          failureAttribution: "contestant_application" as const,
        }
      : {}),
  });

describe("browser-only attacks", () => {
  let temporaryRoot: string;
  let worktrees: WorktreeManager;
  let authorPatch: string;
  let targetPatch: string;
  let probePatch: string;
  let config: FightConfig;
  let attack: Attack;
  let verifier: AttackVerifier;

  beforeAll(async () => {
    const repositoryRoot = await createSlugRepository();
    const baseCommit = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
    ).stdout;
    temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "arena-browser-only-"),
    );
    worktrees = new WorktreeManager(repositoryRoot, temporaryRoot, baseCommit);
    await worktrees.initialize();

    const patches: string[] = [];
    for (const lane of ["author", "target"] as const) {
      const tree = await worktrees.create(lane);
      const relativePath = `src/${lane}.txt`;
      await mkdir(path.dirname(path.join(tree, relativePath)), {
        recursive: true,
      });
      await writeFile(path.join(tree, relativePath), `${lane}\n`);
      const patchPath = path.join(temporaryRoot, `${lane}.diff`);
      await worktrees.capturePatch(tree, patchPath, undefined, true);
      patches.push(patchPath);
    }
    [authorPatch, targetPatch] = patches as [string, string];

    const evidenceEntry = AttackSubmissionV2Schema.parse({
      version: 2,
      attacks: [
        {
          rank: 1,
          claim: "The settings dialog does not open",
          impact: "The user cannot change settings",
          oracle: {
            expectedBehavior: "The settings dialog opens",
            rationale: "The task explicitly requires the dialog",
          },
          proposedSeverity: "medium",
          confidence: 90,
          reproduction: "Open the settings dialog in the browser",
          requiredCapabilities: ["browser_dom_validation"],
          browserProbe: {
            id: "settings-dialog",
            family: "interaction",
            profile: "desktop",
            expectedBehavior: "The settings dialog opens",
            actions: [{ kind: "goto", path: "/" }],
          },
        },
      ],
    }).attacks[0]!;
    probePatch = path.join(temporaryRoot, "probe.diff");
    await writeFile(
      probePatch,
      browserProbeEvidencePatch(evidenceEntry, 1, "a"),
    );

    config = FightConfigSchema.parse({
      task: "Fix the dialog",
      agents: ["codex", "claude"],
      attackVerifier: "codex",
      rounds: 3,
      maxAttacksPerRound: 3,
      testCommand: "npm test",
      repositoryRoot,
      artifactRoot: path.join(repositoryRoot, ".agent-arena", "runs"),
      permissionMode: "confirm",
      nonInteractiveApproval: true,
      limits: {
        implementationMs: 10_000,
        reviewMs: 10_000,
        attackMs: 10_000,
        verifierMs: 10_000,
        repairMs: 10_000,
      },
    });

    attack = {
      id: "browser-only-dialog",
      round: 1,
      origin: { kind: "contestant", contestant: "a", provider: "codex" },
      rank: 1,
      targets: ["b"],
      claim: "The settings dialog does not open",
      impact: "The user cannot change settings",
      oracle: {
        expectedBehavior: "The settings dialog opens",
        rationale: "The task explicitly requires the dialog",
      },
      assertionFingerprint: "settings-dialog-opens",
      requiredCapabilities: ["browser_dom_validation"],
      patchPath: probePatch,
      focusedCommand: 'node -e "process.exit(0)"',
      evidenceKind: "browser_probe",
      browserProbe: evidenceEntry.browserProbe,
      status: "submitted",
      proposedSeverity: "medium",
      checks: [],
    };

    verifier = {
      id: "codex",
      assess: () =>
        Promise.resolve({
          relevant: true,
          oracleSupported: true,
          oracleRationale: "The behavior is explicit",
          rootDefectId: "settings-dialog",
          severity: "medium",
          rationale: "The comparative browser evidence is deterministic",
        }),
    };
  });

  afterAll(async () => {
    await worktrees.cleanup();
  });

  function validate(options: {
    id: string;
    validateBrowser: ValidateBrowser;
    permissionPolicy?: PermissionPolicy;
    verifier?: AttackVerifier;
    attack?: Partial<Attack>;
    priorAdjudications?: readonly PriorAdjudicationContext[];
  }) {
    return validateAttack({
      attack: { ...attack, ...options.attack, id: options.id, checks: [] },
      authorPatch,
      targetPatch,
      runSpec: {} as never,
      permissionPolicy: options.permissionPolicy ?? browserCapability(),
      config,
      worktrees,
      verifier: options.verifier ?? verifier,
      validateBrowser: options.validateBrowser,
      logRoot: path.join(temporaryRoot, `${options.id}-logs`),
      signal: new AbortController().signal,
      knownRootDefects: new Set(),
      priorAdjudications: options.priorAdjudications ?? [],
    });
  }

  function validateSiege(options: {
    id: string;
    validateBrowser: ValidateBrowser;
    permissionPolicy?: PermissionPolicy;
    verifier?: AttackVerifier;
    attack?: Partial<Attack>;
    priorAdjudications?: readonly PriorAdjudicationContext[];
  }) {
    return validateSiegeAttack({
      attack: { ...attack, ...options.attack, id: options.id, checks: [] },
      targetPatch,
      runSpec: {} as never,
      permissionPolicy: options.permissionPolicy ?? browserCapability(),
      config,
      worktrees,
      verifier: options.verifier ?? verifier,
      validateBrowser: options.validateBrowser,
      logRoot: path.join(temporaryRoot, `${options.id}-logs`),
      signal: new AbortController().signal,
      knownRootDefects: new Set(),
      priorAdjudications: options.priorAdjudications ?? [],
    });
  }

  const priorAdjudication: PriorAdjudicationContext = {
    adjudicationId: "adjudication:prior-dialog",
    attackId: "prior-dialog",
    round: 1,
    target: "b",
    claim: "The settings dialog does not open",
    expectedBehavior: "The settings dialog opens",
    oracle: {
      expectedBehavior: "The settings dialog opens",
      rationale: "The task explicitly requires the dialog",
    },
    verdict: "rejected",
    rationale: "The earlier evidence was insufficient",
    scoreEffect: "recoil",
    exactAmount: 5,
  };

  it("lands after a symmetric author pass and target failure", async () => {
    const validateBrowser = vi.fn(symmetricReproduction);

    const result = await validate({
      id: "browser-only-dialog",
      validateBrowser,
    });

    expect(result.status).toBe("landed");
    expect(result.evidenceKind).toBe("browser_probe");
    expect(validateBrowser).toHaveBeenCalledTimes(2);
  });

  it("retries an invalid inferred relationship and retains the valid link", async () => {
    const assess = vi
      .fn<AttackVerifier["assess"]>()
      .mockResolvedValueOnce({
        relevant: true,
        oracleSupported: true,
        oracleRationale: "The behavior is explicit",
        rootDefectId: "settings-dialog",
        severity: "medium",
        rationale: "Invalid first relationship",
        relationship: "overturn",
        priorAdjudicationId: "missing-adjudication",
      })
      .mockResolvedValueOnce({
        relevant: true,
        oracleSupported: true,
        oracleRationale: "The behavior is explicit",
        rootDefectId: "settings-dialog",
        severity: "medium",
        rationale: "The prior rejection is affirmed",
        relationship: "affirm",
        priorAdjudicationId: priorAdjudication.adjudicationId,
      });

    const result = await validate({
      id: "browser-only-inferred-challenge",
      validateBrowser: symmetricReproduction,
      verifier: { id: "codex", assess },
      priorAdjudications: [priorAdjudication],
    });

    expect(assess).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      challengeRelationship: "affirm",
      relatedAdjudicationId: priorAdjudication.adjudicationId,
    });
  });

  it("retains explicit challenge relationships in siege assessment", async () => {
    const result = await validateSiege({
      id: "siege-browser-explicit-challenge",
      attack: {
        challengeAdjudicationId: priorAdjudication.adjudicationId,
      },
      validateBrowser: (_worktree, probe, subject) =>
        Promise.resolve({
          status: subject === "baseline" ? "verified" : "failed",
          provisionAttempts: 1,
          probes: [
            {
              probeId: probe.id,
              family: probe.family,
              profile: probe.profile,
              status: subject === "baseline" ? "verified" : "failed",
              contextId: `${subject}-${probe.id}`,
              requiredCapabilityIds: ["browser_dom_validation"],
              blockedOrigins: [],
              artifacts: [],
            },
          ],
          artifacts: [],
          ...(subject === "target"
            ? {
                reason: "application_failure" as const,
                failureAttribution: "contestant_application" as const,
              }
            : {}),
        }),
      verifier: {
        id: "codex",
        assess: () =>
          Promise.resolve({
            relevant: true,
            oracleSupported: true,
            oracleRationale: "The behavior is explicit",
            rootDefectId: "settings-dialog",
            severity: "medium",
            rationale: "The earlier decision is affirmed",
            relationship: "affirm",
            priorAdjudicationId: priorAdjudication.adjudicationId,
          }),
      },
      priorAdjudications: [priorAdjudication],
    });

    expect(result).toMatchObject({
      challengeRelationship: "affirm",
      relatedAdjudicationId: priorAdjudication.adjudicationId,
    });
  });

  it("runs no focused command when the probe is the only evidence", async () => {
    const result = await validate({
      id: "browser-only-no-focused-command",
      validateBrowser: symmetricReproduction,
    });

    expect(result.checks.filter((check) => check.kind === "focused")).toEqual(
      [],
    );
    expect(result.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining(["author-browser-probe", "target-browser-probe"]),
    );
  });

  it("retains both lanes' result manifests as artifact references", async () => {
    const result = await validate({
      id: "browser-only-artifacts",
      validateBrowser: symmetricReproduction,
    });

    expect(result.browserArtifactRefs).toEqual([
      "/artifacts/author-result.json",
      "/artifacts/target-result.json",
    ]);
  });

  it("ignores an unrelated smoke-probe failure on the target", async () => {
    // The selected probe passes on both lanes; only a mandatory smoke probe
    // fails on the target, which is not the reproduction this attack claims.
    const result = await validate({
      id: "browser-only-unrelated",
      validateBrowser: (_worktree, probe, subject) =>
        Promise.resolve({
          status: subject === "target" ? "failed" : "verified",
          provisionAttempts: 1,
          probes: [
            {
              probeId: probe.id,
              family: probe.family,
              profile: probe.profile,
              status: "verified",
              contextId: `${subject}-${probe.id}-pass`,
              requiredCapabilityIds: ["browser_dom_validation"],
              blockedOrigins: [],
              artifacts: [],
            },
            ...(subject === "target"
              ? [
                  {
                    probeId: "arena-reflow-smoke",
                    family: "responsive" as const,
                    profile: "reflow_320" as const,
                    status: "failed" as const,
                    contextId: "target-unrelated-smoke",
                    requiredCapabilityIds: ["browser_dom_validation" as const],
                    reason: "application_failure" as const,
                    blockedOrigins: [],
                    artifacts: [],
                  },
                ]
              : []),
          ],
          artifacts: [],
          ...(subject === "target"
            ? {
                reason: "application_failure" as const,
                failureAttribution: "contestant_application" as const,
              }
            : {}),
        }),
    });

    expect(result.status).toBe("blocked");
  });

  it("stays score-neutral when the failure cannot be attributed", async () => {
    const assess = vi.fn().mockResolvedValue({
      relevant: true,
      oracleSupported: true,
      oracleRationale: "The behavior is explicit",
      rootDefectId: "settings-dialog",
      severity: "medium" as const,
      rationale: "The comparative browser evidence is deterministic",
    });

    const result = await validate({
      id: "browser-only-unattributed",
      verifier: { id: "codex", assess },
      permissionPolicy: browserCapability({ requirement: "optional" }),
      validateBrowser: (_worktree, probe, subject) =>
        Promise.resolve({
          status: subject === "author" ? "verified" : "failed",
          provisionAttempts: 1,
          probes: [
            {
              probeId: probe.id,
              family: probe.family,
              profile: probe.profile,
              status: subject === "author" ? "verified" : "failed",
              ...(subject === "target"
                ? { reason: "application_failure" as const }
                : {}),
              contextId: `${subject}-unattributed`,
              requiredCapabilityIds: ["browser_dom_validation"],
              blockedOrigins: [],
              artifacts: [],
            },
          ],
          artifacts: [],
          ...(subject === "target"
            ? {
                reason: "application_failure" as const,
                failureAttribution: "unattributed" as const,
              }
            : {}),
        }),
    });

    expect(result.status).toBe("execution_inconclusive");
    expect(result.damage).toBeUndefined();
    expect(assess).not.toHaveBeenCalled();
  });

  it("stays score-neutral when the browser lane times out", async () => {
    const adjudicate = vi.fn().mockResolvedValue({
      decision: "confirmed" as const,
      relevant: true,
      expectedBehaviorClearlySupported: true,
      evidencePointsToDefect: true,
      rootDefectId: "settings-dialog",
      severity: "medium" as const,
      rationale: "The task supports the behavior",
    });

    const result = await validate({
      id: "browser-only-timeout",
      verifier: { ...verifier, adjudicate },
      validateBrowser: (_worktree, probe, subject) =>
        Promise.resolve({
          status: "unverified",
          provisionAttempts: 2,
          reason: "timed_out",
          probes: [
            {
              probeId: probe.id,
              family: probe.family,
              profile: probe.profile,
              status: "unverified",
              reason: "timed_out",
              contextId: `${subject}-unverified`,
              requiredCapabilityIds: ["browser_dom_validation"],
              blockedOrigins: [],
              artifacts: [],
            },
          ],
          artifacts: [],
          failureAttribution: "harness_transport",
        }),
    });

    expect(result.status).toBe("execution_inconclusive");
    expect(result.damage).toBeUndefined();
    expect(adjudicate).not.toHaveBeenCalled();
  });

  it("reports a capability gap without running the browser lane", async () => {
    const validateBrowser = vi.fn(symmetricReproduction);

    const result = await validate({
      id: "browser-only-capability-gap",
      validateBrowser,
      permissionPolicy: {
        ...browserCapability({ status: "provisioning_failed" }),
        reducedValidationAccepted: true,
      },
    });

    expect(result).toMatchObject({
      status: "capability_denied",
      outcomeReason: "Capability browser_dom_validation is provisioning_failed",
    });
    expect(validateBrowser).not.toHaveBeenCalled();
  });

  it("lands a siege browser probe against the defender even when the base lacks the feature", async () => {
    const validateBrowser = vi.fn<ValidateBrowser>(
      (_worktree, probe, subject) =>
        Promise.resolve({
          status: "failed",
          provisionAttempts: 1,
          probes: [
            {
              probeId: probe.id,
              family: probe.family,
              profile: probe.profile,
              status: "failed",
              contextId: `${subject}-${probe.id}`,
              requiredCapabilityIds: ["browser_dom_validation"],
              reason: "application_failure",
              blockedOrigins: [],
              artifacts: [],
            },
          ],
          artifacts: [
            {
              kind: "result_manifest",
              path: `/artifacts/${subject}-result.json`,
              failureOnly: false,
            },
          ],
          reason: "application_failure",
          failureAttribution: "contestant_application",
        }),
    );

    const result = await validateSiege({
      id: "siege-browser-defender-failure",
      validateBrowser,
    });

    expect(result).toMatchObject({
      status: "landed",
      evidenceKind: "browser_probe",
      rootDefectId: "settings-dialog",
    });
    expect(result.outcomeReason).not.toContain("house attack");
    expect(result.checks.filter((check) => check.kind === "focused")).toEqual(
      [],
    );
    expect(result.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        "baseline-browser-probe",
        "target-browser-probe",
      ]),
    );
    expect(result.browserArtifactRefs).toEqual([
      "/artifacts/baseline-result.json",
      "/artifacts/target-result.json",
    ]);
    expect(validateBrowser.mock.calls.map((call) => call[2])).toEqual([
      "baseline",
      "target",
    ]);
  });

  it("blocks a siege browser attack when the defender passes the selected probe", async () => {
    const result = await validateSiege({
      id: "siege-browser-defender-pass",
      validateBrowser: (_worktree, probe, subject) =>
        Promise.resolve({
          status: subject === "baseline" ? "failed" : "verified",
          provisionAttempts: 1,
          probes: [
            {
              probeId: probe.id,
              family: probe.family,
              profile: probe.profile,
              status: subject === "baseline" ? "failed" : "verified",
              contextId: `${subject}-${probe.id}`,
              requiredCapabilityIds: ["browser_dom_validation"],
              blockedOrigins: [],
              artifacts: [],
            },
          ],
          artifacts: [],
          ...(subject === "baseline"
            ? {
                reason: "application_failure" as const,
                failureAttribution: "contestant_application" as const,
              }
            : {}),
        }),
    });

    expect(result).toMatchObject({
      status: "blocked",
      outcomeReason: "Defender patch passes the agent-chosen browser probe",
    });
  });

  it("keeps siege browser infrastructure failures score-neutral", async () => {
    const assess = vi.fn((input: Parameters<AttackVerifier["assess"]>[0]) =>
      verifier.assess(input),
    );
    const result = await validateSiege({
      id: "siege-browser-unverified",
      verifier: { ...verifier, assess },
      validateBrowser: (_worktree, probe, subject) =>
        Promise.resolve({
          status: "unverified",
          provisionAttempts: 2,
          reason: "health_failure",
          probes: [
            {
              probeId: probe.id,
              family: probe.family,
              profile: probe.profile,
              status: "unverified",
              reason: "health_failure",
              contextId: `${subject}-${probe.id}`,
              requiredCapabilityIds: ["browser_dom_validation"],
              blockedOrigins: [],
              artifacts: [],
            },
          ],
          artifacts: [],
          failureAttribution: "harness_transport",
        }),
    });

    expect(result.status).toBe("execution_inconclusive");
    expect(result.damage).toBeUndefined();
    expect(assess).not.toHaveBeenCalled();
  });

  it("does not invoke siege browser mechanics when the capability is unavailable", async () => {
    const validateBrowser = vi.fn(symmetricReproduction);
    const result = await validateSiege({
      id: "siege-browser-capability-gap",
      validateBrowser,
      permissionPolicy: {
        ...browserCapability({ status: "provisioning_failed" }),
        reducedValidationAccepted: true,
      },
    });

    expect(result.status).toBe("capability_denied");
    expect(result.damage).toBeUndefined();
    expect(validateBrowser).not.toHaveBeenCalled();
  });
});
