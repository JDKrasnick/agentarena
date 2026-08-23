import { describe, expect, it } from "vitest";
import { desktopWindowSize } from "../../src/dashboard/window-layout.js";

describe("desktop window layout", () => {
  it("uses a spacious battle window and a smaller results window", () => {
    const workArea = { width: 2000, height: 1200 };

    expect(desktopWindowSize("battle", workArea)).toEqual({
      width: 1600,
      height: 1020,
    });
    expect(desktopWindowSize("results", workArea)).toEqual({
      width: 1180,
      height: 820,
    });
  });

  it("keeps both modes inside the available work area", () => {
    expect(desktopWindowSize("battle", { width: 1366, height: 768 })).toEqual({
      width: 1326,
      height: 728,
    });
    expect(desktopWindowSize("results", { width: 1366, height: 768 })).toEqual({
      width: 1180,
      height: 728,
    });
    expect(desktopWindowSize("battle", { width: 800, height: 600 })).toEqual({
      width: 760,
      height: 560,
    });
  });
});
