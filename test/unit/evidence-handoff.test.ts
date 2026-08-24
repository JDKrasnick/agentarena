import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/store.js";
import { sha256 } from "../../src/core/ids.js";
import type { PermissionPolicy } from "../../src/core/types.js";
import {
  EVIDENCE_HANDOFF_MAX_BYTES,
  HandoffLifecycleRecordSchema,
  buildEvidenceHandoffPacket,
  calculatePacketDigest,
  calculatePermissionManifestFingerprint,
  canonicalHandoffJson,
  normalizeHandoffBlocker,
  projectResolvedPermissions,
  requireConsumableEvidenceHandoff,
  validateEvidenceHandoffPacket,
  type BuildEvidenceHandoffPacketInput,
  type HandoffFindingPayload,
} from "../../src/review/evidence-handoff.js";
import {
  persistEvidenceHandoffPacket,
  persistHandoffLifecycleRecord,
  persistHandoffValidationOutcome,
  readCurrentHandoffLifecycle,
  readEvidenceHandoffArtifact,
  readHandoffDiagnostic,
} from "../../src/review/evidence-handoff-store.js";

const policy: PermissionPolicy = {
  defaultMode: "confirm",
  reducedValidationAccepted: false,
  capabilities: [
    {
      id: "shell",
      reason: "Run focused tests",
      risk: "medium",
      requirement: "required",
      role: "agent",
      enforcement: "advisory",
      mode: "confirm",
      scopes: ["repository"],
      status: "approved",
    },
  ],
};

const projection = projectResolvedPermissions({ policy });

const targetSnapshot = {
  base_commit: "1".repeat(40),
  frozen_patch_sha256: "2".repeat(64),
  frozen_git_tree_id: "3".repeat(40),
};

const finding: HandoffFindingPayload = {
  trust: "reviewer_hypothesis",
  invariant: "Concurrent refresh must preserve the newest valid token.",
  observations: [
    {
      trust: "reviewer_hypothesis",
      statement: "Both requests can read the same pre-refresh version.",
      provenance: {
        kind: "code_inspection",
        references: ["src/session.ts:88-112"],
      },
    },
  ],
  code_locations: [
    {
      path: "src/session.ts",
      line_start: 88,
      line_end: 112,
      symbol: "refreshSession",
    },
  ],
  trigger_sequence: [
    "Start two refresh requests for one session.",
    "Allow both reads to finish before either write.",
    "Complete the writes in reverse order.",
  ],
  oracle: {
    expected_behavior:
      "The session retains the token from the newest successful refresh.",
    task_source_ids: ["source_issue_241"],
    task_source_rationale:
      "Acceptance criterion 3 requires concurrent refresh to retain the valid token.",
  },
  confidence: 84,
  required_capability_ids: ["filesystem", "shell"],
  regression_test_plan: {
    summary: "Add a controlled two-request schedule test.",
    suggested_paths: ["test/session-refresh-race.test.ts"],
    focused_command: "npm test -- test/session-refresh-race.test.ts",
  },
};

function buildInput(
  findings: readonly unknown[] = [finding],
): BuildEvidenceHandoffPacketInput {
  return {
    packetId: "0191a2b3-c4d5-7e6f-8123-456789abcdef",
    runId: "run_2026-08-18T200000Z",
    roundId: "round_2",
    reviewerSlot: "a",
    targetSlot: "b",
    targetSnapshot,
    permissionProjection: projection,
    findings,
    taskSourceIds: ["source_issue_241"],
    capabilityIds: ["filesystem", "shell"],
  };
}

function created(findings: readonly unknown[] = [finding]) {
  const result = buildEvidenceHandoffPacket(buildInput(findings));
  if (result.status !== "packet_created") throw new Error("Expected a packet");
  return result;
}

describe("trusted evidence handoff v2", () => {
  it("matches the RFC target, permission, finding, packet, and byte fixtures", () => {
    const result = created();
    expect(result.packet.target_snapshot.fingerprint).toBe(
      "c4178f888bf7cda1c4c4b1091d6545238966165e5d4abea2a8dd01a6a057aa34",
    );
    expect(calculatePermissionManifestFingerprint(projection)).toBe(
      "88718e5e8034a3bb02190e79eb43829e0b2477c14659889b330f5aeefabef6b3",
    );
    expect(result.packet.findings[0]?.finding_id).toBe(
      "finding_77f97d6a9449717bb848d52bb039ec68ba1cc3fe20bb881b2da391208cd0b32d",
    );
    expect(result.packet.packet_digest).toBe(
      "e745c956a26b486165d92d414109963f4d5df4d09f8088e5ccd176b89d85c5cb",
    );
    expect(result.canonicalBytes.byteLength).toBe(1_877);
    const expected = {
      runId: result.packet.run_id,
      roundId: result.packet.round_id,
      reviewerSlot: "a",
      targetSlot: "b",
      targetSnapshot,
      permissionProjection: projection,
    };
    expect(
      validateEvidenceHandoffPacket({
        packet: result.packet,
        canonicalBytes: result.canonicalBytes,
        expected,
        sourceFindings: [finding],
        taskSourceIds: ["source_issue_241"],
        capabilityIds: ["filesystem", "shell"],
      }),
    ).toEqual({
      status: "packet_valid",
      packet_digest: result.packet.packet_digest,
      finding_count: 1,
    });
    expect(
      validateEvidenceHandoffPacket({ packet: result.packet, expected }),
    ).toEqual({
      status: "packet_malformed",
      diagnostic_code: "omission_evidence_missing",
    });
  });

  it("creates a genuine empty packet without confusing it with failure", () => {
    const built = buildEvidenceHandoffPacket({
      ...buildInput([]),
      packetId: "0191a2b3-c4d5-7e70-8123-456789abcdef",
    });
    if (built.status !== "packet_created") throw new Error("Expected packet");
    const result = built;
    expect(result.packet.packet_digest).toBe(
      "2cafd9d57efddbce61ec8f59877480d17f33dbcb545f409d730149e022e7ebaf",
    );
    expect(result.canonicalBytes.byteLength).toBe(710);
    expect(
      validateEvidenceHandoffPacket({
        packet: result.packet,
        canonicalBytes: result.canonicalBytes,
        sourceFindings: [],
        taskSourceIds: ["source_issue_241"],
        capabilityIds: ["filesystem", "shell"],
        expected: {
          runId: result.packet.run_id,
          roundId: result.packet.round_id,
          reviewerSlot: "a",
          targetSlot: "b",
          targetSnapshot,
          permissionProjection: projection,
        },
      }),
    ).toEqual({
      status: "packet_valid_empty",
      packet_digest: result.packet.packet_digest,
      finding_count: 0,
    });
  });

  it("rejects silently dropped and duplicated source findings", () => {
    const second = {
      ...structuredClone(finding),
      invariant: "A distinct second invariant.",
    };
    const result = created([finding, second]);
    const expected = {
      runId: result.packet.run_id,
      roundId: result.packet.round_id,
      reviewerSlot: "a",
      targetSlot: "b",
      targetSnapshot,
      permissionProjection: projection,
    };
    const silentlyDropped = structuredClone(result.packet);
    silentlyDropped.findings.pop();
    silentlyDropped.packet_digest = calculatePacketDigest(
      Object.fromEntries(
        Object.entries(silentlyDropped).filter(
          ([key]) => key !== "packet_digest",
        ),
      ) as Omit<typeof silentlyDropped, "packet_digest">,
    );
    expect(
      validateEvidenceHandoffPacket({
        packet: silentlyDropped,
        expected,
        sourceFindings: [finding, second],
        taskSourceIds: ["source_issue_241"],
        capabilityIds: ["filesystem", "shell"],
      }),
    ).toEqual({
      status: "packet_malformed",
      diagnostic_code: "omission_metadata_mismatch",
    });

    const duplicated = structuredClone(created().packet);
    duplicated.findings.push({
      ...structuredClone(duplicated.findings[0]!),
      priority: 2,
    });
    duplicated.packet_digest = calculatePacketDigest(
      Object.fromEntries(
        Object.entries(duplicated).filter(([key]) => key !== "packet_digest"),
      ) as Omit<typeof duplicated, "packet_digest">,
    );
    expect(
      validateEvidenceHandoffPacket({
        packet: duplicated,
        expected,
        sourceFindings: [finding],
        taskSourceIds: ["source_issue_241"],
        capabilityIds: ["filesystem", "shell"],
      }),
    ).toEqual({
      status: "packet_malformed",
      diagnostic_code: "omission_metadata_mismatch",
    });
  });

  it("preserves priority, removes exact duplicates, and compacts only the tail", () => {
    const duplicate = structuredClone(finding);
    duplicate.required_capability_ids = ["shell", "filesystem"];
    const many = Array.from({ length: 12 }, (_, index) => ({
      ...structuredClone(finding),
      invariant: `${String(index + 1)} ${"x".repeat(900)}`,
      oracle: {
        ...finding.oracle,
        expected_behavior: `${String(index + 1)} ${"y".repeat(1_300)}`,
      },
    }));
    const duplicateResult = created([finding, many[1], duplicate]);
    expect(
      duplicateResult.packet.findings.map((entry) => entry.priority),
    ).toEqual([1, 2]);
    expect(duplicateResult.packet.omitted_findings.entries).toMatchObject([
      { original_priority: 3, reason: "duplicate" },
    ]);

    const compacted = created(many);
    expect(compacted.canonicalBytes.byteLength).toBeLessThanOrEqual(
      EVIDENCE_HANDOFF_MAX_BYTES,
    );
    expect(compacted.packet.findings.map((entry) => entry.priority)).toEqual(
      Array.from(
        { length: compacted.packet.findings.length },
        (_, index) => index + 1,
      ),
    );
    expect(
      compacted.packet.omitted_findings.entries.every(
        (entry) => entry.reason === "packet_size",
      ),
    ).toBe(true);
    const expected = {
      runId: compacted.packet.run_id,
      roundId: compacted.packet.round_id,
      reviewerSlot: "a",
      targetSlot: "b",
      targetSnapshot,
      permissionProjection: projection,
    };
    expect(
      validateEvidenceHandoffPacket({
        packet: compacted.packet,
        expected,
      }),
    ).toEqual({
      status: "packet_malformed",
      diagnostic_code: "omission_evidence_missing",
    });
    expect(
      validateEvidenceHandoffPacket({
        packet: compacted.packet,
        expected,
        sourceFindings: many,
        taskSourceIds: ["source_issue_241"],
        capabilityIds: ["filesystem", "shell"],
      }).status,
    ).toBe("packet_valid");
    const wrongOmissions = structuredClone(compacted.packet);
    wrongOmissions.omitted_findings.entries[0]!.original_priority -= 1;
    wrongOmissions.packet_digest = calculatePacketDigest(
      Object.fromEntries(
        Object.entries(wrongOmissions).filter(
          ([key]) => key !== "packet_digest",
        ),
      ) as Omit<typeof wrongOmissions, "packet_digest">,
    );
    expect(
      validateEvidenceHandoffPacket({
        packet: wrongOmissions,
        expected,
        sourceFindings: many,
        taskSourceIds: ["source_issue_241"],
        capabilityIds: ["filesystem", "shell"],
      }).status,
    ).toBe("packet_malformed");

    const limited = created(
      Array.from({ length: 13 }, (_, index) => ({
        ...structuredClone(finding),
        invariant: `Distinct invariant ${String(index + 1)}`,
      })),
    );
    expect(limited.packet.findings).toHaveLength(12);
    expect(limited.packet.omitted_findings.entries).toMatchObject([
      { original_priority: 13, reason: "finding_limit" },
    ]);
  });

  it("blocks an oversized single finding instead of creating a false empty packet", () => {
    const huge = {
      ...structuredClone(finding),
      invariant: "i".repeat(1_000),
      observations: Array.from({ length: 8 }, (_, index) => ({
        trust: "reviewer_hypothesis",
        statement: "o".repeat(1_000),
        provenance: {
          kind: "code_inspection",
          references: [`src/session-${String(index)}.ts`],
        },
      })),
      trigger_sequence: Array.from({ length: 12 }, () => "t".repeat(500)),
      oracle: {
        expected_behavior: "e".repeat(1_500),
        task_source_ids: ["source_issue_241"],
        task_source_rationale: "r".repeat(1_500),
      },
      regression_test_plan: {
        summary: "s".repeat(1_500),
        suggested_paths: [],
        focused_command: "c".repeat(1_000),
      },
    };
    const result = buildEvidenceHandoffPacket(buildInput([huge]));
    expect(result.status).toBe("handoff_blocked");
    if (result.status === "handoff_blocked") {
      expect(result.blocker.category).toBe("packet_size");
      expect(result.blocker.measured_bytes).toBeGreaterThan(
        EVIDENCE_HANDOFF_MAX_BYTES,
      );
    }
  });

  it("returns distinct missing, malformed, stale, oversized, and invalidated outcomes", () => {
    const result = created();
    const expected = {
      runId: result.packet.run_id,
      roundId: result.packet.round_id,
      reviewerSlot: "a",
      targetSlot: "b",
      targetSnapshot,
      permissionProjection: projection,
    };
    expect(validateEvidenceHandoffPacket({ expected }).status).toBe(
      "packet_missing",
    );
    expect(
      validateEvidenceHandoffPacket({
        packet: { ...result.packet, unknown: true },
        expected,
      }).status,
    ).toBe("packet_malformed");
    expect(
      validateEvidenceHandoffPacket({
        packet: result.packet,
        expected: {
          ...expected,
          targetSnapshot: {
            ...targetSnapshot,
            frozen_patch_sha256: "9".repeat(64),
          },
        },
      }),
    ).toEqual({
      status: "packet_stale",
      diagnostic_code: "target_fingerprint_mismatch",
    });
    expect(
      validateEvidenceHandoffPacket({
        packet: result.packet,
        expected: {
          ...expected,
          permissionProjection: {
            ...projection,
            capabilities: projection.capabilities.map((capability) => ({
              ...capability,
              status: "denied" as const,
            })),
          },
        },
      }),
    ).toEqual({
      status: "packet_stale",
      diagnostic_code: "permission_fingerprint_mismatch",
    });
    expect(
      validateEvidenceHandoffPacket({
        packet: result.packet,
        expected: { ...expected, reviewerSlot: "b" },
      }),
    ).toEqual({
      status: "packet_malformed",
      diagnostic_code: "lane_identity_mismatch",
    });
    expect(
      validateEvidenceHandoffPacket({
        packet: { ...result.packet, packet_digest: "f".repeat(64) },
        expected,
      }),
    ).toEqual({
      status: "packet_malformed",
      diagnostic_code: "packet_digest_mismatch",
    });
    expect(
      validateEvidenceHandoffPacket({
        packet: result.packet,
        canonicalBytes: Buffer.from(
          `${canonicalHandoffJson(result.packet)}\n`,
          "utf8",
        ),
        expected,
      }),
    ).toEqual({
      status: "packet_malformed",
      diagnostic_code: "noncanonical_encoding",
    });
    expect(
      validateEvidenceHandoffPacket({
        packet: result.packet,
        expected,
        invalidatedReasonCode: "repair_started",
      }),
    ).toEqual({
      status: "packet_invalidated",
      reason_code: "repair_started",
    });
    expect(
      requireConsumableEvidenceHandoff(result.packet, {
        status: "packet_valid",
        packet_digest: result.packet.packet_digest,
        finding_count: 1,
      }).packet_id,
    ).toBe(result.packet.packet_id);
    expect(() =>
      requireConsumableEvidenceHandoff(result.packet, {
        status: "packet_invalidated",
        reason_code: "repair_started",
      }),
    ).toThrow(/not consumable/);

    const oversizedFinding = structuredClone(result.packet.findings[0]!);
    oversizedFinding.invariant = "i".repeat(1_000);
    oversizedFinding.observations = Array.from({ length: 8 }, (_, index) => ({
      trust: "reviewer_hypothesis",
      statement: "o".repeat(1_000),
      provenance: {
        kind: "code_inspection",
        references: [`src/file-${String(index)}.ts`],
      },
    }));
    oversizedFinding.trigger_sequence = Array.from({ length: 12 }, () =>
      "t".repeat(500),
    );
    oversizedFinding.oracle.expected_behavior = "e".repeat(1_500);
    oversizedFinding.oracle.task_source_rationale = "r".repeat(1_500);
    oversizedFinding.regression_test_plan.summary = "s".repeat(1_500);
    oversizedFinding.regression_test_plan.focused_command = "c".repeat(1_000);
    expect(
      validateEvidenceHandoffPacket({
        packet: { ...result.packet, findings: [oversizedFinding] },
        expected,
      }).status,
    ).toBe("packet_oversized");
  });

  it("projects all permission states and expires active leases with the supplied clock", () => {
    const capabilities = [
      policy.capabilities[0]!,
      { ...policy.capabilities[0]!, id: "denied", status: "denied" as const },
      {
        ...policy.capabilities[0]!,
        id: "unavailable",
        status: "unavailable" as const,
      },
      {
        ...policy.capabilities[0]!,
        id: "failed",
        status: "provisioning_failed" as const,
      },
      { ...policy.capabilities[0]!, id: "leased" },
      { ...policy.capabilities[0]!, id: "active" },
    ];
    const projected = projectResolvedPermissions({
      policy: { ...policy, capabilities },
      leases: [
        {
          capabilityId: "active",
          scopes: ["repository"],
          status: "active",
          expiresAt: "2026-08-18T22:00:00.000Z",
        },
        {
          capabilityId: "leased",
          scopes: ["repository"],
          status: "active",
          expiresAt: "2026-08-18T20:00:00.000Z",
        },
      ],
      now: new Date("2026-08-18T21:00:00.000Z"),
    });
    expect(projected.capabilities.map((entry) => entry.status)).toEqual([
      "approved",
      "denied",
      "provisioning_failed",
      "expired",
      "approved",
      "unavailable",
    ]);
    const narrowed = projectResolvedPermissions({
      policy,
      leases: [
        {
          capabilityId: "shell",
          scopes: [],
          status: "active",
          expiresAt: "2026-08-18T22:00:00.000Z",
        },
      ],
      now: new Date("2026-08-18T21:00:00.000Z"),
    });
    expect(calculatePermissionManifestFingerprint(narrowed)).not.toBe(
      calculatePermissionManifestFingerprint(
        projectResolvedPermissions({
          policy,
          leases: [
            {
              capabilityId: "shell",
              scopes: ["repository"],
              status: "active",
              expiresAt: "2026-08-18T22:00:00.000Z",
            },
          ],
          now: new Date("2026-08-18T21:00:00.000Z"),
        }),
      ),
    );
    expect(() =>
      projectResolvedPermissions({
        policy,
        leases: [
          {
            capabilityId: "shell",
            scopes: ["production"],
            status: "active",
            expiresAt: "2026-08-18T22:00:00.000Z",
          },
        ],
      }),
    ).toThrow(/exceeds its approved scopes/);
    expect(() =>
      projectResolvedPermissions({
        policy,
        leases: [
          {
            capabilityId: "shell",
            scopes: [],
            status: "active",
            expiresAt: "2026-08-18T22:00:00.000Z",
          },
          {
            capabilityId: "missing",
            scopes: [],
            status: "active",
            expiresAt: "2026-08-18T22:00:00.000Z",
          },
        ],
      }),
    ).toThrow(/lease without an approved decision/);
  });

  it("normalizes a focused blocker and rejects unknown packet identities", () => {
    const result = created();
    const blocked = normalizeHandoffBlocker(
      {
        version: 2,
        handoff_blocker: {
          finding_ids: [result.packet.findings[0]!.finding_id],
          category: "permission_unavailable",
          explanation: "  The shell capability is unavailable.  ",
          requested_capability_ids: ["shell", "shell"],
          requested_context: ["src/session.ts"],
        },
      },
      result.packet,
      projection,
      ["source_issue_241"],
    );
    expect(blocked.handoff_blocker.explanation).toBe(
      "The shell capability is unavailable.",
    );
    expect(blocked.handoff_blocker.requested_capability_ids).toEqual(["shell"]);
    expect(
      normalizeHandoffBlocker(
        {
          ...blocked,
          handoff_blocker: {
            ...blocked.handoff_blocker,
            requested_context: ["README.md"],
          },
        },
        result.packet,
        projection,
        ["source_issue_241"],
      ).handoff_blocker.requested_context,
    ).toEqual(["README.md"]);
    expect(() =>
      normalizeHandoffBlocker(
        {
          ...blocked,
          handoff_blocker: {
            ...blocked.handoff_blocker,
            finding_ids: [`finding_${"f".repeat(64)}`],
          },
        },
        result.packet,
        projection,
        ["source_issue_241"],
      ),
    ).toThrow(/outside the consumed packet/);
  });

  it("rejects unknown fields, prohibited content, and forged trust labels", () => {
    expect(() =>
      buildEvidenceHandoffPacket(
        buildInput([{ ...finding, provider_identity: "contestant-a" }]),
      ),
    ).toThrow();
    expect(() =>
      buildEvidenceHandoffPacket(
        buildInput([
          {
            ...finding,
            invariant: "Captured provider transcript: private output",
          },
        ]),
      ),
    ).toThrow(/Prohibited/);
    expect(() =>
      buildEvidenceHandoffPacket(
        buildInput([{ ...finding, trust: "harness_attested" }]),
      ),
    ).toThrow(/cannot claim/);
    const withoutTrust = structuredClone(
      finding,
    ) as Partial<HandoffFindingPayload>;
    delete withoutTrust.trust;
    delete (withoutTrust.observations?.[0] as { trust?: string }).trust;
    expect(created([withoutTrust]).packet.findings[0]).toMatchObject({
      trust: "reviewer_hypothesis",
      observations: [{ trust: "reviewer_hypothesis" }],
    });
  });

  it("persists canonical packets and pointer-linked lifecycle records immutably", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-handoff-"));
    const store = new ArtifactStore(root, "run");
    await store.initialize();
    const result = created();
    const pointer = await persistEvidenceHandoffPacket(
      store,
      "round_2",
      "a-to-b",
      result.packet,
    );
    expect(
      (await readEvidenceHandoffArtifact(store, pointer.path)).packet_id,
    ).toBe(result.packet.packet_id);
    await expect(
      store.writeImmutableBytes(pointer.path, Buffer.from("different")),
    ).rejects.toThrow(/already exists/);

    const base = {
      version: 2 as const,
      run_id: "run_2026-08-18T200000Z",
      round_id: "round_2",
      lane_id: "a-to-b",
      reviewer_slot: "a",
      target_slot: "b",
      packet_id: result.packet.packet_id,
      packet_digest: result.packet.packet_digest,
      attempt: 1 as const,
      artifact_pointers: [pointer],
      diagnostic_pointer: null,
      recorded_at: "2026-08-18T20:00:00.000Z",
    };
    const createdRecord = HandoffLifecycleRecordSchema.parse({
      ...base,
      record_id: "created",
      previous_record_id: null,
      state: "created",
      event: "creation",
      reason_code: "review_valid",
    });
    await persistHandoffLifecycleRecord(store, createdRecord);
    await expect(
      persistHandoffValidationOutcome(
        store,
        "round_2",
        "a-to-b",
        "bad-outcome",
        { status: "packet_valid", unexpected: true },
      ),
    ).rejects.toThrow();
    await expect(
      persistHandoffLifecycleRecord(
        store,
        HandoffLifecycleRecordSchema.parse({
          ...base,
          record_id: "substituted-digest",
          previous_record_id: "created",
          packet_digest: "f".repeat(64),
          state: "validated",
          event: "validation",
          reason_code: "fingerprints_match",
        }),
      ),
    ).rejects.toThrow(/identity or digest/);
    await persistHandoffLifecycleRecord(
      store,
      HandoffLifecycleRecordSchema.parse({
        ...base,
        record_id: "validated",
        previous_record_id: "created",
        state: "validated",
        event: "validation",
        reason_code: "fingerprints_match",
      }),
    );
    expect(
      (await readCurrentHandoffLifecycle(store, "round_2", "a-to-b"))?.state,
    ).toBe("validated");
    await persistHandoffLifecycleRecord(
      store,
      HandoffLifecycleRecordSchema.parse({
        ...base,
        record_id: "blocked",
        previous_record_id: "validated",
        state: "refresh_required",
        event: "blocking",
        reason_code: "permission_unavailable",
      }),
    );
    await persistHandoffLifecycleRecord(
      store,
      HandoffLifecycleRecordSchema.parse({
        ...base,
        record_id: "coverage-loss",
        previous_record_id: "blocked",
        state: "coverage_loss",
        event: "coverage_loss",
        reason_code: "blocker_persisted",
        attempt: 2,
      }),
    );
    expect(
      (await readCurrentHandoffLifecycle(store, "round_2", "a-to-b"))?.state,
    ).toBe("coverage_loss");
    await expect(
      persistHandoffLifecycleRecord(
        store,
        HandoffLifecycleRecordSchema.parse({
          ...base,
          record_id: "bad",
          previous_record_id: "coverage-loss",
          state: "created",
          event: "creation",
          reason_code: "revived",
        }),
      ),
    ).rejects.toThrow(/Invalid handoff lifecycle transition/);

    await store.writeImmutableJson("legacy/handoff.json", {
      version: 1,
      findings: [],
    });
    await expect(
      readEvidenceHandoffArtifact(store, "legacy/handoff.json"),
    ).rejects.toThrow();
  });

  it("allows one direct diagnostic artifact up to 8 KiB without traversing pointers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-diagnostic-"));
    const store = new ArtifactStore(root, "run");
    await store.initialize();
    const bytes = Buffer.from('{"diagnostic":"target changed"}', "utf8");
    const diagnosticPath = "rounds/round_2/handoffs/a-to-b/diagnostics/d1.json";
    await store.writeImmutableBytes(diagnosticPath, bytes);
    const pointer = {
      version: 1,
      artifact_id: "d1",
      path: diagnosticPath,
      sha256: sha256(bytes),
      byte_length: bytes.byteLength,
      depth: 1,
      description: "Target mismatch details",
    } as const;
    const loaded = await readHandoffDiagnostic(store, pointer, {
      status: "packet_stale",
      diagnostic_code: "target_fingerprint_mismatch",
    });
    expect(Buffer.from(loaded)).toEqual(bytes);
    await expect(
      readHandoffDiagnostic(store, pointer, {
        status: "packet_valid",
        packet_digest: "a".repeat(64),
        finding_count: 1,
      }),
    ).rejects.toThrow(/only for stale, malformed, or blocked/);
  });

  it("uses canonical key order and rejects unsafe JSON values", () => {
    expect(canonicalHandoffJson({ z: 1, a: { y: 2, x: 3 } })).toBe(
      '{"a":{"x":3,"y":2},"z":1}',
    );
    expect(() => canonicalHandoffJson(Number.NaN)).toThrow(/finite/);
    expect(() => canonicalHandoffJson("\ud800")).toThrow(/surrogates/);
  });
});
