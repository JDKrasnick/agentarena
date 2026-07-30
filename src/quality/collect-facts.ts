import { createHash } from "node:crypto";
import {
  PatchQualityFactsSchema,
  type ContestantId,
  type PatchQualityFacts,
} from "../core/types.js";
import {
  classifyPath,
  type PathClassificationOverrides,
} from "./classify-path.js";
import { compareManifest } from "./manifest-adapters.js";
import { parseGitDiffHeader } from "../repo/git.js";

export interface CollectPatchFactsInput {
  contestantId: ContestantId;
  patch: string;
  patchBytes?: Uint8Array;
  baseContent?: Readonly<Record<string, string>>;
  patchedContent?: Readonly<Record<string, string>>;
  classification?: PathClassificationOverrides;
}

interface DiffFile {
  path: string;
  added: number;
  deleted: number;
  normalized: number;
  binary: boolean;
  addedText: string[];
  deletedText: string[];
}

function whitespaceInsensitiveKey(line: string): string {
  return line.replace(/\s+/gu, "");
}

function countNormalizedChanges(file: DiffFile): number {
  const unmatchedDeletions = new Map<string, number>();
  for (const line of file.deletedText) {
    const key = whitespaceInsensitiveKey(line);
    if (!key) continue;
    unmatchedDeletions.set(key, (unmatchedDeletions.get(key) ?? 0) + 1);
  }
  let changes = 0;
  for (const line of file.addedText) {
    const key = whitespaceInsensitiveKey(line);
    if (!key) continue;
    const available = unmatchedDeletions.get(key) ?? 0;
    if (available > 0) unmatchedDeletions.set(key, available - 1);
    else changes += 1;
  }
  return [...unmatchedDeletions.values()].reduce(
    (total, count) => total + count,
    changes,
  );
}

function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  for (const line of patch.split(/\r?\n/u)) {
    const header = parseGitDiffHeader(line);
    if (header) {
      current = {
        path: header.after,
        added: 0,
        deleted: 0,
        normalized: 0,
        binary: false,
        addedText: [],
        deletedText: [],
      };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (
      line.startsWith("Binary files ") ||
      line.startsWith("GIT binary patch")
    ) {
      current.binary = true;
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) {
      current.added += 1;
      current.addedText.push(line.slice(1));
    } else if (line.startsWith("-")) {
      current.deleted += 1;
      current.deletedText.push(line.slice(1));
    }
  }
  for (const file of files) file.normalized = countNormalizedChanges(file);
  return files;
}

function matchingPaths(files: DiffFile[], pattern: RegExp): string[] {
  return files
    .filter((file) => file.addedText.some((line) => pattern.test(line)))
    .map((file) => file.path);
}

export function collectPatchQualityFacts(
  input: CollectPatchFactsInput,
): PatchQualityFacts {
  const files = parsePatch(input.patch);
  const classified = files.map((file) => ({
    ...file,
    kind: classifyPath(file.path, input.classification),
  }));
  const manifestDeltas = files.flatMap((file) => {
    const delta = compareManifest(
      file.path,
      input.baseContent?.[file.path],
      input.patchedContent?.[file.path],
    );
    return delta ? [delta] : [];
  });
  const publicSurface = matchingPaths(
    files,
    /\b(export|public|interface|type|class|def|func|pub)\b/u,
  );
  const operational = matchingPaths(
    files,
    /\b(process\.env|os\.environ|ENV\[|port|permission|service|migration|schema)\b/iu,
  );
  const verification = classified
    .filter((file) => file.kind === "test")
    .map((file) => file.path);
  const observability = matchingPaths(
    files,
    /\b(log(?:ger)?|metric|trace|health|readiness|audit)\b/iu,
  );
  const risks = files.flatMap((file) => {
    const text = file.addedText.join("\n");
    const values: string[] = [];
    if (
      /\b(secret|token|password|api[_-]?key)\b\s*[:=]\s*["'][^"']+/iu.test(text)
    )
      values.push(`${file.path}: possible embedded secret`);
    if (/metric.*(?:user|request|session).*(?:label|tag)/iu.test(text))
      values.push(`${file.path}: possible unbounded metric labels`);
    if (/(?:console\.log|logger\.\w+).*(?:for|while|map)\b/iu.test(text))
      values.push(`${file.path}: possible noisy logging`);
    return values;
  });
  const production = classified.filter((file) => file.kind === "production");
  const formattingOnly =
    files.length > 0 &&
    files.every((file) => !file.binary && file.normalized === 0);

  return PatchQualityFactsSchema.parse({
    version: 1,
    contestantId: input.contestantId,
    patchSha256: createHash("sha256")
      .update(input.patchBytes ?? Buffer.from(input.patch, "utf8"))
      .digest("hex"),
    changedPaths: files.map((file) => file.path),
    binaryPaths: files.filter((file) => file.binary).map((file) => file.path),
    productionFilesChanged: production.length,
    testFilesChanged: classified.filter((file) => file.kind === "test").length,
    generatedFilesChanged: classified.filter(
      (file) => file.kind === "generated",
    ).length,
    vendorFilesChanged: classified.filter((file) => file.kind === "vendor")
      .length,
    lockfilesChanged: classified.filter((file) => file.kind === "lockfile")
      .length,
    documentationFilesChanged: classified.filter(
      (file) => file.kind === "documentation",
    ).length,
    addedLines: files.reduce((total, file) => total + file.added, 0),
    deletedLines: files.reduce((total, file) => total + file.deleted, 0),
    normalizedProductionLines: production.reduce(
      (total, file) => total + file.normalized,
      0,
    ),
    formattingOnly,
    manifestDeltas,
    publicSurfaceChanges: {
      status: "known",
      values: publicSurface,
      evidencePaths: publicSurface,
    },
    operationalRequirementsAdded: {
      status: "known",
      values: operational,
      evidencePaths: operational,
    },
    verificationEvidence: verification,
    observabilityChanges: observability,
    observabilityRisks: risks,
    evidence: files.map((file) => file.path),
  });
}
