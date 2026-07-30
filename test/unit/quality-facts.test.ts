import { describe, expect, it } from "vitest";
import { collectPatchQualityFacts } from "../../src/quality/collect-facts.js";

describe("patch quality facts", () => {
  it("normalizes production size without tests, docs, generated files, or locks", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -0,0 +1 @@",
      "+export const value = 1;",
      "diff --git a/test/a.test.ts b/test/a.test.ts",
      "--- a/test/a.test.ts",
      "+++ b/test/a.test.ts",
      "@@ -0,0 +1 @@",
      "+it('works', () => {});",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -0,0 +1 @@",
      "+docs",
      "diff --git a/package-lock.json b/package-lock.json",
      "--- a/package-lock.json",
      "+++ b/package-lock.json",
      "@@ -0,0 +1 @@",
      "+{}",
      "",
    ].join("\n");
    const facts = collectPatchQualityFacts({
      contestantId: "codex",
      patch,
    });
    expect(facts).toMatchObject({
      productionFilesChanged: 1,
      testFilesChanged: 1,
      documentationFilesChanged: 1,
      lockfilesChanged: 1,
      normalizedProductionLines: 1,
    });
  });

  it("ignores whitespace-only reformatting", () => {
    const facts = collectPatchQualityFacts({
      contestantId: "codex",
      patch: [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,2 @@",
        "-const a = 1;",
        "-const b = 2;",
        "+    const a = 1;",
        "+    const b = 2;",
        "",
      ].join("\n"),
    });
    expect(facts).toMatchObject({
      addedLines: 2,
      deletedLines: 2,
      normalizedProductionLines: 0,
      formattingOnly: true,
    });
  });

  it("still counts a reindented line that also changed", () => {
    const facts = collectPatchQualityFacts({
      contestantId: "codex",
      patch: [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,2 @@",
        "-const a = 1;",
        "-const b = 2;",
        "+    const a = 1;",
        "+    const b = 3;",
        "",
      ].join("\n"),
    });
    expect(facts).toMatchObject({
      normalizedProductionLines: 2,
      formattingOnly: false,
    });
  });

  it("records binary paths without crashing", () => {
    const facts = collectPatchQualityFacts({
      contestantId: "codex",
      patch:
        "diff --git a/assets/a.png b/assets/a.png\nBinary files a/assets/a.png and b/assets/a.png differ\n",
    });
    expect(facts.binaryPaths).toEqual(["assets/a.png"]);
  });
});
