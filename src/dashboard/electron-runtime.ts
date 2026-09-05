import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

export interface ElectronRuntimeOptions {
  packageJsonPath?: string;
  lockDirectory?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onWait?: () => void;
}

interface ElectronPackageJson {
  version?: unknown;
}

function readExecutable(packageDirectory: string): string | undefined {
  const pathFile = path.join(packageDirectory, "path.txt");
  if (!existsSync(pathFile)) return undefined;

  const relativeExecutable = readFileSync(pathFile, "utf8").trim();
  if (!relativeExecutable) return undefined;

  const executable = path.resolve(packageDirectory, "dist", relativeExecutable);
  const distDirectory = path.resolve(packageDirectory, "dist") + path.sep;
  return executable.startsWith(distDirectory) && existsSync(executable)
    ? executable
    : undefined;
}

function resolvePackageJsonPath(): string {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("electron/package.json");
  } catch (error) {
    throw new Error(
      "The desktop window runtime is unavailable. Reinstall agent-arena with optional dependencies enabled, or use --display terminal.",
      { cause: error },
    );
  }
}

function lockPathFor(
  packageDirectory: string,
  version: string,
  lockDirectory: string,
): string {
  const identity = [
    packageDirectory,
    version,
    process.platform,
    process.arch,
  ].join("\0");
  const digest = createHash("sha256").update(identity).digest("hex");
  return path.join(lockDirectory, `agent-arena-electron-${digest}.lock`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function lockOwnerIsDead(lockPath: string): Promise<boolean> {
  try {
    const owner = Number.parseInt(
      (await readFile(path.join(lockPath, "pid"), "utf8")).trim(),
      10,
    );
    return Number.isInteger(owner) && owner > 0 && !processIsAlive(owner);
  } catch {
    // A newly created lock may not have written its PID yet. Treat it as live.
    return false;
  }
}

async function acquireLock(
  lockPath: string,
  timeoutMs: number,
  pollIntervalMs: number,
  onWait?: () => void,
): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs;
  let waitingReported = false;
  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(path.join(lockPath, "pid"), `${process.pid}\n`);
      return async () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    if (await lockOwnerIsDead(lockPath)) {
      await rm(lockPath, { recursive: true, force: true });
      continue;
    }
    if (!waitingReported) {
      waitingReported = true;
      onWait?.();
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "timed out waiting for the Electron display installation",
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

async function clearIncompleteRuntime(packageDirectory: string): Promise<void> {
  await Promise.all([
    rm(path.join(packageDirectory, "dist"), { recursive: true, force: true }),
    rm(path.join(packageDirectory, "path.txt"), { force: true }),
  ]);
}

async function runInstaller(packageDirectory: string): Promise<void> {
  const installer = path.join(packageDirectory, "install.js");
  if (!existsSync(installer)) {
    throw new Error("Electron's bundled installer is missing");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [installer], {
      cwd: packageDirectory,
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            signal
              ? `Electron installer stopped by signal ${signal}`
              : `Electron installer exited with code ${String(code ?? "unknown")}`,
          ),
        );
      }
    });
  });
}

/** Prepares Electron without evaluating its entry point, which lazily installs it. */
export async function prepareElectronRuntime(
  options: ElectronRuntimeOptions = {},
): Promise<string> {
  const packageJsonPath = options.packageJsonPath ?? resolvePackageJsonPath();
  const packageDirectory = realpathSync(path.dirname(packageJsonPath));
  const packageJson = JSON.parse(
    readFileSync(packageJsonPath, "utf8"),
  ) as ElectronPackageJson;
  const version =
    typeof packageJson.version === "string" ? packageJson.version : "unknown";
  const readyExecutable = readExecutable(packageDirectory);
  if (readyExecutable) return readyExecutable;

  const release = await acquireLock(
    lockPathFor(
      packageDirectory,
      version,
      options.lockDirectory ?? os.tmpdir(),
    ),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    options.onWait ??
      (() =>
        console.error(
          "Waiting for another Agent Arena process to prepare Electron…",
        )),
  );
  try {
    const executableAfterLock = readExecutable(packageDirectory);
    if (executableAfterLock) return executableAfterLock;

    await clearIncompleteRuntime(packageDirectory);
    try {
      await runInstaller(packageDirectory);
    } catch (error) {
      await clearIncompleteRuntime(packageDirectory);
      throw error;
    }
    const executable = readExecutable(packageDirectory);
    if (!executable) {
      await clearIncompleteRuntime(packageDirectory);
      throw new Error(
        "Electron installer completed without creating an executable",
      );
    }
    return executable;
  } finally {
    await release();
  }
}
