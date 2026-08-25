import { chmod, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { beforeAll, describe, expect, it } from "vitest";
import { createSlugRepository } from "../helpers/repository.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const cli = path.join(projectRoot, "dist", "cli.js");
const fixtureAgent = fileURLToPath(
  new URL("../fixtures/fake-agent.mjs", import.meta.url),
);

describe("built CLI smoke flow", () => {
  beforeAll(async () => {
    await execa("npm", ["run", "build"], { cwd: projectRoot });
  });

  it("runs a fight, reviews, accepts, applies, and retests without network", async () => {
    const repositoryRoot = await createSlugRepository();
    const bin = await mkdtemp(path.join(os.tmpdir(), "arena-fake-bin-"));
    for (const executable of ["codex", "claude"]) {
      const target = path.join(bin, executable);
      await writeFile(
        target,
        `#!/bin/sh\nexec "${process.execPath}" "${fixtureAgent}" "$@"\n`,
      );
      await chmod(target, 0o755);
    }
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    };
    const help = await execa(process.execPath, [cli, "--help"], {
      cwd: repositoryRoot,
      env,
    });
    expect(help.stdout).toContain("review");
    expect(help.stdout).toContain("defend");
    expect(help.stdout).toContain("resume");
    const fight = await execa(
      process.execPath,
      [
        cli,
        "fight",
        "Lowercase slugs, collapse whitespace, and reject blank titles.",
        "--test",
        "node --test",
        "--agents",
        "codex,claude",
        "--models",
        "codex-test-model,claude-test-model",
        "--yes",
        "--no-window",
      ],
      { cwd: repositoryRoot, env, timeout: 60_000 },
    );
    expect(fight.stdout).toContain("Agent Arena permission plan");
    expect(fight.stdout).toContain(
      "native_subprocess_execution: required, high risk, both, advisory",
    );
    expect(fight.stdout).toContain(
      "configured provider integrations, including MCP",
    );
    expect(fight.stdout).toContain(
      "Permission plan approved noninteractively via --yes.",
    );
    const runsRoot = path.join(repositoryRoot, ".agent-arena", "runs");
    const [runId] = await readdir(runsRoot);
    expect(runId).toBeTruthy();
    const result = JSON.parse(
      await readFile(path.join(runsRoot, runId!, "result.json"), "utf8"),
    ) as {
      schemaVersion: number;
      contestants: Array<{ id: string }>;
      appliedEnvelopes: Array<{ roundId: number | "recovery" }>;
      coverageAssessment?: {
        confidence: string;
        assessmentDigest: string;
      };
    };
    expect(result.schemaVersion).toBe(8);
    expect(result.contestants.map((contestant) => contestant.id)).toEqual([
      "a",
      "b",
    ]);
    expect(result.appliedEnvelopes.map((entry) => entry.roundId)).toEqual(
      expect.arrayContaining([1, 2, 3]),
    );
    const runSpec = JSON.parse(
      await readFile(path.join(runsRoot, runId!, "run-spec.json"), "utf8"),
    ) as { topology: { contestants: Array<{ model?: string }> } };
    expect(
      runSpec.topology.contestants.map((contestant) => contestant.model),
    ).toEqual(["codex-test-model", "claude-test-model"]);
    const resumed = await execa(
      process.execPath,
      [cli, "resume", runId!, "--display", "json"],
      { cwd: repositoryRoot, env },
    );
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      schemaVersion: 8,
      status: "complete",
    });
    expect(
      await readFile(path.join(runsRoot, runId!, "BATTLE.md"), "utf8"),
    ).toContain("Recommended patch");
    if (result.coverageAssessment?.confidence === "provisional") {
      await execa(
        process.execPath,
        [
          cli,
          "resolve-coverage",
          runId!,
          "--assessment-digest",
          result.coverageAssessment.assessmentDigest,
          "--decision",
          "accept-reduced",
        ],
        { cwd: repositoryRoot, env },
      );
    }
    const review = await execa(
      process.execPath,
      [cli, "review", runId!, "--json"],
      { cwd: repositoryRoot, env },
    );
    const prompt = JSON.parse(review.stdout) as {
      choices: Array<{
        contestantId: string;
        badges: string[];
        patchSha256: string;
      }>;
    };
    expect(prompt.choices).toHaveLength(2);
    const selected =
      prompt.choices.find((choice) => choice.badges.includes("recommended")) ??
      prompt.choices[0]!;
    await execa(
      process.execPath,
      [
        cli,
        "accept",
        runId!,
        "--agent",
        selected.contestantId,
        "--confirm-sha256",
        selected.patchSha256,
        "--apply",
      ],
      { cwd: repositoryRoot, env },
    );
    expect(
      (await execa("node", ["--test"], { cwd: repositoryRoot })).exitCode,
    ).toBe(0);
    const deliveryPlan = JSON.parse(
      (
        await execa(
          process.execPath,
          [cli, "deliver", runId!, "--plan", "--json"],
          { cwd: repositoryRoot, env },
        )
      ).stdout,
    ) as { patchSha256: string; availableActions: string[] };
    expect(deliveryPlan.patchSha256).toBe(selected.patchSha256);
    expect(deliveryPlan.availableActions).toContain("decide_later");
    await execa(
      process.execPath,
      [
        cli,
        "deliver",
        runId!,
        "--action",
        "decide_later",
        "--confirm-sha256",
        selected.patchSha256,
        "--idempotency-key",
        "smoke-delivery",
      ],
      { cwd: repositoryRoot, env },
    );
    const execution = JSON.parse(
      (
        await execa(
          process.execPath,
          [
            cli,
            "deliver",
            runId!,
            "--execute",
            "--idempotency-key",
            "smoke-delivery",
            "--json",
          ],
          { cwd: repositoryRoot, env },
        )
      ).stdout,
    ) as { operationId: string; status: string; terminalReason: string };
    expect(execution).toMatchObject({
      status: "pending",
      terminalReason: "Delivery remains pending.",
    });
    const deliveryStatus = JSON.parse(
      (
        await execa(
          process.execPath,
          [cli, "deliver", runId!, "--status", "--json"],
          { cwd: repositoryRoot, env },
        )
      ).stdout,
    ) as { operationId: string; status: string };
    expect(deliveryStatus).toMatchObject({
      operationId: execution.operationId,
      status: "pending",
    });
  }, 90_000);

  it("recovers provider transport with an exact frozen-input replacement", async () => {
    const repositoryRoot = await createSlugRepository();
    const bin = await mkdtemp(path.join(os.tmpdir(), "arena-recovery-bin-"));
    const marker = path.join(bin, "provider-recovered");
    await writeFile(
      path.join(bin, "codex"),
      `#!/bin/sh
if [ "$AGENT_ARENA_STAGE" = "provider_health_probe" ]; then
  : > "$AGENT_ARENA_TRANSPORT_MARKER"
fi
if [ "$AGENT_ARENA_STAGE" = "implement" ] && [ ! -f "$AGENT_ARENA_TRANSPORT_MARKER" ]; then
  echo "MCP OAuth authentication failed" >&2
  exit 8
fi
exec "${process.execPath}" "${fixtureAgent}" "$@"
`,
    );
    await writeFile(
      path.join(bin, "claude"),
      `#!/bin/sh
exec "${process.execPath}" "${fixtureAgent}" "$@"
`,
    );
    await Promise.all([
      chmod(path.join(bin, "codex"), 0o755),
      chmod(path.join(bin, "claude"), 0o755),
    ]);
    const result = await execa(
      process.execPath,
      [
        cli,
        "fight",
        "Lowercase slugs and collapse whitespace.",
        "--test",
        "node --test",
        "--agents",
        "codex,claude",
        "--yes",
        "--no-window",
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          AGENT_ARENA_TRANSPORT_MARKER: marker,
        },
        timeout: 90_000,
      },
    );

    const runsRoot = path.join(repositoryRoot, ".agent-arena", "runs");
    const runIds = await readdir(runsRoot);
    expect(runIds).toHaveLength(2);
    const summaries = await Promise.all(
      runIds.map(async (runId) => ({
        runId,
        value: JSON.parse(
          await readFile(path.join(runsRoot, runId, "result.json"), "utf8"),
        ) as {
          status: string;
          provenance: {
            parentRunId?: string;
            transportRestartOrdinal?: number;
          };
        },
      })),
    );
    const child = summaries.find((entry) => entry.value.provenance.parentRunId);
    expect(child?.value).toMatchObject({
      status: "complete",
      provenance: { transportRestartOrdinal: 1 },
    });
    const parentId = child?.value.provenance.parentRunId;
    expect(parentId).toBeTruthy();
    expect(result.stdout).toContain(
      `Run chain: ${parentId} -> ${child?.runId}`,
    );
    const recovery = JSON.parse(
      await readFile(
        path.join(runsRoot, parentId!, "transport-recovery.json"),
        "utf8",
      ),
    ) as { disposition: string; replacementRunId?: string };
    expect(recovery).toMatchObject({
      disposition: "provider_recovered",
      replacementRunId: child?.runId,
    });
    const specs = await Promise.all(
      [parentId!, child!.runId].map(
        async (runId) =>
          JSON.parse(
            await readFile(path.join(runsRoot, runId, "run-spec.json"), "utf8"),
          ) as {
            baseCommit: string;
            task: { task: string; sources: Array<{ contentHash: string }> };
            topology: unknown;
            commands: unknown;
            budgets: unknown;
            permissions: unknown;
          },
      ),
    );
    const parentSpec = specs[0];
    const childSpec = specs[1];
    if (!parentSpec || !childSpec)
      throw new Error("Replacement RunSpecs were not persisted");
    expect(childSpec).toMatchObject({
      baseCommit: parentSpec.baseCommit,
      topology: parentSpec.topology,
      commands: parentSpec.commands,
      budgets: parentSpec.budgets,
      permissions: parentSpec.permissions,
    });
    expect(childSpec.task.task).toBe(parentSpec.task.task);
    expect(childSpec.task.sources.map((source) => source.contentHash)).toEqual(
      parentSpec.task.sources.map((source) => source.contentHash),
    );
    const reconnaissance = await Promise.all(
      [parentId!, child!.runId].map(
        async (runId) =>
          JSON.parse(
            await readFile(
              path.join(runsRoot, runId, "reconnaissance.json"),
              "utf8",
            ),
          ) as {
            inputHash: string;
            sources: Array<{ contentHash: string }>;
          },
      ),
    );
    expect(reconnaissance[1]).toEqual(reconnaissance[0]);
  }, 120_000);

  it("retains validated implementations when round-one review recovery continues", async () => {
    const repositoryRoot = await createSlugRepository();
    const bin = await mkdtemp(
      path.join(os.tmpdir(), "arena-stage-recovery-bin-"),
    );
    const marker = path.join(bin, "provider-recovered");
    const implementationCount = path.join(bin, "implementation-count");
    await writeFile(
      path.join(bin, "codex"),
      `#!/bin/sh
if [ "$AGENT_ARENA_STAGE" = "provider_health_probe" ]; then
  : > "$AGENT_ARENA_TRANSPORT_MARKER"
fi
if [ "$AGENT_ARENA_STAGE" = "implement" ]; then
  printf '1\\n' >> "$AGENT_ARENA_IMPLEMENTATION_COUNT"
fi
if [ "$AGENT_ARENA_STAGE" = "review_attacks" ] && [ ! -f "$AGENT_ARENA_TRANSPORT_MARKER" ]; then
  echo "MCP OAuth authentication failed" >&2
  exit 8
fi
exec "${process.execPath}" "${fixtureAgent}" "$@"
`,
    );
    await writeFile(
      path.join(bin, "claude"),
      `#!/bin/sh
if [ "$AGENT_ARENA_STAGE" = "implement" ]; then
  printf '1\\n' >> "$AGENT_ARENA_IMPLEMENTATION_COUNT"
fi
exec "${process.execPath}" "${fixtureAgent}" "$@"
`,
    );
    await Promise.all([
      chmod(path.join(bin, "codex"), 0o755),
      chmod(path.join(bin, "claude"), 0o755),
    ]);

    const result = await execa(
      process.execPath,
      [
        cli,
        "fight",
        "Lowercase slugs and collapse whitespace.",
        "--test",
        "node --test",
        "--agents",
        "codex,claude",
        "--yes",
        "--no-window",
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          AGENT_ARENA_TRANSPORT_MARKER: marker,
          AGENT_ARENA_IMPLEMENTATION_COUNT: implementationCount,
        },
        timeout: 120_000,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(
      (await readFile(implementationCount, "utf8")).trim().split("\n"),
    ).toHaveLength(2);
    expect(
      await readdir(path.join(repositoryRoot, ".agent-arena", "runs")),
    ).toHaveLength(2);
  }, 150_000);

  it("becomes inconclusive after the second unrecovered coverage-stage failure", async () => {
    const repositoryRoot = await createSlugRepository();
    const bin = await mkdtemp(
      path.join(os.tmpdir(), "arena-exhausted-recovery-bin-"),
    );
    await writeFile(
      path.join(bin, "codex"),
      `#!/bin/sh
if [ "$AGENT_ARENA_STAGE" = "review_attacks" ]; then
  echo "MCP OAuth authentication failed" >&2
  exit 8
fi
exec "${process.execPath}" "${fixtureAgent}" "$@"
`,
    );
    await writeFile(
      path.join(bin, "claude"),
      `#!/bin/sh
exec "${process.execPath}" "${fixtureAgent}" "$@"
`,
    );
    await Promise.all([
      chmod(path.join(bin, "codex"), 0o755),
      chmod(path.join(bin, "claude"), 0o755),
    ]);

    const result = await execa(
      process.execPath,
      [
        cli,
        "fight",
        "Lowercase slugs and collapse whitespace.",
        "--test",
        "node --test",
        "--agents",
        "codex,claude",
        "--yes",
        "--no-window",
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        reject: false,
        timeout: 120_000,
      },
    );

    expect(result.exitCode).toBe(2);
    const runsRoot = path.join(repositoryRoot, ".agent-arena", "runs");
    const summaries = await Promise.all(
      (await readdir(runsRoot)).map(
        async (runId) =>
          JSON.parse(
            await readFile(path.join(runsRoot, runId, "result.json"), "utf8"),
          ) as { status: string; provenance: { parentRunId?: string } },
      ),
    );
    const child = summaries.find((entry) => entry.provenance.parentRunId);
    expect(child?.status).toBe("inconclusive");
  }, 150_000);
});
