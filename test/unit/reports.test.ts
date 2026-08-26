import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Attack, RunState } from "../../src/core/types.js";
import { healDefect } from "../../src/core/scoring.js";
import { renderConsoleSummary } from "../../src/reports/console.js";
import { renderBattleHtml } from "../../src/reports/html.js";
import { renderBattleReport } from "../../src/reports/markdown.js";
import { renderBattleVisual } from "../../src/reports/visual.js";
import {
  reportCheckStatus,
  reportDefects,
  resolveArtifactHref,
} from "../../src/reports/presentation.js";
import { makeRunState } from "../helpers/run-state.js";

function attack(state: RunState, overrides: Partial<Attack> = {}): Attack {
  return {
    id: "attack-1",
    round: 1,
    origin: { kind: "contestant", contestant: "a", provider: "codex" },
    rank: 1,
    targets: ["b"],
    claim: "Logout leaves the token valid",
    impact: "A revoked session can still authenticate",
    oracle: {
      expectedBehavior: "Logout revokes the token",
      sourceId: "task",
      sourceLocation: "criterion 1",
      rationale: "The task requires revocation",
    },
    assertionFingerprint: "logout-token",
    requiredCapabilities: [],
    patchPath: `${state.artifacts.runDirectory}/attacks/logout.diff`,
    focusedCommand: "npm test -- logout",
    status: "landed",
    severity: "high",
    damage: 30,
    damageActive: true,
    rootDefectId: "logout-defect",
    outcomeReason: "Expected 401, received 200",
    checks: [],
    ...overrides,
  };
}

describe("battle reports", () => {
  it("renders contestant-scoped validation and handoff sections", () => {
    const state = makeRunState();
    const codex = state.contestants.a;
    const claude = state.contestants.b;
    if (!codex || !claude) throw new Error("Fixture contestants are missing");
    codex.checks = [
      {
        id: "final-required",
        kind: "required",
        status: "passed",
        command: {
          command: "npm test",
          cwd: "/tmp/repository",
          exitCode: 0,
          signal: null,
          timedOut: false,
          attempts: 1,
          durationMs: 1200,
          stdoutPath: "/tmp/run/logs/a.out",
          stderrPath: "/tmp/run/logs/a.err",
        },
      },
    ];
    claude.checks = [
      {
        id: "final-required",
        kind: "required",
        status: "failed",
        reason: "logout token remains valid",
      },
    ];

    const report = renderBattleReport(state);

    expect(report).toContain("## Verified test coverage — final patches");
    expect(report).toContain(
      "| Check / exact command | Scope | Codex | Claude |",
    );
    expect(report).toContain("PASS · 1.2s [stdout](./logs/a.out)");
    expect(report).toContain("FAIL");
    expect(report).toContain("## Round digest");
    expect(report).toContain("## Handoff");
    expect(report).toContain("### Already done");
    expect(report).toContain("### Still needed");
  });

  it("projects initial and round required checks into their causal sections", () => {
    const state = makeRunState();
    for (const contestant of Object.values(state.contestants)) {
      contestant.initialPatchPath = `${state.artifacts.runDirectory}/patches/${contestant.id}-initial.diff`;
      contestant.checks = [
        { id: "initial-required", kind: "required", status: "passed" },
        ...([1, 2, 3] as const).map((round) => ({
          id: `round-${String(round)}-required`,
          kind: "required" as const,
          status: "passed" as const,
        })),
        { id: "final-required", kind: "required", status: "passed" },
      ];
    }

    const report = renderBattleReport(state);

    expect(report).toContain(
      "| Codex | not run | [initial patch](./patches/a-initial.diff) | PASS |",
    );
    expect(report).toContain("- Codex — round-1-required: PASS.");
    expect(report).toContain("- Claude — round-3-required: PASS.");
    expect(report).not.toContain("No round-scoped check result was recorded.");
  });

  it("keeps the terminal verdict tied to validation and unresolved defects", () => {
    const summary = renderConsoleSummary(
      makeRunState({ claudeDamage: 30, claudeHealth: 65 }),
    );

    expect(summary).toContain("evidence-backed final result");
    expect(summary).toContain("Required suite");
    expect(summary).toContain("Still needed:");
  });

  it("renders a self-contained SVG visual from the same run data", () => {
    const visual = renderBattleVisual(makeRunState());

    expect(visual).toContain("<svg");
    expect(visual).toContain("EVIDENCE-LINKED BATTLE REPLAY");
    expect(visual).toContain("ROUND DIGEST");
  });

  it("renders a clickable HTML dossier with scoring, checks, and attack evidence", () => {
    const html = renderBattleHtml(makeRunState());

    expect(html).toContain("EVIDENCE-LINKED BATTLE DOSSIER");
    expect(html).toContain("Verified test coverage");
    expect(html).toContain("Attack ledger — bugs found, misses, and repairs");
    expect(html).toContain("Health starts at 100");
    expect(html).toContain("tie between equally validated patches");
    expect(html).not.toContain("equal-correctness");
    expect(html).toContain('href="./BATTLE.md"');
  });

  it("surfaces durable browser attack artifacts in every report", () => {
    const state = makeRunState();
    const resultManifest = `${state.artifacts.runDirectory}/browser/attacks/attack-1/target-1-result.json`;
    const screenshot = `${state.artifacts.runDirectory}/browser/attacks/attack-1/target.png`;
    state.attacks = [
      attack(state, {
        evidenceKind: "browser_probe",
        browserArtifactRefs: [resultManifest, screenshot],
      }),
    ];

    expect(renderConsoleSummary(state)).toContain(resultManifest);
    expect(renderBattleReport(state)).toContain(
      "[browser artifact 1](./browser/attacks/attack-1/target-1-result.json)",
    );
    expect(renderBattleHtml(state)).toContain(
      'href="./browser/attacks/attack-1/target.png"',
    );
  });

  it("uses the latest required check and preserves every non-pass state", () => {
    const state = makeRunState();
    const codex = state.contestants.a;
    if (!codex) throw new Error("Fixture contestant is missing");
    codex.checks = [
      { id: "required-before", kind: "required", status: "passed" },
      { id: "required-final", kind: "required", status: "failed" },
    ];

    expect(renderBattleHtml(state)).toContain("Review failures");
    expect(renderBattleHtml(state)).not.toContain("Both pass");
    expect([
      reportCheckStatus({ id: "pass", kind: "required", status: "passed" }),
      reportCheckStatus({ id: "fail", kind: "required", status: "failed" }),
      reportCheckStatus({
        id: "infra",
        kind: "required",
        status: "infrastructure_error",
      }),
      reportCheckStatus({ id: "skip", kind: "required", status: "skipped" }),
      reportCheckStatus(),
    ]).toMatchInlineSnapshot(`
      [
        "PASS",
        "FAIL",
        "INFRA",
        "SKIPPED",
        "NOT RUN",
      ]
    `);
  });

  it("deduplicates root defects, derives repair state, and escapes content", () => {
    const state = makeRunState();
    state.attacks = [
      attack(state, { claim: "<script>alert('x')</script>" }),
      attack(state, { id: "attack-2", round: 2 }),
    ];
    const target = state.contestants.b;
    if (!target) throw new Error("Fixture target is missing");
    target.healthLedger.activeDefects = [
      { rootDefectId: "logout-defect", attackId: "attack-1", damage: 30 },
    ];
    expect(reportDefects(state)).toMatchObject([{ active: true }]);
    state.contestants.b = healDefect(target, "logout-defect", 2);

    expect(reportDefects(state)).toHaveLength(1);
    expect(reportDefects(state)).toMatchObject([{ active: false }]);
    const html = renderBattleHtml(state);
    expect(html).toContain("1 (0 unresolved, 1 repaired)");
    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(renderBattleVisual(state)).not.toContain("<script>alert");
  });

  it("renders an incomplete outcome without inventing a draw or winner", () => {
    const state = makeRunState();
    state.status = "inconclusive";
    state.stage = "inconclusive";
    state.ranking = undefined;
    state.arenaOutcome = undefined;

    const html = renderBattleHtml(state);
    const visual = renderBattleVisual(state);

    expect(html).toContain("<h1>Battle incomplete</h1>");
    expect(html).toContain("Why the battle is incomplete");
    expect(html).not.toContain("Draw result");
    expect(visual).toContain("Result: INCOMPLETE · run incomplete");
    expect(visual).not.toContain("Winner:");
  });

  it("renders implementation, round phases, failures, and review in causal order", () => {
    const state = makeRunState();
    state.attacks = [
      attack(state, {
        status: "infrastructure_error",
        damage: undefined,
        damageActive: undefined,
      }),
    ];
    const report = renderBattleReport(state);
    const headings = [
      "## Implementation and baseline",
      "## Round 1",
      "### Attack submissions",
      "### Adjudication",
      "### Repair",
      "### Validation",
      "### Health ledger",
      "## Failure handling ledger",
    ].map((heading) => report.indexOf(heading));
    expect(headings.every((index) => index >= 0)).toBe(true);
    expect(headings).toEqual([...headings].sort((left, right) => left - right));
  });

  it("renders draw, elimination, no-attack, recovery, and siege language", () => {
    const draw = makeRunState();
    draw.ranking = {
      winner: null,
      draw: true,
      order: ["a", "b"],
      reason: "equal evidence",
    };
    expect(renderConsoleSummary(draw)).toContain("Draw: equal evidence");
    expect(renderBattleHtml(draw)).toContain("Draw result");

    const eliminated = makeRunState();
    const contestant = eliminated.contestants.b;
    if (!contestant) throw new Error("Fixture contestant is missing");
    contestant.status = "eliminated";
    contestant.finalHealth = 0;
    contestant.healthLedger.eliminatedByRequiredCheck = true;
    expect(renderConsoleSummary(eliminated)).toContain("  0 HP");

    const siege = makeRunState();
    siege.config.mode = "siege";
    expect(renderConsoleSummary(siege)).toContain("defender final patch only");
    expect(renderBattleReport(siege)).toContain("## Defender artifact");

    const catchUp = makeRunState();
    catchUp.config.mode = "catch_up";
    expect(renderConsoleSummary(catchUp)).toContain("Mode: catch_up");

    expect(renderBattleHtml(makeRunState())).toContain(
      "Recommended patch</dt><dd>Claude",
    );

    const recovery = makeRunState();
    recovery.attacks = [
      attack(recovery, { id: "recovery-1", round: "recovery" }),
    ];
    expect(renderBattleReport(recovery)).toContain("## Recovery round");
    expect(renderBattleHtml(recovery)).toContain("Recovery round");
  });

  it("links only recorded artifacts contained by the run directory", async () => {
    const runDirectory = await mkdtemp(path.join(os.tmpdir(), "arena-report-"));
    await mkdir(path.join(runDirectory, "logs"));
    await mkdir(path.join(runDirectory, "patches"));
    const reportPath = path.join(runDirectory, "BATTLE.md");
    const state = makeRunState({ runDirectory });
    state.artifacts.battle = reportPath;
    await Promise.all([
      writeFile(reportPath, "report", "utf8"),
      writeFile(state.artifacts.result ?? "", "{}", "utf8"),
      writeFile(state.artifacts.battleVisual ?? "", "<svg/>", "utf8"),
      ...Object.values(state.contestants).flatMap((contestant) =>
        contestant.finalPatchPath
          ? [writeFile(contestant.finalPatchPath, "patch", "utf8")]
          : [],
      ),
    ]);

    expect(resolveArtifactHref(state, reportPath)).toBe("./BATTLE.md");
    expect(
      resolveArtifactHref(state, path.join(runDirectory, "not-recorded.txt")),
    ).toBeUndefined();
    expect(
      resolveArtifactHref(state, path.join(runDirectory, "..", "outside.txt")),
    ).toBeUndefined();
    const hrefs = [
      ...renderBattleHtml(state).matchAll(/href="\.\/([^"#]+)"/gu),
    ].map((match) => match[1]);
    await expect(
      Promise.all(
        hrefs.map((href) => access(path.join(runDirectory, href ?? ""))),
      ),
    ).resolves.toBeDefined();
  });
});
