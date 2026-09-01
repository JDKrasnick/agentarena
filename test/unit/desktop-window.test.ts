import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
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
  it("launches Electron with a loopback URL and isolated profile", async () => {
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
    expect(spawnCall?.[2]?.stdio).toEqual([
      "ignore",
      "ignore",
      "inherit",
      "ipc",
    ]);
    expect(spawnCall?.[2]?.env).toEqual(
      expect.objectContaining({
        AGENT_ARENA_DASHBOARD_URL: "http://127.0.0.1:4321/",
      }),
    );
    const profilePath = spawnCall?.[2]?.env?.["AGENT_ARENA_PROFILE_PATH"];
    expect(typeof profilePath).toBe("string");
    expect(profilePath).toContain("agent-arena-electron-profile-");
    expect(existsSync(profilePath as string)).toBe(true);

    child.emit("message", { type: "agent-arena-window-ready" });
    await window.waitUntilReady();
    await window.close();
    expect(killProcess).toHaveBeenCalledOnce();
    expect(existsSync(profilePath as string)).toBe(false);
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

    child.emit("message", { type: "agent-arena-window-ready" });
    await window.waitUntilReady();
    child.emit("exit", 0, null);
    child.emit("error", new Error("already closed"));
    await window.waitUntilClosed();

    expect(onUserClose).toHaveBeenCalledOnce();
  });

  it("reports an early Electron exit as a display launch failure", async () => {
    const { child } = fakeChild();
    const onUserClose = vi.fn();
    const window = startDesktopDashboardWindow("http://127.0.0.1:4321/", {
      electronPath: "/electron",
      mainScriptPath: "/desktop-main.js",
      spawnProcess: readySpawn(child),
      onUserClose,
    });

    child.emit("exit", 1, null);

    await expect(window.waitUntilReady()).rejects.toThrow(
      "Agent Arena window failed to launch (exit code 1)",
    );
    await window.waitUntilClosed();
    expect(onUserClose).not.toHaveBeenCalled();
  });

  it("times out a launch, stops Electron, and removes its profile", async () => {
    const { child, killProcess } = fakeChild();
    const spawnProcess = readySpawn(child);
    const window = startDesktopDashboardWindow("http://127.0.0.1:4321/", {
      electronPath: "/electron",
      mainScriptPath: "/desktop-main.js",
      spawnProcess,
      launchTimeoutMs: 1,
    });
    const profilePath =
      vi.mocked(spawnProcess).mock.calls[0]?.[2]?.env?.[
        "AGENT_ARENA_PROFILE_PATH"
      ];

    await expect(window.waitUntilReady()).rejects.toThrow(
      "Agent Arena window failed to launch: startup timed out",
    );
    await window.waitUntilClosed();

    expect(killProcess).toHaveBeenCalledOnce();
    expect(existsSync(profilePath as string)).toBe(false);
  });

  it("gives concurrent windows different Chromium profiles", async () => {
    const first = fakeChild();
    const second = fakeChild();
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child) as unknown as typeof spawn;
    const firstWindow = startDesktopDashboardWindow("http://127.0.0.1:4321/", {
      electronPath: "/electron",
      mainScriptPath: "/main.js",
      spawnProcess,
    });
    const secondWindow = startDesktopDashboardWindow("http://127.0.0.1:4322/", {
      electronPath: "/electron",
      mainScriptPath: "/main.js",
      spawnProcess,
    });

    const firstProfile =
      vi.mocked(spawnProcess).mock.calls[0]?.[2]?.env?.[
        "AGENT_ARENA_PROFILE_PATH"
      ];
    const secondProfile =
      vi.mocked(spawnProcess).mock.calls[1]?.[2]?.env?.[
        "AGENT_ARENA_PROFILE_PATH"
      ];
    expect(firstProfile).not.toBe(secondProfile);

    first.child.emit("message", { type: "agent-arena-window-ready" });
    second.child.emit("message", { type: "agent-arena-window-ready" });
    await Promise.all([
      firstWindow.waitUntilReady(),
      secondWindow.waitUntilReady(),
    ]);
    await firstWindow.close();
    expect(second.killProcess).not.toHaveBeenCalled();
    await secondWindow.close();
  });

  it("rejects non-loopback dashboard URLs", () => {
    expect(() => startDesktopDashboardWindow("https://example.com")).toThrow(
      "only accepts a loopback URL",
    );
  });
});
