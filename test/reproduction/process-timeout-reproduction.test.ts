import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const fixturePath = fileURLToPath(
  new URL("../fixtures/escaped-descendant.mjs", import.meta.url),
);
const probePath = fileURLToPath(
  new URL("../fixtures/process-timeout-probe.ts", import.meta.url),
);
const runnerTimeoutMs = 500;
const cleanupGraceMs = 2_000;
const outerWatchdogMs = runnerTimeoutMs + cleanupGraceMs + 2_000;

interface LifecycleRecord {
  token: string;
  role: string;
  event: string;
  pid: number;
  parentPid: number;
  processGroupId: number | null;
  sessionId: number | null;
  wallTimeMs: number;
  monotonicMs: number;
  descendantPid?: number;
  descendantRole?: string;
}

interface ProbeOutcome {
  elapsedMs: number;
  result: { timedOut: boolean; durationMs: number };
  logDirectory: string;
}

interface ReproductionResult {
  mode: "process" | "shell";
  runnerReturned: boolean;
  elapsedMs: number;
  watchdogFired: boolean;
  ownedAliveAtDeadline: LifecycleRecord[];
  records: LifecycleRecord[];
  outcome?: ProbeOutcome;
  probeStdout: string;
  probeStderr: string;
}

const emergencyCleanups = new Map<string, Set<number>>();

async function commandLine(pid: number): Promise<string | undefined> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("wmic", [
        "process",
        "where",
        `processid=${pid}`,
        "get",
        "commandline",
        "/value",
      ]);
      return stdout;
    }
    const { stdout } = await execFileAsync("ps", [
      "-o",
      "command=",
      "-p",
      String(pid),
    ]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function isOwnedProcess(pid: number, token: string): Promise<boolean> {
  const command = await commandLine(pid);
  return command?.includes(token) ?? false;
}

async function readRecords(statePath: string): Promise<LifecycleRecord[]> {
  try {
    const contents = await readFile(statePath, "utf8");
    const lines = contents.split("\n");
    if (!contents.endsWith("\n")) lines.pop();
    return lines
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LifecycleRecord);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function aliveOwnedRecords(
  records: LifecycleRecord[],
  token: string,
): Promise<LifecycleRecord[]> {
  const starts = records.filter(
    (record) => record.event === "started" && record.token === token,
  );
  const ownership = await Promise.all(
    starts.map(async (record) => ({
      record,
      owned: await isOwnedProcess(record.pid, token),
    })),
  );
  return ownership.filter(({ owned }) => owned).map(({ record }) => record);
}

function recordedProcessIds(records: LifecycleRecord[]): number[] {
  return [
    ...new Set(
      records.flatMap((record) =>
        record.descendantPid === undefined
          ? [record.pid]
          : [record.pid, record.descendantPid],
      ),
    ),
  ].sort((left, right) => right - left);
}

async function aliveOwnedProcessIds(
  pids: number[],
  token: string,
): Promise<number[]> {
  const ownership = await Promise.all(
    pids.map(async (pid) => ({ pid, owned: await isOwnedProcess(pid, token) })),
  );
  return ownership.filter(({ owned }) => owned).map(({ pid }) => pid);
}

async function signalIfOwned(
  pid: number,
  token: string,
  signal: NodeJS.Signals,
): Promise<void> {
  if (!(await isOwnedProcess(pid, token))) return;
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function cleanupOwnedProcesses(
  records: LifecycleRecord[],
  token: string,
): Promise<void> {
  const pids = recordedProcessIds(records);
  emergencyCleanups.set(token, new Set(pids));

  await Promise.all(pids.map((pid) => signalIfOwned(pid, token, "SIGTERM")));
  await new Promise((resolve) => setTimeout(resolve, 150));
  await Promise.all(pids.map((pid) => signalIfOwned(pid, token, "SIGKILL")));

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await aliveOwnedProcessIds(pids, token)).length === 0) {
      emergencyCleanups.delete(token);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(await aliveOwnedProcessIds(pids, token)).toEqual([]);
}

async function waitForCompleteTopology(
  statePath: string,
): Promise<LifecycleRecord[]> {
  return waitForRecords(statePath, (records) => {
    const startedRoles = new Set(
      records
        .filter((record) => record.event === "started")
        .map((record) => record.role),
    );
    return ["launcher", "child", "grandchild"].every((role) =>
      startedRoles.has(role),
    );
  });
}

async function waitForRecords(
  statePath: string,
  ready: (records: LifecycleRecord[]) => boolean,
): Promise<LifecycleRecord[]> {
  const deadline = performance.now() + cleanupGraceMs;
  let records: LifecycleRecord[] = [];
  while (performance.now() < deadline) {
    records = await readRecords(statePath);
    if (ready(records)) return records;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return records;
}

function expectEscapedTopology(records: LifecycleRecord[]): void {
  const started = records.filter((record) => record.event === "started");
  const launcher = started.find((record) => record.role === "launcher");
  const child = started.find((record) => record.role === "child");
  const grandchild = started.find((record) => record.role === "grandchild");

  expect(launcher, "launcher did not record startup").toBeDefined();
  expect(child, "child did not record startup").toBeDefined();
  expect(grandchild, "grandchild did not record startup").toBeDefined();
  if (
    launcher === undefined ||
    child === undefined ||
    grandchild === undefined
  ) {
    return;
  }

  expect(child.parentPid).toBe(launcher.pid);
  expect(grandchild.parentPid).toBe(child.pid);
  if (process.platform !== "win32") {
    expect(child.processGroupId).toBe(child.pid);
    expect(grandchild.processGroupId).toBe(grandchild.pid);
    expect(child.processGroupId).not.toBe(launcher.processGroupId);
    expect(grandchild.processGroupId).not.toBe(child.processGroupId);
  }
  if (process.platform === "linux") {
    expect(child.sessionId).toBe(child.pid);
    expect(grandchild.sessionId).toBe(grandchild.pid);
  }
}

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function reproduce(
  mode: "process" | "shell",
): Promise<ReproductionResult> {
  const directory = await mkdtemp(
    path.join(tmpdir(), `arena-timeout-${mode}-`),
  );
  const token = `agent-arena-timeout-${randomUUID()}`;
  const statePath = path.join(directory, "lifecycle.jsonl");
  const outcomePath = path.join(directory, "outcome.json");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      probePath,
      mode,
      token,
      statePath,
      outcomePath,
      path.join(directory, "runner"),
      String(runnerTimeoutMs),
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let probeStdout = "";
  let probeStderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    probeStdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    probeStderr += chunk.toString();
  });

  const started = performance.now();
  let watchdogFired = false;
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    void signalIfOwned(child.pid ?? -1, token, "SIGKILL");
  }, outerWatchdogMs);

  try {
    await waitForExit(child);
  } finally {
    clearTimeout(watchdog);
  }

  const elapsedMs = performance.now() - started;
  const records = await readRecords(statePath);
  const ownedAliveAtDeadline = await aliveOwnedRecords(records, token);
  let outcome: ProbeOutcome | undefined;
  try {
    outcome = JSON.parse(await readFile(outcomePath, "utf8")) as ProbeOutcome;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await cleanupOwnedProcesses(records, token);
  return {
    mode,
    runnerReturned: outcome !== undefined,
    elapsedMs,
    watchdogFired,
    ownedAliveAtDeadline,
    records,
    ...(outcome === undefined ? {} : { outcome }),
    probeStdout,
    probeStderr,
  };
}

afterEach(async () => {
  for (const [token, pids] of emergencyCleanups) {
    await Promise.all(
      [...pids].map((pid) => signalIfOwned(pid, token, "SIGKILL")),
    );
  }
  emergencyCleanups.clear();
});

describe("escaped-descendant timeout reproduction", () => {
  test.fails(
    "runProcess satisfies the bounded cleanup contract (#40)",
    async () => {
      const result = await reproduce("process");
      console.info(
        "#40 runProcess reproduction",
        JSON.stringify(result, null, 2),
      );

      expect(result.watchdogFired).toBe(false);
      expect(result.runnerReturned).toBe(true);
      expect(result.outcome?.elapsedMs).toBeLessThanOrEqual(
        runnerTimeoutMs + cleanupGraceMs,
      );
      expect(result.ownedAliveAtDeadline).toEqual([]);
    },
  );

  test.fails(
    "runShellCommand satisfies the bounded cleanup contract (#40)",
    async () => {
      const result = await reproduce("shell");
      console.info(
        "#40 runShellCommand reproduction",
        JSON.stringify(result, null, 2),
      );

      expect(result.watchdogFired).toBe(false);
      expect(result.runnerReturned).toBe(true);
      expect(result.outcome?.elapsedMs).toBeLessThanOrEqual(
        runnerTimeoutMs + cleanupGraceMs,
      );
      expect(result.ownedAliveAtDeadline).toEqual([]);
    },
  );

  test("cleanup never signals an unrelated sentinel", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "arena-timeout-safety-"),
    );
    const fixtureToken = `agent-arena-fixture-${randomUUID()}`;
    const sentinelToken = `agent-arena-sentinel-${randomUUID()}`;
    const fixtureState = path.join(directory, "fixture.jsonl");
    const sentinelState = path.join(directory, "sentinel.jsonl");
    const sentinel = spawn(
      process.execPath,
      [fixturePath, "sentinel", sentinelToken, sentinelState],
      { detached: true, stdio: "ignore" },
    );
    sentinel.unref();
    const fixture = spawn(
      process.execPath,
      [fixturePath, "launcher", fixtureToken, fixtureState],
      { detached: true, stdio: "ignore" },
    );
    fixture.unref();
    let fixtureRecords: LifecycleRecord[] = [];

    try {
      fixtureRecords = await waitForCompleteTopology(fixtureState);
      const sentinelRecords = await waitForRecords(
        sentinelState,
        (records) => records.length > 0,
      );
      expectEscapedTopology(fixtureRecords);
      expect(sentinelRecords).toHaveLength(1);

      // Include the sentinel as a candidate to prove token revalidation, rather
      // than the PID list alone, is what authorizes each signal.
      await cleanupOwnedProcesses(
        [...fixtureRecords, ...sentinelRecords],
        fixtureToken,
      );
      expect(await isOwnedProcess(sentinel.pid ?? -1, sentinelToken)).toBe(
        true,
      );
    } finally {
      await cleanupOwnedProcesses(
        fixtureRecords.length > 0
          ? fixtureRecords
          : await readRecords(fixtureState),
        fixtureToken,
      );
      await cleanupOwnedProcesses(
        await readRecords(sentinelState),
        sentinelToken,
      );
    }
  });

  test("cleanup includes descendants with partial startup records", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "arena-timeout-partial-startup-"),
    );
    const token = `agent-arena-partial-${randomUUID()}`;
    const statePath = path.join(directory, "lifecycle.jsonl");
    const fixture = spawn(
      process.execPath,
      [fixturePath, "launcher", token, statePath],
      { detached: true, stdio: "ignore" },
    );
    fixture.unref();
    let completeRecords: LifecycleRecord[] = [];

    try {
      completeRecords = await waitForCompleteTopology(statePath);
      expectEscapedTopology(completeRecords);
      const partialRecords = completeRecords.filter(
        (record) =>
          record.role === "launcher" || record.event === "spawned-descendant",
      );

      await cleanupOwnedProcesses(partialRecords, token);

      expect(await aliveOwnedRecords(completeRecords, token)).toEqual([]);
    } finally {
      await cleanupOwnedProcesses(
        completeRecords.length > 0
          ? completeRecords
          : await readRecords(statePath),
        token,
      );
    }
  });
});
