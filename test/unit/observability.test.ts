import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ArenaBattleControl,
  appendSteering,
} from "../../src/observability/control.js";
import {
  ArenaEventSchema,
  ArenaEventBus,
  EventJournal,
} from "../../src/observability/events.js";
import {
  projectEvent,
  initialDashboardState,
} from "../../src/dashboard/state.js";
import {
  StreamingRedactor,
  runProcess,
} from "../../src/runner/process-runner.js";

describe("arena observability", () => {
  it("serializes concurrent events with monotonic sequence numbers", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "arena-events-"));
    const journal = new EventJournal(path.join(directory, "events.ndjson"));
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        journal.publish({ type: "warning", message: String(index) }),
      ),
    );
    const events = (await readFile(journal.filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => ArenaEventSchema.parse(JSON.parse(line)));
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 1),
    );
  });

  it("finalizes once for journal and dashboard and resumes after a torn tail", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "arena-bus-"));
    const filePath = path.join(directory, "events.ndjson");
    const firstSink: unknown[] = [];
    const first = new ArenaEventBus(new EventJournal(filePath), [
      { publish: (event) => void firstSink.push(event) },
    ]);
    await Promise.all([
      first.publish({ type: "warning", message: "one" }),
      first.publish({ type: "warning", message: "two" }),
    ]);
    const persisted = (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => ArenaEventSchema.parse(JSON.parse(line)));
    expect(firstSink).toEqual(persisted);

    await appendFile(filePath, '{"torn":', "utf8");
    const replayed: unknown[] = [];
    const resumed = new ArenaEventBus(new EventJournal(filePath), [
      { publish: (event) => void replayed.push(event) },
    ]);
    await resumed.publish({ type: "warning", message: "three" });
    const finalEvents = (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => ArenaEventSchema.parse(JSON.parse(line)));
    expect(finalEvents.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(replayed).toEqual(finalEvents);
  });

  it("redacts credentials split across chunks", () => {
    const redactor = new StreamingRedactor(["secret-value-1234"]);
    const output = [
      redactor.push("before secret-"),
      redactor.push("value-1234 after"),
      redactor.flush(),
    ].join("");
    expect(output).toBe("before [REDACTED] after");
  });

  it("redacts credentials crossing the internal streaming boundary", () => {
    const credential = "ghp_abcdefghijklmnopqrstuvwxyz";
    const redactor = new StreamingRedactor();
    const output = [
      redactor.push(`${"x".repeat(39)}:${credential}:${"y".repeat(229)}`),
      redactor.flush(),
    ].join("");
    expect(output).toBe(
      `${"x".repeat(39)}:[REDACTED_CREDENTIAL]:${"y".repeat(229)}`,
    );
  });

  it("redacts explicit secrets from streamed output and transcript logs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "arena-secrets-"));
    const secret = "custom credential value";
    const output = `${"x".repeat(40)}${secret}${"y".repeat(240)}`;
    const redacted = `${"x".repeat(40)}[REDACTED]${"y".repeat(240)}`;
    const chunks: string[] = [];
    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(output)})`],
      cwd: directory,
      timeoutMs: 5_000,
      logPrefix: path.join(directory, "process"),
      secrets: [secret],
      onOutput: (_stream, text) => {
        chunks.push(text);
      },
    });
    expect(chunks.join("")).toBe(redacted);
    expect(await readFile(result.stdoutPath, "utf8")).toBe(redacted);
  });

  it("streams output and retains a redacted complete transcript", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "arena-process-"));
    const chunks: string[] = [];
    const result = await runProcess({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write('first'); setTimeout(() => process.stdout.write(' second'), 5)",
      ],
      cwd: directory,
      timeoutMs: 5_000,
      logPrefix: path.join(directory, "process"),
      onOutput: (_stream, text) => {
        chunks.push(text);
      },
    });
    expect(chunks.join("")).toBe("first second");
    expect(await readFile(result.stdoutPath, "utf8")).toBe("first second");
  });

  it("queues non-empty steering and delimits it in a prompt", () => {
    const control = new ArenaBattleControl(new AbortController());
    expect(() => control.queueSteering("a", "  ")).toThrow(/cannot be empty/);
    const note = control.queueSteering("a", "focus on cancellation");
    expect(control.consume("a")).toBe(note);
    expect(appendSteering("prompt", note.note)).toContain(
      "--- OPERATOR STEERING NOTE (APPLY ONCE) ---",
    );
  });

  it("projects live agent output and assisted integrity", () => {
    const state = initialDashboardState();
    projectEvent(state, {
      version: 1,
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: "output",
      invocationId: "a-1",
      source: "agent",
      stream: "stderr",
      text: "working\n",
      contestantId: "a",
    });
    projectEvent(state, {
      version: 1,
      sequence: 2,
      timestamp: new Date().toISOString(),
      type: "steering_applied",
      interventionId: "note",
      contestantId: "a",
      stage: "implement",
      promptHash: "hash",
    });
    expect(state.contestants.a.output).toMatchObject([
      { stream: "stderr", text: "working\n" },
    ]);
    expect(state.assisted).toBe(true);
  });

  it("replaces stale dashboard state when a recovery run starts", () => {
    const state = initialDashboardState();
    state.runId = "parent";
    state.status = "inconclusive";
    state.warnings.push("parent warning");
    state.contestants.a.output.push({
      stream: "stdout",
      text: "parent output",
      invocationId: "parent-invocation",
      timestamp: new Date().toISOString(),
    });

    projectEvent(state, {
      version: 1,
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: "battle_started",
      runId: "replacement",
      task: "Retry after transport recovery",
      contestants: [
        { id: "a", provider: "codex" },
        { id: "b", provider: "claude" },
      ],
    });

    expect(state).toMatchObject({
      runId: "replacement",
      status: "running",
      stage: "preflight",
      warnings: [],
    });
    expect(state.contestants.a.output).toEqual([]);
  });

  it("keeps invocation, output, and checks scoped to their round", () => {
    const state = initialDashboardState();
    const timestamp = new Date().toISOString();
    projectEvent(state, {
      version: 1,
      sequence: 1,
      timestamp,
      type: "stage_changed",
      stage: "repair",
      round: 2,
    });
    projectEvent(state, {
      version: 1,
      sequence: 2,
      timestamp,
      type: "invocation_started",
      invocationId: "b-repair",
      source: "agent",
      contestantId: "b",
      stage: "repair",
      round: 2,
    });
    projectEvent(state, {
      version: 1,
      sequence: 3,
      timestamp,
      type: "output",
      invocationId: "b-repair",
      source: "agent",
      stream: "stdout",
      text: "repairing\n",
      contestantId: "b",
    });
    projectEvent(state, {
      version: 1,
      sequence: 4,
      timestamp,
      type: "check_completed",
      checkId: "repair-check",
      status: "passed",
      contestantId: "b",
    });

    expect(state.contestants.b.invocations[0]).toMatchObject({
      id: "b-repair",
      round: 2,
    });
    expect(state.contestants.b.output[0]).toMatchObject({
      invocationId: "b-repair",
      round: 2,
    });
    expect(state.contestants.b.checks[0]).toMatchObject({ round: 2 });
  });

  it("projects mounted, revised, and landed attack activity with health hits", () => {
    const state = initialDashboardState();
    const timestamp = new Date().toISOString();
    projectEvent(state, {
      version: 1,
      sequence: 1,
      timestamp,
      type: "attack_mounted",
      attackId: "race",
      round: 2,
      attackerId: "a",
      targetId: "b",
    });
    projectEvent(state, {
      version: 1,
      sequence: 2,
      timestamp,
      type: "attack_revised",
      attackId: "race",
      round: 2,
      attackerId: "a",
      targetId: "b",
      explanation: "Isolated the concurrent schedule",
    });
    projectEvent(state, {
      version: 1,
      sequence: 3,
      timestamp,
      type: "attack_resolved",
      attackId: "race",
      round: 2,
      status: "landed",
      attackerId: "a",
      targetId: "b",
      damage: 30,
    });
    projectEvent(state, {
      version: 1,
      sequence: 4,
      timestamp,
      type: "health_changed",
      contestantId: "b",
      round: 2,
      attackId: "race",
      health: 70,
      amount: -30,
      reason: "Race landed",
    });
    expect(state.attacks.map((attack) => attack.phase)).toEqual([
      "mounting",
      "revised",
      "landed",
    ]);
    expect(state.contestants.b.lastHealthChange).toEqual({
      sequence: 4,
      amount: -30,
      reason: "Race landed",
    });
  });

  it("projects quarter-point damage, bounded recovery, and terminal outcomes", () => {
    const state = initialDashboardState();
    const timestamp = new Date().toISOString();
    projectEvent(state, {
      version: 1,
      sequence: 1,
      timestamp,
      type: "health_changed",
      contestantId: "b",
      round: 1,
      health: 82.5,
      amount: -17.5,
      reason: "Partial judge confirmation",
    });
    projectEvent(state, {
      version: 1,
      sequence: 2,
      timestamp,
      type: "failure_updated",
      failureId: "failure-1",
      stage: "implementation",
      subject: "implementation:b",
      attempt: 2,
      attemptStatus: "succeeded",
      state: "recovered",
      terminalDisposition: "recovered",
      contestantId: "b",
      diagnosticArtifactRefs: ["attempt-2.log"],
    });
    projectEvent(state, {
      version: 1,
      sequence: 3,
      timestamp,
      type: "battle_completed",
      status: "cancelled",
      terminalOutcome: {
        kind: "cancelled",
        reasonCode: "external_cancellation",
        affectedContestantIds: ["a", "b"],
        eligibleContestantIds: [],
        reason: "Cancelled by operator",
        artifactPaths: [],
      },
    });
    expect(state.contestants.b.health).toBe(82.5);
    expect(state.failures).toEqual([
      expect.objectContaining({ state: "recovered", attempt: 2 }),
    ]);
    expect(state.result?.terminalOutcome).toEqual({
      kind: "cancelled",
      reasonCode: "external_cancellation",
      reason: "Cancelled by operator",
    });
  });
});
