import { z } from "zod";
import {
  AttackSubmissionEntrySchema,
  BugCategorySchema,
  CaseSubmissionSchema,
  HouseSubmissionSchema,
  ReviewFindingSchema,
  type AttackSubmission,
  type CaseSubmission,
  type HouseSubmission,
  type ReviewSubmission,
} from "../core/types.js";

export const SUBMISSION_PARSER_VERSION = 1 as const;

const LegacyAttackEntrySchema = AttackSubmissionEntrySchema.omit({
  focusedCommand: true,
  paths: true,
}).extend({ reproduction: z.string().min(1) });

export type SubmissionKind = "review" | "attack" | "house" | "case";
export type ParseOutcome = "valid" | "valid_empty" | "partial" | "invalid";
export type EntryOutcome = "accepted" | "normalized" | "rejected";

export interface SubmissionNormalization {
  path: string;
  original: unknown;
  normalized: unknown;
  rule: string;
}

export interface SubmissionRejection {
  path: string;
  received: string;
  code: string;
  message: string;
  allowedValues?: string[];
}

export interface ParsedEntry<T = unknown> {
  index: number;
  path: string;
  outcome: EntryOutcome;
  value?: T;
  validatedFields: Record<string, unknown>;
  editablePaths: string[];
  rejections: SubmissionRejection[];
  normalizations: SubmissionNormalization[];
}

export interface ParsedSection<T = unknown> {
  path: string;
  outcome: ParseOutcome;
  entries: ParsedEntry<T>[];
  accepted: T[];
  rejections: SubmissionRejection[];
}

export interface ParsedSubmission<T> {
  parserVersion: typeof SUBMISSION_PARSER_VERSION;
  kind: SubmissionKind;
  outcome: ParseOutcome;
  rawSha256?: string;
  value: T;
  sections: Record<string, ParsedSection>;
  rejections: SubmissionRejection[];
  normalizations: SubmissionNormalization[];
}

const secretPattern =
  /(?:password|passwd|secret|token|credential|api[_-]?key)/i;

/** Render provider-controlled values without leaking likely secrets or flooding logs. */
export function safelyRenderReceived(path: string, value: unknown): string {
  if (secretPattern.test(path)) return "[REDACTED]";
  let rendered: string;
  try {
    rendered = JSON.stringify(value) ?? String(value);
  } catch {
    rendered = "[UNRENDERABLE]";
  }
  return rendered.length > 240 ? `${rendered.slice(0, 237)}...` : rendered;
}

export function mergeCorrectionFields(
  validatedFields: Readonly<Record<string, unknown>>,
  fields: unknown,
):
  | { accepted: true; value: Record<string, unknown> }
  | {
      accepted: false;
      code: "malformed_correction" | "frozen_field_tampering";
    } {
  if (!fields || typeof fields !== "object" || Array.isArray(fields))
    return { accepted: false, code: "malformed_correction" };
  const correction = fields as Record<string, unknown>;
  const merged = mergeFrozenFields(validatedFields, correction);
  if (!merged.accepted)
    return { accepted: false, code: "frozen_field_tampering" };
  return { accepted: true, value: merged.value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeFrozenFields(
  validatedFields: Readonly<Record<string, unknown>>,
  correction: Readonly<Record<string, unknown>>,
): { accepted: true; value: Record<string, unknown> } | { accepted: false } {
  const value: Record<string, unknown> = { ...correction };
  for (const [key, frozen] of Object.entries(validatedFields)) {
    if (isRecord(frozen)) {
      const supplied = correction[key];
      if (key in correction && !isRecord(supplied)) return { accepted: false };
      const nested = mergeFrozenFields(
        frozen,
        isRecord(supplied) ? supplied : {},
      );
      if (!nested.accepted) return nested;
      value[key] = nested.value;
      continue;
    }
    if (
      key in correction &&
      JSON.stringify(correction[key]) !== JSON.stringify(frozen)
    )
      return { accepted: false };
    value[key] = frozen;
  }
  return { accepted: true, value };
}

/** Missing required scoring fields cannot be invented during correction. */
export function isCorrectionEligible(entry: ParsedEntry): boolean {
  return (
    entry.outcome === "rejected" &&
    entry.rejections.length > 0 &&
    Object.keys(entry.validatedFields).length > 0 &&
    entry.rejections.every(
      (rejection) =>
        rejection.code !== "position_limit" &&
        rejection.received !== "undefined",
    )
  );
}

function jsonPath(parts: PropertyKey[]): string {
  return parts.reduce<string>((result, part) => {
    if (typeof part === "number") return `${result}[${String(part)}]`;
    const key = String(part);
    return /^[A-Za-z_$][\w$]*$/.test(key)
      ? `${result}.${key}`
      : `${result}[${JSON.stringify(key)}]`;
  }, "$");
}

function allowedValues(issue: z.core.$ZodIssue): string[] | undefined {
  if (issue.code !== "invalid_value") return undefined;
  const values = issue.values;
  return values.map(String);
}

function zodRejections(
  error: z.ZodError,
  received: unknown,
  prefix: PropertyKey[],
): SubmissionRejection[] {
  return error.issues.map((issue) => {
    const path = [...prefix, ...issue.path];
    let atPath = received;
    for (const part of issue.path) {
      if (atPath === null || typeof atPath !== "object") {
        atPath = undefined;
        break;
      }
      atPath = (atPath as Record<PropertyKey, unknown>)[part];
    }
    const allowed = allowedValues(issue);
    return {
      path: jsonPath(path),
      received: safelyRenderReceived(jsonPath(path), atPath),
      code: issue.code,
      message: issue.message,
      ...(allowed ? { allowedValues: allowed } : {}),
    };
  });
}

function reject(
  path: string,
  received: unknown,
  code: string,
  message: string,
  allowed?: string[],
): SubmissionRejection {
  return {
    path,
    received: safelyRenderReceived(path, received),
    code,
    message,
    ...(allowed ? { allowedValues: allowed } : {}),
  };
}

function extractJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch (originalError) {
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
    if (fenced) return JSON.parse(fenced);
    const start = source.search(/{/);
    const end = source.lastIndexOf("}");
    if (start >= 0 && end > start)
      return JSON.parse(source.slice(start, end + 1));
    throw originalError;
  }
}

function normalizeEntry(
  value: unknown,
  prefix: PropertyKey[],
): { value: unknown; normalizations: SubmissionNormalization[] } {
  const normalizations: SubmissionNormalization[] = [];
  const visit = (current: unknown, path: PropertyKey[]): unknown => {
    if (Array.isArray(current))
      return current.map((entry, index) => visit(entry, [...path, index]));
    if (current && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current).map(([key, entry]) => [
          key,
          visit(entry, [...path, key]),
        ]),
      );
    }
    if (typeof current !== "string") return current;
    const key = String(path.at(-1) ?? "");
    if (key === "proposedSeverity") {
      const normalized = current.trim().toLowerCase();
      if (
        ["critical", "high", "medium", "low"].includes(normalized) &&
        normalized !== current
      ) {
        normalizations.push({
          path: jsonPath(path),
          original: current,
          normalized,
          rule: "v1.enum.proposedSeverity.casefold_trim",
        });
        return normalized;
      }
    }
    if (key === "category") {
      const normalized = current.trim().toLowerCase();
      const alias =
        normalized === "state" || normalized === "lifecycle"
          ? "state_lifecycle"
          : normalized;
      if (BugCategorySchema.safeParse(alias).success && alias !== current) {
        normalizations.push({
          path: jsonPath(path),
          original: current,
          normalized: alias,
          rule:
            normalized === alias
              ? "v1.enum.category.casefold_trim"
              : "v1.enum.category.state_lifecycle_alias",
        });
        return alias;
      }
    }
    return current;
  };
  return { value: visit(value, prefix), normalizations };
}

function collectValidatedFields(
  schema: z.ZodObject<Record<string, z.ZodType>>,
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const shape = schema.shape;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, fieldValue]) => {
      const fieldSchema = shape[key];
      if (!fieldSchema) return [];
      const parsed = fieldSchema.safeParse(fieldValue);
      if (parsed.success) return [[key, parsed.data]];
      if (fieldSchema instanceof z.ZodObject) {
        const nested = collectValidatedFields(fieldSchema, fieldValue);
        if (Object.keys(nested).length) return [[key, nested]];
      }
      return [];
    }),
  );
}

function parseEntries<T>(options: {
  envelope: Record<string, unknown>;
  key: string;
  schema: z.ZodType<T>;
  fieldSchema?: z.ZodObject;
  limit: number;
  duplicateRanks?: boolean;
}): ParsedSection<T> {
  const sectionPath = `$.${options.key}`;
  const raw = options.envelope[options.key];
  if (!Array.isArray(raw)) {
    const rejection = reject(
      sectionPath,
      raw,
      "invalid_type",
      "Expected an array",
    );
    return {
      path: sectionPath,
      outcome: "invalid",
      entries: [],
      accepted: [],
      rejections: [rejection],
    };
  }
  const duplicateRanks = new Set<number>();
  if (options.duplicateRanks) {
    const counts = new Map<number, number>();
    for (const entry of raw) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const rank = (entry as Record<string, unknown>).rank;
        if (typeof rank === "number")
          counts.set(rank, (counts.get(rank) ?? 0) + 1);
      }
    }
    for (const [rank, count] of counts) if (count > 1) duplicateRanks.add(rank);
  }
  const entries: ParsedEntry<T>[] = raw.map((original, index) => {
    const prefix: PropertyKey[] = [options.key, index];
    if (index >= options.limit) {
      const rejection = reject(
        jsonPath(prefix),
        original,
        "position_limit",
        `Only the first ${String(options.limit)} submitted positions are considered`,
      );
      return {
        index,
        path: jsonPath(prefix),
        outcome: "rejected",
        validatedFields: {},
        editablePaths: [jsonPath(prefix)],
        rejections: [rejection],
        normalizations: [],
      };
    }
    const normalized = normalizeEntry(original, prefix);
    const rank =
      normalized.value && typeof normalized.value === "object"
        ? (normalized.value as Record<string, unknown>).rank
        : undefined;
    const parsed = options.schema.safeParse(normalized.value);
    if (typeof rank === "number" && duplicateRanks.has(rank)) {
      const rejections = [
        reject(
          `${jsonPath(prefix)}.rank`,
          rank,
          "duplicate_rank",
          `Rank ${String(rank)} is duplicated; every entry with that rank is rejected`,
        ),
        ...(parsed.success
          ? []
          : zodRejections(parsed.error, normalized.value, prefix)),
      ];
      const validatedFields = options.fieldSchema
        ? collectValidatedFields(options.fieldSchema, normalized.value)
        : {};
      delete validatedFields.rank;
      return {
        index,
        path: jsonPath(prefix),
        outcome: "rejected",
        validatedFields,
        editablePaths: [
          ...new Set([
            `${jsonPath(prefix)}.rank`,
            ...rejections.map((entry) => entry.path),
          ]),
        ],
        rejections,
        normalizations: normalized.normalizations,
      };
    }
    if (!parsed.success) {
      const rejections = zodRejections(parsed.error, normalized.value, prefix);
      return {
        index,
        path: jsonPath(prefix),
        outcome: "rejected",
        validatedFields: options.fieldSchema
          ? collectValidatedFields(options.fieldSchema, normalized.value)
          : {},
        editablePaths: [...new Set(rejections.map((entry) => entry.path))],
        rejections,
        normalizations: normalized.normalizations,
      };
    }
    return {
      index,
      path: jsonPath(prefix),
      outcome: normalized.normalizations.length ? "normalized" : "accepted",
      value: parsed.data,
      validatedFields:
        parsed.data && typeof parsed.data === "object"
          ? (parsed.data as Record<string, unknown>)
          : {},
      editablePaths: [],
      rejections: [],
      normalizations: normalized.normalizations,
    };
  });
  const accepted = entries.flatMap((entry) =>
    entry.value === undefined ? [] : [entry.value],
  );
  const rejections = entries.flatMap((entry) => entry.rejections);
  return {
    path: sectionPath,
    outcome: rejections.length
      ? accepted.length
        ? "partial"
        : "invalid"
      : accepted.length
        ? "valid"
        : "valid_empty",
    entries,
    accepted,
    rejections,
  };
}

function invalidSubmission<T>(
  kind: SubmissionKind,
  value: T,
  rejection: SubmissionRejection,
): ParsedSubmission<T> {
  return {
    parserVersion: SUBMISSION_PARSER_VERSION,
    kind,
    outcome: "invalid",
    value,
    sections: {},
    rejections: [rejection],
    normalizations: [],
  };
}

function overall(
  sections: ParsedSection[],
  scoringKeys: string[],
  sectionMap: Record<string, ParsedSection>,
): ParseOutcome {
  const scoring = scoringKeys
    .map((key) => sectionMap[key])
    .filter((section): section is ParsedSection => section !== undefined);
  const accepted = scoring.reduce(
    (count, section) => count + section.accepted.length,
    0,
  );
  const rejected = sections.reduce(
    (count, section) => count + section.rejections.length,
    0,
  );
  if (rejected) return accepted ? "partial" : "invalid";
  return accepted ? "valid" : "valid_empty";
}

export function parseFaultIsolatedSubmission(
  kind: "review",
  source: string,
): ParsedSubmission<ReviewSubmission>;
export function parseFaultIsolatedSubmission(
  kind: "attack",
  source: string,
): ParsedSubmission<AttackSubmission>;
export function parseFaultIsolatedSubmission(
  kind: "house",
  source: string,
): ParsedSubmission<HouseSubmission>;
export function parseFaultIsolatedSubmission(
  kind: "case",
  source: string,
): ParsedSubmission<CaseSubmission>;
export function parseFaultIsolatedSubmission(
  kind: SubmissionKind,
  source: string,
): ParsedSubmission<
  ReviewSubmission | AttackSubmission | HouseSubmission | CaseSubmission
> {
  const empty =
    kind === "review"
      ? { version: 1 as const, findings: [] }
      : kind === "attack"
        ? { version: 2 as const, sharedSupportPaths: [], attacks: [] }
        : kind === "house"
          ? { version: 1 as const, hypotheses: [], attacks: [] }
          : { version: 1 as const, cases: [] };
  let decoded: unknown;
  try {
    decoded = extractJson(source);
  } catch {
    return invalidSubmission(
      kind,
      empty,
      reject(
        "$",
        "[unparseable bytes]",
        "invalid_json",
        "Submission did not contain parseable JSON",
      ),
    );
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
    return invalidSubmission(
      kind,
      empty,
      reject(
        "$",
        decoded,
        "invalid_envelope",
        "Submission envelope must be an object",
      ),
    );
  const envelope = decoded as Record<string, unknown>;
  const supportedVersions = kind === "attack" ? [1, 2] : [1];
  if (!supportedVersions.includes(Number(envelope.version)))
    return invalidSubmission(
      kind,
      empty,
      reject(
        "$.version",
        envelope.version,
        "unsupported_version",
        `Only submission version ${supportedVersions.join(" or ")} is supported`,
        supportedVersions.map(String),
      ),
    );

  const sections: Record<string, ParsedSection> = {};
  if (kind === "review") {
    sections.findings = parseEntries({
      envelope,
      key: "findings",
      schema: ReviewFindingSchema,
      fieldSchema: ReviewFindingSchema,
      limit: 12,
    });
  } else if (kind === "attack") {
    sections.attacks = parseEntries<unknown>({
      envelope,
      key: "attacks",
      schema: (envelope.version === 1
        ? LegacyAttackEntrySchema
        : AttackSubmissionEntrySchema) as z.ZodType<unknown>,
      fieldSchema:
        envelope.version === 1
          ? LegacyAttackEntrySchema
          : AttackSubmissionEntrySchema,
      limit: Number.MAX_SAFE_INTEGER,
      duplicateRanks: true,
    });
    const shared = z
      .array(z.string().min(1))
      .safeParse(
        envelope.version === 1 ? [] : (envelope.sharedSupportPaths ?? []),
      );
    sections.sharedSupportPaths = shared.success
      ? {
          path: "$.sharedSupportPaths",
          outcome: shared.data.length ? "valid" : "valid_empty",
          entries: [],
          accepted: shared.data,
          rejections: [],
        }
      : {
          path: "$.sharedSupportPaths",
          outcome: "invalid",
          entries: [],
          accepted: [],
          rejections: zodRejections(shared.error, envelope.sharedSupportPaths, [
            "sharedSupportPaths",
          ]),
        };
    // Contestant hypotheses are legacy, non-scoring input. Their shape cannot
    // invalidate or improve attack coverage.
    if ("hypotheses" in envelope) {
      const raw = envelope.hypotheses;
      sections.hypotheses = {
        path: "$.hypotheses",
        outcome:
          Array.isArray(raw) && raw.length === 0 ? "valid_empty" : "valid",
        entries: [],
        accepted: [],
        rejections: [],
      };
    }
    const attacks = sections.attacks;
    if (envelope.version === 2 && attacks) {
      const invalid = new Map<number, SubmissionRejection[]>();
      if (!shared.success) {
        for (const entry of attacks.entries) {
          invalid.set(entry.index, [
            reject(
              "$.sharedSupportPaths",
              envelope.sharedSupportPaths,
              "invalid_shared_support",
              "Invalid shared support rejects every dependent attack",
            ),
          ]);
        }
      } else {
        const pathOwners = new Map<string, number[]>();
        for (const entry of attacks.entries) {
          const entryValue = entry.value as { paths?: string[] } | undefined;
          for (const attackPath of entryValue?.paths ?? []) {
            const owners = pathOwners.get(attackPath) ?? [];
            owners.push(entry.index);
            pathOwners.set(attackPath, owners);
          }
        }
        for (const [attackPath, owners] of pathOwners) {
          if (owners.length > 1) {
            for (const owner of owners) {
              const entries = invalid.get(owner) ?? [];
              entries.push(
                reject(
                  `$.attacks[${String(owner)}].paths`,
                  attackPath,
                  "rank_path_overlap",
                  `Rank-specific path ${attackPath} belongs to multiple attacks`,
                ),
              );
              invalid.set(owner, entries);
            }
          }
          if (shared.data.includes(attackPath)) {
            for (const owner of owners) {
              const entries = invalid.get(owner) ?? [];
              entries.push(
                reject(
                  `$.attacks[${String(owner)}].paths`,
                  attackPath,
                  "shared_path_overlap",
                  `Rank-specific path ${attackPath} is also shared support`,
                ),
              );
              invalid.set(owner, entries);
            }
          }
        }
      }
      for (const entry of attacks.entries) {
        const entryRejections = invalid.get(entry.index);
        if (!entryRejections) continue;
        entry.outcome = "rejected";
        entry.value = undefined;
        entry.rejections.push(...entryRejections);
        entry.editablePaths.push(...entryRejections.map((item) => item.path));
      }
      attacks.accepted = attacks.entries.flatMap((entry) =>
        entry.value === undefined ? [] : [entry.value],
      );
      attacks.rejections = attacks.entries.flatMap((entry) => entry.rejections);
      attacks.outcome = attacks.rejections.length
        ? attacks.accepted.length
          ? "partial"
          : "invalid"
        : attacks.accepted.length
          ? "valid"
          : "valid_empty";
    }
  } else if (kind === "house") {
    const hypothesisSchema = HouseSubmissionSchema.shape.hypotheses.element;
    sections.hypotheses = parseEntries({
      envelope,
      key: "hypotheses",
      schema: hypothesisSchema,
      fieldSchema: hypothesisSchema,
      limit: Number.MAX_SAFE_INTEGER,
    });
    const attackSchema = HouseSubmissionSchema.shape.attacks.element;
    sections.attacks = parseEntries({
      envelope,
      key: "attacks",
      schema: attackSchema,
      fieldSchema: attackSchema,
      limit: 1,
    });
  } else {
    const caseSchema = CaseSubmissionSchema.shape.cases.element;
    sections.cases = parseEntries({
      envelope,
      key: "cases",
      schema: caseSchema,
      fieldSchema: caseSchema,
      limit: 2,
    });
  }
  const sectionValues = Object.values(sections);
  const scoringKeys =
    kind === "review"
      ? ["findings"]
      : kind === "case"
        ? ["cases"]
        : ["attacks"];
  const value =
    kind === "review"
      ? {
          version: 1 as const,
          findings: sections.findings!.accepted as ReviewSubmission["findings"],
        }
      : kind === "attack"
        ? {
            version: 2 as const,
            sharedSupportPaths: sections.sharedSupportPaths!
              .accepted as string[],
            attacks: (
              sections.attacks!.accepted as Array<Record<string, unknown>>
            ).map((entry) => ({
              ...entry,
              focusedCommand:
                typeof entry.focusedCommand === "string"
                  ? entry.focusedCommand
                  : typeof entry.reproduction === "string"
                    ? entry.reproduction
                    : "",
              paths: Array.isArray(entry.paths)
                ? entry.paths
                : ["legacy/attack-evidence"],
            })) as AttackSubmission["attacks"],
          }
        : kind === "house"
          ? {
              version: 1 as const,
              hypotheses: sections.hypotheses!
                .accepted as HouseSubmission["hypotheses"],
              attacks: sections.attacks!.accepted as HouseSubmission["attacks"],
            }
          : {
              version: 1 as const,
              cases: sections.cases!.accepted as CaseSubmission["cases"],
            };
  return {
    parserVersion: SUBMISSION_PARSER_VERSION,
    kind,
    outcome: overall(sectionValues, scoringKeys, sections),
    value,
    sections,
    rejections: sectionValues.flatMap((section) => section.rejections),
    normalizations: sectionValues.flatMap((section) =>
      section.entries.flatMap((entry) => entry.normalizations),
    ),
  };
}
