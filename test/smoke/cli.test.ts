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
    await execa(
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
      ],
      { cwd: repositoryRoot, env, timeout: 60_000 },
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
});
