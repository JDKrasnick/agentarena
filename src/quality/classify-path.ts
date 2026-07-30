export type PathKind =
  "production" | "test" | "generated" | "vendor" | "lockfile" | "documentation";

export interface PathClassificationOverrides {
  test?: RegExp[];
  generated?: RegExp[];
  vendor?: RegExp[];
  lockfile?: RegExp[];
  documentation?: RegExp[];
}

const DEFAULTS: Record<Exclude<PathKind, "production">, RegExp[]> = {
  test: [
    /(^|\/)(__tests__|test|tests|spec|specs|fixtures)(\/|$)/i,
    /\.(?:test|spec)\.[^.]+$/i,
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
    "test",
    "generated",
    "vendor",
    "lockfile",
    "documentation",
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
