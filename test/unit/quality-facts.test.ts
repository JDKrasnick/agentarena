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
    expect(facts.formattingOnly).toBe(false);
  });

  it("reports completed zero-match heuristics as known", () => {
    const facts = collectPatchQualityFacts({
      contestantId: "codex",
      patch:
        "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+const value = 1;\n",
    });
    expect(facts.publicSurfaceChanges.status).toBe("known");
    expect(facts.publicSurfaceChanges.values).toEqual([]);
    expect(facts.operationalRequirementsAdded.status).toBe("known");
    expect(facts.operationalRequirementsAdded.values).toEqual([]);
  });

  it("hashes the original patch bytes", () => {
    const patchBytes = Buffer.from([
      ...Buffer.from(
        "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1 @@\n+",
      ),
      0xff,
      0x0a,
    ]);
    const facts = collectPatchQualityFacts({
      contestantId: "codex",
      patch: patchBytes.toString("utf8"),
      patchBytes,
    });
    const decodedFacts = collectPatchQualityFacts({
      contestantId: "codex",
      patch: patchBytes.toString("utf8"),
    });
    expect(facts.patchSha256).not.toBe(decodedFacts.patchSha256);
  });
});
