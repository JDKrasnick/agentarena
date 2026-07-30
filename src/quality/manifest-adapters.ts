import type { ManifestDelta } from "../core/types.js";

export interface ManifestAdapter {
  readonly ecosystem: string;
  supports(path: string): boolean;
  compare(
    path: string,
    baseContent: string,
    patchContent: string,
  ): ManifestDelta;
}

function added(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  return Object.keys(after)
    .filter((name) => !(name in before))
    .sort();
}

function jsonRecord(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const nested = record[key];
  return nested && typeof nested === "object"
    ? (nested as Record<string, unknown>)
    : {};
}

export class NpmManifestAdapter implements ManifestAdapter {
  readonly ecosystem = "npm";

  supports(path: string): boolean {
    return /(^|\/)package\.json$/.test(path);
  }

  compare(
    path: string,
    baseContent: string,
    patchContent: string,
  ): ManifestDelta {
    try {
      const before = JSON.parse(baseContent) as unknown;
      const after = JSON.parse(patchContent) as unknown;
      return {
        path,
        ecosystem: this.ecosystem,
        status: "known",
        runtimeAdded: added(
          jsonRecord(before, "dependencies"),
          jsonRecord(after, "dependencies"),
        ),
        developmentAdded: added(
          jsonRecord(before, "devDependencies"),
          jsonRecord(after, "devDependencies"),
        ),
        optionalAdded: added(
          jsonRecord(before, "optionalDependencies"),
          jsonRecord(after, "optionalDependencies"),
        ),
        evidence: [path],
      };
    } catch {
      return unknownManifest(path, this.ecosystem);
    }
  }
}

interface DependencyBuckets {
  runtime: Set<string>;
  development: Set<string>;
  optional: Set<string>;
}

function emptyBuckets(): DependencyBuckets {
  return {
    runtime: new Set(),
    development: new Set(),
    optional: new Set(),
  };
}

function addedSet(before: Set<string>, after: Set<string>): string[] {
  return [...after].filter((name) => !before.has(name)).sort();
}

class ParsedManifestAdapter implements ManifestAdapter {
  constructor(
    readonly ecosystem: string,
    private readonly matcher: RegExp,
    private readonly parse: (
      path: string,
      content: string,
    ) => DependencyBuckets,
  ) {}

  supports(path: string): boolean {
    return this.matcher.test(path);
  }

  compare(
    path: string,
    baseContent: string,
    patchContent: string,
  ): ManifestDelta {
    try {
      const before = this.parse(path, baseContent);
      const after = this.parse(path, patchContent);
      return {
        path,
        ecosystem: this.ecosystem,
        status: "known",
        runtimeAdded: addedSet(before.runtime, after.runtime),
        developmentAdded: addedSet(before.development, after.development),
        optionalAdded: addedSet(before.optional, after.optional),
        evidence: [path],
      };
    } catch {
      return unknownManifest(path, this.ecosystem);
    }
  }
}

function requirementName(value: string): string | undefined {
  return /^[\s"']*([A-Za-z0-9_.-]+)/u.exec(value)?.[1];
}

function parsePython(path: string, content: string): DependencyBuckets {
  const result = emptyBuckets();
  if (/requirements[^/]*\.txt$/i.test(path)) {
    const development = /(?:dev|test)/i.test(path);
    for (const line of content.split(/\r?\n/u)) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const name = requirementName(line);
      if (name) (development ? result.development : result.runtime).add(name);
    }
    return result;
  }
  let section = "";
  let arrayBucket: keyof DependencyBuckets | undefined;
  for (const raw of content.split(/\r?\n/u)) {
    const line = raw.trim();
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line);
    if (sectionMatch?.[1]) {
      section = sectionMatch[1].toLowerCase();
      arrayBucket = undefined;
      continue;
    }
    if (/^(dependencies|optional-dependencies)\s*=\s*\[/u.test(line)) {
      arrayBucket = line.startsWith("optional") ? "optional" : "runtime";
    }
    if (arrayBucket) {
      for (const match of line.matchAll(/["']([^"']+)["']/gu)) {
        const name = match[1] ? requirementName(match[1]) : undefined;
        if (name) result[arrayBucket].add(name);
      }
      if (line.includes("]")) arrayBucket = undefined;
      continue;
    }
    const assignment = /^([A-Za-z0-9_.-]+)\s*=/u.exec(line)?.[1];
    if (!assignment || assignment === "python") continue;
    if (section === "tool.poetry.dependencies") result.runtime.add(assignment);
    else if (
      section.includes("dev") ||
      section.includes("test") ||
      section === "dependency-groups"
    )
      result.development.add(assignment);
    else if (section.includes("optional")) result.optional.add(assignment);
  }
  return result;
}

function parseGo(_path: string, content: string): DependencyBuckets {
  const result = emptyBuckets();
  let inRequire = false;
  for (const raw of content.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "require (") {
      inRequire = true;
      continue;
    }
    if (inRequire && line === ")") {
      inRequire = false;
      continue;
    }
    const value = inRequire ? line : /^require\s+(.+)$/u.exec(line)?.[1];
    const name = value?.split(/\s/u)[0];
    if (name && !name.startsWith("//")) result.runtime.add(name);
  }
  return result;
}

function parseCargo(_path: string, content: string): DependencyBuckets {
  const result = emptyBuckets();
  let bucket: keyof DependencyBuckets | undefined;
  for (const raw of content.split(/\r?\n/u)) {
    const line = raw.trim();
    const section = /^\[([^\]]+)\]$/u.exec(line)?.[1]?.toLowerCase();
    if (section !== undefined) {
      bucket =
        section === "dependencies"
          ? "runtime"
          : section === "dev-dependencies" || section === "build-dependencies"
            ? "development"
            : undefined;
      continue;
    }
    const name = /^([A-Za-z0-9_-]+)\s*=/u.exec(line)?.[1];
    if (bucket && name) result[bucket].add(name);
  }
  return result;
}

function parseGemfile(_path: string, content: string): DependencyBuckets {
  const result = emptyBuckets();
  let developmentDepth = 0;
  for (const raw of content.split(/\r?\n/u)) {
    const line = raw.trim();
    if (/^group\s+.*:(?:development|test)/u.test(line)) {
      developmentDepth += 1;
      continue;
    }
    if (line === "end" && developmentDepth > 0) {
      developmentDepth -= 1;
      continue;
    }
    const name = /^gem\s+["']([^"']+)/u.exec(line)?.[1];
    if (name)
      (developmentDepth > 0 ? result.development : result.runtime).add(name);
  }
  return result;
}

export function unknownManifest(
  path: string,
  ecosystem = "unsupported",
): ManifestDelta {
  return {
    path,
    ecosystem,
    status: "unknown",
    runtimeAdded: [],
    developmentAdded: [],
    optionalAdded: [],
    evidence: [path],
  };
}

export const manifestAdapters: readonly ManifestAdapter[] = [
  new NpmManifestAdapter(),
  new ParsedManifestAdapter(
    "python",
    /(^|\/)(pyproject\.toml|requirements[^/]*\.txt)$/i,
    parsePython,
  ),
  new ParsedManifestAdapter("go", /(^|\/)go\.mod$/, parseGo),
  new ParsedManifestAdapter("rust", /(^|\/)Cargo\.toml$/, parseCargo),
  new ParsedManifestAdapter("ruby", /(^|\/)Gemfile$/, parseGemfile),
];

export function isManifestPath(path: string): boolean {
  return (
    manifestAdapters.some((adapter) => adapter.supports(path)) ||
    /(^|\/)[^/]*\.(?:toml|mod)$/i.test(path)
  );
}

export function compareManifest(
  path: string,
  baseContent: string | undefined,
  patchContent: string | undefined,
): ManifestDelta | undefined {
  const adapter = manifestAdapters.find((candidate) =>
    candidate.supports(path),
  );
  if (!adapter) return isManifestPath(path) ? unknownManifest(path) : undefined;
  if (baseContent === undefined && patchContent === undefined)
    return unknownManifest(path, adapter.ecosystem);
  return adapter.compare(path, baseContent ?? "", patchContent ?? "");
}
