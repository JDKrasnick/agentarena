import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareElectronRuntime } from "../../src/dashboard/electron-runtime.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function runtimeFixture(installer: string) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "agent-arena-electron-test-"),
  );
  temporaryRoots.push(root);
  const packageDirectory = path.join(root, "electron");
  const lockDirectory = path.join(root, "locks");
  await mkdir(packageDirectory, { recursive: true });
  await mkdir(lockDirectory);
  const packageJsonPath = path.join(packageDirectory, "package.json");
  await writeFile(packageJsonPath, JSON.stringify({ version: "1.2.3" }));
  await writeFile(path.join(packageDirectory, "install.js"), installer);
  return {
    packageDirectory: await realpath(packageDirectory),
    packageJsonPath: await realpath(packageJsonPath),
    lockDirectory,
    root,
  };
}

function runtimeOptions(fixture: Awaited<ReturnType<typeof runtimeFixture>>) {
  return {
    packageJsonPath: fixture.packageJsonPath,
    lockDirectory: fixture.lockDirectory,
    pollIntervalMs: 5,
  };
}

const successfulInstaller = `
const fs = require("node:fs/promises");
const path = require("node:path");
(async () => {
  await new Promise((resolve) => setTimeout(resolve, 30));
  await fs.appendFile("install-count", "installed\\n");
  await fs.mkdir("dist", { recursive: true });
  await fs.writeFile(path.join("dist", "electron"), "ready");
  await fs.writeFile("path.txt", "electron\\n");
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;

describe("Electron runtime preparation", () => {
  it("returns a ready runtime without invoking the installer", async () => {
    const fixture = await runtimeFixture("throw new Error('should not run');");
    await mkdir(path.join(fixture.packageDirectory, "dist"));
    await writeFile(
      path.join(fixture.packageDirectory, "dist", "electron"),
      "ready",
    );
    await writeFile(
      path.join(fixture.packageDirectory, "path.txt"),
      "electron\n",
    );

    await expect(prepareElectronRuntime(runtimeOptions(fixture))).resolves.toBe(
      path.join(fixture.packageDirectory, "dist", "electron"),
    );
  });

  it("serializes callers and revalidates after waiting for the lock", async () => {
    const fixture = await runtimeFixture(successfulInstaller);
    const options = runtimeOptions(fixture);

    const [first, second] = await Promise.all([
      prepareElectronRuntime(options),
      prepareElectronRuntime(options),
    ]);

    expect(first).toBe(path.join(fixture.packageDirectory, "dist", "electron"));
    expect(second).toBe(first);
    expect(
      (
        await readFile(
          path.join(fixture.packageDirectory, "install-count"),
          "utf8",
        )
      )
        .trim()
        .split("\n"),
    ).toHaveLength(1);
  });

  it("cleans incomplete runtime state after an installer failure", async () => {
    const fixture = await runtimeFixture("process.exitCode = 1;");
    await mkdir(path.join(fixture.packageDirectory, "dist"));
    await writeFile(
      path.join(fixture.packageDirectory, "path.txt"),
      "missing\n",
    );

    await expect(
      prepareElectronRuntime(runtimeOptions(fixture)),
    ).rejects.toThrow("Electron installer exited with code 1");
    expect(existsSync(path.join(fixture.packageDirectory, "dist"))).toBe(false);
    expect(existsSync(path.join(fixture.packageDirectory, "path.txt"))).toBe(
      false,
    );
  });

  it("reclaims a lock owned by a dead process", async () => {
    const fixture = await runtimeFixture(successfulInstaller);
    const identity = [
      fixture.packageDirectory,
      "1.2.3",
      process.platform,
      process.arch,
    ].join("\0");
    const lock = path.join(
      fixture.lockDirectory,
      `agent-arena-electron-${createHash("sha256").update(identity).digest("hex")}.lock`,
    );
    await mkdir(lock);
    await writeFile(path.join(lock, "pid"), "99999999\n");

    await expect(prepareElectronRuntime(runtimeOptions(fixture))).resolves.toBe(
      path.join(fixture.packageDirectory, "dist", "electron"),
    );
  });

  it("fails explicitly when a live lock owner does not finish", async () => {
    const fixture = await runtimeFixture(successfulInstaller);
    const identity = [
      fixture.packageDirectory,
      "1.2.3",
      process.platform,
      process.arch,
    ].join("\0");
    const lock = path.join(
      fixture.lockDirectory,
      `agent-arena-electron-${createHash("sha256").update(identity).digest("hex")}.lock`,
    );
    await mkdir(lock);
    await writeFile(path.join(lock, "pid"), `${process.pid}\n`);

    await expect(
      prepareElectronRuntime({ ...runtimeOptions(fixture), timeoutMs: 10 }),
    ).rejects.toThrow(
      "timed out waiting for the Electron display installation",
    );
  });
});
