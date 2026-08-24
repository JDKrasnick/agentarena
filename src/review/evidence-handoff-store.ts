import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactStore } from "../artifacts/store.js";
import {
  EVIDENCE_HANDOFF_DIAGNOSTIC_MAX_BYTES,
  EvidenceHandoffPacketSchema,
  HandoffDiagnosticPointerSchema,
  HandoffLifecycleRecordSchema,
  HandoffValidationOutcomeSchema,
  assertEvidenceHandoffPacketIntrinsic,
  assertHandoffLifecycleTransition,
  canonicalHandoffJson,
  type EvidenceHandoffPacket,
  type HandoffArtifactPointer,
  type HandoffDiagnosticPointer,
  type HandoffLifecycleRecord,
} from "./evidence-handoff.js";
import { sha256 } from "../core/ids.js";

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new Error(`${label} is not a safe artifact path segment`);
  return value;
}

function handoffRoot(roundId: string, laneId: string): string {
  return path.posix.join(
    "rounds",
    safeSegment(roundId, "roundId"),
    "handoffs",
    safeSegment(laneId, "laneId"),
  );
}

function packetLane(packet: EvidenceHandoffPacket): string {
  return `${safeSegment(packet.reviewer_slot, "reviewer_slot")}-to-${safeSegment(packet.target_slot, "target_slot")}`;
}

function packetArtifactPath(packet: EvidenceHandoffPacket): string {
  return path.posix.join(
    handoffRoot(packet.round_id, packetLane(packet)),
    "packets",
    `${safeSegment(packet.packet_id, "packet_id")}.json`,
  );
}

export async function persistEvidenceHandoffPacket(
  store: ArtifactStore,
  roundId: string,
  laneId: string,
  packet: EvidenceHandoffPacket,
): Promise<HandoffArtifactPointer> {
  const validated = assertEvidenceHandoffPacketIntrinsic(packet);
  const expectedLaneId = packetLane(validated);
  if (roundId !== validated.round_id || laneId !== expectedLaneId)
    throw new Error(
      `Evidence handoff storage identity must match packet lane ${validated.round_id}/${expectedLaneId}`,
    );
  const bytes = Buffer.from(canonicalHandoffJson(validated), "utf8");
  const relative = packetArtifactPath(validated);
  await store.writeImmutableBytes(relative, bytes);
  return {
    artifact_id: validated.packet_id,
    path: relative,
    sha256: sha256(bytes),
    byte_length: bytes.byteLength,
  };
}

/** Each parent may be extended once, so a forked append fails instead of splitting the chain. */
function headClaimId(record: HandoffLifecycleRecord): string {
  return sha256(
    canonicalHandoffJson({ previous_record_id: record.previous_record_id }),
  );
}

function orderLifecycle(
  records: readonly HandoffLifecycleRecord[],
): HandoffLifecycleRecord[] {
  if (records.length === 0) return [];
  const byId = new Map(records.map((record) => [record.record_id, record]));
  if (byId.size !== records.length)
    throw new Error("Handoff lifecycle contains duplicate record IDs");
  const parents = new Set<string>();
  for (const record of records) {
    if (record.previous_record_id === null) continue;
    if (!byId.has(record.previous_record_id))
      throw new Error("Handoff lifecycle references an unknown parent");
    parents.add(record.previous_record_id);
  }
  const heads = records.filter((record) => !parents.has(record.record_id));
  if (heads.length !== 1)
    throw new Error(
      "Handoff lifecycle does not have exactly one structural head",
    );
  const visited = new Set<string>();
  let current: HandoffLifecycleRecord | undefined = heads[0];
  while (current) {
    if (visited.has(current.record_id))
      throw new Error("Handoff lifecycle contains a cycle");
    visited.add(current.record_id);
    current = current.previous_record_id
      ? byId.get(current.previous_record_id)
      : undefined;
  }
  if (visited.size !== records.length)
    throw new Error("Handoff lifecycle contains a disconnected chain");
  const ordered: HandoffLifecycleRecord[] = [];
  current = heads[0];
  while (current) {
    ordered.push(current);
    current = current.previous_record_id
      ? byId.get(current.previous_record_id)
      : undefined;
  }
  return ordered.reverse();
}

export async function readHandoffLifecycle(
  store: ArtifactStore,
  roundId: string,
  laneId: string,
): Promise<HandoffLifecycleRecord[]> {
  const records = await store.listValidatedArtifacts(
    path.posix.join(handoffRoot(roundId, laneId), "lifecycle"),
    HandoffLifecycleRecordSchema,
  );
  const ordered = orderLifecycle(records);
  ordered.forEach((record, index) =>
    assertHandoffLifecycleTransition(ordered[index - 1], record),
  );
  return ordered;
}

export async function readCurrentHandoffLifecycle(
  store: ArtifactStore,
  roundId: string,
  laneId: string,
): Promise<HandoffLifecycleRecord | undefined> {
  return (await readHandoffLifecycle(store, roundId, laneId)).at(-1);
}

export async function persistHandoffLifecycleRecord(
  store: ArtifactStore,
  record: HandoffLifecycleRecord,
): Promise<string> {
  const validated = HandoffLifecycleRecordSchema.parse(record);
  const current = await readCurrentHandoffLifecycle(
    store,
    validated.round_id,
    validated.lane_id,
  );
  assertHandoffLifecycleTransition(current, validated);
  const lifecycle = path.posix.join(
    handoffRoot(validated.round_id, validated.lane_id),
    "lifecycle",
  );
  const relative = path.posix.join(
    lifecycle,
    `${safeSegment(validated.record_id, "record_id")}.json`,
  );
  try {
    await store.writeImmutableJson(
      path.posix.join(lifecycle, "heads", `${headClaimId(validated)}.json`),
      { record_id: validated.record_id },
    );
  } catch (error) {
    throw new Error(
      "Handoff lifecycle head is already claimed by another record",
      { cause: error },
    );
  }
  await store.writeImmutableJson(relative, validated);
  return relative;
}

export async function persistHandoffValidationOutcome(
  store: ArtifactStore,
  roundId: string,
  laneId: string,
  outcomeId: string,
  outcome: unknown,
): Promise<string> {
  const validated = HandoffValidationOutcomeSchema.parse(outcome);
  const relative = path.posix.join(
    handoffRoot(roundId, laneId),
    "validation",
    `${safeSegment(outcomeId, "outcomeId")}.json`,
  );
  await store.writeImmutableJson(relative, validated);
  return relative;
}

export async function readEvidenceHandoffArtifact(
  store: ArtifactStore,
  relativePath: string,
): Promise<EvidenceHandoffPacket> {
  const bytes = await readFile(store.resolve(relativePath));
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  const packet = EvidenceHandoffPacketSchema.parse(value);
  if (!bytes.equals(Buffer.from(canonicalHandoffJson(packet), "utf8")))
    throw new Error("Persisted v2 handoff packet is not canonical JSON");
  const validated = assertEvidenceHandoffPacketIntrinsic(packet);
  if (relativePath !== packetArtifactPath(validated))
    throw new Error(
      "Persisted v2 handoff packet path does not match its round and lane identity",
    );
  return validated;
}

export async function readHandoffDiagnostic(
  store: ArtifactStore,
  pointer: HandoffDiagnosticPointer,
  owner: HandoffLifecycleRecord,
): Promise<Uint8Array> {
  const validatedOwner = HandoffLifecycleRecordSchema.parse(owner);
  const persistedOwner = (
    await readHandoffLifecycle(
      store,
      validatedOwner.round_id,
      validatedOwner.lane_id,
    )
  ).find((record) => record.record_id === validatedOwner.record_id);
  if (
    !persistedOwner ||
    canonicalHandoffJson(persistedOwner) !==
      canonicalHandoffJson(validatedOwner)
  )
    throw new Error(
      "Diagnostic owner is not an immutable persisted lifecycle record",
    );
  const validated = HandoffDiagnosticPointerSchema.parse(pointer);
  if (
    persistedOwner.diagnostic_pointer === null ||
    canonicalHandoffJson(persistedOwner.diagnostic_pointer) !==
      canonicalHandoffJson(validated)
  )
    throw new Error("Diagnostic pointer is not owned by the lifecycle record");
  const diagnosticRoot = path.posix.join(
    handoffRoot(persistedOwner.round_id, persistedOwner.lane_id),
    "diagnostics",
  );
  if (path.posix.dirname(validated.path) !== diagnosticRoot)
    throw new Error("Handoff diagnostic must be one direct lane artifact");
  const blockerCategories = new Set([
    "permission_unavailable",
    "cited_context_missing",
    "target_artifact_unavailable",
    "policy_ambiguous",
    "packet_size",
  ]);
  const validationDiagnostics = new Set([
    "target_fingerprint_mismatch",
    "permission_fingerprint_mismatch",
    "strict_schema_invalid",
    "noncanonical_encoding",
    "packet_digest_mismatch",
    "target_snapshot_fingerprint_invalid",
    "finding_id_mismatch",
    "lane_identity_mismatch",
    "omission_evidence_missing",
    "omission_metadata_mismatch",
    "packet_oversized",
  ]);
  const diagnosticTransition =
    (persistedOwner.state === "refresh_required" ||
      persistedOwner.state === "coverage_loss") &&
    ((persistedOwner.event === "validation" &&
      validationDiagnostics.has(persistedOwner.reason_code)) ||
      (persistedOwner.event === "coverage_loss" &&
        (validationDiagnostics.has(persistedOwner.reason_code) ||
          blockerCategories.has(persistedOwner.reason_code))) ||
      (persistedOwner.event === "blocking" &&
        blockerCategories.has(persistedOwner.reason_code)));
  if (!diagnosticTransition)
    throw new Error(
      "Diagnostic drill-down is available only for stale, malformed, or blocked handoffs",
    );
  const bytes = await readFile(store.resolve(validated.path));
  if (
    bytes.byteLength > EVIDENCE_HANDOFF_DIAGNOSTIC_MAX_BYTES ||
    bytes.byteLength !== validated.byte_length
  )
    throw new Error("Handoff diagnostic exceeds its one-hop 8 KiB contract");
  if (sha256(bytes) !== validated.sha256)
    throw new Error("Handoff diagnostic digest mismatch");
  return bytes;
}
