import { stdout } from "node:process";
import { startWebDashboard } from "../../src/dashboard/web-server.js";
import { startDesktopDashboardWindow } from "../../src/dashboard/desktop-window.js";
import { ArenaBattleControl } from "../../src/observability/control.js";
import type { ArenaEventInput } from "../../src/observability/events.js";

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const controller = new AbortController();
const control = new ArenaBattleControl(controller);
const dashboard = await startWebDashboard(control);
const desktopWindow = process.argv.includes("--window")
  ? startDesktopDashboardWindow(dashboard.url, {
      onUserClose: () => void dashboard.close(),
    })
  : undefined;
const emit = async (event: ArenaEventInput, delay = 650) => {
  await dashboard.observer.publish(event);
  await pause(delay);
};

stdout.write(
  desktopWindow
    ? "Mock battle opened in an Agent Arena window.\n"
    : `Mock battle dashboard server: ${dashboard.url}\n`,
);
stdout.write("The mock will keep running until you choose Finish session.\n");

const close = () => void dashboard.close();
process.once("SIGINT", close);
process.once("SIGTERM", close);

try {
  await emit({
    type: "battle_started",
    runId: "mock-web-battle",
    task: "Fix concurrent refresh-token rotation",
    contestants: [
      { id: "a", provider: "codex", model: "gpt-5.6-sol" },
      { id: "b", provider: "claude", model: "claude-opus" },
    ],
    links: [
      {
        kind: "pull_request",
        label: "PR #241",
        url: "https://github.com/example/agent-arena/pull/241",
      },
    ],
  });
  await emit({ type: "stage_changed", stage: "implement", round: 1 });
  await emit({
    type: "invocation_started",
    invocationId: "a-build",
    source: "agent",
    contestantId: "a",
    stage: "implement",
    round: 1,
  });
  await emit({
    type: "output",
    invocationId: "a-build",
    source: "agent",
    stream: "stdout",
    contestantId: "a",
    text: "Tracing refresh-token state transitions…\n",
  });
  await emit({
    type: "invocation_started",
    invocationId: "b-build",
    source: "agent",
    contestantId: "b",
    stage: "implement",
    round: 1,
  });
  await emit({
    type: "output",
    invocationId: "b-build",
    source: "agent",
    stream: "stdout",
    contestantId: "b",
    text: "Implementing atomic token-family invalidation…\n",
  });
  await emit({
    type: "invocation_finished",
    invocationId: "a-build",
    contestantId: "a",
    status: "succeeded",
    durationMs: 4_300,
  });
  await emit({
    type: "invocation_finished",
    invocationId: "b-build",
    contestantId: "b",
    status: "succeeded",
    durationMs: 4_900,
  });
  await emit({
    type: "check_completed",
    checkId: "initial",
    status: "passed",
    contestantId: "a",
  });
  await emit({
    type: "check_completed",
    checkId: "initial",
    status: "passed",
    contestantId: "b",
  });
  await emit({ type: "stage_changed", stage: "collect_attacks", round: 2 });
  await emit({
    type: "attack_mounted",
    attackId: "logout-retry",
    round: 2,
    attackerId: "a",
    targetId: "b",
    claim: "A logout retry can revive an invalidated token family",
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
    type: "attack_revised",
    attackId: "rotation-race",
    round: 2,
    attackerId: "b",
    targetId: "a",
    explanation: "Added a deterministic scheduler across 24 interleavings",
  });
  await emit({ type: "stage_changed", stage: "validate_attacks", round: 2 });
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
  await emit(
    {
      type: "health_changed",
      contestantId: "b",
      round: 2,
      attackId: "logout-retry",
      health: 70,
      amount: -30,
      reason: "Stale session revived after logout",
    },
    1_200,
  );
  await emit({ type: "stage_changed", stage: "repair", round: 2 });
  await emit({
    type: "invocation_started",
    invocationId: "b-repair",
    source: "agent",
    contestantId: "b",
    stage: "repair",
    round: 2,
  });
  await emit({
    type: "output",
    invocationId: "b-repair",
    source: "agent",
    stream: "stdout",
    contestantId: "b",
    text: "Repairing stale-session invalidation and replaying holdouts…\n",
  });
  await emit({
    type: "invocation_finished",
    invocationId: "b-repair",
    contestantId: "b",
    status: "succeeded",
    durationMs: 3_100,
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
  await emit({ type: "stage_changed", stage: "review_attacks", round: 3 });
  await emit({
    type: "invocation_started",
    invocationId: "a-round-3-review",
    source: "agent",
    contestantId: "a",
    stage: "review_attacks",
    round: 3,
  });
  await emit({
    type: "invocation_finished",
    invocationId: "a-round-3-review",
    contestantId: "a",
    status: "succeeded",
    durationMs: 2_400,
  });
  await emit({
    type: "invocation_started",
    invocationId: "b-round-3-review",
    source: "agent",
    contestantId: "b",
    stage: "review_attacks",
    round: 3,
  });
  await emit({
    type: "invocation_finished",
    invocationId: "b-round-3-review",
    contestantId: "b",
    status: "succeeded",
    durationMs: 2_100,
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
        "Codex kept the stronger concurrency fix after adversarial replay.",
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
    0,
  );
  await dashboard.waitUntilClosed();
} finally {
  process.removeListener("SIGINT", close);
  process.removeListener("SIGTERM", close);
  await dashboard.close();
  await desktopWindow?.close();
}
