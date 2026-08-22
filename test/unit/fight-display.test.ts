import { describe, expect, it } from "vitest";
import { resolveDisplayMode } from "../../src/commands/fight.js";

describe("fight display selection", () => {
  it("launches the desktop window by default", () => {
    expect(resolveDisplayMode("auto", true, true)).toBe("window");
    expect(resolveDisplayMode("auto", true, false)).toBe("window");
  });

  it("uses terminal or plain output when the window is disabled", () => {
    expect(resolveDisplayMode("auto", false, true)).toBe("terminal");
    expect(resolveDisplayMode("auto", false, false)).toBe("plain");
    expect(resolveDisplayMode("window", false, true)).toBe("terminal");
  });

  it("preserves explicit non-window display modes", () => {
    expect(resolveDisplayMode("terminal", true, true)).toBe("terminal");
    expect(resolveDisplayMode("plain", true, true)).toBe("plain");
  });
});
