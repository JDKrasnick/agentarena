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

const ARENA_MECHANISM_IMPORT_ALLOWLIST = new Set<string>();

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

function mechanismUpwardViolations(edges: ImportEdge[]): string[] {
  const dependencies = new Map<string, string[]>();
  for (const { source, target } of edges) {
    dependencies.set(source, [...(dependencies.get(source) ?? []), target]);
  }
  const forbidden = new Set(["core/arena.ts", "core/round-engine.ts"]);
  const violations: string[] = [];
  for (const source of new Set(edges.map(({ source }) => source))) {
    if (!isMechanismModule(source)) continue;
    const pending = [{ module: source, path: [source] }];
    const visited = new Set([source]);
    while (pending.length > 0) {
      const current = pending.shift();
      if (!current) break;
      for (const target of dependencies.get(current.module) ?? []) {
        const importPath = [...current.path, target];
        if (forbidden.has(target)) {
          violations.push(
            `mechanism imports upward: ${importPath.join(" -> ")}`,
          );
          pending.length = 0;
          break;
        }
        if (!visited.has(target)) {
          visited.add(target);
          pending.push({ module: target, path: importPath });
        }
      }
    }
  }
  return violations;
}

function boundaryViolations(edges: ImportEdge[]): string[] {
  const violations = mechanismUpwardViolations(edges);
  for (const edge of edges) {
    const sourceDirectory = edge.source.split("/")[0];
    const targetDirectory = edge.target.split("/")[0];
    if (
      sourceDirectory === "contracts" &&
      targetDirectory !== "contracts" &&
      targetDirectory !== "effort" &&
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

  it("rejects transitive upward dependencies through barrels", () => {
    expect(
      boundaryViolations([
        { source: "attacks/bad.ts", target: "index.ts" },
        { source: "index.ts", target: "core/arena.ts" },
      ]),
    ).toContain(
      "mechanism imports upward: attacks/bad.ts -> index.ts -> core/arena.ts",
    );
  });
});
