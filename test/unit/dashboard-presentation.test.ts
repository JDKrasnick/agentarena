import { describe, expect, it } from "vitest";
import {
  initialDashboardState,
  projectEvent,
} from "../../src/dashboard/state.js";
import {
  attackDisplayLabel,
  createArenaPresentation,
  invocationStatusSentence,
  isRoundAvailable,
  projectAttackLifecycles,
  recordedRoundMoveCount,
  steeringUnavailableMessage,
} from "../../src/web/client/presentation.js";

describe("dashboard presentation model", () => {
  it("projects identical authoritative facts into live and recorded views", () => {
    const state = initialDashboardState();
    projectEvent(state, {
      version: 1,
      sequence: 1,
      timestamp: "2026-08-19T12:00:00.000Z",
      type: "battle_started",
      runId: "run",
      task: "Fix the race",
      contestants: [
        { id: "a", provider: "codex" },
        { id: "b", provider: "claude" },
      ],
      links: [],
    });
    projectEvent(state, {
      version: 1,
      sequence: 2,
      timestamp: "2026-08-19T12:01:00.000Z",
      type: "stage_changed",
      stage: "collect_attacks",
      round: 2,
    });
    projectEvent(state, {
      version: 1,
      sequence: 3,
      timestamp: "2026-08-19T12:02:00.000Z",
      type: "attack_mounted",
      attackId: "race",
      round: 2,
      attackerId: "a",
      targetId: "b",
      claim: "Concurrent writes can commit",
    });

    const live = createArenaPresentation(state, "live", true);
    const replay = createArenaPresentation(state, 2, true);
    expect(live.stage).toBe("Mount attacks");
    expect(live.attacks).toEqual(replay.attacks);
    expect(live.counts.mounting).toBe(1);
    expect(live.canSteer).toBe(true);
    expect(replay.rounds).toEqual([1, 2, 3, 4, 5]);
  });

  it("shows only possible rounds and separates planned work from extensions", () => {
    const state = initialDashboardState();
    state.roundPlan = { planned: 2, maximum: 4 };
    state.attacks.push({
      id: "impossible-round",
      round: 5,
      phase: "mounting",
      status: "mounting",
    });

    const presentation = createArenaPresentation(state, "live", true);
    expect(presentation.rounds).toEqual([1, 2, 3, 4]);
    expect(presentation.rounds).not.toContain(5);
  });

  it("never permits steering without a live running connection", () => {
    const state = initialDashboardState();
    expect(createArenaPresentation(state, "live", false).canSteer).toBe(false);
    state.status = "complete";
    expect(createArenaPresentation(state, "live", true).canSteer).toBe(false);
  });

  it("falls back to the authoritative attack ID when detail is absent", () => {
    expect(
      attackDisplayLabel({
        id: "logout-retry",
        phase: "landed",
        status: "landed",
        damage: 30,
      }),
    ).toBe("logout-retry");
    expect(
      attackDisplayLabel({
        id: "logout-retry",
        phase: "landed",
        status: "landed",
        detail: "  Stale sessions survive logout  ",
      }),
    ).toBe("Stale sessions survive logout");
    expect(attackDisplayLabel(undefined)).toBeUndefined();
  });

  it("describes reconnecting separately from a stopped battle", () => {
    expect(steeringUnavailableMessage(false, "running")).toBe(
      "Steering is unavailable while reconnecting.",
    );
    expect(steeringUnavailableMessage(true, "complete")).toBe(
      "Steering is unavailable while the battle is not running.",
    );
  });

  it("makes invocation-only recorded rounds available during a later live round", () => {
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

    expect(recordedRoundMoveCount(state, 1)).toBe(1);
    expect(isRoundAvailable(state, 1)).toBe(true);
    expect(isRoundAvailable(state, 3)).toBe(false);
  });

  it("formats invocation statuses as grammatical sentences", () => {
    expect(invocationStatusSentence("b-repair", "succeeded")).toBe(
      "Invocation b-repair succeeded.",
    );
    expect(invocationStatusSentence("b-repair", "running")).toBe(
      "Invocation b-repair is running.",
    );
  });

  it("keeps compact summaries separate from the full transcript", () => {
    const state = initialDashboardState();
    const timestamp = "2026-08-19T12:00:00.000Z";
    projectEvent(state, {
      version: 1,
      sequence: 1,
      timestamp,
      type: "invocation_started",
      invocationId: "a-implement",
      source: "agent",
      contestantId: "a",
      stage: "implement",
      round: 1,
    });
    projectEvent(state, {
      version: 1,
      sequence: 2,
      timestamp,
      type: "output",
      invocationId: "a-implement",
      source: "agent",
      stream: "stdout",
      text: "$ npm test\n✓ 253 tests passed\n",
      contestantId: "a",
    });
    projectEvent(state, {
      version: 1,
      sequence: 3,
      timestamp,
      type: "invocation_finished",
      invocationId: "a-implement",
      contestantId: "a",
      status: "succeeded",
      durationMs: 2_000,
      summary: "Implemented atomic token-family invalidation.",
    });

    const fighter = createArenaPresentation(state, "live", true).contestants.a;
    expect(fighter.summaries.map((entry) => entry.text)).toEqual([
      "Implemented atomic token-family invalidation.",
    ]);
    expect(fighter.output.map((entry) => entry.text)).toEqual([
      "$ npm test\n✓ 253 tests passed\n",
    ]);
  });

  it("consolidates attack revision, resolution, and repair without changing source state", () => {
    const state = initialDashboardState();
    state.attacks.push(
      {
        id: "race",
        round: 2,
        phase: "mounting",
        status: "mounting",
        attacker: "a",
        target: "b",
        detail: "Original concurrency claim",
      },
      {
        id: "race",
        round: 2,
        phase: "revised",
        status: "revised",
        attacker: "a",
        target: "b",
        detail: "Narrowed to duplicate commit",
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
    state.contestants.b.healthChanges.push({
      sequence: 7,
      amount: 30,
      health: 100,
      reason: "Repair verified",
      round: 2,
      attackId: "race",
    });

    expect(projectAttackLifecycles(state)).toEqual([
      expect.objectContaining({
        id: "race",
        phase: "landed",
        originalClaim: "Original concurrency claim",
        latestDetail: "Narrowed to duplicate commit",
        attacker: "a",
        target: "b",
        severity: "high",
        damage: 30,
        repairedBy: "b",
        repairAmount: 30,
      }),
    ]);
    expect(state.attacks).toHaveLength(3);
  });

  it("orders lifecycles by their latest recorded attack event", () => {
    const state = initialDashboardState();
    state.attacks.push(
      {
        id: "first",
        phase: "mounting",
        status: "mounting",
        detail: "First claim",
      },
      {
        id: "second",
        phase: "mounting",
        status: "mounting",
        detail: "Second claim",
      },
      {
        id: "first",
        phase: "landed",
        status: "landed",
        damage: 10,
      },
    );

    expect(projectAttackLifecycles(state).map((attack) => attack.id)).toEqual([
      "second",
      "first",
    ]);
  });
});
