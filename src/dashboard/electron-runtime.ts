import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
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

  const runtimeDirectory = path.resolve(
    process.env.ELECTRON_OVERRIDE_DIST_PATH ??
      path.join(packageDirectory, "dist"),
  );
  const executable = path.resolve(runtimeDirectory, relativeExecutable);
  const relativePath = path.relative(runtimeDirectory, executable);
  return relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    existsSync(executable)
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

async function removeOwner(lockPath: string, ownerFile: string): Promise<void> {
  // Remove only this generation's marker. A replacement lock is published
  // already populated, so rmdir cannot delete another owner's lock.
  await rm(path.join(lockPath, ownerFile), { force: true });
  try {
    await rmdir(lockPath);
  } catch (error) {
    if (
      !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
  }
}

async function reclaimDeadOwner(lockPath: string): Promise<void> {
  try {
    const files = await readdir(lockPath);
    // `pid` is the marker written by the original lock implementation.
    const ownerFile = files.length === 1 ? files[0] : undefined;
    if (
      !ownerFile ||
      (ownerFile !== "pid" && !/^owner-[0-9a-f-]+$/.test(ownerFile))
    )
      return;
    const owner = Number(
      (await readFile(path.join(lockPath, ownerFile), "utf8")).trim(),
    );
    if (Number.isInteger(owner) && owner > 0 && !processIsAlive(owner)) {
      await removeOwner(lockPath, ownerFile);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function acquireLock(
  lockPath: string,
  deadline: number,
  pollIntervalMs: number,
  onWait?: () => void,
): Promise<() => Promise<void>> {
  const stagingPath = await mkdtemp(`${lockPath}.pending-`);
  const ownerFile = `owner-${randomUUID()}`;
  let waitingReported = false;
  try {
    await writeFile(path.join(stagingPath, ownerFile), `${process.pid}\n`);
    while (true) {
      if (Date.now() >= deadline) {
        throw new Error(
          "timed out waiting for the Electron display installation",
        );
      }
      try {
        // Atomic publication never exposes an empty owned lock. Renaming over
        // a nonempty directory fails, while an abandoned empty lock is safe.
        await rename(stagingPath, lockPath);
        return async () => removeOwner(lockPath, ownerFile);
      } catch (error) {
        if (
          !["EEXIST", "ENOTEMPTY"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
      }

      await reclaimDeadOwner(lockPath);
      if (!waitingReported) {
        waitingReported = true;
        onWait?.();
      }
      if (Date.now() >= deadline) {
        throw new Error(
          "timed out waiting for the Electron display installation",
        );
      }
      await new Promise<void>((resolve) =>
        setTimeout(
          resolve,
          Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())),
        ),
      );
    }
  } finally {
    await rm(stagingPath, { recursive: true, force: true });
  }
}

async function clearIncompleteRuntime(packageDirectory: string): Promise<void> {
  await Promise.all([
    rm(path.join(packageDirectory, "dist"), { recursive: true, force: true }),
    rm(path.join(packageDirectory, "path.txt"), { force: true }),
  ]);
}

async function runInstaller(
  packageDirectory: string,
  deadline: number,
): Promise<void> {
  const installer = path.join(packageDirectory, "install.js");
  if (!existsSync(installer)) {
    throw new Error("Electron's bundled installer is missing");
  }
  if (Date.now() >= deadline)
    throw new Error("Electron display installation timed out");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [installer], {
      cwd: packageDirectory,
      stdio: ["ignore", "ignore", "inherit"],
    });
    let timedOut = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGTERM");
        escalation = setTimeout(() => child.kill("SIGKILL"), 1_000);
      },
      Math.max(0, deadline - Date.now()),
    );
    const clearTimers = () => {
      clearTimeout(timeout);
      clearTimeout(escalation);
    };
    child.once("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimers();
      if (timedOut)
        reject(new Error("Electron display installation timed out"));
      else if (code === 0) resolve();
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

  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const release = await acquireLock(
    lockPathFor(
      packageDirectory,
      version,
      options.lockDirectory ?? os.tmpdir(),
    ),
    deadline,
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
      await runInstaller(packageDirectory, deadline);
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
