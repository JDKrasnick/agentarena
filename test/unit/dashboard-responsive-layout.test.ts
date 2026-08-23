import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  new URL("../../src/web/client/styles.css", import.meta.url),
  "utf8",
);

describe("dashboard responsive layout", () => {
  it("moves Test Lab samples below the benches before supported desktop widths collide", () => {
    const breakpoint = stylesheet.match(
      /@media \(max-width: (\d+)px\) \{\s*\.test-lab \{\s*grid-template-columns: 220px minmax\(0, 1fr\);/,
    );

    expect(Number(breakpoint?.[1])).toBeGreaterThanOrEqual(1_340);
    expect(stylesheet).toMatch(
      /\.lab-samples \{\s*display: grid;\s*grid-column: 1 \/ -1;/,
    );
    expect(stylesheet).toMatch(
      /\.lab-workspace \{\s*display: grid;\s*min-width: 0;/,
    );
  });
});
