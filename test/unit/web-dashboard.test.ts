import { describe, expect, it } from "vitest";
import { startWebDashboard } from "../../src/dashboard/web-server.js";
import { ArenaBattleControl } from "../../src/observability/control.js";

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
      expect(state.task).toBe("Ship a dashboard");
      expect(state.contestants.b.provider).toBe("claude");

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
});
