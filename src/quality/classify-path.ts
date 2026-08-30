export type PathKind =
  | "production"
  | "test"
  | "fixture"
  | "manifest"
  | "documentation"
  | "generated"
  | "vendor"
  | "lockfile";

export interface PathClassificationOverrides {
  test?: RegExp[];
  fixture?: RegExp[];
  manifest?: RegExp[];
  generated?: RegExp[];
  vendor?: RegExp[];
  lockfile?: RegExp[];
  documentation?: RegExp[];
}

const DEFAULTS: Record<Exclude<PathKind, "production">, RegExp[]> = {
  test: [
    /(^|\/)(__tests__|test|tests|spec|specs)(\/|$)/i,
    /\.(?:test|spec)\.[^.]+$/i,
    /(^|\/)(?:test|spec)\.[^./]+$/i,
    /(^|\/)(?:test_[^/]+|[^/]+_(?:test|spec))(?:\.[^/]+)?$/i,
    /(^|\/)[^/]+Tests?\.(?:java|cs|fs|vb)$/i,
  ],
  fixture: [/(^|\/)(?:fixtures?|testdata|snapshots?|__snapshots__)(\/|$)/i],
  manifest: [
    /(^|\/)(?:package\.json|Cargo\.toml|pyproject\.toml|requirements(?:-[^/]+)?\.txt|Pipfile|Gemfile|composer\.json|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.(?:csproj|fsproj|vbproj))$/i,
  ],
  generated: [/(^|\/)(dist|build|coverage|generated)(\/|$)/i, /\.generated\./i],
  vendor: [/(^|\/)(vendor|third_party|node_modules)(\/|$)/i],
  lockfile: [
    /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock)$/i,
  ],
  documentation: [/(^|\/)(docs?|examples?)(\/|$)/i, /\.(?:md|mdx|rst|txt)$/i],
};

export function classifyPath(
  filePath: string,
  overrides: PathClassificationOverrides = {},
): PathKind {
  for (const kind of [
    "vendor",
    "lockfile",
    "generated",
    "manifest",
    "documentation",
    "fixture",
    "test",
  ] as const) {
    if (
      [...DEFAULTS[kind], ...(overrides[kind] ?? [])].some((rule) =>
        rule.test(filePath),
      )
    )
      return kind;
  }
  return "production";
}
