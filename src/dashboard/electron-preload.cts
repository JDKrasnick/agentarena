import { contextBridge, ipcRenderer } from "electron";

type ArenaTheme =
  | "classic-shell"
  | "sticker-league"
  | "night-edition"
  | "live-arena-broadcast"
  | "evidence-deck";

const themes = new Set<ArenaTheme>([
  "classic-shell",
  "sticker-league",
  "night-edition",
  "live-arena-broadcast",
  "evidence-deck",
]);
const initialArgument = process.argv.find((entry) =>
  entry.startsWith("--agent-arena-theme="),
);
const initialTheme = initialArgument?.split("=")[1];
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
