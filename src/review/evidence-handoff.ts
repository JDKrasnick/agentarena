import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { CapabilityDecision, PermissionPolicy } from "../core/types.js";
import type { CapabilityLease } from "../permissions/leases.js";

export const EVIDENCE_HANDOFF_VERSION = 2 as const;
export const EVIDENCE_HANDOFF_MAX_FINDINGS = 12;
export const EVIDENCE_HANDOFF_MAX_BOUNDARY_FINDINGS = 24;
export const EVIDENCE_HANDOFF_MAX_BYTES = 16 * 1024;
export const EVIDENCE_HANDOFF_DIAGNOSTIC_MAX_BYTES = 8 * 1024;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const FindingIdSchema = z.string().regex(/^finding_[a-f0-9]{64}$/);
const UuidV7Schema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const GitObjectIdSchema = z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/);
const Rfc3339UtcSchema = z.string().datetime({ offset: true }).regex(/Z$/);
const PrintableRunIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x20-\x7e]+$/);
const PrintableRoundIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\x20-\x7e]+$/);
const SlotIdSchema = z.string().regex(/^[a-z0-9_-]{1,32}$/);

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function normalizeText(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .normalize("NFC")
    .trim();
}

function normalizedTextSchema(minBytes: number, maxBytes: number) {
  return z.string().superRefine((value, context) => {
    if (value !== normalizeText(value)) {
      context.addIssue({
        code: "custom",
        message: "Text must use NFC, LF newlines, and trimmed outer whitespace",
      });
    }
    if (hasLoneSurrogate(value)) {
      context.addIssue({
        code: "custom",
        message: "Text must not contain lone Unicode surrogates",
      });
    }
    if (/[^\n\P{Cc}]/u.test(value)) {
      context.addIssue({
        code: "custom",
        message: "Text contains a prohibited control character",
      });
    }
    const bytes = utf8Length(value);
    if (bytes < minBytes || bytes > maxBytes) {
      context.addIssue({
        code: "custom",
        message: `Text must contain ${String(minBytes)}-${String(maxBytes)} UTF-8 bytes`,
      });
    }
  });
}

/** RFC 8785 sorts JSON object keys by their UTF-16 code units. */
function utf16Compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Contract arrays sort lexicographically by Unicode scalar value. */
function unicodeCodePointCompare(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]!.codePointAt(0)!;
    const rightPoint = rightPoints[index]!.codePointAt(0)!;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(unicodeCodePointCompare);
}

function normalizeStringArray(
  value: unknown,
  normalizer: (entry: string) => string,
  sort: boolean,
): unknown {
  if (!Array.isArray(value)) return value;
  const normalized = (value as unknown[]).map((entry) =>
    typeof entry === "string" ? normalizer(entry) : entry,
  );
  return sort &&
    normalized.every((entry): entry is string => typeof entry === "string")
    ? sortedUnique(normalized)
    : normalized;
}

function normalizeTargetPath(value: string): string {
  return normalizeText(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

function isTargetRelativePath(value: string): boolean {
  if (
    !value ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:\//.test(value)
  )
    return false;
  const parts = value.split("/");
  return parts.every(
    (part) => part.length > 0 && part !== "." && part !== "..",
  );
}

const TargetRelativePathSchema = normalizedTextSchema(1, 1_000).superRefine(
  (value, context) => {
    if (value !== normalizeTargetPath(value) || !isTargetRelativePath(value)) {
      context.addIssue({
        code: "custom",
        message: "Path must be normalized and target-relative",
      });
    }
  },
);

const prohibitedContent = [
  /(?:^|\n)diff --git /i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:private reasoning|chain[- ]of[- ]thought|hidden deliberation)\b/i,
  /\b(?:provider transcript|implementation transcript|raw transcript)\b/i,
  /\bauthorization\s*[:=]\s*\S+/i,
  /\bbearer\s+\S+/i,
  /\b(?:api[_-]?key|token|secret|password|passwd|client_secret)\s*[:=]\s*\S+/i,
  /\b(?:process\.env\.)?[a-z][a-z0-9_]*(?:_token|_secret|_password|_api_key|_access_key)(?:\b|\s*[:=])/i,
  /\$\{?[a-z][a-z0-9_]*(?:_token|_secret|_password|_api_key|_access_key)\}?\b/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b(?:sk-(?:proj-)?[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{12,}|AIza[a-z0-9_-]{20,})\b/i,
  /\b(?:anthropic|claude|codex|gemini|openai|opencode)\b/i,
];

function assertNoProhibitedContent(
  value: unknown,
  context: z.RefinementCtx,
): void {
  const visit = (candidate: unknown, path: PropertyKey[]): void => {
    if (
      typeof candidate === "string" &&
      prohibitedContent.some((pattern) => pattern.test(candidate))
    ) {
      context.addIssue({
        code: "custom",
        path,
        message:
          "Prohibited private, provider, credential, transcript, or raw patch content",
      });
      return;
    }
    if (Array.isArray(candidate))
      candidate.forEach((entry, index) => visit(entry, [...path, index]));
    else if (candidate && typeof candidate === "object") {
      Object.entries(candidate as Record<string, unknown>).forEach(
        ([key, entry]) => visit(entry, [...path, key]),
      );
    }
  };
  visit(value, []);
}

const UniquePreservedTextArray = (
  schema: z.ZodType<string>,
  min: number,
  max: number,
) =>
  z
    .array(schema)
    .min(min)
    .max(max)
    .superRefine((values, context) => {
      if (new Set(values).size !== values.length)
        context.addIssue({ code: "custom", message: "Values must be unique" });
    });

const SortedUniqueTextArray = (schema: z.ZodType<string>, max: number) =>
  z
    .array(schema)
    .max(max)
    .superRefine((values, context) => {
      if (JSON.stringify(values) !== JSON.stringify(sortedUnique(values))) {
        context.addIssue({
          code: "custom",
          message: "Values must be de-duplicated and sorted",
        });
      }
    });

export const HandoffObservationSchema = z
  .object({
    trust: z.literal("reviewer_hypothesis"),
    statement: normalizedTextSchema(1, 1_000),
    provenance: z
      .object({
        kind: z.enum([
          "code_inspection",
          "task_source",
          "test_inspection",
          "tool_summary",
          "other",
        ]),
        references: UniquePreservedTextArray(
          normalizedTextSchema(1, 300),
          1,
          8,
        ),
      })
      .strict(),
  })
  .strict();

export const HandoffCodeLocationSchema = z
  .object({
    path: TargetRelativePathSchema,
    line_start: z.number().int().positive(),
    line_end: z.number().int().positive(),
    symbol: z.union([normalizedTextSchema(1, 300), z.null()]),
  })
  .strict()
  .superRefine((location, context) => {
    if (location.line_end < location.line_start)
      context.addIssue({
        code: "custom",
        path: ["line_end"],
        message: "line_end must be at least line_start",
      });
  });

const HandoffFindingPayloadShape = {
  trust: z.literal("reviewer_hypothesis"),
  invariant: normalizedTextSchema(1, 1_000),
  observations: z.array(HandoffObservationSchema).min(1).max(8),
  code_locations: z.array(HandoffCodeLocationSchema).min(1).max(8),
  trigger_sequence: z.array(normalizedTextSchema(1, 500)).min(1).max(12),
  oracle: z
    .object({
      expected_behavior: normalizedTextSchema(1, 1_500),
      task_source_ids: SortedUniqueTextArray(
        normalizedTextSchema(1, 128),
        8,
      ).min(1),
      task_source_rationale: normalizedTextSchema(1, 1_500),
    })
    .strict(),
  confidence: z.number().int().min(0).max(100),
  required_capability_ids: SortedUniqueTextArray(
    normalizedTextSchema(1, 128),
    16,
  ),
  regression_test_plan: z
    .object({
      summary: normalizedTextSchema(1, 1_500),
      suggested_paths: SortedUniqueTextArray(TargetRelativePathSchema, 8),
      focused_command: z.union([normalizedTextSchema(1, 1_000), z.null()]),
    })
    .strict(),
};

export const HandoffFindingPayloadSchema = z
  .object(HandoffFindingPayloadShape)
  .strict()
  .superRefine((finding, context) => {
    const locations = finding.code_locations.map((location) =>
      canonicalHandoffJson(location),
    );
    if (new Set(locations).size !== locations.length)
      context.addIssue({
        code: "custom",
        path: ["code_locations"],
        message: "Code locations must be unique",
      });
    assertNoProhibitedContent(finding, context);
  });
export type HandoffFindingPayload = z.infer<typeof HandoffFindingPayloadSchema>;

export const EvidenceHandoffFindingSchema = z
  .object({
    finding_id: FindingIdSchema,
    priority: z
      .number()
      .int()
      .min(1)
      .max(EVIDENCE_HANDOFF_MAX_BOUNDARY_FINDINGS),
    ...HandoffFindingPayloadShape,
  })
  .strict()
  .superRefine((finding, context) =>
    assertNoProhibitedContent(finding, context),
  );
export type EvidenceHandoffFinding = z.infer<
  typeof EvidenceHandoffFindingSchema
>;

export const HandoffOmissionEntrySchema = z
  .object({
    finding_id: FindingIdSchema,
    original_priority: z
      .number()
      .int()
      .positive()
      .max(EVIDENCE_HANDOFF_MAX_BOUNDARY_FINDINGS),
    reason: z.enum(["duplicate", "finding_limit", "packet_size"]),
    duplicate_of: z.union([FindingIdSchema, z.null()]),
  })
  .strict()
  .superRefine((entry, context) => {
    const expected = entry.reason === "duplicate" ? entry.finding_id : null;
    if (entry.duplicate_of !== expected)
      context.addIssue({
        code: "custom",
        path: ["duplicate_of"],
        message: "duplicate_of must identify only an exact duplicate",
      });
  });
export type HandoffOmissionEntry = z.infer<typeof HandoffOmissionEntrySchema>;

export const HandoffTargetSnapshotSchema = z
  .object({
    base_commit: GitObjectIdSchema,
    frozen_patch_sha256: Sha256Schema,
    frozen_git_tree_id: GitObjectIdSchema,
    fingerprint: Sha256Schema,
  })
  .strict();
export type HandoffTargetSnapshot = z.infer<typeof HandoffTargetSnapshotSchema>;

export const EvidenceHandoffPacketSchema = z
  .object({
    version: z.literal(2),
    packet_id: UuidV7Schema,
    packet_digest: Sha256Schema,
    run_id: PrintableRunIdSchema,
    round_id: PrintableRoundIdSchema,
    reviewer_slot: SlotIdSchema,
    target_slot: SlotIdSchema,
    target_snapshot: HandoffTargetSnapshotSchema,
    permission_manifest_fingerprint: Sha256Schema,
    findings: z
      .array(EvidenceHandoffFindingSchema)
      .max(EVIDENCE_HANDOFF_MAX_FINDINGS),
    omitted_findings: z
      .object({
        count: z
          .number()
          .int()
          .min(0)
          .max(EVIDENCE_HANDOFF_MAX_BOUNDARY_FINDINGS),
        entries: z
          .array(HandoffOmissionEntrySchema)
          .max(EVIDENCE_HANDOFF_MAX_BOUNDARY_FINDINGS),
      })
      .strict(),
  })
  .strict()
  .superRefine((packet, context) => {
    if (packet.reviewer_slot === packet.target_slot)
      context.addIssue({
        code: "custom",
        path: ["target_slot"],
        message: "Reviewer and target slots must differ",
      });
    if (
      packet.omitted_findings.count !== packet.omitted_findings.entries.length
    )
      context.addIssue({
        code: "custom",
        path: ["omitted_findings", "count"],
        message: "Omission count must equal entry length",
      });
    const priorities = packet.findings.map((finding) => finding.priority);
    if (
      priorities.some(
        (priority, index) => index > 0 && priority <= priorities[index - 1]!,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["findings"],
        message: "Retained priorities must be unique and ascending",
      });
    const omittedPriorities = packet.omitted_findings.entries.map(
      (entry) => entry.original_priority,
    );
    if (
      omittedPriorities.some(
        (priority, index) =>
          index > 0 && priority <= omittedPriorities[index - 1]!,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["omitted_findings", "entries"],
        message: "Omissions must use unique ascending original priorities",
      });
    if (
      new Set([...priorities, ...omittedPriorities]).size !==
      priorities.length + omittedPriorities.length
    )
      context.addIssue({
        code: "custom",
        path: ["omitted_findings", "entries"],
        message: "Every original priority must be retained or omitted once",
      });
  });
export type EvidenceHandoffPacket = z.infer<typeof EvidenceHandoffPacketSchema>;

export const ResolvedPermissionProjectionSchema = z
  .object({
    capabilities: z.array(
      z
        .object({
          capability_id: normalizedTextSchema(1, 128),
          status: z.enum([
            "approved",
            "denied",
            "unavailable",
            "provisioning_failed",
            "expired",
          ]),
          requirement: z.enum(["required", "optional"]),
          roles: z.array(z.enum(["agent", "harness_only", "both"])).length(1),
          scopes: SortedUniqueTextArray(normalizedTextSchema(1, 1_000), 64),
          enforcement: z.enum(["enforced", "brokered", "advisory"]),
          expires_at: z.union([Rfc3339UtcSchema, z.null()]),
        })
        .strict(),
    ),
    reduced_validation: z
      .object({
        accepted: z.boolean(),
        assessment_digest: z.union([Sha256Schema, z.null()]),
        omitted_check_ids: SortedUniqueTextArray(
          normalizedTextSchema(1, 128),
          128,
        ),
      })
      .strict(),
  })
  .strict()
  .superRefine((projection, context) => {
    const ids = projection.capabilities.map(
      (capability) => capability.capability_id,
    );
    if (JSON.stringify(ids) !== JSON.stringify(sortedUnique(ids)))
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Capabilities must be unique and sorted by capability_id",
      });
    if (
      projection.reduced_validation.accepted !==
      (projection.reduced_validation.assessment_digest !== null)
    )
      context.addIssue({
        code: "custom",
        path: ["reduced_validation", "assessment_digest"],
        message:
          "Accepted reduced validation requires its assessment digest; unaccepted validation must use null",
      });
    projection.capabilities.forEach((capability, index) => {
      if (capability.status === "expired" && capability.expires_at === null)
        context.addIssue({
          code: "custom",
          path: ["capabilities", index, "expires_at"],
          message: "Expired capabilities require a lease expiry",
        });
      if (
        capability.status !== "approved" &&
        capability.status !== "expired" &&
        capability.expires_at !== null
      )
        context.addIssue({
          code: "custom",
          path: ["capabilities", index, "expires_at"],
          message: "Non-approved capability decisions cannot carry leases",
        });
    });
  });
export type ResolvedPermissionProjection = z.infer<
  typeof ResolvedPermissionProjectionSchema
>;

export interface PermissionProjectionOptions {
  policy: PermissionPolicy;
  leases?: readonly CapabilityLease[];
  now?: Date;
  reducedValidation?: {
    accepted: boolean;
    assessmentDigest: string | null;
    omittedCheckIds: readonly string[];
  };
}

function resolvedLease(
  capability: CapabilityDecision,
  leases: ReadonlyMap<string, CapabilityLease>,
): CapabilityLease | undefined {
  const explicit = leases.get(capability.id);
  if (explicit) return explicit;
  return capability.status === "approved" && capability.expiresAt
    ? {
        capabilityId: capability.id,
        scopes: capability.scopes,
        expiresAt: capability.expiresAt,
        status: "active",
      }
    : undefined;
}

export function projectResolvedPermissions(
  options: PermissionProjectionOptions,
): ResolvedPermissionProjection {
  const now = options.now ?? new Date();
  const leases = new Map(
    (options.leases ?? []).map((lease) => [lease.capabilityId, lease]),
  );
  if (leases.size !== (options.leases ?? []).length)
    throw new Error(
      "Resolved permission leases contain duplicate capability IDs",
    );
  for (const lease of leases.values()) {
    const decision = options.policy.capabilities.find(
      (capability) => capability.id === lease.capabilityId,
    );
    if (!decision || decision.status !== "approved")
      throw new Error(
        `Capability ${lease.capabilityId} has a lease without an approved decision`,
      );
  }
  const capabilities = options.policy.capabilities
    .map((capability) => {
      const lease = resolvedLease(capability, leases);
      if (capability.status !== "approved" && lease)
        throw new Error(
          `Capability ${capability.id} has a lease without an approved decision`,
        );
      const expired = lease
        ? Date.parse(lease.expiresAt) <= now.getTime() ||
          lease.status === "expired"
        : false;
      const approvedScopes = new Set(
        capability.scopes.map((scope) => normalizeText(scope)),
      );
      const effectiveScopes = (lease?.scopes ?? capability.scopes).map(
        (scope) => normalizeText(scope),
      );
      if (effectiveScopes.some((scope) => !approvedScopes.has(scope)))
        throw new Error(
          `Capability ${capability.id} lease exceeds its approved scopes`,
        );
      return {
        capability_id: normalizeText(capability.id),
        status: expired ? ("expired" as const) : capability.status,
        requirement: capability.requirement,
        roles: [capability.role] as [typeof capability.role],
        scopes: sortedUnique(effectiveScopes),
        enforcement: capability.enforcement,
        expires_at: lease ? new Date(lease.expiresAt).toISOString() : null,
      };
    })
    .sort((left, right) =>
      unicodeCodePointCompare(left.capability_id, right.capability_id),
    );
  const reduced = options.reducedValidation ?? {
    accepted: options.policy.reducedValidationAccepted,
    assessmentDigest: null,
    omittedCheckIds: [],
  };
  return ResolvedPermissionProjectionSchema.parse({
    capabilities,
    reduced_validation: {
      accepted: reduced.accepted,
      assessment_digest: reduced.assessmentDigest,
      omitted_check_ids: sortedUnique(
        reduced.omittedCheckIds.map(normalizeText),
      ),
    },
  });
}

/** RFC 8785-compatible canonical JSON for strict handoff values. */
export function canonicalHandoffJson(value: unknown): string {
  const serialize = (candidate: unknown): string => {
    if (candidate === null) return "null";
    if (typeof candidate === "boolean" || typeof candidate === "string") {
      if (typeof candidate === "string" && hasLoneSurrogate(candidate))
        throw new Error("Canonical JSON rejects lone Unicode surrogates");
      return JSON.stringify(candidate);
    }
    if (typeof candidate === "number") {
      if (
        !Number.isFinite(candidate) ||
        (Number.isInteger(candidate) && !Number.isSafeInteger(candidate))
      )
        throw new Error(
          "Canonical JSON requires finite, safely represented numbers",
        );
      return JSON.stringify(candidate);
    }
    if (Array.isArray(candidate))
      return `[${candidate.map(serialize).join(",")}]`;
    if (candidate && typeof candidate === "object") {
      const prototype = Object.getPrototypeOf(candidate) as object | null;
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error("Canonical JSON requires plain JSON objects");
      const entries = Object.entries(candidate as Record<string, unknown>).sort(
        ([left], [right]) => utf16Compare(left, right),
      );
      return `{${entries
        .map(([key, entry]) => {
          if (entry === undefined)
            throw new Error("Canonical JSON rejects undefined values");
          if (hasLoneSurrogate(key))
            throw new Error("Canonical JSON rejects lone Unicode surrogates");
          return `${JSON.stringify(key)}:${serialize(entry)}`;
        })
        .join(",")}}`;
    }
    throw new Error(`Canonical JSON rejects ${typeof candidate} values`);
  };
  return serialize(value);
}

export function sha256Jcs(value: unknown): string {
  return createHash("sha256")
    .update(canonicalHandoffJson(value), "utf8")
    .digest("hex");
}

export function calculateTargetFingerprint(
  snapshot: Pick<
    HandoffTargetSnapshot,
    "base_commit" | "frozen_git_tree_id" | "frozen_patch_sha256"
  >,
): string {
  return sha256Jcs({
    base_commit: snapshot.base_commit,
    frozen_git_tree_id: snapshot.frozen_git_tree_id,
    frozen_patch_sha256: snapshot.frozen_patch_sha256,
  });
}

export function calculatePermissionManifestFingerprint(
  projection: ResolvedPermissionProjection,
): string {
  return sha256Jcs(ResolvedPermissionProjectionSchema.parse(projection));
}

export function calculateFindingId(
  targetFingerprint: string,
  payload: HandoffFindingPayload,
): string {
  return `finding_${sha256Jcs({ target_fingerprint: Sha256Schema.parse(targetFingerprint), finding: HandoffFindingPayloadSchema.parse(payload) })}`;
}

export function calculatePacketDigest(
  packet: Omit<EvidenceHandoffPacket, "packet_digest">,
): string {
  return sha256Jcs(packet);
}

export function measureEvidenceHandoffPacket(
  packet: EvidenceHandoffPacket,
): number {
  return utf8Length(
    canonicalHandoffJson(EvidenceHandoffPacketSchema.parse(packet)),
  );
}

/** Fail closed on every packet invariant that can be checked without lane state. */
export function assertEvidenceHandoffPacketIntrinsic(
  value: unknown,
): EvidenceHandoffPacket {
  const packet = EvidenceHandoffPacketSchema.parse(value);
  if (measureEvidenceHandoffPacket(packet) > EVIDENCE_HANDOFF_MAX_BYTES)
    throw new Error("Evidence handoff packet exceeds 16 KiB");
  const { packet_digest: packetDigest, ...body } = packet;
  if (calculatePacketDigest(body) !== packetDigest)
    throw new Error("Evidence handoff packet digest does not match");
  if (
    calculateTargetFingerprint(packet.target_snapshot) !==
    packet.target_snapshot.fingerprint
  )
    throw new Error("Evidence handoff target fingerprint does not match");
  const retainedIds = new Set<string>();
  for (const finding of packet.findings) {
    const payload = HandoffFindingPayloadSchema.parse(
      Object.fromEntries(
        Object.entries(finding).filter(
          ([key]) => key !== "finding_id" && key !== "priority",
        ),
      ),
    );
    if (
      calculateFindingId(packet.target_snapshot.fingerprint, payload) !==
      finding.finding_id
    )
      throw new Error("Evidence handoff finding ID does not match");
    if (retainedIds.has(finding.finding_id))
      throw new Error("Evidence handoff retains an exact duplicate finding");
    retainedIds.add(finding.finding_id);
  }
  for (const omission of packet.omitted_findings.entries) {
    if (
      omission.reason === "duplicate" &&
      !retainedIds.has(omission.finding_id) &&
      !packet.omitted_findings.entries.some(
        (entry) =>
          entry.reason === "packet_size" &&
          entry.finding_id === omission.finding_id,
      )
    )
      throw new Error(
        "Duplicate omission does not identify a retained or size-compacted finding",
      );
    if (omission.reason !== "duplicate" && retainedIds.has(omission.finding_id))
      throw new Error("Non-duplicate omission identifies a retained finding");
  }
  return packet;
}

export function createUuidV7(now = new Date()): string {
  const bytes = randomBytes(16);
  const milliseconds = now.getTime();
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > 0xffffffffffff
  )
    throw new Error("UUIDv7 timestamp is outside the 48-bit Unix range");
  let timestamp = BigInt(milliseconds);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeFindingPayload(value: unknown): HandoffFindingPayload {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return HandoffFindingPayloadSchema.parse(value);
  const finding = value as Record<string, unknown>;
  if (finding.trust !== undefined && finding.trust !== "reviewer_hypothesis")
    throw new Error("Reviewer findings cannot claim an attested trust domain");
  const observations = Array.isArray(finding.observations)
    ? (finding.observations as unknown[]).map((entry) => {
        const observation = entry as Record<string, unknown>;
        if (
          observation.trust !== undefined &&
          observation.trust !== "reviewer_hypothesis"
        )
          throw new Error(
            "Reviewer observations cannot claim an attested trust domain",
          );
        const provenance = observation.provenance as Record<string, unknown>;
        return {
          ...observation,
          trust: "reviewer_hypothesis",
          statement:
            typeof observation.statement === "string"
              ? normalizeText(observation.statement)
              : observation.statement,
          provenance: {
            ...provenance,
            references: Array.isArray(provenance?.references)
              ? (provenance.references as unknown[]).map((reference) =>
                  typeof reference === "string"
                    ? normalizeText(reference)
                    : reference,
                )
              : provenance?.references,
          },
        };
      })
    : finding.observations;
  const codeLocations = Array.isArray(finding.code_locations)
    ? finding.code_locations.map((entry) => {
        const location = entry as Record<string, unknown>;
        return {
          ...location,
          path:
            typeof location.path === "string"
              ? normalizeTargetPath(location.path)
              : location.path,
          symbol:
            typeof location.symbol === "string"
              ? normalizeText(location.symbol)
              : location.symbol,
        };
      })
    : finding.code_locations;
  const oracle = finding.oracle as Record<string, unknown>;
  const plan = finding.regression_test_plan as Record<string, unknown>;
  return HandoffFindingPayloadSchema.parse({
    ...finding,
    trust: "reviewer_hypothesis",
    invariant:
      typeof finding.invariant === "string"
        ? normalizeText(finding.invariant)
        : finding.invariant,
    observations,
    code_locations: codeLocations,
    trigger_sequence: Array.isArray(finding.trigger_sequence)
      ? (finding.trigger_sequence as unknown[]).map((step) =>
          typeof step === "string" ? normalizeText(step) : step,
        )
      : finding.trigger_sequence,
    oracle: {
      ...oracle,
      expected_behavior:
        typeof oracle?.expected_behavior === "string"
          ? normalizeText(oracle.expected_behavior)
          : oracle?.expected_behavior,
      task_source_ids: normalizeStringArray(
        oracle?.task_source_ids,
        normalizeText,
        true,
      ),
      task_source_rationale:
        typeof oracle?.task_source_rationale === "string"
          ? normalizeText(oracle.task_source_rationale)
          : oracle?.task_source_rationale,
    },
    required_capability_ids: normalizeStringArray(
      finding.required_capability_ids,
      normalizeText,
      true,
    ),
    regression_test_plan: {
      ...plan,
      summary:
        typeof plan?.summary === "string"
          ? normalizeText(plan.summary)
          : plan?.summary,
      suggested_paths: normalizeStringArray(
        plan?.suggested_paths,
        normalizeTargetPath,
        true,
      ),
      focused_command:
        typeof plan?.focused_command === "string"
          ? normalizeText(plan.focused_command)
          : plan?.focused_command,
    },
  });
}

export interface BuildEvidenceHandoffPacketInput {
  packetId?: string;
  runId: string;
  roundId: string;
  reviewerSlot: string;
  targetSlot: string;
  targetSnapshot: Pick<
    HandoffTargetSnapshot,
    "base_commit" | "frozen_patch_sha256" | "frozen_git_tree_id"
  >;
  permissionProjection: ResolvedPermissionProjection;
  findings: readonly unknown[];
  taskSourceIds: readonly string[];
  capabilityIds: readonly string[];
}

export const HandoffPacketSizeBlockerSchema = z
  .object({
    version: z.literal(2),
    status: z.literal("handoff_blocked"),
    category: z.literal("packet_size"),
    packet_id: UuidV7Schema,
    finding_ids: z.array(FindingIdSchema).min(1).max(12),
    measured_bytes: z.number().int().positive(),
    max_bytes: z.literal(EVIDENCE_HANDOFF_MAX_BYTES),
  })
  .strict();
export type HandoffPacketSizeBlocker = z.infer<
  typeof HandoffPacketSizeBlockerSchema
>;

export type BuildEvidenceHandoffPacketResult =
  | {
      status: "packet_created";
      packet: EvidenceHandoffPacket;
      canonicalBytes: Uint8Array;
      normalizedFindings: HandoffFindingPayload[];
    }
  | {
      status: "handoff_blocked";
      blocker: HandoffPacketSizeBlocker;
      normalizedFindings: HandoffFindingPayload[];
    };

function assemblePacket(
  input: BuildEvidenceHandoffPacketInput,
): BuildEvidenceHandoffPacketResult {
  if (input.findings.length > EVIDENCE_HANDOFF_MAX_BOUNDARY_FINDINGS)
    throw new Error(
      `Review handoff accepts at most ${String(EVIDENCE_HANDOFF_MAX_BOUNDARY_FINDINGS)} boundary findings`,
    );
  const packetId = UuidV7Schema.parse(input.packetId ?? createUuidV7());
  const targetBase = HandoffTargetSnapshotSchema.omit({
    fingerprint: true,
  }).parse(input.targetSnapshot);
  const targetSnapshot = HandoffTargetSnapshotSchema.parse({
    ...targetBase,
    fingerprint: calculateTargetFingerprint(targetBase),
  });
  const permissionProjection = ResolvedPermissionProjectionSchema.parse(
    input.permissionProjection,
  );
  const taskSourceIds = new Set(input.taskSourceIds);
  const capabilityIds = new Set(input.capabilityIds);
  const normalizedFindings = input.findings.map(normalizeFindingPayload);
  normalizedFindings.forEach((finding, index) => {
    finding.oracle.task_source_ids.forEach((id) => {
      if (!taskSourceIds.has(id))
        throw new Error(
          `Finding ${String(index + 1)} references unknown task source ${id}`,
        );
    });
    finding.required_capability_ids.forEach((id) => {
      if (!capabilityIds.has(id))
        throw new Error(
          `Finding ${String(index + 1)} references unknown capability ${id}`,
        );
    });
  });
  const retained: EvidenceHandoffFinding[] = [];
  const omissions: HandoffOmissionEntry[] = [];
  const retainedIds = new Set<string>();
  normalizedFindings.forEach((payload, index) => {
    const priority = index + 1;
    const findingId = calculateFindingId(targetSnapshot.fingerprint, payload);
    if (retainedIds.has(findingId)) {
      omissions.push({
        finding_id: findingId,
        original_priority: priority,
        reason: "duplicate",
        duplicate_of: findingId,
      });
    } else if (retained.length >= EVIDENCE_HANDOFF_MAX_FINDINGS) {
      omissions.push({
        finding_id: findingId,
        original_priority: priority,
        reason: "finding_limit",
        duplicate_of: null,
      });
    } else {
      retainedIds.add(findingId);
      retained.push(
        EvidenceHandoffFindingSchema.parse({
          finding_id: findingId,
          priority,
          ...payload,
        }),
      );
    }
  });
  const body = {
    version: 2 as const,
    packet_id: packetId,
    run_id: input.runId,
    round_id: input.roundId,
    reviewer_slot: input.reviewerSlot,
    target_slot: input.targetSlot,
    target_snapshot: targetSnapshot,
    permission_manifest_fingerprint:
      calculatePermissionManifestFingerprint(permissionProjection),
  };
  const blockOnSize = (
    measuredBytes: number,
  ): BuildEvidenceHandoffPacketResult => ({
    status: "handoff_blocked",
    blocker: HandoffPacketSizeBlockerSchema.parse({
      version: 2,
      status: "handoff_blocked",
      category: "packet_size",
      packet_id: packetId,
      finding_ids: [
        ...new Set(
          normalizedFindings.map((payload) =>
            calculateFindingId(targetSnapshot.fingerprint, payload),
          ),
        ),
      ].slice(0, EVIDENCE_HANDOFF_MAX_FINDINGS),
      measured_bytes: measuredBytes,
      max_bytes: EVIDENCE_HANDOFF_MAX_BYTES,
    }),
    normalizedFindings,
  });
  let lastOversizedBytes = 0;
  while (true) {
    omissions.sort(
      (left, right) => left.original_priority - right.original_priority,
    );
    const packetWithoutDigest = {
      ...body,
      findings: retained,
      omitted_findings: { count: omissions.length, entries: omissions },
    };
    const packet = EvidenceHandoffPacketSchema.parse({
      ...packetWithoutDigest,
      packet_digest: calculatePacketDigest(packetWithoutDigest),
    });
    const measuredBytes = measureEvidenceHandoffPacket(packet);
    if (measuredBytes <= EVIDENCE_HANDOFF_MAX_BYTES) {
      if (
        retained.length === 0 &&
        normalizedFindings.length > 0 &&
        omissions.some((entry) => entry.reason === "packet_size")
      ) {
        return blockOnSize(lastOversizedBytes);
      }
      return {
        status: "packet_created",
        packet,
        canonicalBytes: Buffer.from(canonicalHandoffJson(packet), "utf8"),
        normalizedFindings,
      };
    }
    lastOversizedBytes = measuredBytes;
    const removed = retained.pop();
    if (!removed) return blockOnSize(measuredBytes);
    omissions.push({
      finding_id: removed.finding_id,
      original_priority: removed.priority,
      reason: "packet_size",
      duplicate_of: null,
    });
  }
}

export function buildEvidenceHandoffPacket(
  input: BuildEvidenceHandoffPacketInput,
): BuildEvidenceHandoffPacketResult {
  return assemblePacket(input);
}

export const HandoffBlockerSchema = z
  .object({
    finding_ids: SortedUniqueTextArray(FindingIdSchema, 12).min(1),
    category: z.enum([
      "permission_unavailable",
      "cited_context_missing",
      "target_artifact_unavailable",
      "policy_ambiguous",
    ]),
    explanation: normalizedTextSchema(1, 1_500),
    requested_capability_ids: SortedUniqueTextArray(
      normalizedTextSchema(1, 128),
      16,
    ),
    requested_context: SortedUniqueTextArray(normalizedTextSchema(1, 1_000), 8),
  })
  .strict()
  .superRefine((blocker, context) => {
    blocker.requested_context.forEach((entry, index) => {
      const sourceId = /^[A-Za-z0-9_-]{1,128}$/.test(entry);
      if (
        (!sourceId && !isTargetRelativePath(entry)) ||
        /[*?{}[\]]/.test(entry) ||
        /^(?:the )?(?:whole|entire) repository$/i.test(entry)
      )
        context.addIssue({
          code: "custom",
          path: ["requested_context", index],
          message:
            "Context must be a focused target-relative path or frozen task-source ID",
        });
    });
    assertNoProhibitedContent(blocker, context);
  });

export const HandoffBlockerResultSchema = z
  .object({ version: z.literal(2), handoff_blocker: HandoffBlockerSchema })
  .strict();
export type HandoffBlockerResult = z.infer<typeof HandoffBlockerResultSchema>;

export function normalizeHandoffBlocker(
  value: unknown,
  packet: EvidenceHandoffPacket,
  permissionProjection: ResolvedPermissionProjection,
  taskSourceIds: readonly string[],
): HandoffBlockerResult {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return HandoffBlockerResultSchema.parse(value);
  const result = value as Record<string, unknown>;
  const raw = result.handoff_blocker as Record<string, unknown>;
  const sources = new Set(taskSourceIds);
  const normalized = HandoffBlockerResultSchema.parse({
    ...result,
    handoff_blocker: {
      ...raw,
      finding_ids: normalizeStringArray(raw?.finding_ids, normalizeText, true),
      explanation:
        typeof raw?.explanation === "string"
          ? normalizeText(raw.explanation)
          : raw?.explanation,
      requested_capability_ids: normalizeStringArray(
        raw?.requested_capability_ids,
        normalizeText,
        true,
      ),
      requested_context: normalizeStringArray(
        raw?.requested_context,
        (entry) => {
          const text = normalizeText(entry);
          return sources.has(text) ? text : normalizeTargetPath(text);
        },
        true,
      ),
    },
  });
  const packetIds = new Set(
    packet.findings.map((finding) => finding.finding_id),
  );
  normalized.handoff_blocker.finding_ids.forEach((id) => {
    if (!packetIds.has(id))
      throw new Error(
        `Handoff blocker references finding outside the consumed packet: ${id}`,
      );
  });
  const capabilityIds = new Set(
    permissionProjection.capabilities.map(
      (capability) => capability.capability_id,
    ),
  );
  normalized.handoff_blocker.requested_capability_ids.forEach((id) => {
    if (!capabilityIds.has(id))
      throw new Error(`Handoff blocker references unknown capability: ${id}`);
  });
  normalized.handoff_blocker.requested_context.forEach((entry) => {
    if (!sources.has(entry) && !isTargetRelativePath(entry))
      throw new Error(
        `Handoff blocker references unknown task source: ${entry}`,
      );
  });
  return normalized;
}

export const HandoffValidationOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("packet_valid"),
      packet_digest: Sha256Schema,
      finding_count: z.number().int().min(1).max(12),
    })
    .strict(),
  z
    .object({
      status: z.literal("packet_valid_empty"),
      packet_digest: Sha256Schema,
      finding_count: z.literal(0),
    })
    .strict(),
  z
    .object({
      status: z.literal("packet_stale"),
      diagnostic_code: z.enum([
        "target_fingerprint_mismatch",
        "permission_fingerprint_mismatch",
      ]),
    })
    .strict(),
  z
    .object({
      status: z.literal("packet_malformed"),
      diagnostic_code: z.enum([
        "strict_schema_invalid",
        "noncanonical_encoding",
        "packet_digest_mismatch",
        "target_snapshot_fingerprint_invalid",
        "finding_id_mismatch",
        "lane_identity_mismatch",
        "omission_evidence_missing",
        "omission_metadata_mismatch",
      ]),
    })
    .strict(),
  z
    .object({
      status: z.literal("packet_oversized"),
      measured_bytes: z.number().int().positive(),
      max_bytes: z.literal(EVIDENCE_HANDOFF_MAX_BYTES),
    })
    .strict(),
  z.object({ status: z.literal("packet_missing") }).strict(),
  z
    .object({
      status: z.literal("packet_invalidated"),
      reason_code: z.string().min(1),
    })
    .strict(),
  HandoffPacketSizeBlockerSchema,
]);
export type HandoffValidationOutcome = z.infer<
  typeof HandoffValidationOutcomeSchema
>;

/** Return a packet only after a valid typed outcome is bound to its digest. */
export function requireConsumableEvidenceHandoff(
  value: unknown,
  outcome: HandoffValidationOutcome,
): EvidenceHandoffPacket {
  const packet = assertEvidenceHandoffPacketIntrinsic(value);
  const validatedOutcome = HandoffValidationOutcomeSchema.parse(outcome);
  if (
    validatedOutcome.status !== "packet_valid" &&
    validatedOutcome.status !== "packet_valid_empty"
  )
    throw new Error(
      `Evidence handoff outcome ${validatedOutcome.status} is not consumable`,
    );
  if (
    validatedOutcome.packet_digest !== packet.packet_digest ||
    validatedOutcome.finding_count !== packet.findings.length
  )
    throw new Error("Consumable handoff outcome is not bound to this packet");
  return packet;
}

export interface ValidateEvidenceHandoffPacketInput {
  packet?: unknown;
  canonicalBytes?: Uint8Array;
  expected: {
    runId: string;
    roundId: string;
    reviewerSlot: string;
    targetSlot: string;
    targetSnapshot: Pick<
      HandoffTargetSnapshot,
      "base_commit" | "frozen_patch_sha256" | "frozen_git_tree_id"
    >;
    permissionProjection: ResolvedPermissionProjection;
  };
  invalidatedReasonCode?: string;
  sourceFindings?: readonly unknown[];
  taskSourceIds?: readonly string[];
  capabilityIds?: readonly string[];
}

export function validateEvidenceHandoffPacket(
  input: ValidateEvidenceHandoffPacketInput,
): HandoffValidationOutcome {
  if (input.packet === undefined || input.packet === null)
    return { status: "packet_missing" };
  let packet: EvidenceHandoffPacket;
  try {
    packet = EvidenceHandoffPacketSchema.parse(input.packet);
  } catch {
    return {
      status: "packet_malformed",
      diagnostic_code: "strict_schema_invalid",
    };
  }
  if (input.invalidatedReasonCode)
    return {
      status: "packet_invalidated",
      reason_code: input.invalidatedReasonCode,
    };
  const measuredBytes = measureEvidenceHandoffPacket(packet);
  if (measuredBytes > EVIDENCE_HANDOFF_MAX_BYTES)
    return {
      status: "packet_oversized",
      measured_bytes: measuredBytes,
      max_bytes: EVIDENCE_HANDOFF_MAX_BYTES,
    };
  if (
    !input.canonicalBytes ||
    !Buffer.from(input.canonicalBytes).equals(
      Buffer.from(canonicalHandoffJson(packet), "utf8"),
    )
  )
    return {
      status: "packet_malformed",
      diagnostic_code: "noncanonical_encoding",
    };
  const { packet_digest: packetDigest, ...body } = packet;
  if (calculatePacketDigest(body) !== packetDigest)
    return {
      status: "packet_malformed",
      diagnostic_code: "packet_digest_mismatch",
    };
  if (
    calculateTargetFingerprint(packet.target_snapshot) !==
    packet.target_snapshot.fingerprint
  )
    return {
      status: "packet_malformed",
      diagnostic_code: "target_snapshot_fingerprint_invalid",
    };
  for (const finding of packet.findings) {
    const findingId = finding.finding_id;
    const payload = HandoffFindingPayloadSchema.parse(
      Object.fromEntries(
        Object.entries(finding).filter(
          ([key]) => key !== "finding_id" && key !== "priority",
        ),
      ),
    );
    if (
      calculateFindingId(packet.target_snapshot.fingerprint, payload) !==
      findingId
    )
      return {
        status: "packet_malformed",
        diagnostic_code: "finding_id_mismatch",
      };
  }
  if (
    packet.run_id !== input.expected.runId ||
    packet.round_id !== input.expected.roundId ||
    packet.reviewer_slot !== input.expected.reviewerSlot ||
    packet.target_slot !== input.expected.targetSlot
  )
    return {
      status: "packet_malformed",
      diagnostic_code: "lane_identity_mismatch",
    };
  const expectedTarget = {
    ...input.expected.targetSnapshot,
    fingerprint: calculateTargetFingerprint(input.expected.targetSnapshot),
  };
  if (
    canonicalHandoffJson(packet.target_snapshot) !==
    canonicalHandoffJson(expectedTarget)
  )
    return {
      status: "packet_stale",
      diagnostic_code: "target_fingerprint_mismatch",
    };
  if (
    packet.permission_manifest_fingerprint !==
    calculatePermissionManifestFingerprint(input.expected.permissionProjection)
  )
    return {
      status: "packet_stale",
      diagnostic_code: "permission_fingerprint_mismatch",
    };
  if (!input.sourceFindings || !input.taskSourceIds || !input.capabilityIds)
    return {
      status: "packet_malformed",
      diagnostic_code: "omission_evidence_missing",
    };
  try {
    const rebuilt = assemblePacket({
      packetId: packet.packet_id,
      runId: packet.run_id,
      roundId: packet.round_id,
      reviewerSlot: packet.reviewer_slot,
      targetSlot: packet.target_slot,
      targetSnapshot: input.expected.targetSnapshot,
      permissionProjection: input.expected.permissionProjection,
      findings: input.sourceFindings,
      taskSourceIds: input.taskSourceIds,
      capabilityIds: input.capabilityIds,
    });
    if (
      rebuilt.status !== "packet_created" ||
      canonicalHandoffJson(rebuilt.packet) !== canonicalHandoffJson(packet)
    )
      return {
        status: "packet_malformed",
        diagnostic_code: "omission_metadata_mismatch",
      };
  } catch {
    return {
      status: "packet_malformed",
      diagnostic_code: "omission_metadata_mismatch",
    };
  }
  return packet.findings.length === 0
    ? {
        status: "packet_valid_empty",
        packet_digest: packet.packet_digest,
        finding_count: 0,
      }
    : {
        status: "packet_valid",
        packet_digest: packet.packet_digest,
        finding_count: packet.findings.length,
      };
}

export const HandoffArtifactPointerSchema = z
  .object({
    artifact_id: normalizedTextSchema(1, 128),
    path: TargetRelativePathSchema,
    sha256: Sha256Schema,
    byte_length: z.number().int().nonnegative(),
  })
  .strict();
export type HandoffArtifactPointer = z.infer<
  typeof HandoffArtifactPointerSchema
>;

export const HandoffDiagnosticPointerSchema = z
  .object({
    version: z.literal(1),
    artifact_id: normalizedTextSchema(1, 128),
    path: TargetRelativePathSchema,
    sha256: Sha256Schema,
    byte_length: z
      .number()
      .int()
      .min(1)
      .max(EVIDENCE_HANDOFF_DIAGNOSTIC_MAX_BYTES),
    depth: z.literal(1),
    description: normalizedTextSchema(1, 300),
  })
  .strict();
export type HandoffDiagnosticPointer = z.infer<
  typeof HandoffDiagnosticPointerSchema
>;

export const HandoffLifecycleStateSchema = z.enum([
  "created",
  "validated",
  "refresh_required",
  "consumed",
  "completed_empty",
  "invalidated",
  "coverage_loss",
]);
export const HandoffLifecycleEventSchema = z.enum([
  "creation",
  "validation",
  "refresh",
  "consumption",
  "empty_completion",
  "invalidation",
  "blocking",
  "coverage_loss",
]);
export type HandoffLifecycleState = z.infer<typeof HandoffLifecycleStateSchema>;

export const HandoffLifecycleRecordSchema = z
  .object({
    version: z.literal(2),
    record_id: normalizedTextSchema(1, 128),
    previous_record_id: z.union([normalizedTextSchema(1, 128), z.null()]),
    run_id: PrintableRunIdSchema,
    round_id: PrintableRoundIdSchema,
    lane_id: SlotIdSchema,
    reviewer_slot: SlotIdSchema,
    target_slot: SlotIdSchema,
    packet_id: z.union([UuidV7Schema, z.null()]),
    packet_digest: z.union([Sha256Schema, z.null()]),
    state: HandoffLifecycleStateSchema,
    event: HandoffLifecycleEventSchema,
    reason_code: normalizedTextSchema(1, 128),
    attempt: z.union([z.literal(1), z.literal(2)]),
    artifact_pointers: z.array(HandoffArtifactPointerSchema),
    diagnostic_pointer: z.union([HandoffDiagnosticPointerSchema, z.null()]),
    recorded_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.reviewer_slot === record.target_slot)
      context.addIssue({
        code: "custom",
        path: ["target_slot"],
        message: "Reviewer and target slots must differ",
      });
    if (record.packet_digest !== null && record.packet_id === null)
      context.addIssue({
        code: "custom",
        path: ["packet_digest"],
        message: "A packet digest requires its packet ID",
      });
    if (
      [
        "created",
        "validated",
        "consumed",
        "completed_empty",
        "invalidated",
      ].includes(record.state) &&
      (record.packet_id === null || record.packet_digest === null)
    )
      context.addIssue({
        code: "custom",
        path: ["packet_digest"],
        message: `${record.state} lifecycle records require a packet identity and digest`,
      });
    if (record.state === "created" && record.artifact_pointers.length === 0)
      context.addIssue({
        code: "custom",
        path: ["artifact_pointers"],
        message: "Created lifecycle records must point to the packet artifact",
      });
    const allowedEvents: Record<
      HandoffLifecycleState,
      ReadonlySet<z.infer<typeof HandoffLifecycleEventSchema>>
    > = {
      created: new Set(["creation"]),
      validated: new Set(["validation", "refresh"]),
      refresh_required: new Set(["validation", "blocking"]),
      consumed: new Set(["consumption"]),
      completed_empty: new Set(["empty_completion"]),
      invalidated: new Set(["invalidation"]),
      coverage_loss: new Set(["coverage_loss"]),
    };
    if (!allowedEvents[record.state].has(record.event))
      context.addIssue({
        code: "custom",
        path: ["event"],
        message: `Event ${record.event} cannot produce state ${record.state}`,
      });
  });
export type HandoffLifecycleRecord = z.infer<
  typeof HandoffLifecycleRecordSchema
>;

const allowedLifecycleTransitions: Record<
  HandoffLifecycleState,
  ReadonlySet<HandoffLifecycleState>
> = {
  created: new Set(["validated", "refresh_required", "invalidated"]),
  validated: new Set([
    "consumed",
    "completed_empty",
    "refresh_required",
    "invalidated",
  ]),
  refresh_required: new Set(["validated", "coverage_loss"]),
  consumed: new Set(),
  completed_empty: new Set(),
  invalidated: new Set(),
  coverage_loss: new Set(),
};

export function assertHandoffLifecycleTransition(
  previous: HandoffLifecycleRecord | undefined,
  next: HandoffLifecycleRecord,
): void {
  HandoffLifecycleRecordSchema.parse(next);
  if (!previous) {
    if (
      next.previous_record_id !== null ||
      (next.state !== "created" && next.state !== "refresh_required") ||
      next.attempt !== 1 ||
      (next.state === "created" && next.event !== "creation") ||
      (next.state === "refresh_required" && next.event !== "blocking")
    )
      throw new Error(
        "A handoff lifecycle must start with a valid attempt-1 creation or blocking tuple without a parent",
      );
    return;
  }
  HandoffLifecycleRecordSchema.parse(previous);
  if (next.previous_record_id !== previous.record_id)
    throw new Error("Handoff lifecycle record must point to the current head");
  if (
    next.run_id !== previous.run_id ||
    next.round_id !== previous.round_id ||
    next.lane_id !== previous.lane_id ||
    next.reviewer_slot !== previous.reviewer_slot ||
    next.target_slot !== previous.target_slot
  )
    throw new Error("Handoff lifecycle identity cannot change");
  if (!allowedLifecycleTransitions[previous.state]?.has(next.state))
    throw new Error(
      `Invalid handoff lifecycle transition: ${previous.state} -> ${next.state}`,
    );
  const expectedEvents: Partial<
    Record<
      HandoffLifecycleState,
      Partial<
        Record<
          HandoffLifecycleState,
          z.infer<typeof HandoffLifecycleEventSchema>
        >
      >
    >
  > = {
    created: {
      validated: "validation",
      refresh_required: "validation",
      invalidated: "invalidation",
    },
    validated: {
      consumed: "consumption",
      completed_empty: "empty_completion",
      refresh_required: "blocking",
      invalidated: "invalidation",
    },
    refresh_required: {
      validated: "refresh",
      coverage_loss: "coverage_loss",
    },
  };
  const expectedEvent = expectedEvents[previous.state]?.[next.state];
  const expectedAttempt =
    previous.state === "refresh_required" ? 2 : previous.attempt;
  if (
    next.event !== expectedEvent ||
    next.attempt !== expectedAttempt ||
    (previous.state === "refresh_required" &&
      previous.attempt === 2 &&
      next.state !== "coverage_loss")
  )
    throw new Error(
      `Invalid handoff lifecycle tuple: ${previous.state} -> ${next.state} via ${next.event} on attempt ${String(next.attempt)}`,
    );
  const successfulRefresh =
    previous.state === "refresh_required" && next.state === "validated";
  if (
    !successfulRefresh &&
    (next.packet_id !== previous.packet_id ||
      next.packet_digest !== previous.packet_digest)
  )
    throw new Error(
      "A packet identity or digest cannot change without a refresh",
    );
  if (
    previous.state === "refresh_required" &&
    next.state === "validated" &&
    previous.packet_id !== null &&
    next.packet_id === previous.packet_id
  )
    throw new Error("A refresh must create a fresh packet identity");
}
