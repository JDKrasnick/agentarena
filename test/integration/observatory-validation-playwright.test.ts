import { access } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import {
  startWebDashboard,
  type WebDashboard,
} from "../../src/dashboard/web-server.js";
import { ArenaBattleControl } from "../../src/observability/control.js";

const chromiumCandidates = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter((value): value is string => Boolean(value));

async function chromiumExecutable(): Promise<string> {
  for (const candidate of chromiumCandidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep checking the same allowlist as the built-in adapter.
    }
  }
  throw new Error("Chrome or Chromium is required for the real browser test");
}

describe.runIf(process.env.ARENA_REAL_BROWSER === "1")(
  "observatory validation evidence",
  () => {
    let browser: Browser | undefined;
    let dashboard: WebDashboard | undefined;

    afterEach(async () => {
      await browser?.close();
      await dashboard?.close();
    });

    it("shows timeout and retry evidence in the terminal results screen", async () => {
      dashboard = await startWebDashboard(
        new ArenaBattleControl(new AbortController()),
      );
      await dashboard.observer.publish({
        type: "battle_started",
        runId: "validation-evidence-fixture",
        task: "Preserve required validation termination evidence",
        contestants: [
          { id: "a", provider: "codex" },
          { id: "b", provider: "claude" },
        ],
        links: [],
      });
      await dashboard.observer.publish({
        type: "battle_completed",
        status: "inconclusive",
        terminalOutcome: {
          kind: "inconclusive",
          reasonCode: "initial_validation_unstable",
          affectedContestantIds: ["a"],
          eligibleContestantIds: [],
          reason: "Required validation attempts disagreed.",
          artifactPaths: [],
          contestants: [
            {
              contestantId: "a",
              eligible: false,
              reasonCode: "initial_validation_unstable",
              artifactPaths: [],
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
                    stdoutPath: "/tmp/attempt-1.stdout.log",
                    stderrPath: "/tmp/attempt-1.stderr.log",
                    failureExcerpt:
                      "168 runtime tests passed; waiting for teardown",
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
                    stdoutPath: "/tmp/attempt-2.stdout.log",
                    stderrPath: "/tmp/attempt-2.stderr.log",
                  },
                ],
              },
            },
          ],
        },
        contestants: [
          {
            id: "a",
            health: 100,
            status: "failed",
            checksPassed: 0,
            checksTotal: 1,
          },
          {
            id: "b",
            health: 100,
            status: "pending",
            checksPassed: 0,
            checksTotal: 0,
          },
        ],
      });

      browser = await chromium.launch({
        executablePath: await chromiumExecutable(),
        headless: true,
      });
      const page = await browser.newPage();
      await page.goto(dashboard.url);

      await expect
        .poll(() =>
          page
            .getByRole("heading", {
              name: "Eligibility and validation evidence",
            })
            .count(),
        )
        .toBe(1);
      expect(await page.getByText("Attempt 1 · timeout").count()).toBe(1);
      expect(await page.getByText("Attempt 2 · exit").count()).toBe(1);
      await page.getByText("Failure excerpt").click();
      expect(
        await page
          .getByText("168 runtime tests passed; waiting for teardown")
          .count(),
      ).toBe(1);
    });

    it("shows eligibility evidence when validation passes and the fight completes", async () => {
      dashboard = await startWebDashboard(
        new ArenaBattleControl(new AbortController()),
      );
      await dashboard.observer.publish({
        type: "battle_started",
        runId: "successful-validation-evidence-fixture",
        task: "Preserve successful required validation evidence",
        contestants: [
          { id: "a", provider: "codex" },
          { id: "b", provider: "claude" },
        ],
        links: [],
      });
      await dashboard.observer.publish({
        type: "battle_completed",
        status: "complete",
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
        contestants: [
          {
            id: "a",
            health: 100,
            status: "survived",
            checksPassed: 1,
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

      browser = await chromium.launch({
        executablePath: await chromiumExecutable(),
        headless: true,
      });
      const page = await browser.newPage();
      await page.goto(dashboard.url);

      await expect
        .poll(() => page.getByText("Fighter A · eligible").count())
        .toBe(1);
      expect(await page.getByText("Attempt 1 · exit").count()).toBe(1);
      expect(await page.getByText("passed", { exact: true }).count()).toBe(1);
    });
  },
);
