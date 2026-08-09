import { appendFile, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { ArtifactStore } from "../artifacts/store.js";

export const RecoveryEventSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().positive(),
    runId: z.string().min(1),
    at: z.string().datetime({ offset: true }),
    type: z.enum([
      "resume_started",
      "drift_detected",
      "drift_approved",
      "sealed_envelope_applied",
      "unsealed_round_expired",
      "resume_continued",
      "resume_stopped",
    ]),
    detail: z.record(z.string(), z.unknown()),
  })
  .strict();
export type RecoveryEvent = z.infer<typeof RecoveryEventSchema>;

export async function readRecoveryEvents(
  store: ArtifactStore,
): Promise<RecoveryEvent[]> {
  let text: string;
  try {
    text = await readFile(store.resolve("events/lifecycle.ndjson"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const events: RecoveryEvent[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      events.push(RecoveryEventSchema.parse(JSON.parse(line) as unknown));
    } catch (error) {
      if (index === lines.length - 1) break;
      throw new Error(`Corrupt lifecycle journal record ${String(index + 1)}`, {
        cause: error,
      });
    }
  }
  events.forEach((event, index) => {
    const previous = events[index - 1];
    if (previous && event.sequence !== previous.sequence + 1)
      throw new Error("Lifecycle journal sequence is broken");
  });
  return events;
}

export async function appendRecoveryEvent(options: {
  store: ArtifactStore;
  type: RecoveryEvent["type"];
  detail?: Record<string, unknown>;
  now?: Date;
}): Promise<RecoveryEvent> {
  const events = await readRecoveryEvents(options.store);
  const event = RecoveryEventSchema.parse({
    version: 1,
    sequence: (events.at(-1)?.sequence ?? 0) + 1,
    runId: options.store.runId,
    at: (options.now ?? new Date()).toISOString(),
    type: options.type,
    detail: options.detail ?? {},
  });
  const target = options.store.resolve("events/lifecycle.ndjson");
  let tornTrailingRecord = false;
  try {
    const lines = (await readFile(target, "utf8")).split("\n").filter(Boolean);
    tornTrailingRecord = lines.length !== events.length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (tornTrailingRecord) {
    await writeFile(
      target,
      `${[...events, event].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
  } else {
    await appendFile(target, `${JSON.stringify(event)}\n`, "utf8");
  }
  return event;
}
