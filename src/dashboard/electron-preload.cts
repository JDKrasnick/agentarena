import { contextBridge, ipcRenderer } from "electron";

type ArenaTheme =
  | "classic-shell"
  | "developer-dashboard"
  | "night-transit"
  | "test-lab"
  | "live-arena-broadcast"
  | "retro-tactics";

const themes = new Set<ArenaTheme>([
  "classic-shell",
  "developer-dashboard",
  "night-transit",
  "test-lab",
  "live-arena-broadcast",
  "retro-tactics",
]);
const initialArgument = process.argv.find((entry) =>
  entry.startsWith("--agent-arena-theme="),
);
const initialValue = initialArgument?.split("=")[1];
const initialTheme =
  initialValue === "night-edition"
    ? "night-transit"
    : initialValue === "sticker-league"
      ? "developer-dashboard"
      : initialValue === "evidence-deck" || initialValue === "monster-battle"
        ? "retro-tactics"
        : initialValue;
let currentTheme: ArenaTheme = themes.has(initialTheme as ArenaTheme)
  ? (initialTheme as ArenaTheme)
  : "classic-shell";

contextBridge.exposeInMainWorld("arenaTheme", {
  getTheme(): ArenaTheme {
    return currentTheme;
  },
  async setTheme(theme: ArenaTheme): Promise<void> {
    currentTheme = themes.has(theme) ? theme : "classic-shell";
    await ipcRenderer.invoke("arena-theme:set", currentTheme);
  },
});
