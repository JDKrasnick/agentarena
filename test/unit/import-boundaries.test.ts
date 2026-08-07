import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface ImportEdge {
  source: string;
  target: string;
}

const SRC_ROOT = path.resolve(import.meta.dirname, "../../src");
const MECHANISM_DIRECTORIES = new Set([
  "agents",
  "artifacts",
  "attacks",
  "delivery",
  "maintenance",
  "methods",
  "outcomes",
  "permissions",
  "quality",
  "recommendation",
  "repo",
  "reports",
  "review",
  "runner",
  "task",
]);
const CORE_MECHANISM_MODULES = new Set([
  "core/scoring.ts",
  "core/state-machine.ts",
]);

const ARENA_MECHANISM_IMPORT_ALLOWLIST = new Set([
  "agents/adapter.ts",
  "agents/prompts.ts",
  "artifacts/store.ts",
  "attacks/case-bundle.ts",
  "attacks/evidence-revision.ts",
  "attacks/submission.ts",
  "attacks/validate.ts",
  "core/scoring.ts",
  "core/state-machine.ts",
  "delivery/target.ts",
  "maintenance/overlays.ts",
  "methods/catalog.ts",
  "outcomes/derive-outcome.ts",
  "permissions/policy.ts",
  "quality/collect-facts.ts",
  "quality/manifest-adapters.ts",
  "quality/verifier.ts",
  "recommendation/select-patch.ts",
  "repo/git.ts",
  "reports/console.ts",
  "reports/html.ts",
  "reports/markdown.ts",
  "reports/visual.ts",
  "review/prompt.ts",
  "runner/integration.ts",
  "runner/process-runner.ts",
  "task/pr-fixture.ts",
  "task/task-contract.ts",
]);

function relative(file: string): string {
  return path.relative(SRC_ROOT, file).split(path.sep).join("/");
}

function resolveLocalImport(source: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const resolved = path.resolve(path.dirname(source), specifier);
  return resolved.replace(/\.js$/, ".ts");
}

function importsOf(source: string): ImportEdge[] {
  const text = readFileSync(source, "utf8");
  return ts.preProcessFile(text).importedFiles.flatMap(({ fileName }) => {
    const target = resolveLocalImport(source, fileName);
    return target
      ? [{ source: relative(source), target: relative(target) }]
      : [];
  });
}

function isMechanismModule(file: string): boolean {
  const directory = file.split("/")[0];
  return (
    (directory ? MECHANISM_DIRECTORIES.has(directory) : false) ||
    CORE_MECHANISM_MODULES.has(file)
  );
}

function boundaryViolations(edges: ImportEdge[]): string[] {
  const violations: string[] = [];
  for (const edge of edges) {
    const sourceDirectory = edge.source.split("/")[0];
    const targetDirectory = edge.target.split("/")[0];
    if (
      isMechanismModule(edge.source) &&
      (edge.target === "core/arena.ts" ||
        edge.target === "core/round-engine.ts")
    ) {
      violations.push(
        `mechanism imports upward: ${edge.source} -> ${edge.target}`,
      );
    }
    if (
      sourceDirectory === "contracts" &&
      targetDirectory !== "contracts" &&
      edge.target !== "core/types.ts"
    ) {
      violations.push(
        `contract imports non-domain module: ${edge.source} -> ${edge.target}`,
      );
    }
    if (
      edge.source === "core/round-engine.ts" &&
      edge.target === "core/arena.ts"
    ) {
      violations.push(
        `RoundEngine imports Arena: ${edge.source} -> ${edge.target}`,
      );
    }
    if (
      edge.source === "core/arena.ts" &&
      isMechanismModule(edge.target) &&
      !ARENA_MECHANISM_IMPORT_ALLOWLIST.has(edge.target)
    ) {
      violations.push(
        `Arena mechanism import is not allowlisted: ${edge.target}`,
      );
    }
  }
  return violations;
}

describe("Arena/RoundEngine import boundaries", () => {
  it("enforces the current TypeScript import graph", () => {
    const sources = ts.sys.readDirectory(
      SRC_ROOT,
      [".ts"],
      undefined,
      undefined,
    );
    const edges = sources.flatMap(importsOf);
    expect(boundaryViolations(edges)).toEqual([]);

    const arenaImports = new Set(
      edges
        .filter(({ source }) => source === "core/arena.ts")
        .map(({ target }) => target)
        .filter(isMechanismModule),
    );
    expect(arenaImports).toEqual(ARENA_MECHANISM_IMPORT_ALLOWLIST);
  });

  it.each([
    { source: "attacks/bad.ts", target: "core/arena.ts" },
    { source: "runner/bad.ts", target: "core/round-engine.ts" },
    { source: "core/scoring.ts", target: "core/round-engine.ts" },
    { source: "contracts/bad.ts", target: "core/arena.ts" },
    { source: "core/round-engine.ts", target: "core/arena.ts" },
    { source: "core/arena.ts", target: "attacks/new-phase-service.ts" },
  ])("rejects representative upward or new Arena dependencies", (edge) => {
    expect(boundaryViolations([edge])).not.toEqual([]);
  });
});
