import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { Dashboard } from "../../src/dashboard/app.js";
import { DashboardObserver } from "../../src/dashboard/state.js";
import { ArenaBattleControl } from "../../src/observability/control.js";

const update = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("terminal dashboard", () => {
  it("renders a pre-review forfeit without competitive victory language", async () => {
    const observer = new DashboardObserver();
    observer.publish({
      type: "battle_started",
      runId: "forfeit-run",
      task: "Fix it",
      contestants: [
        { id: "a", provider: "codex" },
        { id: "b", provider: "claude" },
      ],
    });
    observer.publish({
      type: "battle_completed",
      status: "complete",
      roundsCompleted: 0,
      recommendedId: "b",
      terminalOutcome: {
        kind: "forfeit",
        reasonCode: "implementation_empty_patch",
        affectedContestantIds: ["a"],
        eligibleContestantIds: ["b"],
        reason: "Only Fighter B passed initial validation.",
        artifactPaths: [],
      },
      contestants: [
        {
          id: "a",
          health: 0,
          status: "failed",
          checksPassed: 0,
          checksTotal: 1,
        },
        {
          id: "b",
          health: 100,
          status: "survived",
          checksPassed: 1,
          checksTotal: 1,
        },
      ],
    });
    const view = render(<Dashboard observer={observer} />);
    await update();

    expect(view.lastFrame()).toContain("PRE-REVIEW FORFEIT");
    expect(view.lastFrame()).toContain(
      "Fighter B is recommended after a pre-review forfeit.",
    );
    expect(view.lastFrame()).toContain("Not contested — no attack rounds ran.");
    expect(view.lastFrame()).not.toContain("PATCH HARDENED");
    view.unmount();
  });

  it("renders overview updates and navigates to filtered agent output", async () => {
    const observer = new DashboardObserver();
    const control = new ArenaBattleControl(new AbortController());
    observer.publish({
      type: "battle_started",
      runId: "run",
      task: "Fix it",
      contestants: [
        { id: "a", provider: "codex" },
        { id: "b", provider: "claude" },
      ],
      links: [
        {
          kind: "pull_request",
          label: "PR owner/repo#42",
          url: "https://github.com/owner/repo/pull/42",
        },
      ],
    });
    observer.publish({
      type: "output",
      invocationId: "a-1",
      source: "agent",
      stream: "stdout",
      text: "live output",
      contestantId: "a",
    });
    const view = render(<Dashboard observer={observer} control={control} />);
    expect(view.lastFrame()).toContain("Fix it");
    expect(view.lastFrame()).toContain("FIGHTER A");
    expect(view.lastFrame()).toContain("CODEX");
    expect(view.lastFrame()).toContain("CLAUDE");
    expect(view.lastFrame()).toContain("✦ CLAUDE");
    expect(view.lastFrame()).toContain("◆ CODEX");
    expect(view.lastFrame()).not.toContain("▄");
    expect(view.lastFrame()).toContain("100/100");
    expect(view.lastFrame()).toContain("VS");
    expect(view.lastFrame()).toContain("↳ live output");
    expect(view.lastFrame()).toContain("PR owner/repo#42");
    expect(view.lastFrame()).toContain("SETUP │ Preflight");
    expect(view.lastFrame()).toContain(
      "Objective: Checking the repository, agents, and battle contract",
    );

    observer.publish({
      type: "effort_resolved",
      tier: "medium",
      plannedRounds: 3,
      maxRounds: 3,
    });
    observer.publish({
      type: "stage_changed",
      stage: "collect_attacks",
      round: 2,
    });

    observer.publish({
      type: "attack_mounted",
      attackId: "retry-race",
      round: 2,
      attackerId: "a",
      targetId: "b",
      claim: "Retry revives a stale session",
    });
    observer.publish({
      type: "attack_revised",
      attackId: "retry-race",
      round: 2,
      attackerId: "a",
      targetId: "b",
      explanation: "Added deterministic scheduling",
    });
    observer.publish({
      type: "attack_resolved",
      attackId: "retry-race",
      round: 2,
      status: "landed",
      attackerId: "a",
      targetId: "b",
      severity: "high",
      damage: 30,
    });
    observer.publish({
      type: "health_changed",
      contestantId: "b",
      round: 2,
      attackId: "retry-race",
      health: 70,
      amount: -30,
      reason: "Retry race landed",
    });
    await update();
    expect(view.lastFrame()).toContain("ROUND 2/3 · 3 planned │ Mount attacks");
    expect(view.lastFrame()).toContain(
      "Round flow: scout → [mount] → verify → damage → repair",
    );
    expect(view.lastFrame()).toContain("mounting 1 · landed 1 · revisions 1");
    expect(view.lastFrame()).toContain("A used retry-race! B took 30 HP.");
    await vi.waitFor(() => expect(view.lastFrame()).toMatch(/[╳◆✦] -30 HP/u));

    view.stdin.write("1");
    await update();
    expect(view.lastFrame()).toContain("Contestant A output");
    expect(view.lastFrame()).toContain("live output");
    view.stdin.write("t");
    await update();
    expect(view.lastFrame()).toContain("stdout · following");
    observer.publish({ type: "stage_changed", stage: "complete" });
    await update();
    expect(view.lastFrame()).toContain("RESULT │ Complete");
    observer.publish({
      type: "health_changed",
      contestantId: "b",
      round: 2,
      attackId: "retry-race",
      health: 100,
      amount: 30,
      reason: "Replay passed after repair",
    });
    observer.publish({
      type: "battle_completed",
      status: "complete",
      roundsCompleted: 3,
      championId: "a",
      recommendedId: "a",
      recommendationReason: "Stronger after adversarial replay.",
      contestants: [
        {
          id: "a",
          health: 100,
          status: "survived",
          checksPassed: 4,
          checksTotal: 4,
        },
        {
          id: "b",
          health: 100,
          status: "survived",
          checksPassed: 4,
          checksTotal: 4,
        },
      ],
    });
    await update();
    expect(observer.snapshot().stage).toBe("complete");
    expect(observer.snapshot().contestants.a.authoritativeCheckCounts).toEqual({
      passed: 4,
      total: 4,
    });
    expect(view.lastFrame()).toContain("★ BATTLE COMPLETE · PATCH HARDENED");
    expect(view.lastFrame()).toContain("1 verified defect caught");
    expect(view.lastFrame()).toContain("DEFECTS CAUGHT BEFORE SHIP");
    expect(view.lastFrame()).toContain("Retry revives a stale session");
    expect(view.lastFrame()).toContain("IMPROVEMENTS VERIFIED");
    expect(view.lastFrame()).toContain(
      "+30 HP in R2 · Replay passed after repair",
    );
    expect(view.lastFrame()).toContain("agent-arena review run");
    view.unmount();
  });

  it("captures a steering note for the selected contestant", async () => {
    const observer = new DashboardObserver();
    const control = new ArenaBattleControl(new AbortController());
    const view = render(<Dashboard observer={observer} control={control} />);
    view.stdin.write("2");
    await update();
    view.stdin.write("n");
    await update();
    view.stdin.write("focus on cleanup");
    await update();
    view.stdin.write("\r");
    await update();
    expect(control.all()).toEqual([
      expect.objectContaining({
        contestantId: "b",
        note: "focus on cleanup",
        status: "queued",
      }),
    ]);
    view.unmount();
  });

  it("routes Ctrl-C through battle cancellation", async () => {
    const observer = new DashboardObserver();
    const controller = new AbortController();
    const control = new ArenaBattleControl(controller);
    const view = render(<Dashboard observer={observer} control={control} />);

    view.stdin.write("\u0003");
    await update();

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toEqual(new Error("Interrupted"));
    view.unmount();
  });
});
