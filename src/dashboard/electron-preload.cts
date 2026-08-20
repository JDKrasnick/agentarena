import { contextBridge, ipcRenderer } from "electron";

type ArenaTheme =
  | "classic-shell"
  | "sticker-league"
  | "night-edition"
  | "live-arena-broadcast"
  | "monster-battle";

const themes = new Set<ArenaTheme>([
  "classic-shell",
  "sticker-league",
  "night-edition",
  "live-arena-broadcast",
  "monster-battle",
]);
const initialArgument = process.argv.find((entry) =>
  entry.startsWith("--agent-arena-theme="),
);
const initialValue = initialArgument?.split("=")[1];
const initialTheme =
  initialValue === "evidence-deck" ? "monster-battle" : initialValue;
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
