import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareElectronRuntime } from "../../src/dashboard/electron-runtime.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
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

function lockPath(fixture: Awaited<ReturnType<typeof runtimeFixture>>) {
  const identity = [
    fixture.packageDirectory,
    "1.2.3",
    process.platform,
    process.arch,
  ].join("\0");
  return path.join(
    fixture.lockDirectory,
    `agent-arena-electron-${createHash("sha256").update(identity).digest("hex")}.lock`,
  );
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
  it("shares stale-lock recovery across independent processes", async () => {
    const fixture = await runtimeFixture(successfulInstaller);
    await mkdir(lockPath(fixture));
    await writeFile(path.join(lockPath(fixture), "owner-abcd"), "99999999\n");
    const moduleUrl = new URL(
      "../../src/dashboard/electron-runtime.ts",
      import.meta.url,
    ).href;
    const script = `import { prepareElectronRuntime } from ${JSON.stringify(moduleUrl)};
      console.log(await prepareElectronRuntime(${JSON.stringify({ ...runtimeOptions(fixture), timeoutMs: 5_000 })}));`;
    const outputs = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise<string>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              ["--import", "tsx", "--input-type=module", "--eval", script],
              { stdio: ["ignore", "pipe", "pipe"] },
            );
            let output = "";
            let errors = "";
            child.stdout.on("data", (chunk: Buffer) => {
              output += chunk.toString();
            });
            child.stderr.on("data", (chunk: Buffer) => {
              errors += chunk.toString();
            });
            child.once("error", reject);
            child.once("exit", (code) => {
              if (code === 0) resolve(output.trim());
              else reject(new Error(errors));
            });
          }),
      ),
    );
    expect(new Set(outputs)).toEqual(
      new Set([path.join(fixture.packageDirectory, "dist", "electron")]),
    );
    expect(
      await readFile(
        path.join(fixture.packageDirectory, "install-count"),
        "utf8",
      ),
    ).toBe("installed\n");
    expect(await readdir(fixture.lockDirectory)).toEqual([]);
  }, 10_000);

  it.each(["pid", "owner-1234abcd", undefined])(
    "serializes simultaneous recovery of an abandoned lock (%s)",
    async (marker) => {
      for (let trial = 0; trial < 5; trial++) {
        const fixture = await runtimeFixture(successfulInstaller);
        await mkdir(lockPath(fixture));
        if (marker)
          await writeFile(path.join(lockPath(fixture), marker), "99999999\n");
        const results = await Promise.all(
          Array.from({ length: 16 }, () =>
            prepareElectronRuntime({
              ...runtimeOptions(fixture),
              onWait: () => {},
            }),
          ),
        );
        expect(new Set(results)).toEqual(
          new Set([path.join(fixture.packageDirectory, "dist", "electron")]),
        );
        expect(
          await readFile(
            path.join(fixture.packageDirectory, "install-count"),
            "utf8",
          ),
        ).toBe("installed\n");
        expect(await readdir(fixture.lockDirectory)).toEqual([]);
      }
    },
  );

  it("kills a stuck installer before cleaning up and admitting a waiting caller", async () => {
    const fixture = await runtimeFixture(`
const fs = require('node:fs');
process.on('SIGTERM', () => fs.writeFileSync('terminated', 'yes'));
fs.mkdirSync('dist');
fs.writeFileSync('dist/partial', 'partial');
fs.writeFileSync('installer-pid', String(process.pid));
setInterval(() => {}, 100);
`);
    const started = Date.now();
    const first = prepareElectronRuntime({
      ...runtimeOptions(fixture),
      timeoutMs: 800,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(
      async () => {
        expect(
          await readFile(
            path.join(fixture.packageDirectory, "installer-pid"),
            "utf8",
          ),
        ).toMatch(/^\d+$/);
      },
      { timeout: 700 },
    );
    const installerPid = Number(
      await readFile(
        path.join(fixture.packageDirectory, "installer-pid"),
        "utf8",
      ),
    );
    // The running child already loaded its script; the next owner gets a healthy installer.
    await writeFile(
      path.join(fixture.packageDirectory, "install.js"),
      successfulInstaller,
    );
    const waiting = prepareElectronRuntime({
      ...runtimeOptions(fixture),
      timeoutMs: 4_000,
      onWait: () => {},
    });
    expect(await first).toEqual(
      expect.objectContaining({
        message: "Electron display installation timed out",
      }),
    );
    expect(Date.now() - started).toBeLessThan(3_500);
    expect(() => process.kill(installerPid, 0)).toThrow();
    expect(
      await readFile(path.join(fixture.packageDirectory, "terminated"), "utf8"),
    ).toBe("yes");
    await expect(waiting).resolves.toBe(
      path.join(fixture.packageDirectory, "dist", "electron"),
    );
    expect(
      existsSync(path.join(fixture.packageDirectory, "dist", "partial")),
    ).toBe(false);
    expect(await readdir(fixture.lockDirectory)).toEqual([]);
  });

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

  it("returns a ready runtime from ELECTRON_OVERRIDE_DIST_PATH", async () => {
    const fixture = await runtimeFixture("throw new Error('should not run');");
    const overrideDirectory = path.join(fixture.root, "electron-override");
    await mkdir(overrideDirectory);
    await writeFile(path.join(overrideDirectory, "electron"), "ready");
    await writeFile(
      path.join(fixture.packageDirectory, "path.txt"),
      "electron\n",
    );
    vi.stubEnv("ELECTRON_OVERRIDE_DIST_PATH", overrideDirectory);

    await expect(prepareElectronRuntime(runtimeOptions(fixture))).resolves.toBe(
      path.join(overrideDirectory, "electron"),
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
