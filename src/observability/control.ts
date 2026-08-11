import { randomUUID } from "node:crypto";
import type { ContestantId, OperatorIntervention } from "../core/types.js";

export interface BattleControl {
  cancel(reason?: unknown): void;
  queueSteering(contestantId: ContestantId, note: string): OperatorIntervention;
}

export class ArenaBattleControl implements BattleControl {
  private readonly notes: OperatorIntervention[] = [];
  private queuedListener: ((note: OperatorIntervention) => void) | undefined;

  constructor(
    private readonly controller: AbortController,
    private readonly now: () => Date = () => new Date(),
    onQueued?: (note: OperatorIntervention) => void,
  ) {
    this.queuedListener = onQueued;
  }

  onQueue(listener: (note: OperatorIntervention) => void): void {
    this.queuedListener = listener;
  }

  cancel(reason: unknown = new Error("Interrupted")): void {
    this.controller.abort(reason);
  }

  queueSteering(
    contestantId: ContestantId,
    rawNote: string,
  ): OperatorIntervention {
    const note = rawNote.trim();
    if (!note) throw new Error("Steering note cannot be empty");
    const intervention: OperatorIntervention = {
      id: randomUUID(),
      contestantId,
      note,
      authoredAt: this.now().toISOString(),
      status: "queued",
    };
    this.notes.push(intervention);
    this.queuedListener?.(intervention);
    return intervention;
  }

  consume(contestantId: ContestantId): OperatorIntervention | undefined {
    return this.notes.find(
      (note) => note.contestantId === contestantId && note.status === "queued",
    );
  }

  all(): readonly OperatorIntervention[] {
    return this.notes;
  }
}

export function appendSteering(prompt: string, note: string): string {
  return `${prompt}\n\n--- OPERATOR STEERING NOTE (APPLY ONCE) ---\n${note}\n--- END OPERATOR STEERING NOTE ---\n`;
}
