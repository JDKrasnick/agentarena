import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LifecycleLedger,
  PauseReplanManifestSchema,
  runPauseReplanEvaluation,
} from "../../src/evaluation/pause-replan.js";
import type {
  PauseReplanConditionResult,
  PauseReplanRunner,
  PauseReplanRunInput,
} from "../../src/evaluation/pause-replan-runner.js";
import { createPauseReplanRunner } from "../../src/evaluation/pause-replan-runner.js";

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execa("git", args, { cwd })).stdout.trim();
}

function manifest(phase: "transport_gate" | "full") {
  return {
    version: 2,
    evaluation_id: "pause-replan-integration",
    seed: 17,
    mode: "fake",
    phase,
    models: [
      {
        provider: "claude",
        requested_model: "sonnet",
        conditions: ["telemetry_only", "passive_warning", "checkpoint"],
      },
      {
        provider: "codex",
        requested_model: "gpt-5.6-sol",
        conditions: ["telemetry_only", "checkpoint"],
      },
    ],
    scenarios: Array.from({ length: 12 }, (_, index) => ({
      id: `scenario-${String(index)}`,
      source_run_id: `source-${String(index)}`,
      lane: "a-to-b",
      repository_root: "/unused/by-injected-runner",
      base_commit: "1".repeat(40),
      target_patch: { path: "target.diff", sha256: "2".repeat(64) },
      packet: { findings: [{ finding_id: "finding-1" }] },
      packet_digest: "3".repeat(64),
      active_finding_id: "finding-1",
      trusted_paths: ["src/value.ts", "test/value.test.ts"],
      validation_command: "true",
      attack_prompt: "Create a focused attack.",
    })),
    transport_gate_scenario_ids: [
      "scenario-0",
      "scenario-1",
      "scenario-2",
      "scenario-3",
    ],
    limits: {
      duration_ms: 360_000,
      tool_calls: 100,
      checkpoint_lease_calls: 5,
      checkpoint_lease_files: 2,
      aggregate_cost_usd: 40,
      maximum_condition_cost_usd: 0.25,
    },
    rate_card: [
      {
        provider: "claude",
        model: "sonnet",
        input_usd_per_million: 3,
        output_usd_per_million: 15,
      },
      {
        provider: "codex",
        model: "gpt-5.6-sol",
        input_usd_per_million: 2,
        output_usd_per_million: 8,
      },
    ],
  };
}

function conditionResult(
  input: PauseReplanRunInput,
): PauseReplanConditionResult {
  const ledger = new LifecycleLedger({
    provider: input.provider,
    requestedModel: input.requestedModel,
    providerModel: input.requestedModel,
    condition: input.condition,
  });
  if (input.condition === "checkpoint") {
    ledger.record("drift_detected", "broad");
    ledger.record("interrupt_requested", "broad");
    ledger.record("interrupt_completed", "broad", {
      checkpoint_id: "checkpoint-1",
    });
    ledger.record("checkpoint_started", "trusted", {
      checkpoint_id: "checkpoint-1",
    });
    ledger.record("checkpoint_acknowledged", "trusted", {
      checkpoint_id: "checkpoint-1",
    });
    ledger.record("decision_recorded", "trusted", {
      checkpoint_id: "checkpoint-1",
      decision: "return_to_scope",
    });
    ledger.record("continuation_started", "trusted", {
      checkpoint_id: "checkpoint-1",
    });
    ledger.record("post_checkpoint_action", "trusted", {
      checkpoint_id: "checkpoint-1",
    });
  }
  ledger.record("credible_test_created", "trusted");
  ledger.record("attack_accepted", "trusted");
  ledger.record("attack_landed", "trusted");
  ledger.record("terminal", "unknown", { terminal_reason: "usable" });
  return {
    lifecycle: ledger.events,
    durationMs: 1_000,
    toolCalls: 20,
    firstBroadCall: 2,
    firstExecutableTestCall: input.condition === "checkpoint" ? 12 : 18,
    outcome: "usable",
    acceptedAttacks: 1,
    landedAttacks: 1,
    providerModel: input.requestedModel,
    cliVersion: `fake-${input.provider}-1.0`,
    inputTokens: 100,
    outputTokens: 20,
    infrastructureFailure: false,
    passiveWarningDelivery:
      input.condition === "passive_warning" ? "attempted" : "not_applicable",
    protocolChecks: {
      completeOrdering: true,
      modelVersionStable: true,
      noRepositoryActionBeforeAcknowledgement: true,
      checkpointWithoutRepositoryAccess: true,
      validStructuredDecision: true,
      continuationAfterDecision: true,
      leaseCountingAndPathsEnforced: true,
      cleanupComplete: true,
      noSurvivingChildProcess: true,
      noLeakedWorktree: true,
      sourceImmutable: true,
    },
  };
}

function runner(
  mutate?: (
    input: PauseReplanRunInput,
    result: PauseReplanConditionResult,
  ) => void,
): PauseReplanRunner {
  return {
    runCondition: (input) => {
      const result = conditionResult(input);
      mutate?.(input, result);
      return Promise.resolve(result);
    },
    cleanup: () => Promise.resolve(),
  };
}

describe("pause–replan evaluation orchestration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("runs the eight-session gate, then permits exactly sixty full conditions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-pause-replan-"));
    const gateManifest = path.join(root, "gate.json");
    const fullManifest = path.join(root, "full.json");
    await writeFile(gateManifest, JSON.stringify(manifest("transport_gate")));
    await writeFile(fullManifest, JSON.stringify(manifest("full")));

    await expect(
      runPauseReplanEvaluation(gateManifest, { cwd: root }),
    ).rejects.toThrow(/injected test runner/u);

    const gate = await runPauseReplanEvaluation(gateManifest, {
      cwd: root,
      runner: runner(),
    });
    expect(gate.result.measurements).toHaveLength(8);
    expect(gate.result.transport_gate.status).toBe("Protocol passed");

    const full = await runPauseReplanEvaluation(fullManifest, {
      cwd: root,
      gateArtifactPath: path.join(gate.outputPath, "evaluation.json"),
      runner: runner(),
    });
    expect(full.result.measurements).toHaveLength(60);
    expect(
      full.result.measurements.filter((value) => value.provider === "claude"),
    ).toHaveLength(36);
    expect(
      full.result.measurements.filter((value) => value.provider === "codex"),
    ).toHaveLength(24);
    expect(full.result.total_estimated_cost_usd).toBeGreaterThan(0);
    const persisted = await readFile(
      path.join(full.outputPath, "evaluation.json"),
      "utf8",
    );
    expect(persisted).not.toContain("Create a focused attack.");
    expect(persisted).not.toContain('"packet":');
    expect(persisted).toContain('"attack_prompt_sha256"');
    expect(
      await readFile(path.join(full.outputPath, "SUMMARY.html"), "utf8"),
    ).not.toMatch(/https?:\/\//u);
  });

  it("stops a failed protocol gate before a full run can spend budget", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-gate-failure-"));
    const gateManifest = path.join(root, "gate.json");
    const fullManifest = path.join(root, "full.json");
    await writeFile(gateManifest, JSON.stringify(manifest("transport_gate")));
    await writeFile(fullManifest, JSON.stringify(manifest("full")));
    const gate = await runPauseReplanEvaluation(gateManifest, {
      cwd: root,
      runner: runner((input, result) => {
        if (input.provider === "codex" && input.scenario.id === "scenario-0")
          result.protocolChecks.cleanupComplete = false;
      }),
    });
    expect(gate.result.transport_gate.status).toBe("Protocol failed");
    await expect(
      runPauseReplanEvaluation(fullManifest, {
        cwd: root,
        gateArtifactPath: path.join(gate.outputPath, "evaluation.json"),
        runner: runner(),
      }),
    ).rejects.toThrow(/passing gate/u);
  });

  it("retries one model-version drift and excludes a repeated mismatch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-model-drift-"));
    const gateManifest = path.join(root, "gate.json");
    const fullManifest = path.join(root, "full.json");
    await writeFile(gateManifest, JSON.stringify(manifest("transport_gate")));
    await writeFile(fullManifest, JSON.stringify(manifest("full")));
    const gate = await runPauseReplanEvaluation(gateManifest, {
      cwd: root,
      runner: runner(),
    });
    const evaluation = await runPauseReplanEvaluation(fullManifest, {
      cwd: root,
      gateArtifactPath: path.join(gate.outputPath, "evaluation.json"),
      runner: runner((input, result) => {
        if (
          input.provider === "claude" &&
          input.scenario.id === "scenario-0" &&
          input.condition === "telemetry_only"
        )
          result.providerModel = `changed-attempt-${String(input.attempt)}`;
      }),
    });
    const repeated = evaluation.result.measurements.filter(
      (measurement) =>
        measurement.provider === "claude" &&
        measurement.scenario_id === "scenario-0",
    );
    expect(repeated).toHaveLength(3);
    expect(repeated.every((value) => value.attempt === 2)).toBe(true);
    expect(
      repeated.every(
        (value) => value.protocol_checks.modelVersionStable === false,
      ),
    ).toBe(true);
  });

  it("interrupts fake Claude and Codex process groups and compact-restarts both", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-fake-providers-"));
    const repository = path.join(root, "repository");
    const bin = path.join(root, "bin");
    const output = path.join(root, "output");
    await mkdir(path.join(repository, "src"), { recursive: true });
    await mkdir(path.join(repository, "test"), { recursive: true });
    await mkdir(bin);
    await mkdir(output);
    await git(repository, ["init", "-q"]);
    await git(repository, ["config", "user.email", "arena@example.test"]);
    await git(repository, ["config", "user.name", "Arena Test"]);
    await writeFile(
      path.join(repository, "src", "value.ts"),
      "export const value = 1;\n",
    );
    await writeFile(
      path.join(repository, "test", "value.test.ts"),
      "// frozen test\n",
    );
    await git(repository, ["add", "."]);
    await git(repository, ["commit", "-qm", "base"]);
    const baseCommit = await git(repository, ["rev-parse", "HEAD"]);
    await writeFile(
      path.join(repository, "src", "value.ts"),
      "export const value = 2;\n",
    );
    const patchText = (
      await execa("git", ["diff", "--binary"], { cwd: repository })
    ).stdout;
    const patchPath = path.join(repository, "target.diff");
    await writeFile(patchPath, `${patchText}\n`);
    await writeFile(
      path.join(repository, "src", "value.ts"),
      "export const value = 1;\n",
    );
    const { createHash } = await import("node:crypto");
    const patchSha = createHash("sha256")
      .update(await readFile(patchPath))
      .digest("hex");
    const fakeProvider = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";
const provider = path.basename(process.argv[1]);
if (process.argv.includes("--version")) { console.log("fake-" + provider + " 1.0"); process.exit(0); }
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { prompt += chunk; });
process.stdin.on("end", () => {
  const model = provider === "claude" ? "sonnet" : "gpt-5.6-sol";
  const emit = value => console.log(JSON.stringify(value));
  const tool = (name, input) => provider === "claude"
    ? {type:"assistant",model,message:{content:[{type:"tool_use",name,input}]}}
    : {type:"item.completed",model,item:{type:"mcp_tool_call",tool:name,arguments:input}};
  if (process.env.AGENT_ARENA_CHECKPOINT_DECISION) {
    writeFileSync(process.env.AGENT_ARENA_CHECKPOINT_DECISION, JSON.stringify({version:1,decision:"return_to_scope",hypothesis:"Test the selected finding only."}));
    emit(provider === "claude" ? {type:"result",model,usage:{input_tokens:5,output_tokens:2}} : {type:"turn.completed",model,usage:{input_tokens:5,output_tokens:2}});
    process.exit(0);
  }
  if (prompt.includes("Checkpoint decision acknowledged")) {
    emit(tool("Edit", {file_path:"test/value.test.ts"}));
    writeFileSync(process.env.AGENT_ARENA_SUBMISSION, JSON.stringify({version:2,sharedSupportPaths:[],attacks:[]}));
    emit(provider === "claude" ? {type:"result",model,usage:{input_tokens:8,output_tokens:3}} : {type:"turn.completed",model,usage:{input_tokens:8,output_tokens:3}});
    process.exit(0);
  }
  emit(tool("Grep", {path:".",recursive:true}));
  setInterval(() => {}, 1000);
});
`;
    for (const provider of ["claude", "codex"]) {
      const executable = path.join(bin, provider);
      await writeFile(executable, fakeProvider);
      await chmod(executable, 0o755);
    }
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    const parsed = PauseReplanManifestSchema.parse({
      ...manifest("transport_gate"),
      scenarios: manifest("transport_gate").scenarios.map((scenario) => ({
        ...scenario,
        repository_root: repository,
        base_commit: baseCommit,
        target_patch: { path: "target.diff", sha256: patchSha },
      })),
    });
    const defaultRunner = createPauseReplanRunner(output);
    for (const provider of ["claude", "codex"] as const) {
      const result = await defaultRunner.runCondition({
        manifest: parsed,
        scenario: parsed.scenarios[0]!,
        provider,
        requestedModel: provider === "claude" ? "sonnet" : "gpt-5.6-sol",
        condition: "checkpoint",
        attempt: 1,
      });
      expect(result.infrastructureFailure).toBe(false);
      expect(result.outcome).toBe("empty");
      expect(result.lifecycle.map((event) => event.kind)).toEqual(
        expect.arrayContaining([
          "drift_detected",
          "interrupt_completed",
          "checkpoint_acknowledged",
          "continuation_started",
          "credible_test_created",
          "terminal",
        ]),
      );
      expect(result.providerModel).toBe(
        provider === "claude" ? "sonnet" : "gpt-5.6-sol",
      );
    }
    await defaultRunner.cleanup();
    expect(await git(repository, ["status", "--short"])).toBe("?? target.diff");
  }, 30_000);
});
