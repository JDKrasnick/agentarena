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
      config: {
        contestants: Array<{ model?: string }>;
      };
      contestants: Record<
        string,
        { model?: string; implementation?: { model?: string } }
      >;
      reviewPrompt: { choices: unknown[] };
    };
    expect(result.schemaVersion).toBe(3);
    expect(
      result.config.contestants.map((contestant) => contestant.model),
    ).toEqual(["codex-test-model", "claude-test-model"]);
    expect(result.contestants.a?.implementation?.model).toBe(
      "codex-test-model",
    );
    expect(result.contestants.b?.implementation?.model).toBe(
      "claude-test-model",
    );
    expect(result.reviewPrompt.choices).toHaveLength(2);
    expect(
      await readFile(path.join(runsRoot, runId!, "BATTLE.md"), "utf8"),
    ).toContain("Recommended patch");
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
