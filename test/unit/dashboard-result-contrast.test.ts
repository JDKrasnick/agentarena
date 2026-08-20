import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  new URL("../../src/web/client/styles.css", import.meta.url),
  "utf8",
);

const themes = [
  "developer-dashboard",
  "night-edition",
  "live-arena-broadcast",
  "retro-tactics",
] as const;

const operationalThemes = [
  "classic-shell",
  "developer-dashboard",
  "night-edition",
  "live-arena-broadcast",
  "retro-tactics",
] as const;

const operationalTextPairs = [
  ["--detail-page-fg", "--detail-page-surface"],
  ["--detail-page-muted", "--detail-page-surface"],
  ["--detail-page-faint", "--detail-page-surface"],
  ["--detail-accent", "--detail-page-surface"],
  ["--detail-success", "--detail-page-surface"],
  ["--detail-page-danger", "--detail-page-surface"],
  ["--detail-output-fg", "--detail-output-surface"],
  ["--detail-output-muted", "--detail-output-surface"],
  ["--detail-output-danger", "--detail-output-surface"],
  ["--detail-input-fg", "--detail-input-surface"],
  ["--detail-input-placeholder", "--detail-input-surface"],
  ["--detail-button-fg", "--detail-button-surface"],
] as const;

const textPairs = [
  ["--result-fg", "--result-surface"],
  ["--result-muted", "--result-surface"],
  ["--result-link", "--result-surface"],
  ["--result-card-fg", "--result-card-surface"],
  ["--result-card-muted", "--result-card-surface"],
  ["--result-stat", "--result-card-surface"],
  ["--result-card-fg", "--result-winner-surface"],
  ["--result-card-muted", "--result-winner-surface"],
  ["--result-stat", "--result-winner-surface"],
] as const;

function themeTokens(theme: (typeof themes)[number]): Map<string, string> {
  const blocks = [
    ...stylesheet.matchAll(
      new RegExp(`\\.theme-${theme}\\s*\\{([\\s\\S]*?)\\n\\}`, "g"),
    ),
  ];
  const block = blocks.find((match) =>
    match[1]?.includes("--result-surface"),
  )?.[1];
  expect(block, `missing CSS block for ${theme}`).toBeDefined();

  const tokens = new Map<string, string>();
  for (const match of (block ?? "").matchAll(
    /(--[\w-]+):\s*(#[\da-f]{3,8})\s*;/gi,
  )) {
    const name = match[1];
    const value = match[2];
    if (name && value) tokens.set(name, value);
  }
  return tokens;
}

function operationalThemeTokens(
  theme: (typeof operationalThemes)[number],
): Map<string, string> {
  const blocks = [
    ...stylesheet.matchAll(
      new RegExp(`\\.theme-${theme}\\s*\\{([\\s\\S]*?)\\n\\}`, "g"),
    ),
  ];
  const block = blocks.find((match) =>
    match[1]?.includes("--detail-output-surface"),
  )?.[1];
  expect(block, `missing operational CSS block for ${theme}`).toBeDefined();

  const tokens = new Map<string, string>();
  for (const match of (block ?? "").matchAll(
    /(--[\w-]+):\s*(#[\da-f]{3,8})\s*;/gi,
  )) {
    const name = match[1];
    const value = match[2];
    if (name && value) tokens.set(name, value);
  }
  return tokens;
}

function relativeLuminance(hex: string): number {
  const full =
    hex.length === 4
      ? hex
          .slice(1)
          .split("")
          .map((digit) => digit.repeat(2))
          .join("")
      : hex.slice(1);
  const channels = [full.slice(0, 2), full.slice(2, 4), full.slice(4, 6)];
  const [red = 0, green = 0, blue = 0] = channels.map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  );
  return (lighter + 0.05) / (darker + 0.05);
}

describe("result theme contrast", () => {
  for (const theme of themes) {
    it(`${theme} keeps result text at WCAG AA contrast`, () => {
      const tokens = themeTokens(theme);

      for (const [foregroundToken, backgroundToken] of textPairs) {
        const foreground = tokens.get(foregroundToken);
        const background = tokens.get(backgroundToken);
        expect(
          foreground,
          `${theme} is missing ${foregroundToken}`,
        ).toBeDefined();
        expect(
          background,
          `${theme} is missing ${backgroundToken}`,
        ).toBeDefined();
        expect(
          contrastRatio(foreground ?? "#000", background ?? "#fff"),
          `${theme} ${foregroundToken} on ${backgroundToken}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe("fighter detail theme contrast", () => {
  for (const theme of operationalThemes) {
    it(`${theme} keeps operational text at WCAG AA contrast`, () => {
      const tokens = operationalThemeTokens(theme);

      for (const [foregroundToken, backgroundToken] of operationalTextPairs) {
        const foreground = tokens.get(foregroundToken);
        const background = tokens.get(backgroundToken);
        expect(
          foreground,
          `${theme} is missing ${foregroundToken}`,
        ).toBeDefined();
        expect(
          background,
          `${theme} is missing ${backgroundToken}`,
        ).toBeDefined();
        expect(
          contrastRatio(foreground ?? "#000", background ?? "#fff"),
          `${theme} ${foregroundToken} on ${backgroundToken}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe("retro tactics header contrast", () => {
  it("keeps connection status readable on the tactics top bar", () => {
    const tokens = operationalThemeTokens("retro-tactics");
    const foreground = tokens.get("--header-status-fg");
    const background = tokens.get("--header-surface");

    expect(foreground).toBeDefined();
    expect(background).toBeDefined();
    expect(
      contrastRatio(foreground ?? "#000", background ?? "#fff"),
    ).toBeGreaterThanOrEqual(4.5);
  });
});
