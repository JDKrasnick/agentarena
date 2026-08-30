import type { PatchQualityFacts } from "../core/types.js";

export const QUALITY_CATEGORY_ORDER = [
  "production",
  "test",
  "fixture",
  "manifest",
  "documentation",
  "generated",
  "vendor",
  "lockfile",
] as const;

export function qualityCategoryRows(facts: PatchQualityFacts | undefined) {
  if (!facts || facts.version !== 2) return [];
  return QUALITY_CATEGORY_ORDER.map((category) => ({
    category,
    ...facts.categories[category],
  }));
}
