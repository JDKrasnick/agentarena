import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  shell,
  type Session,
} from "electron";
import { desktopWindowSize, type DesktopWindowMode } from "./window-layout.js";
import { isArenaTheme, type ArenaTheme } from "./arena-theme.js";
import {
  readThemePreference,
  writeThemePreference,
} from "./theme-preference.js";

function debug(message: string): void {
  if (process.env["AGENT_ARENA_WINDOW_DEBUG"] === "1") {
    process.stderr.write(`[Agent Arena window] ${message}\n`);
  }
}

debug("main process loaded");

app.setName("Agent Arena");
const sharedUserDataPath = app.getPath("userData");
const isolatedProfilePath = process.env["AGENT_ARENA_PROFILE_PATH"];
if (!isolatedProfilePath) {
  throw new Error("Missing Agent Arena isolated profile path");
}
app.setPath("userData", isolatedProfilePath);

const dashboardUrl = process.env["AGENT_ARENA_DASHBOARD_URL"];
if (!dashboardUrl) throw new Error("Missing Agent Arena dashboard URL");

const parsedDashboardUrl = new URL(dashboardUrl);
if (
  parsedDashboardUrl.protocol !== "http:" ||
  parsedDashboardUrl.hostname !== "127.0.0.1"
) {
  throw new Error("Agent Arena only loads its loopback dashboard origin");
}
const dashboardOrigin = parsedDashboardUrl.origin;
let mainWindow: BrowserWindow | null = null;
let currentTheme: ArenaTheme = "classic-shell";

if (process.env["AGENT_ARENA_SOFTWARE_RENDERING"] === "1") {
  app.disableHardwareAcceleration();
  debug("software rendering fallback enabled");
}

async function openExternalTarget(target: string): Promise<void> {
  const parsed = new URL(target);
  if (parsed.protocol === "https:" || parsed.protocol === "http:") {
    await shell.openExternal(parsed.toString());
  } else if (parsed.protocol === "file:") {
    await shell.openPath(fileURLToPath(parsed));
  }
}

function denyRendererPermissions(rendererSession: Session): void {
  rendererSession.setPermissionCheckHandler(() => false);
  rendererSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
}

function createWindow(): void {
  debug("creating BrowserWindow");
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const battleSize = desktopWindowSize("battle", workArea);
  const window = new BrowserWindow({
    width: battleSize.width,
    height: battleSize.height,
    minWidth: Math.min(980, battleSize.width),
    minHeight: Math.min(680, battleSize.height),
    backgroundColor: "#080b11",
    show: false,
    title: "Agent Arena",
    webPreferences: {
      preload: fileURLToPath(
        new URL("./electron-preload.cjs", import.meta.url),
      ),
      additionalArguments: [`--agent-arena-theme=${currentTheme}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      partition: `agent-arena-${String(process.pid)}-${String(Date.now())}`,
    },
  });
  denyRendererPermissions(window.webContents.session);
  mainWindow = window;
  debug("BrowserWindow created");

  let windowMode: DesktopWindowMode = "battle";
  const applyWindowMode = (mode: DesktopWindowMode) => {
    if (mode === windowMode || window.isDestroyed()) return;
    windowMode = mode;
    const size = desktopWindowSize(mode, workArea);
    window.setSize(size.width, size.height, process.platform === "darwin");
    window.center();
    debug(
      `window resized for ${mode} (${String(size.width)}x${String(size.height)})`,
    );
  };

  window.once("ready-to-show", () => {
    if (process.platform === "darwin") app.focus({ steal: true });
    else app.focus();
    window.setAlwaysOnTop(true, "floating");
    window.show();
    window.focus();
    setTimeout(() => {
      if (!window.isDestroyed()) window.setAlwaysOnTop(false);
    }, 750).unref();
    debug(
      `window revealed (visible=${String(window.isVisible())}, focused=${String(window.isFocused())})`,
    );
    process.send?.({ type: "agent-arena-window-ready" });
  });
  window.webContents.once("did-finish-load", () => {
    debug("React UI loaded");
    const capturePath = process.env["AGENT_ARENA_CAPTURE_PATH"];
    if (!capturePath) return;
    const configuredDelay = Number(
      process.env["AGENT_ARENA_CAPTURE_DELAY_MS"] ?? "8000",
    );
    const captureDelay = Number.isFinite(configuredDelay)
      ? Math.max(0, configuredDelay)
      : 8_000;
    setTimeout(() => {
      void (async () => {
        const captureTheme = process.env["AGENT_ARENA_CAPTURE_THEME"];
        if (captureTheme && !isArenaTheme(captureTheme)) {
          await window.webContents.executeJavaScript(
            `[...document.querySelectorAll('.theme-option')].find((button) => button.getAttribute('aria-label') === ${JSON.stringify(captureTheme)})?.click()`,
          );
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const fighter = process.env["AGENT_ARENA_CAPTURE_FIGHTER"];
        const round = process.env["AGENT_ARENA_CAPTURE_ROUND"];
        if (round === "1" || round === "2" || round === "3") {
          await window.webContents.executeJavaScript(
            `[...document.querySelectorAll('.round-nav button, .compact-rounds button')].find((button) => button.textContent?.includes('Round ${round}') || button.textContent?.trim() === 'R${round}')?.click()`,
          );
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        if (fighter === "a" || fighter === "b") {
          await window.webContents.executeJavaScript(
            `document.querySelector('.fighter-${fighter} .fighter-hitbox, .result-fighter.fighter-${fighter}, .broadcast-fighter-${fighter}, .tactics-status-${fighter}, .tactics-node-${fighter}-base')?.click()`,
          );
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (process.env["AGENT_ARENA_CAPTURE_BACK"] === "1") {
          await window.webContents.executeJavaScript(
            `document.querySelector('.back-to-arena')?.click()`,
          );
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const captureWidth = Number(
          process.env["AGENT_ARENA_CAPTURE_WIDTH"] ?? "0",
        );
        const captureHeight = Number(
          process.env["AGENT_ARENA_CAPTURE_HEIGHT"] ?? "0",
        );
        if (captureWidth > 0 && captureHeight > 0) {
          if (captureWidth < 980 || captureHeight < 680) {
            window.setMinimumSize(1, 1);
          }
          window.setSize(captureWidth, captureHeight, false);
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const hoverFighter = process.env["AGENT_ARENA_CAPTURE_HOVER_FIGHTER"];
        if (hoverFighter === "a" || hoverFighter === "b") {
          const point = (await window.webContents.executeJavaScript(
            `(() => { const rect = document.querySelector('.fighter-${hoverFighter} .fighter-hitbox')?.getBoundingClientRect(); return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null; })()`,
          )) as { x: number; y: number } | null;
          if (point) {
            window.webContents.sendInputEvent({ type: "mouseMove", ...point });
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
        }
        const image = await window.webContents.capturePage();
        await writeFile(capturePath, image.toPNG());
        const metadataPath = process.env["AGENT_ARENA_CAPTURE_METADATA_PATH"];
        if (metadataPath) {
          const metadata = (await window.webContents.executeJavaScript(`({
            viewportWidth: document.documentElement.clientWidth,
            viewportHeight: document.documentElement.clientHeight,
            scrollY: window.scrollY,
            documentScrollWidth: document.documentElement.scrollWidth,
            bodyScrollWidth: document.body.scrollWidth,
            roundLabels: [...document.querySelectorAll('.round-nav button[aria-label], .compact-rounds button[aria-label], .developer-timeline button[aria-label]')].map((element) => element.getAttribute('aria-label')),
            visibleRoundText: [...document.querySelectorAll('.round-nav button, .compact-rounds button, .developer-timeline nav button')].map((element) => element.textContent?.trim()).filter(Boolean),
            clippedPrimaryControls: [...document.querySelectorAll('button, input, a')].filter((element) => {
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 && (rect.left < 0 || rect.right > document.documentElement.clientWidth);
            }).map((element) => ({ text: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.tagName, rect: element.getBoundingClientRect().toJSON() })),
            matchupRects: [...document.querySelectorAll('.fighter, .versus, .developer-agent, .transit-contestant, .lab-bench, .broadcast-fighter, .broadcast-vs, .tactics-status, .tactics-versus')].map((element) => ({ className: element.className, rect: element.getBoundingClientRect().toJSON() })),
            selectedCompactRound: document.querySelector('.compact-rounds [aria-current="page"]')?.textContent?.trim() ?? null,
            battleCall: document.querySelector('.battle-call strong')?.textContent?.trim() ?? null,
            evidenceCardTitle: document.querySelector('.attack-card h2')?.textContent?.trim() ?? null,
            pageHeading: document.querySelector('h1')?.textContent?.trim() ?? null
          })`)) as Record<string, unknown>;
          await writeFile(
            metadataPath,
            `${JSON.stringify(metadata, null, 2)}\n`,
          );
        }
        debug(`capture written to ${capturePath}`);
        if (process.env["AGENT_ARENA_CAPTURE_CLOSE"] === "1") app.quit();
      })().catch((error: unknown) => {
        process.stderr.write(
          `Agent Arena capture failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    }, captureDelay).unref();
  });
  let recoveryTimer: NodeJS.Timeout | undefined;
  const recoverRenderer = (
    reason: string,
    delay = 500,
    replaceWindow = false,
  ) => {
    if (window.isDestroyed() || recoveryTimer) return;
    debug(`renderer recovery scheduled: ${reason}`);
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined;
      if (window.isDestroyed()) return;
      if (replaceWindow) {
        createWindow();
        window.destroy();
        return;
      }
      void window
        .loadURL(parsedDashboardUrl.toString())
        .catch((error: unknown) => {
          process.stderr.write(
            `Agent Arena renderer recovery failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        });
    }, delay);
    recoveryTimer.unref();
  };
  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      process.stderr.write(
        `Agent Arena window failed to load (${String(errorCode)}): ${errorDescription}\n`,
      );
      if (isMainFrame && errorCode !== -3) {
        recoverRenderer(`load failure ${String(errorCode)}`);
      }
    },
  );
  window.webContents.on("render-process-gone", (_event, details) => {
    recoverRenderer(`renderer ${details.reason}`, 500, true);
  });
  window.on("unresponsive", () => recoverRenderer("unresponsive", 2_000));
  window.on("responsive", () => {
    if (!recoveryTimer) return;
    clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
    debug("renderer recovered before reload");
  });
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) {
      process.stderr.write(`[Agent Arena renderer] ${message}\n`);
    }
  });
  window.webContents.on("page-title-updated", (event, title) => {
    event.preventDefault();
    window.setTitle("Agent Arena");
    if (title === "Agent Arena · Results") applyWindowMode("results");
    if (title === "Agent Arena · Live battle") applyWindowMode("battle");
  });
  window.once("closed", () => {
    if (recoveryTimer) clearTimeout(recoveryTimer);
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== dashboardOrigin) {
      event.preventDefault();
      void openExternalTarget(target);
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalTarget(url);
    return { action: "deny" };
  });
  void window.loadURL(parsedDashboardUrl.toString());
}

app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (!mainWindow) createWindow();
});

void app
  .whenReady()
  .then(async () => {
    debug("Electron app ready");
    currentTheme = isArenaTheme(process.env["AGENT_ARENA_CAPTURE_THEME"])
      ? process.env["AGENT_ARENA_CAPTURE_THEME"]
      : await readThemePreference(sharedUserDataPath);
    ipcMain.handle("arena-theme:set", async (_event, theme: unknown) => {
      if (!isArenaTheme(theme)) throw new Error("Unknown arena theme");
      currentTheme = theme;
      await writeThemePreference(sharedUserDataPath, theme);
    });
    ipcMain.on("arena-renderer:painted", (event, revision: unknown) => {
      if (
        !mainWindow ||
        mainWindow.isDestroyed() ||
        event.sender !== mainWindow.webContents ||
        !Number.isInteger(revision)
      )
        return;
      mainWindow.webContents.invalidate();
      debug(`renderer painted snapshot ${String(revision)}`);
    });
    if (process.platform === "darwin") app.setActivationPolicy("regular");
    createWindow();
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `Agent Arena window failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    app.quit();
  });
