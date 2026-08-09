import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/artifacts/store.js";
import {
  DependencyManifestSchema,
  type DependencyManifest,
} from "../../src/recovery/contracts.js";
import {
  approveDrift,
  createDriftReport,
} from "../../src/recovery/manifest.js";
import { calculateCheckpointHash } from "../../src/recovery/durable.js";
import { createForkContract } from "../../src/recovery/fork.js";
import { makeRunState } from "../helpers/run-state.js";

async function manifest(overrides: Partial<DependencyManifest> = {}) {
  const commit = (await execa("git", ["rev-parse", "HEAD"])).stdout;
  return DependencyManifestSchema.parse({
    version: 1,
    runId: "run-12345678",
    capturedAt: "2026-08-08T00:00:00.000Z",
    repository: {
      identity: "owner/repository",
      path: process.cwd(),
      baseCommit: commit,
    },
    frozenSources: { task: "a".repeat(64) },
    dependencyFiles: { "package-lock.json": "b".repeat(64) },
    runtime: {
      node: "v24.0.0",
      os: "darwin 25",
      architecture: "arm64",
      packageManager: "npm/11",
    },
    providers: [
      { contestantId: "a", provider: "codex", cliVersion: "1" },
      { contestantId: "b", provider: "claude", cliVersion: "1" },
    ],
    commandsHash: "c".repeat(64),
    capabilitiesHash: "d".repeat(64),
    credentialsHash: "6".repeat(64),
    servicesHash: "e".repeat(64),
    displayHash: "7".repeat(64),
    manifestHash: "f".repeat(64),
    ...overrides,
  });
}

describe("resume drift and fork contracts", () => {
  it("classifies corruption as hard, dependency drift as approval-required, and relocation as informational", async () => {
    const original = await manifest();
    const current = await manifest({
      repository: { ...original.repository, path: "/relocated/repository" },
      frozenSources: { task: "1".repeat(64) },
      dependencyFiles: { "package-lock.json": "2".repeat(64) },
      credentialsHash: "3".repeat(64),
      displayHash: "4".repeat(64),
    });
    const report = await createDriftReport({
      original,
      current,
      repositoryRoot: process.cwd(),
      now: new Date("2026-08-08T01:00:00.000Z"),
    });
    const retriedReport = await createDriftReport({
      original,
      current,
      repositoryRoot: process.cwd(),
      now: new Date("2026-08-08T02:00:00.000Z"),
    });
    expect(retriedReport.reportHash).toBe(report.reportHash);
    expect(report.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "source_corrupt",
          severity: "hard_stop",
        }),
        expect.objectContaining({
          code: "dependency_changed",
          severity: "approval_required",
        }),
        expect.objectContaining({
          code: "path_relocated",
          severity: "informational",
        }),
        expect.objectContaining({
          code: "credential_changed",
          severity: "approval_required",
        }),
        expect.objectContaining({
          code: "display_changed",
          severity: "informational",
        }),
      ]),
    );
  });

  it("binds persisted manual approval to the exact drift-report hash", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-drift-"));
    const store = new ArtifactStore(root, "run-12345678");
    await store.initialize();
    const original = await manifest();
    const current = await manifest({
      dependencyFiles: { "package-lock.json": "2".repeat(64) },
    });
    const report = await createDriftReport({
      original,
      current,
      repositoryRoot: process.cwd(),
    });
    await expect(
      approveDrift({
        store,
        report,
        reportHash: "0".repeat(64),
        approvedBy: "test-user",
      }),
    ).rejects.toThrow(/not bound/);
    const approval = await approveDrift({
      store,
      report,
      reportHash: report.reportHash,
      approvedBy: "test-user",
    });
    expect(approval.reportHash).toBe(report.reportHash);
    expect(approval.approvalHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("defaults fork steering symmetrically and marks explicit asymmetry non-comparable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-fork-"));
    const parentStore = new ArtifactStore(root, "run-12345678");
    await parentStore.initialize();
    const state = makeRunState({ runDirectory: parentStore.runDirectory });
    const checkpointDraft = {
      version: 1 as const,
      runId: state.runId,
      roundId: 1 as const,
      envelopeHash: "a".repeat(64),
      snapshotHash: "b".repeat(64),
      replayHash: "c".repeat(64),
      stateHash: "d".repeat(64),
      createdAt: "2026-08-08T00:00:00.000Z",
      checkpointHash: "0".repeat(64),
    };
    checkpointDraft.checkpointHash = calculateCheckpointHash(checkpointDraft);
    await parentStore.writeImmutableJson("checkpoints/1.json", checkpointDraft);

    const symmetric = await createForkContract({
      parentStore,
      parentState: state,
      checkpointRound: 1,
      newRunId: "fork-symmetric",
      steering: { a: ["focus on cancellation"] },
    });
    expect(symmetric.fork.intervention.steering).toEqual({
      a: ["focus on cancellation"],
      b: ["focus on cancellation"],
    });
    expect(symmetric.fork.assisted).toBe(true);
    expect(symmetric.fork.competitivelyComparable).toBe(true);

    const asymmetric = await createForkContract({
      parentStore,
      parentState: state,
      checkpointRound: 1,
      newRunId: "fork-asymmetric",
      steering: { a: ["focus on cancellation"], b: ["focus on security"] },
    });
    expect(asymmetric.fork.assisted).toBe(true);
    expect(asymmetric.fork.competitivelyComparable).toBe(false);
  });
});
