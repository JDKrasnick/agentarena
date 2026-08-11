import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ArenaBattleControl,
  appendSteering,
} from "../../src/observability/control.js";
import {
  ArenaEventSchema,
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

  it("redacts credentials split across chunks", () => {
    const redactor = new StreamingRedactor(["secret-value-1234"]);
    const output = [
      redactor.push("before secret-"),
      redactor.push("value-1234 after"),
      redactor.flush(),
    ].join("");
    expect(output).toBe("before [REDACTED] after");
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
    expect(state.contestants.a.output).toEqual([
      { stream: "stderr", text: "working\n" },
    ]);
    expect(state.assisted).toBe(true);
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
});
