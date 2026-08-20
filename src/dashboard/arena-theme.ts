export const ARENA_THEMES = [
  "classic-shell",
  "sticker-league",
  "night-edition",
  "live-arena-broadcast",
  "evidence-deck",
] as const;

export type ArenaTheme = (typeof ARENA_THEMES)[number];

export const DEFAULT_ARENA_THEME: ArenaTheme = "classic-shell";

export function isArenaTheme(value: unknown): value is ArenaTheme {
  return (
    typeof value === "string" &&
    (ARENA_THEMES as readonly string[]).includes(value)
  );
}

export function normalizeArenaTheme(value: unknown): ArenaTheme {
  return isArenaTheme(value) ? value : DEFAULT_ARENA_THEME;
}

export interface ArenaThemeBridge {
  getTheme(): ArenaTheme;
  setTheme(theme: ArenaTheme): Promise<void>;
}

export function createArenaThemeBridge(
  initialTheme: unknown,
  persist: (theme: ArenaTheme) => Promise<void>,
): ArenaThemeBridge {
  let currentTheme = normalizeArenaTheme(initialTheme);
  return {
    getTheme: () => currentTheme,
    async setTheme(theme) {
      currentTheme = normalizeArenaTheme(theme);
      await persist(currentTheme);
    },
  };
}
