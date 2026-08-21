import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface DesktopDashboardWindow {
  close(): Promise<void>;
  waitUntilClosed(): Promise<void>;
}

interface DesktopWindowOptions {
  onUserClose?: () => void;
  electronPath?: string;
  mainScriptPath?: string;
  spawnProcess?: typeof spawn;
}

function resolveElectronPath(): string {
  const require = createRequire(import.meta.url);
  try {
    return require("electron") as string;
  } catch {
    throw new Error(
      "The desktop window runtime is unavailable. Reinstall agent-arena with optional dependencies enabled, or use --display terminal.",
    );
  }
}

export function startDesktopDashboardWindow(
  url: string,
  options: DesktopWindowOptions = {},
): DesktopDashboardWindow {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "http:" || parsedUrl.hostname !== "127.0.0.1") {
    throw new Error("The desktop dashboard only accepts a loopback URL");
  }

  const electronPath = options.electronPath ?? resolveElectronPath();
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
  const child: ChildProcess = spawnProcess(electronPath, [mainScriptPath], {
    env: {
      ...process.env,
      AGENT_ARENA_DASHBOARD_URL: parsedUrl.toString(),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });

  let closing = false;
  let userCloseReported = false;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const reportUserClose = () => {
    if (closing || userCloseReported) return;
    userCloseReported = true;
    options.onUserClose?.();
  };
  child.once("error", () => {
    resolveClosed();
    reportUserClose();
  });
  child.once("exit", () => {
    resolveClosed();
    reportUserClose();
  });

  return {
    async close() {
      if (closing) {
        await closed;
        return;
      }
      closing = true;
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    },
    waitUntilClosed: () => closed,
  };
}
