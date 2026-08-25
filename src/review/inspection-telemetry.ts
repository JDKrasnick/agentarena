import { z } from "zod";

export type InspectionClass = "targeted" | "broad" | "unknown";
export type InspectionVisibility = "complete" | "partial" | "unsupported";

export const InspectionEventSchema = z
  .object({
    kind: z.enum(["tool", "read", "search", "edit", "usage", "visibility"]),
    path: z.string().optional(),
    recursive: z.boolean().optional(),
    executableTestEdit: z.boolean().optional(),
    timestampMs: z.number().int().nonnegative().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    warningVisible: z.boolean().optional(),
  })
  .strict();
export type InspectionEvent = z.infer<typeof InspectionEventSchema>;

export interface DecodedInspectionEvents {
  events: InspectionEvent[];
  visibility: InspectionVisibility;
}

export function normalizeInspectionPath(value: string): string | undefined {
  let normalized = value.trim().replaceAll("\\", "/");
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1);
  }
  normalized = normalized.replace(/^\.\//u, "").replace(/\/$/u, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => !part || part === "..")
  ) {
    return undefined;
  }
  return normalized;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function timestampFrom(record: Record<string, unknown>, fallback?: number) {
  const direct = numberField(record.timestampMs ?? record.timestamp_ms);
  if (direct !== undefined) return Math.trunc(direct);
  const iso = stringField(record.timestamp ?? record.created_at);
  if (iso) {
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

const TEST_PATH =
  /(?:^|\/)(?:test|tests|spec|specs|__tests__)(?:\/|$)|(?:\.test|\.spec)\.[^./]+$/iu;

function isExecutableTestPath(value: string | undefined): boolean {
  return value !== undefined && TEST_PATH.test(value);
}

function pathCandidates(command: string): string[] {
  const candidates: string[] = [];
  for (const match of command.matchAll(
    /(?:^|\s)(?:--?\w+(?:=|\s+))?["']?((?:\.\.?\/)?[A-Za-z0-9_@+.-]+(?:\/[A-Za-z0-9_@+.*?{}[\]-]+)+|\.?\.?\/|\.)["']?(?=\s|$)/gu,
  )) {
    const candidate = normalizeInspectionPath(match[1] ?? "");
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function commandEvent(
  command: string,
  timestampMs: number | undefined,
): InspectionEvent | undefined {
  const lower = command.toLowerCase();
  const edit =
    /(?:^|\s)(?:apply_patch|sed\s+-i|perl\s+-pi|tee|touch|cp|mv)(?:\s|$)/u.test(
      lower,
    ) || />{1,2}\s*[^&]/u.test(command);
  const search =
    /(?:^|\s)(?:rg|grep|find|fd|ls)(?:\s|$)/u.test(lower) ||
    /--files(?:\s|$)/u.test(lower);
  const read = /(?:^|\s)(?:cat|sed\s+-n|head|tail|less|bat)(?:\s|$)/u.test(
    lower,
  );
  if (!edit && !search && !read) {
    return {
      kind: "tool",
      ...(timestampMs === undefined ? {} : { timestampMs }),
    };
  }
  const candidates = pathCandidates(command);
  const selected = candidates.at(-1);
  const recursive =
    /(?:^|\s)(?:find\s+\.|ls\s+[^\n]*-[^\n]*r|rg\s+--files)(?:\s|$)/iu.test(
      command,
    ) ||
    /(?:^|\/)\*\*(?:\/|$)/u.test(command) ||
    candidates.length === 0;
  return {
    kind: edit ? "edit" : search ? "search" : "read",
    ...(selected ? { path: selected } : {}),
    ...(recursive ? { recursive: true } : {}),
    ...(edit ? { executableTestEdit: isExecutableTestPath(selected) } : {}),
    ...(timestampMs === undefined ? {} : { timestampMs }),
  };
}

function toolEvent(
  name: string,
  input: Record<string, unknown>,
  timestampMs: number | undefined,
): InspectionEvent | undefined {
  const normalizedName = name.toLowerCase();
  const command = stringField(input.command);
  if (command) return commandEvent(command, timestampMs);
  const rawPath =
    stringField(input.file_path) ??
    stringField(input.path) ??
    stringField(input.glob) ??
    stringField(input.directory);
  const normalizedPath = rawPath ? normalizeInspectionPath(rawPath) : undefined;
  const edit = /edit|write|patch|notebookedit/u.test(normalizedName);
  const search = /grep|glob|search|find/u.test(normalizedName);
  const read = /read|open|view/u.test(normalizedName);
  if (!edit && !search && !read) {
    return {
      kind: "tool",
      ...(timestampMs === undefined ? {} : { timestampMs }),
    };
  }
  return {
    kind: edit ? "edit" : search ? "search" : "read",
    ...(normalizedPath ? { path: normalizedPath } : {}),
    ...(!normalizedPath || input.recursive === true ? { recursive: true } : {}),
    ...(edit
      ? { executableTestEdit: isExecutableTestPath(normalizedPath) }
      : {}),
    ...(timestampMs === undefined ? {} : { timestampMs }),
  };
}

export function decodeInspectionRecord(
  provider: "codex" | "claude" | "gemini",
  value: unknown,
  receivedAtMs?: number,
): InspectionEvent[] | undefined {
  if (provider === "gemini") return undefined;
  const record = objectField(value);
  if (!record) return undefined;
  const type = stringField(record.type)?.toLowerCase();
  if (!type) return [];
  const timestampMs = timestampFrom(record, receivedAtMs);

  if (provider === "codex") {
    if (type === "turn.completed") {
      const usage = objectField(record.usage);
      if (!usage) return [];
      return [
        {
          kind: "usage",
          ...(numberField(usage.input_tokens) === undefined
            ? {}
            : { inputTokens: Math.trunc(numberField(usage.input_tokens)!) }),
          ...(numberField(usage.output_tokens) === undefined
            ? {}
            : { outputTokens: Math.trunc(numberField(usage.output_tokens)!) }),
          ...(timestampMs === undefined ? {} : { timestampMs }),
        },
      ];
    }
    if (type !== "item.started" && type !== "item.completed") return [];
    const item = objectField(record.item);
    if (!item) return undefined;
    const itemType = stringField(item.type)?.toLowerCase();
    if (itemType === "command_execution") {
      const command = stringField(item.command);
      const event = command ? commandEvent(command, timestampMs) : undefined;
      return event ? [event] : [];
    }
    if (itemType === "file_change") {
      const changes = Array.isArray(item.changes) ? item.changes : [item];
      return changes.flatMap((change) => {
        const object = objectField(change);
        const normalizedPath = object
          ? normalizeInspectionPath(stringField(object.path) ?? "")
          : undefined;
        return normalizedPath
          ? [
              {
                kind: "edit" as const,
                path: normalizedPath,
                executableTestEdit: isExecutableTestPath(normalizedPath),
                ...(timestampMs === undefined ? {} : { timestampMs }),
              },
            ]
          : [];
      });
    }
    if (itemType === "mcp_tool_call") {
      const input = objectField(item.arguments ?? item.input) ?? {};
      const event = toolEvent(stringField(item.tool) ?? "", input, timestampMs);
      return event ? [event] : [];
    }
    return [];
  }

  if (type === "result") {
    const usage = objectField(record.usage);
    const costUsd = numberField(record.total_cost_usd);
    return usage || costUsd !== undefined
      ? [
          {
            kind: "usage",
            ...(numberField(usage?.input_tokens) === undefined
              ? {}
              : { inputTokens: Math.trunc(numberField(usage?.input_tokens)!) }),
            ...(numberField(usage?.output_tokens) === undefined
              ? {}
              : {
                  outputTokens: Math.trunc(numberField(usage?.output_tokens)!),
                }),
            ...(costUsd === undefined ? {} : { costUsd }),
            ...(timestampMs === undefined ? {} : { timestampMs }),
          },
        ]
      : [];
  }
  if (type === "user") {
    const serialized = JSON.stringify(record);
    return serialized.includes("AGENT_ARENA_REDISCOVERY_WARNING")
      ? [
          {
            kind: "visibility",
            warningVisible: true,
            ...(timestampMs === undefined ? {} : { timestampMs }),
          },
        ]
      : [];
  }
  if (type !== "assistant") return [];
  const message = objectField(record.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.flatMap((entry) => {
    const block = objectField(entry);
    if (stringField(block?.type) !== "tool_use") return [];
    const input = objectField(block?.input) ?? {};
    const event = toolEvent(stringField(block?.name) ?? "", input, timestampMs);
    return event ? [event] : [];
  });
}

export function decodeInspectionJsonl(
  provider: "codex" | "claude" | "gemini",
  text: string,
): DecodedInspectionEvents {
  if (provider === "gemini") return { events: [], visibility: "unsupported" };
  const events: InspectionEvent[] = [];
  let partial = false;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      partial = true;
      continue;
    }
    const normalized = decodeInspectionRecord(provider, decoded);
    if (normalized === undefined) partial = true;
    else events.push(...normalized);
  }
  return { events, visibility: partial ? "partial" : "complete" };
}

export function classifyInspection(
  event: InspectionEvent,
  targets: ReadonlySet<string>,
  visibility: InspectionVisibility = "complete",
): InspectionClass {
  if (visibility !== "complete") return "unknown";
  if (event.kind !== "read" && event.kind !== "search" && event.kind !== "edit")
    return "unknown";
  if (event.recursive || !event.path) return "broad";
  return targets.has(event.path) ? "targeted" : "broad";
}
