import type { DashboardContestant } from "./state.js";

export function providerActivityLabel(
  contestant: DashboardContestant,
  now = Date.now(),
): string {
  const invocation = contestant.invocations.at(-1);
  if (!invocation || invocation.status !== "running")
    return contestant.activity.replaceAll("_", " ");
  const lastAt = invocation.lastActivityAt ?? invocation.startedAt;
  const ageSeconds = Math.max(
    0,
    Math.floor((now - new Date(lastAt).getTime()) / 1000),
  );
  if (invocation.currentOpenTool)
    return `Waiting on ${invocation.currentOpenTool} · ${String(ageSeconds)}s`;
  if (ageSeconds > 30)
    return `No recent provider activity · ${String(ageSeconds)}s`;
  const latest = invocation.progress?.at(-1)?.label;
  return `Active${latest ? ` · ${latest}` : ""}`;
}
