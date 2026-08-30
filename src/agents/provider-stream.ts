export type ProviderStreamKind = "codex" | "claude" | "gemini";

export type ProviderActivityKind =
  "message" | "tool_started" | "tool_finished" | "progress" | "result";

export interface ProviderActivity {
  kind: ProviderActivityKind;
  label: string;
  timestamp: string;
  toolName?: string;
  toolId?: string;
  sessionId?: string;
}

export interface ProviderStreamUpdate {
  activities: ProviderActivity[];
  assistantText: string[];
  assistantDeltas: string[];
}

export interface ProviderStreamDiagnostics {
  sessionId?: string;
  eventCount: number;
  toolStartedCount: number;
  toolFinishedCount: number;
  firstActivityAt?: string;
  lastActivityAt?: string;
  currentOpenTool?: string;
  decodingWarnings: string[];
  resolvedModel?: string;
  usageCompleteness?: "complete" | "partial" | "unavailable";
  usageAccountingVersion?: 1;
  reportedCostUsd?: number;
  reportedCostSource?: "provider_billing";
  tokenUsage?: {
    uncachedInputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
  };
}

const safeToolName = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim()
    ? value
        .trim()
        .replaceAll(/[\r\n\t]/g, " ")
        .slice(0, 80)
    : undefined;

const stringAt = (record: Record<string, unknown>, key: string) =>
  typeof record[key] === "string" ? record[key] : undefined;

const recordAt = (
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined => {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

/** Incrementally normalizes provider JSONL without retaining tool arguments. */
export class ProviderStreamDecoder {
  private pending = "";
  private readonly events: ProviderActivity[] = [];
  private readonly warnings: string[] = [];
  private readonly openTools = new Map<string, string>();
  private sessionId?: string;
  private toolStartedCount = 0;
  private toolFinishedCount = 0;
  private lastAssistantText?: string;
  private tokenUsage?: ProviderStreamDiagnostics["tokenUsage"];
  private resolvedModel?: string;
  private reportedCostUsd?: number;
  private reportedCostSource?: "provider_billing";
  private readonly claudeMessageUsage = new Map<
    string,
    NonNullable<ProviderStreamDiagnostics["tokenUsage"]>
  >();
  private claudeFinalUsage?: NonNullable<
    ProviderStreamDiagnostics["tokenUsage"]
  >;
  private usageRecordSequence = 0;

  constructor(
    readonly kind: ProviderStreamKind,
    private readonly now: () => Date = () => new Date(),
  ) {}

  push(chunk: string): ProviderStreamUpdate {
    this.pending += chunk;
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? "";
    return this.decodeLines(lines);
  }

  flush(): ProviderStreamUpdate {
    const tail = this.pending;
    this.pending = "";
    return tail.trim()
      ? this.decodeLines([tail])
      : { activities: [], assistantText: [], assistantDeltas: [] };
  }

  diagnostics(): ProviderStreamDiagnostics {
    const firstActivityAt = this.events[0]?.timestamp;
    const lastActivityAt = this.events.at(-1)?.timestamp;
    return {
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      eventCount: this.events.length,
      toolStartedCount: this.toolStartedCount,
      toolFinishedCount: this.toolFinishedCount,
      ...(firstActivityAt ? { firstActivityAt } : {}),
      ...(lastActivityAt ? { lastActivityAt } : {}),
      ...(this.openTools.size
        ? { currentOpenTool: [...this.openTools.values()].at(-1)! }
        : {}),
      decodingWarnings: [...this.warnings],
      ...(this.resolvedModel ? { resolvedModel: this.resolvedModel } : {}),
      usageCompleteness: this.usageCompleteness(),
      usageAccountingVersion: 1,
      ...(this.reportedCostUsd === undefined
        ? {}
        : {
            reportedCostUsd: this.reportedCostUsd,
            reportedCostSource: this.reportedCostSource,
          }),
      ...(this.tokenUsage ? { tokenUsage: { ...this.tokenUsage } } : {}),
    };
  }

  eventLog(): readonly ProviderActivity[] {
    return this.events;
  }

  private decodeLines(lines: string[]): ProviderStreamUpdate {
    const update: ProviderStreamUpdate = {
      activities: [],
      assistantText: [],
      assistantDeltas: [],
    };
    for (const line of lines) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        this.warn("Malformed provider JSONL record");
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        this.warn("Provider JSONL record was not an object");
        continue;
      }
      this.decodeRecord(value as Record<string, unknown>, update);
    }
    return update;
  }

  private decodeRecord(
    record: Record<string, unknown>,
    update: ProviderStreamUpdate,
  ): void {
    const type = stringAt(record, "type") ?? "unknown";
    const item = recordAt(record, "item");
    const message = recordAt(record, "message");
    const sessionId =
      stringAt(record, "session_id") ??
      stringAt(record, "sessionId") ??
      stringAt(record, "thread_id");
    if (!this.sessionId && sessionId) this.sessionId = sessionId;
    this.captureModel(record, message);
    this.captureCost(record);
    this.captureTokenUsage(record);

    if (this.kind === "codex") {
      const itemType = item ? stringAt(item, "type") : undefined;
      const toolItem =
        itemType !== undefined &&
        [
          "command_execution",
          "mcp_tool_call",
          "web_search",
          "file_change",
        ].includes(itemType);
      if (type === "item.started" && toolItem) {
        this.toolStarted(item!, update, "command");
        return;
      }
      if (type === "item.completed" && toolItem) {
        this.toolFinished(item!, update, "command");
        return;
      }
      if (type === "item.completed" && itemType === "agent_message") {
        const text = stringAt(item!, "text");
        if (text) this.assistantText(update, text);
        this.activity(update, "message", "Assistant message");
        return;
      }
      if (type === "turn.completed") {
        this.activity(update, "result", "Provider completed");
        return;
      }
      if (type === "turn.started") {
        this.activity(update, "progress", "Provider turn started");
        return;
      }
    }

    if (this.kind === "claude") {
      if (type === "assistant" && message) {
        this.decodeClaudeContent(message.content, update);
        return;
      }
      if (type === "user" && message) {
        this.decodeClaudeToolResults(message.content, update);
        return;
      }
      if (type === "result") {
        const text = stringAt(record, "result");
        if (text && text !== this.lastAssistantText)
          this.assistantText(update, text);
        this.activity(update, "result", "Provider completed");
        return;
      }
    }

    if (this.kind === "gemini") {
      if (type === "message") {
        const role = stringAt(record, "role");
        const content = stringAt(record, "content");
        if (role === "assistant" && content) {
          if (record.delta === true) update.assistantDeltas.push(content);
          else this.assistantText(update, content);
        }
        this.activity(update, "message", "Assistant message");
        return;
      }
      if (type === "tool_use") {
        this.toolStarted(record, update, "tool");
        return;
      }
      if (type === "tool_result") {
        this.toolFinished(record, update, "tool");
        return;
      }
      if (type === "result") {
        this.activity(update, "result", "Provider completed");
        return;
      }
    }

    if (type === "system" || type === "init" || type.endsWith(".started")) {
      this.activity(update, "progress", "Provider activity");
      return;
    }
    // Providers add record variants frequently. Unknown records are ignored by
    // design so telemetry can never fail an otherwise usable invocation.
  }

  private captureModel(
    record: Record<string, unknown>,
    message?: Record<string, unknown>,
  ): void {
    const response = recordAt(record, "response");
    const model =
      stringAt(record, "model") ??
      (message ? stringAt(message, "model") : undefined) ??
      (response ? stringAt(response, "model") : undefined);
    if (model?.trim()) this.resolvedModel = model.trim().slice(0, 200);
  }

  private captureCost(record: Record<string, unknown>): void {
    const usage = recordAt(record, "usage");
    const billing =
      recordAt(record, "billing") ??
      (usage ? recordAt(usage, "billing") : undefined);
    if (!billing || stringAt(billing, "source") !== "provider_billing") return;
    const candidates = [billing.usd, billing.cost_usd];
    const value = candidates.find(
      (candidate): candidate is number =>
        typeof candidate === "number" &&
        Number.isFinite(candidate) &&
        candidate >= 0,
    );
    if (value !== undefined) {
      this.reportedCostUsd = value;
      this.reportedCostSource = "provider_billing";
    }
  }

  private captureTokenUsage(record: Record<string, unknown>) {
    const usage =
      recordAt(record, "usage") ??
      recordAt(recordAt(record, "response") ?? {}, "usage") ??
      recordAt(recordAt(record, "turn") ?? {}, "usage");
    if (!usage) return;
    const numberAt = (...keys: string[]): number | undefined => {
      for (const key of keys) {
        const value = usage[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0)
          return Math.round(value);
      }
      return undefined;
    };
    const input = numberAt("input_tokens", "inputTokens", "prompt_tokens");
    const cacheRead = numberAt(
      "cache_read_input_tokens",
      "cacheReadInputTokens",
      "cached_input_tokens",
    );
    const cacheWrite = numberAt(
      "cache_creation_input_tokens",
      "cache_write_input_tokens",
      "cacheWriteInputTokens",
    );
    const output = numberAt(
      "output_tokens",
      "outputTokens",
      "completion_tokens",
    );
    const reasoning = numberAt(
      "reasoning_tokens",
      "reasoning_output_tokens",
      "reasoningTokens",
      "output_reasoning_tokens",
    );
    if (
      [input, cacheRead, cacheWrite, output, reasoning].every(
        (value) => value === undefined,
      )
    )
      return;
    const normalized = {
      ...(input === undefined
        ? {}
        : {
            uncachedInputTokens:
              this.kind === "codex"
                ? Math.max(0, input - (cacheRead ?? 0))
                : input,
          }),
      ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
      ...(cacheWrite === undefined
        ? this.kind === "codex"
          ? { cacheWriteTokens: 0 }
          : {}
        : { cacheWriteTokens: cacheWrite }),
      ...(output === undefined ? {} : { outputTokens: output }),
      ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    };
    if (this.kind === "claude") {
      const type = stringAt(record, "type");
      if (type === "result") {
        this.claudeFinalUsage = normalized;
        this.tokenUsage = normalized;
        return;
      }
      const message = recordAt(record, "message");
      const identity =
        (message ? stringAt(message, "id") : undefined) ??
        stringAt(record, "message_id") ??
        stringAt(record, "id");
      if (identity) this.claudeMessageUsage.set(identity, normalized);
      else {
        this.usageRecordSequence += 1;
        this.claudeMessageUsage.set(
          `event-${String(this.usageRecordSequence)}`,
          normalized,
        );
      }
      this.tokenUsage = this.sumUsage([...this.claudeMessageUsage.values()]);
      return;
    }
    // Codex emits cumulative turn snapshots. Gemini's supported records are
    // likewise treated as snapshots; retaining the latest avoids inflation.
    this.tokenUsage = normalized;
  }

  private sumUsage(
    usages: NonNullable<ProviderStreamDiagnostics["tokenUsage"]>[],
  ): NonNullable<ProviderStreamDiagnostics["tokenUsage"]> {
    const keys = [
      "uncachedInputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "outputTokens",
      "reasoningTokens",
    ] as const;
    return Object.fromEntries(
      keys.flatMap((key) => {
        const values = usages
          .map((usage) => usage[key])
          .filter((value): value is number => value !== undefined);
        return values.length
          ? [[key, values.reduce((sum, value) => sum + value, 0)]]
          : [];
      }),
    );
  }

  private usageCompleteness(): "complete" | "partial" | "unavailable" {
    const usage = this.claudeFinalUsage ?? this.tokenUsage;
    if (!usage || Object.values(usage).every((value) => value === undefined))
      return "unavailable";
    const required = [
      usage.uncachedInputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
      usage.outputTokens,
    ];
    return required.every((value) => value !== undefined)
      ? "complete"
      : "partial";
  }

  private decodeClaudeContent(value: unknown, update: ProviderStreamUpdate) {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const block = entry as Record<string, unknown>;
      if (block.type === "text") {
        const text = stringAt(block, "text");
        if (text) this.assistantText(update, text);
        this.activity(update, "message", "Assistant message");
      } else if (block.type === "tool_use") {
        this.toolStarted(block, update, "tool");
      }
    }
  }

  private decodeClaudeToolResults(
    value: unknown,
    update: ProviderStreamUpdate,
  ) {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>).type === "tool_result"
      ) {
        this.toolFinished(entry as Record<string, unknown>, update, "tool");
      }
    }
  }

  private toolStarted(
    record: Record<string, unknown>,
    update: ProviderStreamUpdate,
    fallback: string,
  ) {
    const name =
      safeToolName(record.name) ??
      safeToolName(record.tool_name) ??
      safeToolName(record.type) ??
      fallback;
    const id =
      stringAt(record, "id") ?? stringAt(record, "tool_id") ?? `${name}-open`;
    this.openTools.set(id, name);
    this.toolStartedCount += 1;
    this.activity(update, "tool_started", `Waiting on ${name}`, name, id);
  }

  private toolFinished(
    record: Record<string, unknown>,
    update: ProviderStreamUpdate,
    fallback: string,
  ) {
    const id =
      stringAt(record, "tool_use_id") ??
      stringAt(record, "tool_id") ??
      stringAt(record, "id");
    const name =
      (id ? this.openTools.get(id) : undefined) ??
      safeToolName(record.name) ??
      safeToolName(record.tool_name) ??
      fallback;
    if (id) this.openTools.delete(id);
    else {
      const match = [...this.openTools].find(([, value]) => value === name);
      if (match) this.openTools.delete(match[0]);
    }
    this.toolFinishedCount += 1;
    this.activity(update, "tool_finished", `${name} finished`, name, id);
  }

  private activity(
    update: ProviderStreamUpdate,
    kind: ProviderActivityKind,
    label: string,
    toolName?: string,
    toolId?: string,
  ) {
    const activity: ProviderActivity = {
      kind,
      label,
      timestamp: this.now().toISOString(),
      ...(toolName ? { toolName } : {}),
      ...(toolId ? { toolId } : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    };
    this.events.push(activity);
    update.activities.push(activity);
  }

  private assistantText(update: ProviderStreamUpdate, text: string) {
    update.assistantText.push(text);
    this.lastAssistantText = text;
  }

  private warn(message: string) {
    if (this.warnings.length < 20) this.warnings.push(message);
  }
}
