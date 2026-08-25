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
    expect(() =>
      decoder.push('{bad}\n{"type":"future.variant","payload":1}\n'),
    ).not.toThrow();
    expect(decoder.diagnostics().decodingWarnings).toEqual([
      "Malformed provider JSONL record",
    ]);
  });
});
