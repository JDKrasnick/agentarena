import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AttackSubmissionEntrySchema,
  BugCategorySchema,
  CaseSubmissionSchema,
  HouseSubmissionSchema,
  LegacyAttackSubmissionEntrySchema,
  type AttackSubmission,
  type CaseSubmission,
  type HouseSubmission,
} from "../core/types.js";
import {
  HANDOFF_OBSERVATION_PROVENANCE_KINDS,
  HandoffFindingPayloadSchema,
  TrustedReviewSubmissionSchema,
  type TrustedReviewSubmission,
} from "../review/evidence-handoff.js";

export const SUBMISSION_PARSER_VERSION = 1 as const;

const TRUSTED_REVIEW_ENVELOPE_KEYS = new Set(
  Object.keys(TrustedReviewSubmissionSchema.shape),
);

const LegacyAttackEntrySchema = LegacyAttackSubmissionEntrySchema.extend({
  reproduction: z.string().min(1),
});

export type SubmissionKind = "review" | "attack" | "house" | "case";
export type ParseOutcome = "valid" | "valid_empty" | "partial" | "invalid";
export type EntryOutcome = "accepted" | "normalized" | "rejected";

export interface SubmissionNormalization {
  path: string;
  original: unknown;
  normalized: unknown;
  rule: string;
}

interface BoundedNormalizationOriginal {
  preview: string;
  utf8Bytes: number;
  sha256: string;
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

/**
 * Return every independently schema-valid path declaration, including paths
 * owned by an entry rejected for a different field or duplicate rank. This
 * lets the caller quarantine that entry's edits without treating them as
 * undeclared mutations that suppress valid siblings.
 */
export function declaredAttackPaths(
  parsed: ParsedSubmission<AttackSubmission>,
): string[] {
  const shared = parsed.sections.sharedSupportPaths?.accepted.filter(
    (entry): entry is string => typeof entry === "string",
  );
  const ranked = parsed.sections.attacks?.entries.flatMap((entry) => {
    const paths = entry.validatedFields.paths;
    return Array.isArray(paths)
      ? paths.filter((candidate): candidate is string =>
          Boolean(typeof candidate === "string" && candidate.length),
        )
      : [];
  });
  return [...new Set([...(shared ?? []), ...(ranked ?? [])])];
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

function truncateUtf8WithEllipsis(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const ellipsis = "…";
  const contentBudget = maxBytes - Buffer.byteLength(ellipsis, "utf8");
  let bytes = 0;
  let prefix = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > contentBudget) break;
    prefix += character;
    bytes += characterBytes;
  }
  return `${prefix.trimEnd()}${ellipsis}`;
}

function reviewDescriptiveTextLimit(
  prefix: readonly PropertyKey[],
  path: readonly PropertyKey[],
): number | undefined {
  if (prefix[0] !== "findings") return undefined;
  const key = String(path.at(-1) ?? "");
  const parent = String(path.at(-2) ?? "");
  if (key === "statement" || key === "invariant") return 1_000;
  if (key === "expected_behavior" || key === "task_source_rationale")
    return 1_500;
  if (key === "summary" && parent === "regression_test_plan") return 1_500;
  if (/^\d+$/u.test(key) && parent === "trigger_sequence") return 500;
  if (/^\d+$/u.test(key) && parent === "references") return 300;
  return undefined;
}

function isStrictBoundaryString(path: readonly PropertyKey[]): boolean {
  const key = String(path.at(-1) ?? "");
  const parent = String(path.at(-2) ?? "");
  return (
    [
      "focusedCommand",
      "focused_command",
      "reproduction",
      "path",
      "symbol",
      "selector",
      "target",
      "trust",
      "kind",
      "family",
      "profile",
      "id",
      "challengeAdjudicationId",
    ].includes(key) ||
    (path.includes("browserProbe") && key !== "expectedBehavior") ||
    /(?:Id|Ids|_id|_ids)$/u.test(key) ||
    [
      "paths",
      "sharedSupportPaths",
      "suggested_paths",
      "references",
      "task_source_ids",
      "required_capability_ids",
      "requiredCapabilities",
    ].includes(parent)
  );
}

function normalizeEntry(
  value: unknown,
  prefix: PropertyKey[],
): { value: unknown; normalizations: SubmissionNormalization[] } {
  const normalizations: SubmissionNormalization[] = [];
  const record = (
    path: PropertyKey[],
    original: unknown,
    normalized: unknown,
    rule: string,
  ): void => {
    const persistedOriginal: unknown =
      typeof original === "string" &&
      rule.startsWith("v1.review.text.truncate_utf8_")
        ? ({
            preview: safelyRenderReceived(jsonPath(path), original),
            utf8Bytes: Buffer.byteLength(original, "utf8"),
            sha256: createHash("sha256").update(original).digest("hex"),
          } satisfies BoundedNormalizationOriginal)
        : original;
    normalizations.push({
      path: jsonPath(path),
      original: persistedOriginal,
      normalized,
      rule,
    });
  };
  const aliasObjectKeys = (
    current: Record<string, unknown>,
    path: PropertyKey[],
  ): Record<string, unknown> => {
    const aliases =
      prefix[0] === "findings"
        ? {
            codeLocations: "code_locations",
            triggerSequence: "trigger_sequence",
            requiredCapabilityIds: "required_capability_ids",
            regressionTestPlan: "regression_test_plan",
            expectedBehavior: "expected_behavior",
            taskSourceIds: "task_source_ids",
            taskSourceRationale: "task_source_rationale",
            lineStart: "line_start",
            lineEnd: "line_end",
            suggestedPaths: "suggested_paths",
            focusedCommand: "focused_command",
          }
        : {
            proposed_severity: "proposedSeverity",
            focused_command: "focusedCommand",
            required_capabilities: "requiredCapabilities",
            browser_probe: "browserProbe",
            challenge_adjudication_id: "challengeAdjudicationId",
          };
    const result = { ...current };
    for (const [alias, canonical] of Object.entries(aliases)) {
      if (!(alias in result) || canonical in result) continue;
      result[canonical] = result[alias];
      delete result[alias];
      record(
        [...path, alias],
        alias,
        canonical,
        `v1.field_alias.${alias}_to_${canonical}`,
      );
    }
    const isReviewFinding =
      prefix[0] === "findings" &&
      (path.length === 2 ||
        (path.length >= 4 && path.at(-2) === "observations"));
    if (isReviewFinding && result.trust === undefined) {
      result.trust = "reviewer_hypothesis";
      record(
        [...path, "trust"],
        undefined,
        "reviewer_hypothesis",
        "v1.review.trust.default_untrusted",
      );
    }
    return result;
  };
  const visit = (current: unknown, path: PropertyKey[]): unknown => {
    if (Array.isArray(current)) {
      const visited = current.map((entry, index) =>
        visit(entry, [...path, index]),
      );
      const key = String(path.at(-1) ?? "");
      if (
        [
          "task_source_ids",
          "required_capability_ids",
          "suggested_paths",
          "requiredCapabilities",
          "paths",
        ].includes(key) &&
        visited.every((entry): entry is string => typeof entry === "string")
      ) {
        const normalized = [...new Set(visited)].sort((left, right) =>
          left < right ? -1 : left > right ? 1 : 0,
        );
        if (JSON.stringify(normalized) !== JSON.stringify(visited)) {
          record(path, visited, normalized, `v1.array.${key}.sort_dedupe`);
          return normalized;
        }
      }
      return visited;
    }
    if (current && typeof current === "object") {
      const aliased = aliasObjectKeys(current as Record<string, unknown>, path);
      return Object.fromEntries(
        Object.entries(aliased).map(([key, entry]) => [
          key,
          visit(entry, [...path, key]),
        ]),
      );
    }
    if (typeof current !== "string") return current;
    const key = String(path.at(-1) ?? "");
    const isReviewProvenanceKind =
      prefix[0] === "findings" &&
      path.length === 6 &&
      path.at(-4) === "observations" &&
      path.at(-2) === "provenance" &&
      key === "kind";
    if (isReviewProvenanceKind) {
      const candidate = current
        .replaceAll("\r\n", "\n")
        .replaceAll("\r", "\n")
        .normalize("NFC")
        .trim();
      if (current !== "test_run" && /^test(?:_|-|\s+)run$/iu.test(candidate)) {
        record(
          path,
          current,
          "test_run",
          "v1.review.provenance.test_run_alias",
        );
        return "test_run";
      }
      if (current === "execution") {
        record(
          path,
          current,
          "tool_summary",
          "v1.review.provenance.execution_alias",
        );
        return "tool_summary";
      }
      return current;
    }
    if (isStrictBoundaryString(path)) return current;
    let text = current;
    const normalizedText = text
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      .normalize("NFC")
      .trim();
    if (normalizedText !== text) {
      record(path, text, normalizedText, "v1.text.nfc_lf_trim");
      text = normalizedText;
    }
    const descriptiveLimit = reviewDescriptiveTextLimit(prefix, path);
    if (
      descriptiveLimit !== undefined &&
      Buffer.byteLength(text, "utf8") > descriptiveLimit
    ) {
      const truncated = truncateUtf8WithEllipsis(text, descriptiveLimit);
      record(
        path,
        text,
        truncated,
        `v1.review.text.truncate_utf8_${String(descriptiveLimit)}`,
      );
      text = truncated;
    }
    if (key === "proposedSeverity") {
      const normalized = text.toLowerCase();
      if (
        ["critical", "high", "medium", "low"].includes(normalized) &&
        normalized !== text
      ) {
        record(
          path,
          text,
          normalized,
          "v1.enum.proposedSeverity.casefold_trim",
        );
        return normalized;
      }
    }
    if (key === "category") {
      const normalized = text.toLowerCase();
      const alias =
        normalized === "state" || normalized === "lifecycle"
          ? "state_lifecycle"
          : normalized;
      if (BugCategorySchema.safeParse(alias).success && alias !== text) {
        record(
          path,
          text,
          alias,
          normalized === alias
            ? "v1.enum.category.casefold_trim"
            : "v1.enum.category.state_lifecycle_alias",
        );
        return alias;
      }
    }
    return text;
  };
  return { value: visit(value, prefix), normalizations };
}

export function reviewRetryFeedback(
  parsed: ParsedSubmission<unknown>,
): string | undefined {
  if (parsed.kind !== "review" || parsed.rejections.length === 0)
    return undefined;
  const invalidFields = [
    ...new Map(
      parsed.rejections.map((rejection) => [
        `${rejection.path}\0${rejection.received}`,
        { path: rejection.path, received: rejection.received },
      ]),
    ).values(),
  ];
  return JSON.stringify(
    {
      invalid_fields: invalidFields,
      allowed_provenance_kinds: HANDOFF_OBSERVATION_PROVENANCE_KINDS,
    },
    null,
    2,
  );
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
): ParsedSubmission<TrustedReviewSubmission>;
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
  TrustedReviewSubmission | AttackSubmission | HouseSubmission | CaseSubmission
> {
  const empty =
    kind === "review"
      ? { version: 2 as const, findings: [] }
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
  const supportedVersions =
    kind === "attack" ? [1, 2] : kind === "review" ? [2] : [1];
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
  if (kind === "attack" && "handoff_blocker" in envelope) {
    return invalidSubmission(
      kind,
      empty,
      reject(
        "$.handoff_blocker",
        envelope.handoff_blocker,
        "handoff_blocker_requires_refresh",
        "A handoff blocker must be handled by the trusted handoff refresh path",
      ),
    );
  }

  const sections: Record<string, ParsedSection> = {};
  if (kind === "review") {
    const unknownKeys = Object.keys(envelope)
      .filter((key) => !TRUSTED_REVIEW_ENVELOPE_KEYS.has(key))
      .sort();
    if (unknownKeys.length > 0)
      return invalidSubmission(
        kind,
        empty,
        reject(
          "$",
          unknownKeys,
          "unknown_field",
          `Review submission envelope contains unknown fields: ${unknownKeys.join(", ")}`,
        ),
      );
    sections.findings = parseEntries({
      envelope,
      key: "findings",
      schema: HandoffFindingPayloadSchema,
      fieldSchema: HandoffFindingPayloadSchema,
      limit: 24,
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
          version: 2 as const,
          findings: sections.findings!
            .accepted as TrustedReviewSubmission["findings"],
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
              ...(typeof entry.focusedCommand === "string"
                ? { focusedCommand: entry.focusedCommand }
                : typeof entry.reproduction === "string"
                  ? { focusedCommand: entry.reproduction }
                  : {}),
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
