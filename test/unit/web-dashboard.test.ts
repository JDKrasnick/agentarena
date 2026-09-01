import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveWebRoot,
  startWebDashboard,
} from "../../src/dashboard/web-server.js";
import { ArenaBattleControl } from "../../src/observability/control.js";

async function readServerEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  let message = "";
  while (!message.includes("\n\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("Event stream closed before a message");
    message += new TextDecoder().decode(chunk.value);
  }
  return message;
}

describe("web dashboard", () => {
  it("serves live state and accepts steering", async () => {
    const controller = new AbortController();
    const control = new ArenaBattleControl(controller);
    const dashboard = await startWebDashboard(control);
    try {
      await dashboard.observer.publish({
        type: "battle_started",
        runId: "web-test",
        task: "Ship a dashboard",
        contestants: [
          { id: "a", provider: "codex" },
          { id: "b", provider: "claude" },
        ],
      });
      const stateResponse = await fetch(`${dashboard.url}/api/state`);
      const state = (await stateResponse.json()) as {
        task: string;
        contestants: { b: { provider: string } };
      };
      expect(stateResponse.status).toBe(200);
      expect(stateResponse.headers.get("x-agent-arena-snapshot-revision")).toBe(
        "1",
      );
      expect(
        stateResponse.headers.get("x-agent-arena-snapshot-generated-at"),
      ).toBeTruthy();
      expect(state.task).toBe("Ship a dashboard");
      expect(state.contestants.b.provider).toBe("claude");

      const streamController = new AbortController();
      const stream = await fetch(`${dashboard.url}/events`, {
        signal: streamController.signal,
      });
      const reader = stream.body!.getReader();
      const initialEvent = await readServerEvent(reader);
      expect(initialEvent).toContain("id: 1");
      expect(initialEvent).toContain('"revision":1');
      expect(initialEvent).toContain('"task":"Ship a dashboard"');
      await dashboard.observer.publish({
        type: "stage_changed",
        stage: "initial_validate",
        round: 1,
      });
      const updatedEvent = await readServerEvent(reader);
      expect(updatedEvent).toContain("id: 2");
      expect(updatedEvent).toContain('"revision":2');
      expect(updatedEvent).toContain('"stage":"initial_validate"');
      streamController.abort();

      const steerResponse = await fetch(`${dashboard.url}/api/steer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contestantId: "b", note: "Check cleanup" }),
      });
      expect(steerResponse.status).toBe(202);
      expect(control.all()).toEqual([
        expect.objectContaining({ contestantId: "b", note: "Check cleanup" }),
      ]);

      const emptySteer = await fetch(`${dashboard.url}/api/steer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contestantId: "a", note: "  " }),
      });
      expect(emptySteer.status).toBe(400);
      const traversal = await fetch(`${dashboard.url}/..%2F..%2Fpackage.json`);
      expect(traversal.status).toBe(404);

      const crossOrigin = await fetch(`${dashboard.url}/api/state`, {
        headers: { Origin: "https://example.com" },
      });
      expect(crossOrigin.status).toBe(403);
    } finally {
      await dashboard.close();
    }
  });

  it("does not resolve dashboard assets from the target repository", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "arena-target-"));
    await mkdir(path.join(repository, "dist/web"), { recursive: true });
    await writeFile(
      path.join(repository, "dist/web/index.html"),
      "TARGET-REPOSITORY-CONTENT",
      "utf8",
    );
    const originalCwd = process.cwd();
    process.chdir(repository);
    try {
      expect(resolveWebRoot()).not.toBe(path.join(repository, "dist/web"));
      expect(resolveWebRoot()).toBe(path.join(originalCwd, "dist/web"));
    } finally {
      process.chdir(originalCwd);
    }
  });
});
