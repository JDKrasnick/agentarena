import type { ArenaEventInput, ArenaObserver } from "./events.js";

/** Emits provider activity state transitions without repeating heartbeat text. */
export class PlainProgressObserver implements ArenaObserver {
  private readonly states = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly write: (line: string) => void) {}

  publish(event: ArenaEventInput): void {
    if (event.type === "invocation_started") {
      this.transition(event.invocationId, "Active");
      this.armQuiet(event.invocationId);
      return;
    }
    if (event.type === "invocation_progress") {
      const state =
        event.kind === "tool_started" && event.toolName
          ? `Waiting on ${event.toolName}`
          : `Active · ${event.label}`;
      this.transition(event.invocationId, state);
      this.armQuiet(event.invocationId);
      return;
    }
    if (event.type === "invocation_finished") {
      const timer = this.timers.get(event.invocationId);
      if (timer) clearTimeout(timer);
      this.timers.delete(event.invocationId);
      this.states.delete(event.invocationId);
    }
  }

  private transition(invocationId: string, state: string) {
    if (this.states.get(invocationId) === state) return;
    this.states.set(invocationId, state);
    this.write(`[${invocationId}] ${state}\n`);
  }

  private armQuiet(invocationId: string) {
    const current = this.timers.get(invocationId);
    if (current) clearTimeout(current);
    const timer = setTimeout(
      () => this.transition(invocationId, "No recent provider activity · 30s"),
      30_001,
    );
    timer.unref();
    this.timers.set(invocationId, timer);
  }
}
