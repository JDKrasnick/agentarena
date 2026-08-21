import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { startDesktopDashboardWindow } from "../../src/dashboard/desktop-window.js";

function fakeChild() {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperties(child, {
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
  });
  const killProcess = vi.fn(() => {
    child.emit("exit", 0, "SIGTERM");
    return true;
  });
  child.kill = killProcess;
  return { child, killProcess };
}

function readySpawn(child: ChildProcess): typeof spawn {
  return vi.fn(() => child) as unknown as typeof spawn;
}

describe("desktop dashboard window", () => {
  it("launches Electron with only the loopback URL in its environment", async () => {
    const { child, killProcess } = fakeChild();
    const spawnProcess = readySpawn(child);
    const window = startDesktopDashboardWindow("http://127.0.0.1:4321/", {
      electronPath: "/electron",
      mainScriptPath: "/desktop-main.js",
      spawnProcess,
    });

    const spawnCall = vi.mocked(spawnProcess).mock.calls[0];
    expect(spawnCall?.[0]).toBe("/electron");
    expect(spawnCall?.[1]).toEqual(["/desktop-main.js"]);
    expect(spawnCall?.[2]?.stdio).toEqual(["ignore", "ignore", "inherit"]);
    expect(spawnCall?.[2]?.env).toEqual(
      expect.objectContaining({
        AGENT_ARENA_DASHBOARD_URL: "http://127.0.0.1:4321/",
      }),
    );

    await window.close();
    expect(killProcess).toHaveBeenCalledOnce();
  });

  it("reports a user close once", async () => {
    const { child } = fakeChild();
    const onUserClose = vi.fn();
    const window = startDesktopDashboardWindow("http://127.0.0.1:4321/", {
      electronPath: "/electron",
      mainScriptPath: "/desktop-main.js",
      spawnProcess: readySpawn(child),
      onUserClose,
    });

    child.emit("exit", 0, null);
    child.emit("error", new Error("already closed"));
    await window.waitUntilClosed();

    expect(onUserClose).toHaveBeenCalledOnce();
  });

  it("rejects non-loopback dashboard URLs", () => {
    expect(() => startDesktopDashboardWindow("https://example.com")).toThrow(
      "only accepts a loopback URL",
    );
  });
});
