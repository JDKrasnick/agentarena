import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { initialDashboardState } from "../../src/dashboard/state.js";
import { CompactRoundNav } from "../../src/web/client/App.js";

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
});
