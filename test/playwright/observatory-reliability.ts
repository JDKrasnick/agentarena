import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron as electron,
  type ElectronApplication,
} from "playwright-core";
import { ArenaBattleControl } from "../../src/observability/control.js";
import type { ArenaEventInput } from "../../src/observability/events.js";
import { startWebDashboard } from "../../src/dashboard/web-server.js";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const artifacts = path.join(root, ".context", "issue-95-playwright");
const electronPath = createRequire(import.meta.url)("electron") as string;
const mainScript = path.join(root, "dist", "dashboard", "electron-main.js");
const soakMs = Number(process.env["AGENT_ARENA_PLAYWRIGHT_SOAK_MS"] ?? "3000");
const profilePaths: string[] = [];

async function launch(
  url: string,
  softwareRendering = false,
): Promise<ElectronApplication> {
  const profilePath = await mkdtemp(
    path.join(os.tmpdir(), "agent-arena-playwright-profile-"),
  );
  profilePaths.push(profilePath);
  return electron.launch({
    executablePath: electronPath,
    args: [mainScript],
    env: {
      ...process.env,
      AGENT_ARENA_DASHBOARD_URL: url,
      AGENT_ARENA_PROFILE_PATH: profilePath,
      AGENT_ARENA_WINDOW_DEBUG: "1",
      ...(softwareRendering ? { AGENT_ARENA_SOFTWARE_RENDERING: "1" } : {}),
    },
  });
}

const controller = new AbortController();
const dashboard = await startWebDashboard(
  new ArenaBattleControl(controller),
  // The production heartbeat prevents quiet periods. Disabling it here lets
  // Playwright prove that the client watchdog removes Live and then recovers.
  { heartbeatIntervalMs: 0 },
);
let desktop: ElectronApplication | undefined;
let fallbackDesktop: ElectronApplication | undefined;

try {
  await mkdir(artifacts, { recursive: true });
  const publish = async (event: ArenaEventInput) => {
    await dashboard.observer.publish(event);
  };
  await publish({
    type: "battle_started",
    runId: "playwright-observatory-reliability",
    task: "Keep the observatory live and recoverable",
    contestants: [
      { id: "a", provider: "codex" },
      { id: "b", provider: "claude" },
    ],
  });
  await publish({ type: "stage_changed", stage: "implement", round: 1 });

  desktop = await launch(dashboard.url);
  assert.equal(
    await desktop.evaluate(({ app }) => app.isHardwareAccelerationEnabled()),
    true,
    "normal Electron launch disabled hardware acceleration",
  );
  let page = await desktop.firstWindow();
  assert.equal(
    await page.evaluate(() => Notification.requestPermission()),
    "denied",
    "isolated renderer session approved a permission request",
  );
  const shell = page.locator(".app-shell");
  const connection = page.getByRole("status").filter({ hasText: "Live" });
  await connection.waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector(".app-shell")?.getAttribute("data-live-stage") ===
      "implement",
  );
  const initialPixels = await page.screenshot({
    path: path.join(artifacts, "initial.png"),
  });

  await page.waitForFunction(
    () =>
      document
        .querySelector(".app-shell")
        ?.getAttribute("data-connection-state") === "stale",
    undefined,
    { timeout: 12_000 },
  );
  assert.match(await page.getByRole("status").ariaSnapshot(), /Stale/u);

  await publish({ type: "stage_changed", stage: "initial_validate", round: 1 });
  await page.waitForFunction(
    () =>
      document
        .querySelector(".app-shell")
        ?.getAttribute("data-connection-state") === "live",
  );

  const soakStarted = Date.now();
  let update = 0;
  while (Date.now() - soakStarted < soakMs) {
    update += 1;
    await publish({
      type: "stage_changed",
      stage: update % 2 === 0 ? "review_attacks" : "initial_validate",
      round: 1,
    });
    await publish({
      type: "check_completed",
      checkId: `synthetic-${String(update)}`,
      status: "passed",
      contestantId: update % 2 === 0 ? "a" : "b",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  await publish({ type: "stage_changed", stage: "final_validate", round: 1 });
  await page.waitForFunction(async () => {
    const response = await fetch("/api/state", { cache: "no-store" });
    const api = (await response.json()) as { stage: string };
    const rendered = document
      .querySelector(".app-shell")
      ?.getAttribute("data-live-stage");
    return (
      api.stage === "final_validate" &&
      rendered === api.stage &&
      document.body.innerText.includes("Final validation") &&
      document
        .querySelector(".app-shell")
        ?.getAttribute("data-connection-state") === "live"
    );
  });
  await page.getByText("Final validation", { exact: true }).first().waitFor();
  assert.match(await page.locator("body").ariaSnapshot(), /Final validation/u);
  const updatedPixels = await page.screenshot({
    path: path.join(artifacts, "updated.png"),
  });
  assert.notDeepEqual(
    updatedPixels,
    initialPixels,
    "visible pixels did not repaint",
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await shell.waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector(".app-shell")?.getAttribute("data-live-stage") ===
      "final_validate",
  );
  assert.equal(controller.signal.aborted, false, "reload cancelled the fight");

  await publish({
    type: "battle_completed",
    status: "failed",
    roundsCompleted: 0,
  });
  await page.getByRole("button", { name: "Finish session" }).waitFor();
  await publish({
    type: "battle_started",
    runId: "playwright-observatory-recovery-child",
    task: "Continue the active recovery child",
    contestants: [
      { id: "a", provider: "codex" },
      { id: "b", provider: "claude" },
    ],
  });
  await publish({ type: "stage_changed", stage: "initial_validate", round: 1 });
  await page.waitForFunction(
    () =>
      document.querySelector(".app-shell")?.getAttribute("data-live-stage") ===
        "initial_validate" &&
      !document.body.innerText.includes("No competitive winner was published"),
  );
  assert.equal(
    await page.getByRole("button", { name: "Finish session" }).count(),
    0,
    "recovery child retained the failed parent's terminal controls",
  );
  assert.equal(
    controller.signal.aborted,
    false,
    "recovery child transition cancelled the fight",
  );
  await publish({ type: "stage_changed", stage: "final_validate", round: 1 });

  const recoveredWindow = desktop.waitForEvent("window", { timeout: 15_000 });
  await desktop.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer();
  });
  page = await recoveredWindow;
  await page.waitForFunction(
    () =>
      document.querySelector(".app-shell")?.getAttribute("data-live-stage") ===
      "final_validate",
    undefined,
    { timeout: 15_000 },
  );
  assert.equal(
    controller.signal.aborted,
    false,
    "renderer recovery cancelled the fight",
  );

  await publish({
    type: "battle_completed",
    status: "complete",
    roundsCompleted: 1,
    championId: "a",
    outcomeKind: "winner",
    decisionBasis: "competitive_evidence",
    coverageConfidence: "full_confidence",
    contestants: [
      {
        id: "a",
        health: 100,
        status: "complete",
        checksPassed: update,
        checksTotal: update,
      },
      {
        id: "b",
        health: 85,
        status: "complete",
        checksPassed: update,
        checksTotal: update,
      },
    ],
  });
  await page.waitForFunction(() => document.title === "Agent Arena · Results");
  await page.getByRole("button", { name: "Finish session" }).waitFor();
  await page.screenshot({ path: path.join(artifacts, "complete.png") });

  await desktop.close();
  desktop = undefined;

  fallbackDesktop = await launch(dashboard.url, true);
  assert.equal(
    await fallbackDesktop.evaluate(({ app }) =>
      app.isHardwareAccelerationEnabled(),
    ),
    false,
    "software-rendering fallback left hardware acceleration enabled",
  );
  const fallbackPage = await fallbackDesktop.firstWindow();
  await fallbackPage.getByRole("button", { name: "Finish session" }).waitFor();
  assert.equal(
    await fallbackPage.locator(".app-shell").getAttribute("data-live-stage"),
    "final_validate",
  );
  await fallbackPage.screenshot({
    path: path.join(artifacts, "software-rendering.png"),
  });

  process.stdout.write(
    `Playwright observatory reliability passed (${String(update)} synthetic updates, ${String(soakMs)} ms soak).\n`,
  );
} finally {
  await fallbackDesktop?.close().catch(() => undefined);
  await desktop?.close().catch(() => undefined);
  await dashboard.close();
  await Promise.all(
    profilePaths.map((profilePath) =>
      rm(profilePath, { recursive: true, force: true }),
    ),
  );
}
