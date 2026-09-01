import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  InvocationUsageSchema,
  buildUsageSummary,
  countersFromCommand,
  sealInvocationUsage,
  type InvocationUsage,
} from "../../src/telemetry/usage.js";

const invocation = (overrides: Partial<InvocationUsage> = {}) =>
  InvocationUsageSchema.parse({
    version: 1,
    accountingVersion: 1,
    invocationId: crypto.randomUUID(),
    provider: "codex",
    requestedModel: "gpt-5.6-sol",
    resolvedModel: "gpt-5.6-sol-202608",
    resolvedModelSource: "provider",
    role: "contestant",
    contestantId: "a",
    stage: "implement",
    round: 1,
    status: "succeeded",
    startedAt: "2026-08-30T12:00:00.000Z",
    finishedAt: "2026-08-30T12:00:01.000Z",
    durationMs: 1000,
    usage: {
      uncachedInputTokens: 80,
      cacheCreationTokens: 0,
      cacheReadTokens: 20,
      outputTokens: 10,
      reasoningTokens: 4,
      processedTokens: 110,
      newInputOutputTokens: 90,
      completeness: "complete",
    },
    cost: {
      usd: null,
      source: "unavailable",
      rateCardVersion: null,
      unavailableReason: "subscription_cli_no_metered_cost",
    },
    artifactRefs: ["/run/logs/a.stdout.log"],
    ...overrides,
  });

describe("usage telemetry", () => {
  it("derives processed and new-I/O totals without adding reasoning twice", () => {
    expect(
      countersFromCommand({
        command: "codex",
        cwd: "/work",
        exitCode: 0,
        signal: null,
        timedOut: false,
        attempts: 1,
        durationMs: 1,
        stdoutPath: "/out",
        stderrPath: "/err",
        providerDiagnostics: {
          eventCount: 1,
          toolStartedCount: 0,
          toolFinishedCount: 0,
          decodingWarnings: [],
          eventLogPath: "/events",
          usageCompleteness: "complete",
          usageAccountingVersion: 1,
          tokenUsage: {
            uncachedInputTokens: 80,
            cacheReadTokens: 20,
            cacheWriteTokens: 5,
            outputTokens: 10,
            reasoningTokens: 4,
          },
        },
      }),
    ).toMatchObject({
      processedTokens: 115,
      newInputOutputTokens: 90,
      reasoningTokens: 4,
      completeness: "complete",
    });
  });

  it("does not promote missing cache components to complete telemetry", () => {
    expect(
      countersFromCommand({
        command: "custom-agent",
        cwd: "/work",
        exitCode: 0,
        signal: null,
        timedOut: false,
        attempts: 1,
        durationMs: 1,
        stdoutPath: "/out",
        stderrPath: "/err",
        providerDiagnostics: {
          eventCount: 1,
          toolStartedCount: 0,
          toolFinishedCount: 0,
          decodingWarnings: [],
          eventLogPath: "/events",
          usageCompleteness: "complete",
          usageAccountingVersion: 1,
          tokenUsage: {
            uncachedInputTokens: 700_000,
            outputTokens: 100_000,
          },
        },
      }),
    ).toMatchObject({
      uncachedInputTokens: 700_000,
      cacheCreationTokens: null,
      cacheReadTokens: null,
      outputTokens: 100_000,
      processedTokens: 800_000,
      completeness: "partial",
    });
  });

  it("rolls up dimensions and keeps mixed cost coverage null", () => {
    const records = [
      invocation({}),
      invocation({
        invocationId: crypto.randomUUID(),
        provider: "claude",
        requestedModel: null,
        resolvedModel: null,
        resolvedModelSource: "unavailable",
        role: "judge",
        contestantId: null,
        stage: "attack-verifier",
        round: null,
        cost: {
          usd: 0.2,
          source: "provider_billing",
          rateCardVersion: null,
          unavailableReason: null,
        },
      }),
    ];
    const summary = buildUsageSummary(
      records,
      new Date("2026-08-30T12:00:02.000Z"),
    );
    expect(summary.total).toMatchObject({
      invocationCount: 2,
      providerDurationMs: 2000,
      usage: { processedTokens: 220, completeness: "complete" },
      cost: { usd: null, unavailableReason: "incomplete_cost_coverage" },
    });
    expect(summary.byProvider.map((entry) => entry.key)).toEqual([
      "claude",
      "codex",
    ]);
    expect(summary.byResolvedModel.map((entry) => entry.key)).toContain(
      "unknown",
    );
    expect(summary.byRole.map((entry) => entry.key)).toEqual([
      "contestant",
      "judge",
    ]);
  });

  it("seals immutable evidence and atomically rebuilds the durable summary", async () => {
    const runDirectory = await mkdtemp(path.join(os.tmpdir(), "arena-usage-"));
    await Promise.all([
      mkdir(path.join(runDirectory, "logs")),
      mkdir(path.join(runDirectory, "rounds")),
    ]);
    const sealed = await sealInvocationUsage({
      logPrefix: path.join(runDirectory, "logs", "implement-a"),
      metadata: {
        provider: "codex",
        requestedModel: "gpt-5.6-sol",
        role: "contestant",
        contestantId: "a",
        stage: "implement",
        round: 1,
      },
      result: {
        command: "codex",
        cwd: "/work",
        exitCode: 0,
        signal: null,
        timedOut: false,
        attempts: 1,
        durationMs: 25,
        stdoutPath: path.join(runDirectory, "logs", "implement-a.stdout.log"),
        stderrPath: path.join(runDirectory, "logs", "implement-a.stderr.log"),
      },
      startedAt: new Date("2026-08-30T12:00:00.000Z"),
      finishedAt: new Date("2026-08-30T12:00:00.025Z"),
    });
    expect(sealed?.path).toContain("telemetry/invocations/");
    const record = InvocationUsageSchema.parse(
      JSON.parse(await readFile(sealed!.path, "utf8")),
    );
    expect(record).not.toHaveProperty("prompt");
    expect(record.usage.completeness).toBe("unavailable");
    expect(record).toMatchObject({
      requestedModel: "gpt-5.6-sol",
      resolvedModel: "gpt-5.6-sol",
      resolvedModelSource: "requested",
      cost: {
        usd: null,
        source: "unavailable",
        unavailableReason: "subscription_cli_no_metered_cost",
      },
    });
    const summary = JSON.parse(
      await readFile(
        path.join(runDirectory, "telemetry", "summary.json"),
        "utf8",
      ),
    ) as { total: { invocationCount: number; cost: { usd: number | null } } };
    expect(summary.total).toMatchObject({
      invocationCount: 1,
      cost: { usd: null },
    });
  });
});
