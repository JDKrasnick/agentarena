import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_ARENA_THEME,
  normalizeArenaTheme,
  type ArenaTheme,
} from "./arena-theme.js";

const PREFERENCE_FILE = "arena-theme.json";

export function themePreferencePath(userDataPath: string): string {
  return path.join(userDataPath, PREFERENCE_FILE);
}

export async function readThemePreference(
  userDataPath: string,
): Promise<ArenaTheme> {
  try {
    const raw = await readFile(themePreferencePath(userDataPath), "utf8");
    const parsed = JSON.parse(raw) as { theme?: unknown };
    return normalizeArenaTheme(parsed.theme);
  } catch {
    return DEFAULT_ARENA_THEME;
  }
}

export async function writeThemePreference(
  userDataPath: string,
  theme: ArenaTheme,
): Promise<void> {
  const destination = themePreferencePath(userDataPath);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await mkdir(userDataPath, { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify({ theme })}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
