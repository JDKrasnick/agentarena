import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentAdapter,
  ConnectivityProbeInput,
} from "../../src/agents/adapter.js";
import { ArtifactStore } from "../../src/artifacts/store.js";
import { exitCodeForStatus } from "../../src/commands/fight.js";
import type { ConnectivityProbeResult } from "../../src/core/types.js";
import {
  probeProviderConnectivity,
  TransportRecoverySchema,
  withReplacementRunId,
} from "../../src/recovery/transport.js";

function probeResult(
  healthy: boolean,
  prefix: string,
): ConnectivityProbeResult {
  return {
    version: 1,
    provider: "codex",
    healthy,
    startedAt: "2026-08-18T00:00:00.000Z",
    finishedAt: "2026-08-18T00:00:00.100Z",
    durationMs: 100,
    reason: healthy ? "backend healthy" : "transport unavailable",
    transportFailures: healthy
      ? []
      : [{ kind: "transport", detail: "connection failed" }],
    artifactPaths: [`${prefix}.stdout.log`, `${prefix}.stderr.log`],
    command: {
      command: "codex",
      cwd: "/tmp",
      exitCode: healthy ? 0 : 1,
      signal: null,
      timedOut: false,
      attempts: 1,
      durationMs: 100,
      stdoutPath: `${prefix}.stdout.log`,
      stderrPath: `${prefix}.stderr.log`,
    },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-recovery-"));
  const store = new ArtifactStore(root, "parent", { durableV5: true });
  await store.initialize();
  return { root, store };
}

function adapterWith(results: boolean[]) {
  const probeConnectivity = vi.fn(
    ({ transcriptPrefix }: ConnectivityProbeInput) =>
      Promise.resolve(probeResult(results.shift() ?? false, transcriptPrefix)),
  );
  return {
    adapter: { id: "codex", probeConnectivity } as unknown as AgentAdapter,
    probeConnectivity,
  };
}

describe("implementation transport recovery", () => {
  it.each([1, 2, 3])(
    "recovers on provider probe %s",
    async (healthyAttempt) => {
      const { root, store } = await fixture();
      const sequence = [false, false, false];
      sequence[healthyAttempt - 1] = true;
      const { adapter, probeConnectivity } = adapterWith(sequence);
      const recovery = await probeProviderConnectivity({
        parentRunId: "parent",
        store,
        adapters: new Map([["codex", adapter]]),
        restartOrdinal: 1,
        cwd: root,
        signal: new AbortController().signal,
      });

      expect(recovery.disposition).toBe("provider_recovered");
      expect(recovery.probeAttempts).toHaveLength(healthyAttempt);
      expect(probeConnectivity).toHaveBeenCalledTimes(healthyAttempt);
      expect(
        TransportRecoverySchema.parse(
          withReplacementRunId(recovery, "replacement"),
        ).replacementRunId,
      ).toBe("replacement");
    },
  );

  it("persists exhausted probes without a replacement", async () => {
    const { root, store } = await fixture();
    const { adapter, probeConnectivity } = adapterWith([false, false, false]);
    const recovery = await probeProviderConnectivity({
      parentRunId: "parent",
      store,
      adapters: new Map([["codex", adapter]]),
      restartOrdinal: 2,
      cwd: root,
      signal: new AbortController().signal,
    });

    expect(recovery).toMatchObject({
      disposition: "probe_exhausted",
      restartOrdinal: 2,
    });
    expect(recovery.probeAttempts).toHaveLength(3);
    expect(probeConnectivity).toHaveBeenCalledTimes(3);
  });

  it("does not probe after two replacement runs", async () => {
    const { root, store } = await fixture();
    const { adapter, probeConnectivity } = adapterWith([true]);
    const recovery = await probeProviderConnectivity({
      parentRunId: "third-run",
      store,
      adapters: new Map([["codex", adapter]]),
      restartOrdinal: 3,
      cwd: root,
      signal: new AbortController().signal,
    });

    expect(recovery.disposition).toBe("restart_limit_reached");
    expect(recovery.probeAttempts).toEqual([]);
    expect(probeConnectivity).not.toHaveBeenCalled();
  });
});

describe("CLI terminal exit status", () => {
  it.each([
    ["complete", 0],
    ["inconclusive", 2],
    ["cancelled", 130],
    ["failed", 1],
    ["running", 1],
  ] as const)("maps %s to %s", (status, exitCode) => {
    expect(exitCodeForStatus(status)).toBe(exitCode);
  });
});
