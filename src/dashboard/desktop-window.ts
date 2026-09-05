import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareElectronRuntime } from "./electron-runtime.js";

export interface DesktopDashboardWindow {
  close(): Promise<void>;
  waitUntilReady(): Promise<void>;
  waitUntilClosed(): Promise<void>;
}

interface DesktopWindowOptions {
  onUserClose?: () => void;
  electronPath?: string;
  mainScriptPath?: string;
  spawnProcess?: typeof spawn;
  launchTimeoutMs?: number;
}

interface DesktopWindowReadyMessage {
  type: "agent-arena-window-ready";
}

function isReadyMessage(
  message: unknown,
): message is DesktopWindowReadyMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "agent-arena-window-ready"
  );
}

export async function startDesktopDashboardWindow(
  url: string,
  options: DesktopWindowOptions = {},
): Promise<DesktopDashboardWindow> {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "http:" || parsedUrl.hostname !== "127.0.0.1") {
    throw new Error("The desktop dashboard only accepts a loopback URL");
  }

  let electronPath: string;
  try {
    electronPath = options.electronPath ?? (await prepareElectronRuntime());
  } catch (error) {
    throw new Error(
      `Agent Arena window failed to launch: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const adjacentMainScript = fileURLToPath(
    new URL("./electron-main.js", import.meta.url),
  );
  const builtMainScript = path.resolve(
    process.cwd(),
    "dist/dashboard/electron-main.js",
  );
  const mainScriptPath =
    options.mainScriptPath ??
    (existsSync(adjacentMainScript) ? adjacentMainScript : builtMainScript);
  const spawnProcess = options.spawnProcess ?? spawn;
  const profilePath = mkdtempSync(
    path.join(os.tmpdir(), "agent-arena-electron-profile-"),
  );
  let child: ChildProcess;
  try {
    child = spawnProcess(electronPath, [mainScriptPath], {
      env: {
        ...process.env,
        AGENT_ARENA_DASHBOARD_URL: parsedUrl.toString(),
        AGENT_ARENA_PROFILE_PATH: profilePath,
      },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
  } catch (error) {
    rmSync(profilePath, { recursive: true, force: true });
    throw new Error(
      `Agent Arena window failed to launch: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  let closing = false;
  let ready = false;
  let userCloseReported = false;
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  let resolveClosed: () => void = () => {};
  const launched = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const cleanedUp = closed.then(() =>
    rm(profilePath, { recursive: true, force: true }),
  );
  const launchTimeout = setTimeout(() => {
    if (ready) return;
    rejectReady(
      new Error("Agent Arena window failed to launch: startup timed out"),
    );
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }, options.launchTimeoutMs ?? 15_000);
  launchTimeout.unref();

  const reportUserClose = () => {
    if (!ready || closing || userCloseReported) return;
    userCloseReported = true;
    options.onUserClose?.();
  };
  child.on("message", (message: unknown) => {
    if (ready || !isReadyMessage(message)) return;
    ready = true;
    clearTimeout(launchTimeout);
    resolveReady();
  });
  child.once("error", (error) => {
    clearTimeout(launchTimeout);
    if (!ready) {
      rejectReady(
        new Error(`Agent Arena window failed to launch: ${error.message}`),
      );
    }
    resolveClosed();
    reportUserClose();
  });
  child.once("exit", (code, signal) => {
    clearTimeout(launchTimeout);
    if (!ready) {
      const reason = signal
        ? `signal ${signal}`
        : `exit code ${String(code ?? "unknown")}`;
      rejectReady(new Error(`Agent Arena window failed to launch (${reason})`));
    }
    resolveClosed();
    reportUserClose();
  });

  return {
    async close() {
      if (closing) {
        await cleanedUp;
        return;
      }
      closing = true;
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await cleanedUp;
    },
    waitUntilReady: () => launched,
    waitUntilClosed: () => cleanedUp,
  };
}
