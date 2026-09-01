import { describe, expect, it } from "vitest";
import { ProviderStreamDecoder } from "../../src/agents/provider-stream.js";

describe("provider stream decoding", () => {
  it("normalizes split Codex records and retains final assistant text", () => {
    const decoder = new ProviderStreamDecoder("codex");
    const first = decoder.push(
      '{"type":"thread.started","thread_id":"thread-1"}\n{"type":"item.started","item":{"id":"tool-1","type":"command_execution","command":"secret args"}}\n{"type":"item.com',
    );
    const second = decoder.push(
      'pleted","item":{"id":"tool-1","type":"command_execution"}}\n{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n',
    );

    expect(
      [...first.activities, ...second.activities].map((event) => event.kind),
    ).toEqual(["progress", "tool_started", "tool_finished", "message"]);
    expect(first.deadlineProgressCount).toBe(1);
    expect(second.deadlineProgressCount).toBe(2);
    expect(second.assistantText).toEqual(["done"]);
    expect(JSON.stringify(decoder.eventLog())).not.toContain("secret args");
    expect(decoder.diagnostics()).toMatchObject({
      sessionId: "thread-1",
      eventCount: 4,
      toolStartedCount: 1,
      toolFinishedCount: 1,
    });
  });

  it("normalizes Claude and Gemini tool lifecycles", () => {
    const claude = new ProviderStreamDecoder("claude");
    const claudeUpdate = claude.push(
      [
        JSON.stringify({ type: "system", session_id: "session-1" }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "checking" },
              {
                type: "tool_use",
                id: "read-1",
                name: "Read",
                input: { path: "/private" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "read-1",
                content: "private",
              },
            ],
          },
        }),
        JSON.stringify({ type: "result", result: "complete" }),
        "",
      ].join("\n"),
    );
    expect(claudeUpdate.assistantText).toEqual(["checking", "complete"]);
    expect(claudeUpdate.activities.map((event) => event.kind)).toEqual([
      "progress",
      "message",
      "tool_started",
      "tool_finished",
      "result",
    ]);
    expect(JSON.stringify(claude.eventLog())).not.toContain("/private");

    const gemini = new ProviderStreamDecoder("gemini");
    const geminiUpdate = gemini.push(
      [
        JSON.stringify({ type: "init", session_id: "gemini-1" }),
        JSON.stringify({
          type: "tool_use",
          tool_id: "shell-1",
          tool_name: "shell",
          parameters: { command: "secret" },
        }),
        JSON.stringify({ type: "tool_result", tool_id: "shell-1" }),
        JSON.stringify({
          type: "message",
          role: "assistant",
          content: "done",
          delta: true,
        }),
        "",
      ].join("\n"),
    );
    expect(geminiUpdate.activities.map((event) => event.kind)).toEqual([
      "progress",
      "tool_started",
      "tool_finished",
      "message",
    ]);
    expect(geminiUpdate.assistantDeltas).toEqual(["done"]);
  });

  it("warns on malformed records and ignores unknown variants", () => {
    const decoder = new ProviderStreamDecoder("codex");
    const update = decoder.push(
      '{bad}\n{"type":"future.variant","payload":1}\n{"type":"future.keepalive.started"}\n',
    );
    expect(update.activities.map((event) => event.kind)).toEqual(["progress"]);
    expect(update.deadlineProgressCount).toBe(0);
    expect(decoder.diagnostics().decodingWarnings).toEqual([
      "Malformed provider JSONL record",
    ]);
  });

  it("uses the latest cumulative Codex usage without double counting reasoning", () => {
    const decoder = new ProviderStreamDecoder("codex");
    decoder.push(
      [
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            cache_write_input_tokens: 2,
            output_tokens: 10,
            reasoning_output_tokens: 4,
          },
          model: "gpt-5.6-sol",
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 220,
            cached_input_tokens: 50,
            cache_write_input_tokens: 7,
            output_tokens: 30,
            reasoning_output_tokens: 12,
          },
        }),
        "",
      ].join("\n"),
    );
    expect(decoder.diagnostics()).toMatchObject({
      resolvedModel: "gpt-5.6-sol",
      usageCompleteness: "complete",
      usageAccountingVersion: 1,
      tokenUsage: {
        uncachedInputTokens: 170,
        cacheReadTokens: 50,
        cacheWriteTokens: 7,
        outputTokens: 30,
        reasoningTokens: 12,
      },
    });
  });

  it("deduplicates Claude messages and prefers a final aggregate", () => {
    const decoder = new ProviderStreamDecoder("claude");
    const message = {
      type: "assistant",
      message: { id: "msg-1", model: "claude-opus-4-6", content: [] },
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 2,
        output_tokens: 4,
      },
    };
    decoder.push(
      [
        JSON.stringify(message),
        JSON.stringify(message),
        JSON.stringify({
          type: "assistant",
          message: { id: "msg-2", content: [] },
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
        JSON.stringify({
          type: "result",
          total_cost_usd: 0.42,
          usage: {
            input_tokens: 30,
            cache_read_input_tokens: 8,
            cache_creation_input_tokens: 5,
            output_tokens: 9,
          },
        }),
        "",
      ].join("\n"),
    );
    expect(decoder.diagnostics()).toMatchObject({
      resolvedModel: "claude-opus-4-6",
      tokenUsage: {
        uncachedInputTokens: 30,
        cacheReadTokens: 8,
        cacheWriteTokens: 5,
        outputTokens: 9,
      },
    });
    expect(decoder.diagnostics()).not.toHaveProperty("reportedCostUsd");
  });

  it("captures USD only from explicitly authoritative billing telemetry", () => {
    const decoder = new ProviderStreamDecoder("claude");
    decoder.push(
      `${JSON.stringify({
        type: "result",
        total_cost_usd: 0.99,
        billing: {
          source: "provider_billing",
          usd: 0.42,
        },
      })}\n`,
    );
    expect(decoder.diagnostics()).toMatchObject({
      reportedCostUsd: 0.42,
      reportedCostSource: "provider_billing",
    });
  });
});
