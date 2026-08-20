import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  initialDashboardState,
  projectEvent,
} from "../../src/dashboard/state.js";
import { CompactRoundNav, FullAgentOutput } from "../../src/web/client/App.js";

describe("dashboard UI contracts", () => {
  it("exposes the selected compact round to assistive technology", () => {
    const state = initialDashboardState();
    state.round = 2;
    state.result = { roundsCompleted: 3 };

    const roundTwo = renderToStaticMarkup(
      <CompactRoundNav
        state={state}
        rounds={[1, 2, 3]}
        selected={2}
        onSelect={() => undefined}
      />,
    );
    const live = renderToStaticMarkup(
      <CompactRoundNav
        state={state}
        rounds={[1, 2, 3]}
        selected="live"
        onSelect={() => undefined}
      />,
    );

    expect(roundTwo).toContain('aria-current="page">R2</button>');
    expect(live).toContain('aria-current="page">Live</button>');
  });

  it("enables invocation-only historical rounds during a later live round", () => {
    const state = initialDashboardState();
    state.status = "running";
    state.round = 2;
    state.contestants.a.invocations.push({
      id: "a-implementation",
      stage: "implement",
      status: "succeeded",
      round: 1,
      startedAt: "2026-08-19T12:00:00.000Z",
    });

    const markup = renderToStaticMarkup(
      <CompactRoundNav
        state={state}
        rounds={[1, 2, 3]}
        selected="live"
        onSelect={() => undefined}
      />,
    );

    expect(markup).toContain(">R1</button>");
    expect(markup).not.toContain('disabled="">R1</button>');
    expect(markup).toContain('disabled="">R3</button>');
  });

  it("renders full fighter output as one whitespace-preserving terminal stream", () => {
    const fighter = initialDashboardState().contestants.a;
    fighter.output.push(
      {
        stream: "stdout",
        text: "  first line\nsecond line\n",
        invocationId: "a-implement",
        timestamp: "2026-08-19T12:00:00.000Z",
      },
      {
        stream: "stderr",
        text: "warning: keep trailing space \n",
        invocationId: "a-implement",
        timestamp: "2026-08-19T12:00:01.000Z",
      },
    );

    const markup = renderToStaticMarkup(
      <FullAgentOutput fighter={fighter} provider="Codex" />,
    );

    expect(markup).toContain("  first line\nsecond line\n");
    expect(markup).toContain("warning: keep trailing space \n");
    expect(markup).toContain("output-stderr");
    expect(markup).not.toContain("12:00:00");
  });

  it("retains the complete fighter transcript beyond the compact list bound", () => {
    const state = initialDashboardState();
    const timestamp = new Date().toISOString();
    for (let sequence = 1; sequence <= 2_005; sequence += 1) {
      projectEvent(state, {
        version: 1,
        sequence,
        timestamp,
        type: "output",
        invocationId: "a-long-run",
        source: "agent",
        stream: "stdout",
        text: `chunk-${String(sequence)}\n`,
        contestantId: "a",
      });
    }

    expect(state.contestants.a.output).toHaveLength(2_005);
    expect(state.contestants.a.output[0]?.text).toBe("chunk-1\n");
    expect(state.contestants.a.output.at(-1)?.text).toBe("chunk-2005\n");
  });
});
