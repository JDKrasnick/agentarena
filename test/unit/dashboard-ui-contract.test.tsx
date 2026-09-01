import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  initialDashboardState,
  projectEvent,
} from "../../src/dashboard/state.js";
import {
  CompactAgentOutput,
  BrowserSessionAction,
  BroadcastArena,
  CompactRoundNav,
  DeveloperDashboardArena,
  FullAgentOutput,
  NightTransitArena,
  ResultScreen,
  RetroTacticsArena,
  TestLabArena,
} from "../../src/web/client/App.js";

describe("dashboard UI contracts", () => {
  it("renders non-discriminating evidence and an independent recommendation without winner styling", () => {
    const state = initialDashboardState();
    state.status = "complete";
    state.contestants.a.provider = "codex";
    state.contestants.b.provider = "claude";
    state.result = {
      roundsCompleted: 1,
      outcomeKind: "non_discriminating",
      decisionBasis: "independent_patch_quality",
      competitiveLandingCount: 0,
      sharedDefectCount: 1,
      explicitEmptyLaneCount: 5,
      recommendedId: "b",
      recommendationReason:
        "Independent identity-blind quality comparison preferred Patch B.",
    };

    const markup = renderToStaticMarkup(
      <ResultScreen
        state={state}
        onReview={() => undefined}
        onOpenFighter={() => undefined}
      />,
    );
    expect(markup).toContain("Non-discriminating battle.");
    expect(markup).toContain("No champion");
    expect(markup).toContain("Claude · Fighter B");
    expect(markup).toContain("0 competitive · 1 shared · 5 empty lanes");
    expect(markup).not.toContain("is-winner");
  });

  it("renders per-contestant termination evidence for unstable pre-review validation", () => {
    const state = initialDashboardState();
    state.status = "inconclusive";
    state.result = {
      terminalOutcome: {
        kind: "inconclusive",
        reasonCode: "initial_validation_unstable",
        reason: "Required validation attempts disagreed.",
        contestants: [
          {
            contestantId: "a",
            eligible: false,
            reasonCode: "initial_validation_unstable",
            validation: {
              outcome: "unstable",
              attempts: [
                {
                  command: "npm test",
                  cwd: "/tmp/a",
                  exitCode: null,
                  signal: "SIGTERM",
                  timedOut: true,
                  attempts: 1,
                  durationMs: 30_000,
                  stdoutPath: "/tmp/a.stdout.log",
                  stderrPath: "/tmp/a.stderr.log",
                  failureExcerpt: "168 tests passed; waiting for teardown",
                  termination: {
                    cause: "timeout",
                    timeoutType: "wall_clock",
                    startedAt: "2026-08-30T19:18:18.000Z",
                    finishedAt: "2026-08-30T19:18:48.000Z",
                    lastOutputAt: "2026-08-30T19:18:47.000Z",
                    escalation: [],
                  },
                },
                {
                  command: "npm test",
                  cwd: "/tmp/a",
                  exitCode: 0,
                  signal: null,
                  timedOut: false,
                  attempts: 1,
                  durationMs: 42_000,
                  stdoutPath: "/tmp/a-retry.stdout.log",
                  stderrPath: "/tmp/a-retry.stderr.log",
                },
              ],
            },
          },
        ],
      },
    };

    const markup = renderToStaticMarkup(
      <ResultScreen
        state={state}
        onReview={() => undefined}
        onOpenFighter={() => undefined}
      />,
    );

    expect(markup).toContain("Eligibility and validation evidence");
    expect(markup).toContain("initial_validation_unstable");
    expect(markup).toContain("Attempt 1 · timeout");
    expect(markup).toContain("168 tests passed; waiting for teardown");
    expect(markup).toContain("Attempt 2 · exit");
  });

  it("renders eligibility evidence after a successful completed validation", () => {
    const state = initialDashboardState();
    state.status = "complete";
    state.result = {
      implementationEligibility: [
        {
          contestantId: "a",
          eligible: true,
          artifactPaths: [],
          validation: {
            outcome: "passed",
            attempts: [
              {
                command: "npm test",
                cwd: "/tmp/a",
                exitCode: 0,
                signal: null,
                timedOut: false,
                attempts: 1,
                durationMs: 420,
                stdoutPath: "/tmp/a.stdout.log",
                stderrPath: "/tmp/a.stderr.log",
                termination: {
                  cause: "exit",
                  timeoutType: null,
                  startedAt: "2026-08-30T19:18:18.000Z",
                  finishedAt: "2026-08-30T19:18:18.420Z",
                  lastOutputAt: "2026-08-30T19:18:18.300Z",
                  escalation: [],
                },
              },
            ],
          },
        },
      ],
    };

    const markup = renderToStaticMarkup(
      <ResultScreen
        state={state}
        onReview={() => undefined}
        onOpenFighter={() => undefined}
      />,
    );

    expect(markup).toContain("Eligibility and validation evidence");
    expect(markup).toContain("Fighter A · eligible");
    expect(markup).toContain("Attempt 1 · exit");
  });

  it("renders an operator-triggered browser link only for an active session", () => {
    expect(
      renderToStaticMarkup(
        <BrowserSessionAction sessions={[]} actor="Codex" />,
      ),
    ).toBe("");

    const markup = renderToStaticMarkup(
      <BrowserSessionAction
        sessions={[
          {
            id: "8c715f8d-4528-42b1-9704-c4a323d3cc1b",
            label: "Attack slug-check · target",
            contestantId: "a",
            url: "http://127.0.0.1:5184",
            runner: "playwright",
            attempt: 1,
            startedAt: "2026-08-23T12:00:00.000Z",
          },
        ]}
        actor="Codex"
      />,
    );

    expect(markup).toContain("Open browser");
    expect(markup).toContain("Codex is using the browser");
    expect(markup).toContain("browser-session-action is-a");
    expect(markup).toContain('href="http://127.0.0.1:5184"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain("separate view from Arena&#x27;s isolated probe");
  });

  it("places the active browser action with its contestant in every arena theme", () => {
    const state = initialDashboardState();
    state.contestants.a.provider = "codex";
    state.contestants.b.provider = "claude";
    state.browserSessions.push({
      id: "8c715f8d-4528-42b1-9704-c4a323d3cc1b",
      label: "Attack slug-check · target",
      contestantId: "a",
      url: "http://127.0.0.1:5184",
      runner: "playwright",
      attempt: 1,
      startedAt: "2026-08-23T12:00:00.000Z",
    });
    const common = {
      state,
      rounds: [1 as const],
      selectedRound: "live" as const,
      contestants: state.contestants,
      attacks: state.attacks,
      stage: "Validate attacks",
      onRound: () => undefined,
      onFighter: () => undefined,
    };
    const interactive = {
      ...common,
      onSteer: () => Promise.resolve(),
      canSteer: false,
      steeringUnavailable: "Unavailable",
    };
    const markups = [
      renderToStaticMarkup(<DeveloperDashboardArena {...interactive} />),
      renderToStaticMarkup(<NightTransitArena {...interactive} />),
      renderToStaticMarkup(<TestLabArena {...interactive} />),
      renderToStaticMarkup(<BroadcastArena {...common} />),
      renderToStaticMarkup(<RetroTacticsArena {...common} />),
    ];

    for (const markup of markups) {
      expect(markup).toContain("Codex is using the browser");
      expect(markup).toContain('href="http://127.0.0.1:5184"');
      expect(markup).toContain("browser-session-action is-a");
    }
  });

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

  it("labels planned and conditional extension rounds accessibly", () => {
    const state = initialDashboardState();
    state.roundPlan = { planned: 2, maximum: 4 };
    const markup = renderToStaticMarkup(
      <CompactRoundNav
        state={state}
        rounds={[1, 2, 3, 4]}
        selected="live"
        onSelect={() => undefined}
      />,
    );

    expect(markup).toContain("Round 2 — Planned round");
    expect(markup).toContain(
      "Round 3 — Conditional extension — runs only if qualified",
    );
    expect(markup).not.toContain("R5");
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

  it("exposes the selected Developer Dashboard round to assistive technology", () => {
    const state = initialDashboardState();
    state.round = 2;
    state.status = "running";

    const markup = renderToStaticMarkup(
      <DeveloperDashboardArena
        state={state}
        rounds={[1, 2, 3]}
        selectedRound={2}
        contestants={state.contestants}
        attacks={state.attacks}
        stage="Validate attacks"
        onRound={() => undefined}
        onFighter={() => undefined}
        onSteer={() => Promise.resolve()}
        canSteer={false}
        steeringUnavailable="Unavailable"
      />,
    );

    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain("Round 2");
  });

  it("derives Tactics identities and latest routes from recorded state", () => {
    const state = initialDashboardState();
    state.contestants.a.provider = "gemini";
    state.contestants.b.provider = "opencode";
    state.contestants.a.healthChanges.push({
      sequence: 4,
      amount: 10,
      health: 100,
      reason: "Latest repair",
      round: 2,
    });
    state.contestants.b.healthChanges.push({
      sequence: 3,
      amount: 10,
      health: 100,
      reason: "Older repair",
      round: 2,
    });
    state.attacks.push({
      id: "house-check",
      phase: "resolved",
      status: "resolved",
      target: "both",
      detail: "Neutral verification completed",
      round: 2,
    });

    const markup = renderToStaticMarkup(
      <RetroTacticsArena
        state={state}
        rounds={[1, 2, 3]}
        selectedRound="live"
        contestants={state.contestants}
        attacks={state.attacks}
        stage="Validate attacks"
        onRound={() => undefined}
        onFighter={() => undefined}
      />,
    );

    expect(markup).toContain("Gemini");
    expect(markup).toContain("Opencode");
    expect(markup).toContain("route-repair route-a");
    expect(markup).not.toContain("route-latest route-a");
    expect(markup).toContain("Neutral verification completed");
  });

  it("renders Night Transit routes only for recorded lifecycles and keeps replay read-only", () => {
    const state = initialDashboardState();
    state.contestants.a.provider = "gemini";
    state.contestants.b.provider = "opencode";
    state.attacks.push({
      id: "boundary",
      round: 2,
      phase: "mounting",
      status: "mounting",
      attacker: "a",
      target: "b",
      detail: "Boundary claim",
    });
    const markup = renderToStaticMarkup(
      <NightTransitArena
        state={state}
        rounds={[1, 2, 3]}
        selectedRound={2}
        contestants={state.contestants}
        attacks={state.attacks}
        stage="Mount attacks"
        onRound={() => undefined}
        onFighter={() => undefined}
        onSteer={() => Promise.resolve()}
        canSteer={true}
        steeringUnavailable="Unavailable"
      />,
    );
    expect(markup).toContain("route-a");
    expect(markup).not.toContain("route-b");
    expect(markup).toContain("transit-track track-a");
    expect(markup).toContain("transit-track track-b");
    expect(markup).toContain("transit-route-highlight route-a");
    expect(markup).toContain("Line A");
    expect(markup).toContain("Line B");
    expect(markup).toContain("Boundary claim");
    expect(markup).toContain("Read-only recorded state");
    expect(markup).toContain("Inspect Gemini");
    expect(markup).toContain("Inspect Opencode");
    expect(markup).toContain("Recorded route totals");
    expect(markup).toContain("Attack routes");
    expect(markup).toContain("Verified");
    expect(markup).toContain("Repaired");
    expect(markup).not.toContain("One-time note for");
  });

  it("renders an intentional compact Night Transit empty state", () => {
    const state = initialDashboardState();
    const markup = renderToStaticMarkup(
      <NightTransitArena
        state={state}
        rounds={[1, 2, 3]}
        selectedRound={3}
        contestants={state.contestants}
        attacks={[]}
        stage="Review attacks"
        onRound={() => undefined}
        onFighter={() => undefined}
        onSteer={() => Promise.resolve()}
        canSteer={false}
        steeringUnavailable="Unavailable"
      />,
    );

    expect(markup).toContain("No recorded services");
    expect(markup).toContain("The network is ready");
  });

  it("renders Test Lab from invocation, check, health, and adjudication facts", () => {
    const state = initialDashboardState();
    state.contestants.a.provider = "codex";
    state.contestants.b.provider = "claude";
    state.contestants.a.invocations.push({
      id: "a-review",
      stage: "review_attacks",
      status: "succeeded",
      round: 2,
      startedAt: "2026-08-20T12:00:00.000Z",
      durationMs: 2500,
    });
    state.contestants.a.checks.push({
      id: "npm test",
      status: "passed",
      round: 2,
    });
    state.contestants.b.healthChanges.push({
      sequence: 4,
      amount: -30,
      health: 70,
      reason: "High defect",
      round: 2,
      attackId: "race",
    });
    state.attacks.push(
      {
        id: "race",
        round: 2,
        phase: "mounting",
        status: "mounting",
        attacker: "a",
        target: "b",
        detail: "Concurrent writes commit twice",
      },
      {
        id: "race",
        round: 2,
        phase: "landed",
        status: "landed",
        attacker: "a",
        target: "b",
        severity: "high",
        damage: 30,
      },
    );
    const markup = renderToStaticMarkup(
      <TestLabArena
        state={state}
        rounds={[1, 2, 3]}
        selectedRound="live"
        contestants={state.contestants}
        attacks={state.attacks}
        stage="Verify attacks"
        onRound={() => undefined}
        onFighter={() => undefined}
        onSteer={() => Promise.resolve()}
        canSteer={true}
        steeringUnavailable="Unavailable"
      />,
    );
    expect(markup).toContain("Concurrent writes commit twice");
    expect(markup).toContain("2.5s · succeeded");
    expect(markup).toContain("npm test");
    expect(markup).toContain("30 HP");
    expect(markup).toContain("Codex");
    expect(markup).toContain("Claude");
    expect(markup).toContain("Check samples");
    expect(markup).toContain("lab-invocation-a");
    expect(markup).toContain("lab-fact-claim");
    expect(markup).toContain("lab-fact-damage");
    expect(markup).toContain("lab-check-a");
    expect(markup).toContain("npm test: passed");
    expect(markup).toContain(">P</span>");
    expect(markup).toContain("100 to 70 HP; low 70 HP");
    expect(markup).toContain('points="0,4 100,12.4"');
    expect(markup).toContain("Inspect Codex");
    expect(markup).toContain("Inspect Claude");
  });

  it("renders full fighter output as one whitespace-preserving terminal stream", () => {
    const fighter = initialDashboardState().contestants.a;
    fighter.summaries.push({
      text: "Implemented the token-family repair.",
      invocationId: "a-implement",
      timestamp: "2026-08-19T12:00:02.000Z",
    });
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

    const detailMarkup = renderToStaticMarkup(
      <FullAgentOutput fighter={fighter} provider="Codex" />,
    );
    const compactMarkup = renderToStaticMarkup(
      <CompactAgentOutput fighter={fighter} provider="Codex" />,
    );

    expect(detailMarkup).toContain("  first line\nsecond line\n");
    expect(detailMarkup).toContain("warning: keep trailing space \n");
    expect(detailMarkup).toContain("output-stderr");
    expect(detailMarkup).not.toContain("Implemented the token-family repair.");
    expect(detailMarkup).not.toContain("12:00:00");
    expect(compactMarkup).toContain("Implemented the token-family repair.");
    expect(compactMarkup).not.toContain("first line");
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
