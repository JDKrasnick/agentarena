import { describe, expect, it } from "vitest";
import { collectPatchQualityFacts } from "../../src/quality/collect-facts.js";
import { PatchQualityFactsSchema } from "../../src/core/types.js";

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
      contestantId: "a",
      patch,
    });
    expect(facts).toMatchObject({
      version: 2,
      categories: {
        production: { filesChanged: 1, normalizedLines: 1 },
        test: { filesChanged: 1, normalizedLines: 1 },
        documentation: { filesChanged: 1, normalizedLines: 1 },
        lockfile: { filesChanged: 1, normalizedLines: 1 },
      },
    });
  });

  it("ignores whitespace-only reformatting", () => {
    const facts = collectPatchQualityFacts({
      contestantId: "a",
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
      totals: { addedLines: 2, deletedLines: 2, normalizedLines: 0 },
      categories: { production: { normalizedLines: 0 } },
      formattingOnly: true,
    });
  });

  it("still counts a reindented line that also changed", () => {
    const facts = collectPatchQualityFacts({
      contestantId: "a",
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
      categories: { production: { normalizedLines: 2 } },
      formattingOnly: false,
    });
  });

  it("records binary paths without crashing", () => {
    const facts = collectPatchQualityFacts({
      contestantId: "a",
      patch:
        "diff --git a/assets/a.png b/assets/a.png\nBinary files a/assets/a.png and b/assets/a.png differ\n",
    });
    expect(facts.version).toBe(2);
    if (facts.version !== 2) throw new Error("expected v2 facts");
    expect(facts.totals.binaryPaths).toEqual(["assets/a.png"]);
    expect(facts.formattingOnly).toBe(false);
  });

  it.each([
    "test.ts",
    "spec.mjs",
    "thing.test.tsx",
    "thing.spec.cjs",
    "test_parser.py",
    "parser_test.go",
    "parser_spec.rb",
    "ParserTest.java",
    "ParserTests.cs",
  ])("classifies conservative root test convention %s", (filePath) => {
    const facts = collectPatchQualityFacts({
      contestantId: "a",
      patch: `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -0,0 +1 @@\n+test body\n`,
    });
    expect(facts).toMatchObject({ categories: { test: { filesChanged: 1 } } });
  });

  it("keeps generic test substrings such as contest.ts in production", () => {
    const facts = collectPatchQualityFacts({
      contestantId: "a",
      patch:
        "diff --git a/contest.ts b/contest.ts\n--- a/contest.ts\n+++ b/contest.ts\n@@ -0,0 +1 @@\n+export const contest = true;\n",
    });
    expect(facts).toMatchObject({
      categories: {
        production: { filesChanged: 1 },
        test: { filesChanged: 0 },
      },
    });
  });

  it("uses category precedence and keeps observability as an overlapping heuristic", () => {
    const patch = [
      "vendor/generated.test.ts",
      "fixtures/case.test.ts",
      "docs/example.test.ts",
      "package.json",
    ]
      .map(
        (filePath) =>
          `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -0,0 +1 @@\n+logger.audit('health');`,
      )
      .join("\n");
    const facts = collectPatchQualityFacts({ contestantId: "a", patch });
    expect(facts).toMatchObject({
      categories: {
        vendor: { filesChanged: 1 },
        fixture: { filesChanged: 1 },
        documentation: { filesChanged: 1 },
        manifest: { filesChanged: 1 },
        test: { filesChanged: 0 },
        production: { filesChanged: 0 },
      },
      facets: {
        observability: {
          status: "heuristic",
          filesChanged: 4,
          matchedAddedLines: 4,
        },
      },
    });
  });

  it("reports completed zero-match heuristics as known", () => {
    const facts = collectPatchQualityFacts({
      contestantId: "a",
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
      contestantId: "a",
      patch: patchBytes.toString("utf8"),
      patchBytes,
    });
    const decodedFacts = collectPatchQualityFacts({
      contestantId: "a",
      patch: patchBytes.toString("utf8"),
    });
    expect(facts.patchSha256).not.toBe(decodedFacts.patchSha256);
  });

  it("reads stored v1 facts without reclassifying them", () => {
    const stored = {
      version: 1 as const,
      contestantId: "a" as const,
      patchSha256: "a".repeat(64),
      changedPaths: ["fixtures/legacy.test.ts"],
      binaryPaths: [],
      productionFilesChanged: 0,
      testFilesChanged: 1,
      generatedFilesChanged: 0,
      vendorFilesChanged: 0,
      lockfilesChanged: 0,
      documentationFilesChanged: 0,
      addedLines: 1,
      deletedLines: 0,
      normalizedProductionLines: 0,
      formattingOnly: false,
      manifestDeltas: [],
      publicSurfaceChanges: {
        status: "known" as const,
        values: [],
        evidencePaths: [],
      },
      operationalRequirementsAdded: {
        status: "known" as const,
        values: [],
        evidencePaths: [],
      },
      verificationEvidence: ["fixtures/legacy.test.ts"],
      observabilityChanges: [],
      observabilityRisks: [],
      evidence: ["fixtures/legacy.test.ts"],
    };
    expect(PatchQualityFactsSchema.parse(stored)).toEqual(stored);
  });

  it("shows why a smaller total patch cannot decide production minimality", () => {
    const diff = (filePath: string, lines: number) =>
      [
        `diff --git a/${filePath} b/${filePath}`,
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        `@@ -0,0 +1,${String(lines)} @@`,
        ...Array.from(
          { length: lines },
          (_, index) => `+line ${String(index)}`,
        ),
      ].join("\n");
    const smallerTotal = collectPatchQualityFacts({
      contestantId: "a",
      patch: [diff("src/change.ts", 8), diff("test/change.test.ts", 1)].join(
        "\n",
      ),
    });
    const strongerTests = collectPatchQualityFacts({
      contestantId: "b",
      patch: [diff("src/change.ts", 2), diff("test/change.test.ts", 20)].join(
        "\n",
      ),
    });
    if (smallerTotal.version !== 2 || strongerTests.version !== 2)
      throw new Error("expected v2 facts");

    expect(smallerTotal.totals.normalizedLines).toBeLessThan(
      strongerTests.totals.normalizedLines,
    );
    expect(smallerTotal.categories.production.normalizedLines).toBeGreaterThan(
      strongerTests.categories.production.normalizedLines,
    );
  });
});
