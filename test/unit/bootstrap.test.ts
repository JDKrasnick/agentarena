import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBootstrapContract } from "../../src/task/bootstrap.js";

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-bootstrap-"));
  await Promise.all(
    Object.entries(files).map(async ([name, body]) => {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), body);
    }),
  );
  return root;
}

describe("bootstrap contract", () => {
  it("freezes npm ci and its dependency inputs", async () => {
    const root = await repository({
      "package.json": "{}",
      "package-lock.json": '{"lockfileVersion":3}',
    });
    const contract = await resolveBootstrapContract({
      repositoryRoot: root,
      bootstrap: "auto",
      timeoutMs: 1000,
    });
    expect(contract).toMatchObject({
      source: "auto",
      disposition: "command",
      command: "npm ci",
    });
    expect(contract.dependencyInputs.map((entry) => entry.path)).toEqual([
      "package.json",
      "package-lock.json",
    ]);
  });

  it("uses explicit none without inventing installation authority", async () => {
    const root = await repository({ "package.json": "{}" });
    await expect(
      resolveBootstrapContract({
        repositoryRoot: root,
        bootstrap: "none",
        timeoutMs: 1000,
      }),
    ).resolves.toMatchObject({ source: "none", disposition: "none" });
  });
});
