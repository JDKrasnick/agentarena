import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARENA_THEMES,
  createArenaThemeBridge,
  isArenaTheme,
  normalizeArenaTheme,
} from "../../src/dashboard/arena-theme.js";
import {
  readThemePreference,
  themePreferencePath,
  writeThemePreference,
} from "../../src/dashboard/theme-preference.js";

const temporaryDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arena-theme-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("arena themes", () => {
  it("accepts only the five supported identifiers", () => {
    for (const theme of ARENA_THEMES) expect(isArenaTheme(theme)).toBe(true);
    expect(isArenaTheme("classic")).toBe(false);
    expect(normalizeArenaTheme(undefined)).toBe("classic-shell");
  });

  it("falls back for missing, corrupt, and unknown preferences", async () => {
    const directory = await tempDirectory();
    expect(await readThemePreference(directory)).toBe("classic-shell");
    await writeFile(themePreferencePath(directory), "not json");
    expect(await readThemePreference(directory)).toBe("classic-shell");
    await writeFile(
      themePreferencePath(directory),
      JSON.stringify({ theme: "unknown-theme" }),
    );
    expect(await readThemePreference(directory)).toBe("classic-shell");
  });

  it("persists atomically without leaving temporary files", async () => {
    const directory = await tempDirectory();
    await writeThemePreference(directory, "monster-battle");
    expect(await readThemePreference(directory)).toBe("monster-battle");
    expect(await readdir(directory)).toEqual(["arena-theme.json"]);
  });

  it("migrates the retired evidence deck preference", async () => {
    const directory = await tempDirectory();
    await writeFile(
      themePreferencePath(directory),
      JSON.stringify({ theme: "evidence-deck" }),
    );
    expect(await readThemePreference(directory)).toBe("monster-battle");
  });

  it("exposes only getTheme and setTheme and keeps a failed save in session", async () => {
    const persist = vi.fn().mockRejectedValue(new Error("disk full"));
    const bridge = createArenaThemeBridge("night-edition", persist);
    expect(Object.keys(bridge).sort()).toEqual(["getTheme", "setTheme"]);
    await expect(bridge.setTheme("sticker-league")).rejects.toThrow(
      "disk full",
    );
    expect(bridge.getTheme()).toBe("sticker-league");
  });
});
