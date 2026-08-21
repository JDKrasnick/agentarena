import { stdin, stdout } from "node:process";
import { ArenaBattleControl } from "../../src/observability/control.js";
import { startDashboard } from "../../src/dashboard/app.js";
import { DashboardObserver } from "../../src/dashboard/state.js";
import type { ArenaEventInput } from "../../src/observability/events.js";

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function main(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("The dashboard demo requires an interactive terminal");
  }

  const observer = new DashboardObserver();
  const control = new ArenaBattleControl(new AbortController());
  const dashboard = startDashboard(observer, control);
  const emit = async (event: ArenaEventInput, delay = 650) => {
    observer.publish(event);
    await pause(delay);
  };

  try {
    await emit({
      type: "battle_started",
      runId: "mock-battle",
      task: "Fix concurrent refresh-token rotation",
      contestants: [
        { id: "a", provider: "codex", model: "gpt-5.6-sol" },
        { id: "b", provider: "claude", model: "claude-opus" },
      ],
      links: [
        {
          kind: "pull_request",
          label: "PR agent-arena/demo#241",
          url: "https://github.com/example/agent-arena/pull/241",
        },
        {
          kind: "artifacts",
          label: "Run artifacts",
          url: "file:///tmp/agent-arena/mock-battle",
        },
      ],
    });
    await emit({ type: "stage_changed", stage: "implement" });
    await emit({
      type: "invocation_started",
      invocationId: "a-implementation",
      source: "agent",
      contestantId: "a",
      stage: "implement",
    });
    await emit({
      type: "invocation_started",
      invocationId: "b-implementation",
      source: "agent",
      contestantId: "b",
      stage: "implement",
    });
    await emit({
      type: "output",
      invocationId: "a-implementation",
      source: "agent",
      stream: "stdout",
      contestantId: "a",
      text: "Tracing refresh-token state transitions...\n",
    });
    await emit({
      type: "output",
      invocationId: "b-implementation",
      source: "agent",
      stream: "stdout",
      contestantId: "b",
      text: "Adding an atomic token-family update...\n",
    });
    await emit({
      type: "output",
      invocationId: "a-implementation",
      source: "agent",
      stream: "stdout",
      contestantId: "a",
      text: "Implemented compare-and-swap with a regression test.\n",
    });
    await emit({
      type: "invocation_finished",
      invocationId: "a-implementation",
      contestantId: "a",
      status: "succeeded",
      durationMs: 4_300,
    });
    await emit({
      type: "invocation_finished",
      invocationId: "b-implementation",
      contestantId: "b",
      status: "succeeded",
      durationMs: 4_900,
    });
    await emit({
      type: "check_completed",
      checkId: "initial-required",
      status: "passed",
      contestantId: "a",
    });
    await emit({
      type: "check_completed",
      checkId: "initial-required",
      status: "passed",
      contestantId: "b",
    });
    await emit({ type: "stage_changed", stage: "collect_attacks", round: 2 });
    await emit({ type: "round_started", round: 2 });
    await emit({
      type: "attack_mounted",
      attackId: "logout-retry",
      round: 2,
      attackerId: "a",
      targetId: "b",
      claim: "A retry can revive an invalidated token family",
    });
    await emit({
      type: "attack_mounted",
      attackId: "rotation-race",
      round: 2,
      attackerId: "b",
      targetId: "a",
      claim: "Concurrent rotations can both commit",
    });
    await emit({
      type: "output",
      invocationId: "a-attack",
      source: "agent",
      stream: "stdout",
      contestantId: "a",
      text: "Running focused concurrency probe: 24 schedules passed.\n",
    });
    await emit({
      type: "output",
      invocationId: "b-attack",
      source: "agent",
      stream: "stderr",
      contestantId: "b",
      text: "Warning: logout retry path revives a stale session.\n",
    });
    await emit({
      type: "attack_revised",
      attackId: "rotation-race",
      round: 2,
      attackerId: "b",
      targetId: "a",
      explanation:
        "Added an isolated barrier to make the schedule deterministic",
    });
    await emit({
      type: "attack_resolved",
      attackId: "logout-retry",
      round: 2,
      status: "landed",
      attackerId: "a",
      targetId: "b",
      severity: "high",
      damage: 30,
    });
    await emit({
      type: "health_changed",
      contestantId: "b",
      round: 2,
      attackId: "logout-retry",
      health: 70,
      amount: -30,
      reason: "Logout retry defect",
    });
    await emit({ type: "stage_changed", stage: "repair", round: 2 });
    await emit({
      type: "output",
      invocationId: "b-repair",
      source: "agent",
      stream: "stdout",
      contestantId: "b",
      text: "Repairing stale-session invalidation and rerunning holdouts...\n",
    });
    await emit({
      type: "health_changed",
      contestantId: "b",
      round: 2,
      attackId: "logout-retry",
      health: 100,
      amount: 30,
      reason: "Visible and held-out cases passed",
    });
    await emit({ type: "stage_changed", stage: "complete" });
    await emit(
      {
        type: "battle_completed",
        status: "complete",
        roundsCompleted: 3,
        championId: "a",
        recommendedId: "a",
        recommendationReason:
          "Fighter A kept the stronger concurrency fix after adversarial replay.",
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
      },
      4_000,
    );
  } finally {
    dashboard.unmount();
  }

  stdout.write(
    "\nMock battle complete. Interactive fights use this terminal view by default.\n",
  );
}

await main();
