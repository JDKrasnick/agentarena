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
  type HandoffValidationOutcome,
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

export async function persistEvidenceHandoffPacket(
  store: ArtifactStore,
  roundId: string,
  laneId: string,
  packet: EvidenceHandoffPacket,
): Promise<HandoffArtifactPointer> {
  const validated = assertEvidenceHandoffPacketIntrinsic(packet);
  const bytes = Buffer.from(canonicalHandoffJson(validated), "utf8");
  const relative = path.posix.join(
    handoffRoot(roundId, laneId),
    "packets",
    `${validated.packet_id}.json`,
  );
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
  return assertEvidenceHandoffPacketIntrinsic(packet);
}

export async function readHandoffDiagnostic(
  store: ArtifactStore,
  pointer: HandoffDiagnosticPointer,
  outcome: HandoffValidationOutcome,
): Promise<Uint8Array> {
  const validatedOutcome = HandoffValidationOutcomeSchema.parse(outcome);
  if (
    validatedOutcome.status !== "packet_stale" &&
    validatedOutcome.status !== "packet_malformed" &&
    validatedOutcome.status !== "handoff_blocked"
  )
    throw new Error(
      "Diagnostic drill-down is available only for stale, malformed, or blocked handoffs",
    );
  const validated = HandoffDiagnosticPointerSchema.parse(pointer);
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
