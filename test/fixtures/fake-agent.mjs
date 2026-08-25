import { readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-agent 1.0.0\n");
  process.exit(0);
}

const prompt = await new Promise((resolve) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    value += chunk;
  });
  process.stdin.on("end", () => resolve(value));
});

const agent = process.env.AGENT_ARENA_AGENT;
const contestant = process.env.AGENT_ARENA_CONTESTANT;
const stage = process.env.AGENT_ARENA_STAGE;
const round = process.env.AGENT_ARENA_ROUND;
const submission = process.env.AGENT_ARENA_SUBMISSION;
if (!agent || !stage || !submission)
  throw new Error("Missing Agent Arena environment");

const sourcePath = path.join(process.cwd(), "src", "slug.mjs");

if (stage === "provider_health_probe") {
  const sentinel = "AGENT_ARENA_PROVIDER_HEALTH_OK";
  process.stdout.write(
    agent === "codex"
      ? `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: sentinel } })}\n`
      : agent === "claude"
        ? `${JSON.stringify({ type: "result", result: sentinel })}\n`
        : `${JSON.stringify({ type: "message", role: "assistant", content: sentinel })}\n`,
  );
} else if (stage === "implement") {
  if (process.env.AGENT_ARENA_EMPTY_IMPLEMENTATION === "1") {
    await writeFile(
      submission,
      JSON.stringify({ version: 1, explanation: "intentionally empty" }),
    );
    process.exit(0);
  }
  const implementation =
    (contestant ?? agent) === "a"
      ? `export function slug(value) {\n  return value.trim().toLowerCase().replace(/\\s+/g, "-");\n}\n`
      : `export function slug(value) {\n  return value.trim().toLowerCase().replaceAll(" ", "-");\n}\n`;
  await writeFile(sourcePath, implementation);
  await writeFile(
    submission,
    JSON.stringify({ version: 1, explanation: `${agent} implementation` }),
  );
} else if (stage === "house") {
  if (round !== "2" || !prompt.includes("Candidate 2")) {
    await writeFile(
      submission,
      JSON.stringify({ version: 1, hypotheses: [], attacks: [] }),
    );
  } else {
    const testPath = "test/arena-blank-title.test.mjs";
    await writeFile(
      path.join(process.cwd(), testPath),
      `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slug } from "../src/slug.mjs";\ntest("rejects blank titles", () => assert.throws(() => slug("   "), /blank/i));\n`,
    );
    await writeFile(
      submission,
      JSON.stringify({
        version: 1,
        hypotheses: [
          {
            category: "inputs_errors",
            invariant: "Blank titles are rejected",
            probe: "Use a whitespace-only title",
            requiredCapabilities: [],
            confidence: 95,
          },
        ],
        attacks: [
          {
            claim: "Blank titles are accepted as empty slugs",
            impact: "The service can create unusable empty identifiers",
            oracle: {
              expectedBehavior: "Reject blank titles",
              sourceId: "task-user",
              sourceLocation: "command-line task",
              rationale: "The task explicitly requires blank rejection",
            },
            proposedSeverity: "medium",
            confidence: 95,
            reproduction:
              "Call slug with a whitespace-only title and expect an explicit rejection.",
            focusedCommand: "node --test test/arena-blank-title.test.mjs",
            requiredCapabilities: [],
            paths: [testPath],
          },
        ],
      }),
    );
  }
} else if (stage === "harness_maintainer") {
  await writeFile(
    submission,
    JSON.stringify({
      version: 1,
      explanation:
        "Add symmetric redacted diagnostics for the verifier boundary.",
      scopes: ["diagnostic"],
      permissionChanges: [],
    }),
  );
} else if (stage === "infrastructure_review") {
  await writeFile(
    submission,
    JSON.stringify({
      version: 1,
      decision: "accept",
      explanation: "Control evidence shows a verifier-owned outage.",
    }),
  );
} else if (stage === "case_builder") {
  if (
    prompt.includes("# Neutral case judge") &&
    prompt.includes("Repeated whitespace is not collapsed")
  ) {
    const testPath = "test/arena-repeated-whitespace.test.mjs";
    await writeFile(
      path.join(process.cwd(), testPath),
      `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slug } from "../src/slug.mjs";\ntest("collapses repeated whitespace", () => assert.equal(slug("Alpha   Beta"), "alpha-beta"));\n`,
    );
    await writeFile(
      submission,
      JSON.stringify({
        version: 1,
        cases: [
          {
            category: "repeated_whitespace",
            focusedCommand:
              "node --test test/arena-repeated-whitespace.test.mjs",
            paths: [testPath],
          },
        ],
      }),
    );
  } else if (prompt.includes("Repeated whitespace is not collapsed")) {
    const testPath = "test/arena-tab-whitespace.test.mjs";
    await writeFile(
      path.join(process.cwd(), testPath),
      `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slug } from "../src/slug.mjs";\ntest("collapses tab whitespace", () => assert.equal(slug("Alpha\\tBeta"), "alpha-beta"));\n`,
    );
    await writeFile(
      submission,
      JSON.stringify({
        version: 1,
        cases: [
          {
            category: "alternate_whitespace",
            focusedCommand: "node --test test/arena-tab-whitespace.test.mjs",
            paths: [testPath],
          },
        ],
      }),
    );
  } else if (prompt.includes("Uppercase input is not normalized")) {
    const testPath = "test/arena-uppercase.test.mjs";
    await writeFile(
      path.join(process.cwd(), testPath),
      `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slug } from "../src/slug.mjs";\ntest("normalizes case", () => assert.equal(slug("Alpha Beta"), "alpha-beta"));\n`,
    );
    await writeFile(
      submission,
      JSON.stringify({
        version: 1,
        cases: [
          {
            category: "case_normalization",
            focusedCommand: "node --test test/arena-uppercase.test.mjs",
            paths: [testPath],
          },
        ],
      }),
    );
  } else {
    const testPath = "test/arena-case-judge.test.mjs";
    await writeFile(
      path.join(process.cwd(), testPath),
      `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slug } from "../src/slug.mjs";\ntest("case judge preserves slug contract", () => assert.equal(slug("Alpha Beta"), "alpha-beta"));\n`,
    );
    await writeFile(
      submission,
      JSON.stringify({
        version: 1,
        cases: [
          {
            category: "contract_case",
            focusedCommand: "node --test test/arena-case-judge.test.mjs",
            paths: [testPath],
          },
        ],
      }),
    );
  }
} else if (stage === "review_attacks") {
  if (process.env.AGENT_ARENA_FAKE_REVIEW_RETRY_THEN_TIMEOUT === "1") {
    const retryMarker = path.join(
      process.cwd(),
      ".agent-arena-review-retry-once",
    );
    try {
      await rm(retryMarker);
    } catch {
      await writeFile(retryMarker, "retry");
      process.exit(0);
    }
  }
  if (
    process.env.AGENT_ARENA_FAKE_UNKNOWN_REVIEW_FIELD_ALWAYS === "1" &&
    round === "1"
  ) {
    await writeFile(
      submission,
      JSON.stringify({
        version: 2,
        findings: [],
        provider_identity: "claude",
      }),
    );
    process.exit(0);
  }
  if (
    process.env.AGENT_ARENA_FAKE_INVALID_REVIEW_ALWAYS === "1" &&
    round === "1"
  ) {
    await writeFile(submission, JSON.stringify({ version: 2, findings: [{}] }));
    process.exit(0);
  }
  if (
    process.env.AGENT_ARENA_FAKE_OVERSIZED_REVIEW_ONCE === "1" &&
    round === "1" &&
    agent === "codex" &&
    !prompt.includes("# Targeted packet-size blocker refresh")
  ) {
    await writeFile(
      submission,
      JSON.stringify({
        version: 2,
        findings: [
          {
            trust: "reviewer_hypothesis",
            invariant: "i".repeat(1_000),
            observations: Array.from({ length: 8 }, (_, index) => ({
              trust: "reviewer_hypothesis",
              statement: "o".repeat(1_000),
              provenance: {
                kind: "code_inspection",
                references: [`src/slug-${String(index)}.mjs`],
              },
            })),
            code_locations: [
              {
                path: "src/slug.mjs",
                line_start: 1,
                line_end: 3,
                symbol: "slug",
              },
            ],
            trigger_sequence: Array.from({ length: 12 }, () => "t".repeat(500)),
            oracle: {
              expected_behavior: "e".repeat(1_500),
              task_source_ids: ["task-user"],
              task_source_rationale: "r".repeat(1_500),
            },
            confidence: 90,
            required_capability_ids: [],
            regression_test_plan: {
              summary: "s".repeat(1_500),
              suggested_paths: [],
              focused_command: "c".repeat(1_000),
            },
          },
        ],
      }),
    );
    process.exit(0);
  }
  if (
    process.env.AGENT_ARENA_FAKE_DIRTY_BLOCKER === "1" &&
    prompt.includes("# Targeted blocker refresh")
  ) {
    try {
      await readFile(path.join(process.cwd(), ".attacker-refresh-leak"));
      process.exit(2);
    } catch {
      // The blocker refresh must run in a freshly frozen target worktree.
    }
  }
  const source = await readFile(sourcePath, "utf8");
  const repeatedWhitespaceFinding = source.includes('replaceAll(" ", "-")')
    ? [
        {
          trust: "reviewer_hypothesis",
          invariant: "Every run of whitespace becomes one separator",
          observations: [
            {
              trust: "reviewer_hypothesis",
              statement:
                "The implementation replaces individual spaces instead of whitespace runs.",
              provenance: {
                kind: "code_inspection",
                references: ["src/slug.mjs:1"],
              },
            },
          ],
          code_locations: [
            {
              path: "src/slug.mjs",
              line_start: 1,
              line_end: 3,
              symbol: "slug",
            },
          ],
          trigger_sequence: [
            "Call slug with a title containing three consecutive spaces",
            "Observe the generated slug",
          ],
          oracle: {
            expected_behavior: "The whitespace run becomes one hyphen",
            task_source_ids: ["task-user"],
            task_source_rationale:
              "The frozen user task requires every whitespace run to collapse.",
          },
          confidence: 98,
          required_capability_ids: [],
          regression_test_plan: {
            summary: "Add a three-space title regression.",
            suggested_paths: ["test/arena-repeated-whitespace.test.mjs"],
            focused_command:
              "node --test test/arena-repeated-whitespace.test.mjs",
          },
        },
      ]
    : [
        {
          trust: "reviewer_hypothesis",
          invariant: "Slugs are lowercase",
          observations: [
            {
              trust: "reviewer_hypothesis",
              statement:
                "Mixed-case input should be checked against the frozen lowercase requirement.",
              provenance: {
                kind: "code_inspection",
                references: ["src/slug.mjs:1"],
              },
            },
          ],
          code_locations: [
            {
              path: "src/slug.mjs",
              line_start: 1,
              line_end: 3,
              symbol: "slug",
            },
          ],
          trigger_sequence: [
            "Call slug with uppercase characters",
            "Observe the generated slug",
          ],
          oracle: {
            expected_behavior: "The result is lowercase",
            task_source_ids: ["task-user"],
            task_source_rationale:
              "The frozen user task requires lowercase slugs.",
          },
          confidence: 70,
          required_capability_ids: [],
          regression_test_plan: {
            summary: "Add a mixed-case input regression.",
            suggested_paths: ["test/arena-uppercase.test.mjs"],
            focused_command: "node --test test/arena-uppercase.test.mjs",
          },
        },
      ];
  await writeFile(
    submission,
    JSON.stringify({ version: 2, findings: repeatedWhitespaceFinding }),
  );
  if (
    process.env.AGENT_ARENA_FAKE_REVIEW_TIMEOUT_AFTER_WRITE === "1" ||
    process.env.AGENT_ARENA_FAKE_REVIEW_RETRY_THEN_TIMEOUT === "1"
  )
    await new Promise((resolve) => setTimeout(resolve, 10_000));
} else if (stage === "collect_attacks") {
  if (
    process.env.AGENT_ARENA_FAKE_INVALID_ATTACK_ALWAYS === "1" &&
    round === "1"
  ) {
    await writeFile(submission, JSON.stringify({ version: 2, attacks: [{}] }));
    process.exit(0);
  }
  const retryMarker = path.join(process.cwd(), ".agent-arena-retry-once");
  const blockerMarker = path.join(
    tmpdir(),
    `agent-arena-blocker-${createHash("sha256").update(process.cwd()).digest("hex")}`,
  );
  let emitRetryFailure = false;
  let emitBlocker = false;
  const emitInvalidBlocker =
    process.env.AGENT_ARENA_FAKE_INVALID_BLOCKER === "1" &&
    round === "2" &&
    agent === "codex";
  if (
    process.env.AGENT_ARENA_FAKE_INVALID_THEN_BLOCKER === "1" &&
    round === "2" &&
    agent === "codex"
  ) {
    try {
      const phase = await readFile(blockerMarker, "utf8");
      if (phase === "invalid\n") {
        emitBlocker = true;
        await writeFile(blockerMarker, "blocker\n");
      } else {
        await rm(blockerMarker);
      }
    } catch {
      emitRetryFailure = true;
      await writeFile(blockerMarker, "invalid\n");
    }
  }
  if (
    process.env.AGENT_ARENA_FAKE_RETRY_ONCE === "1" &&
    round === "1" &&
    agent === "codex"
  ) {
    try {
      await readFile(retryMarker);
      await rm(retryMarker);
    } catch {
      emitRetryFailure = true;
      await writeFile(retryMarker, "retry\n");
    }
  }
  if (
    process.env.AGENT_ARENA_FAKE_BLOCKER_ONCE === "1" &&
    round === "2" &&
    agent === "codex"
  ) {
    try {
      await readFile(blockerMarker);
      await rm(blockerMarker);
    } catch {
      emitBlocker = true;
      await writeFile(blockerMarker, "blocker\n");
    }
  }
  if (emitInvalidBlocker) {
    await writeFile(
      submission,
      JSON.stringify({
        version: 2,
        handoff_blocker: {
          finding_ids: [`finding_${"0".repeat(64)}`],
          category: "cited_context_missing",
          explanation: "This blocker cites a finding outside the packet.",
          requested_capability_ids: [],
          requested_context: ["src/slug.mjs"],
        },
      }),
    );
  } else if (emitBlocker) {
    if (process.env.AGENT_ARENA_FAKE_DIRTY_BLOCKER === "1")
      await writeFile(
        path.join(process.cwd(), ".attacker-refresh-leak"),
        "attacker-owned bytes\n",
      );
    const findingId = prompt.match(
      /"finding_id":"(finding_[a-f0-9]{64})"/,
    )?.[1];
    if (!findingId) throw new Error("Trusted packet finding ID is missing");
    await writeFile(
      submission,
      JSON.stringify({
        version: 2,
        handoff_blocker: {
          finding_ids: [findingId],
          category: "cited_context_missing",
          explanation:
            "The cited target context requires a fresh reviewer pass.",
          requested_capability_ids: [],
          requested_context: ["src/slug.mjs"],
        },
      }),
    );
  } else if (emitRetryFailure) {
    await writeFile(submission, JSON.stringify({ version: 2, attacks: [{}] }));
  } else if (prompt.includes("# Correction-only reconciliation")) {
    const candidateIds = [...prompt.matchAll(/"candidateId":\s*"([^"]+)"/g)]
      .map((match) => match[1])
      .filter((candidateId) => candidateId !== "...");
    await writeFile(
      submission,
      JSON.stringify({
        version: 1,
        corrections: candidateIds.map((candidateId) => ({
          candidateId,
          fields: { proposedSeverity: "medium" },
        })),
      }),
    );
  } else if (
    process.env.AGENT_ARENA_FAKE_RECONCILIATION === "1" &&
    round === "3" &&
    agent === "codex"
  ) {
    await writeFile(
      submission,
      JSON.stringify({
        version: 1,
        attacks: [
          {},
          {
            rank: 1,
            claim: "Uppercase input is not normalized",
            impact: "Public slugs are inconsistent",
            oracle: {
              expectedBehavior: "Return a lowercase slug",
              sourceId: "task-user",
              sourceLocation: "command-line task",
              rationale: "The task requires lowercase slugs",
            },
            proposedSeverity: "medium",
            confidence: 70,
            reproduction:
              "Call slug with Alpha Beta; expect a lowercase alpha-beta slug.",
            requiredCapabilities: [],
          },
        ],
      }),
    );
  } else if (round === "2" && agent === "claude") {
    process.exit(0);
  } else if (
    process.env.AGENT_ARENA_FAKE_BROWSER_SIEGE === "1" &&
    round === "1" &&
    agent === "codex" &&
    (await readFile(sourcePath, "utf8")).includes('replaceAll(" ", "-")')
  ) {
    await writeFile(
      submission,
      JSON.stringify({
        version: 2,
        sharedSupportPaths: [],
        attacks: [
          {
            rank: 1,
            claim: "Repeated whitespace is not collapsed",
            impact: "The browser UI renders malformed public slugs",
            oracle: {
              expectedBehavior:
                "Three spaces entered through the browser produce one hyphen",
              sourceId: "task-user",
              sourceLocation: "command-line task",
              rationale:
                "The task explicitly requires every whitespace run to collapse",
            },
            proposedSeverity: "high",
            confidence: 98,
            requiredCapabilities: ["browser_dom_validation"],
            browserProbe: {
              id: "slug-browser-whitespace",
              family: "interaction",
              profile: "desktop",
              expectedBehavior:
                "Entering Alpha, three spaces, and Beta renders alpha-beta",
              actions: [
                { kind: "goto", path: "/" },
                { kind: "assert_text", text: "alpha-beta" },
              ],
            },
          },
        ],
      }),
    );
  } else if (round !== "1") {
    await writeFile(
      submission,
      JSON.stringify({ version: 1, hypotheses: [], attacks: [] }),
    );
  } else if (
    agent === "codex" &&
    (await readFile(sourcePath, "utf8")).includes('replaceAll(" ", "-")')
  ) {
    const testPath = "test/arena-repeated-whitespace.test.mjs";
    await writeFile(
      path.join(process.cwd(), testPath),
      `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slug } from "../src/slug.mjs";\ntest("collapses repeated whitespace", () => assert.equal(slug("Alpha   Beta"), "alpha-beta"));\n`,
    );
    await writeFile(
      submission,
      JSON.stringify({
        version: 1,
        hypotheses: [
          {
            category: "inputs_errors",
            invariant: "Any run of whitespace is one separator",
            probe: "Use three spaces",
            requiredCapabilities: [],
            confidence: 98,
          },
        ],
        attacks: [
          {
            rank: 1,
            claim: "Repeated whitespace is not collapsed",
            impact: "Valid titles produce malformed public slugs",
            oracle: {
              expectedBehavior:
                "Collapse every run of whitespace to one hyphen",
              sourceId: "task-user",
              sourceLocation: "command-line task",
              rationale: "The task explicitly requires collapsed whitespace",
            },
            proposedSeverity: "high",
            confidence: 98,
            reproduction:
              "Call slug with Alpha followed by three spaces and Beta; expect alpha-beta.",
            focusedCommand:
              "node --test test/arena-repeated-whitespace.test.mjs",
            requiredCapabilities: [],
            paths: [testPath],
          },
        ],
      }),
    );
  } else {
    const testPath = "test/arena-uppercase.test.mjs";
    await writeFile(
      path.join(process.cwd(), testPath),
      `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slug } from "../src/slug.mjs";\ntest("normalizes case", () => assert.equal(slug("Alpha Beta"), "alpha-beta"));\n`,
    );
    await writeFile(
      submission,
      JSON.stringify({
        version: 1,
        hypotheses: [
          {
            category: "contract_logic",
            invariant: "Slugs are lowercase",
            probe: "Use uppercase input",
            requiredCapabilities: [],
            confidence: 70,
          },
        ],
        attacks: [
          {
            rank: 1,
            claim: "Uppercase input is not normalized",
            impact: "Public slugs are inconsistent",
            oracle: {
              expectedBehavior: "Return a lowercase slug",
              sourceId: "task-user",
              sourceLocation: "command-line task",
              rationale: "The task requires lowercase slugs",
            },
            proposedSeverity: "medium",
            confidence: 70,
            reproduction:
              "Call slug with Alpha Beta; expect a lowercase alpha-beta slug.",
            focusedCommand: "node --test test/arena-uppercase.test.mjs",
            requiredCapabilities: [],
            paths: [testPath],
          },
        ],
      }),
    );
  }
} else if (stage === "repair") {
  if (
    agent === "claude" &&
    process.env.AGENT_ARENA_FAKE_SKIP_REPAIR !== "1" &&
    prompt.includes("Repeated whitespace is not collapsed")
  ) {
    const current = await readFile(sourcePath, "utf8");
    await writeFile(
      sourcePath,
      current.replace(
        'replaceAll(" ", "-")',
        'replace("   ", "-").replaceAll(" ", "-")',
      ),
    );
  }
  if (agent === "claude" && prompt.includes("arena-tab-whitespace")) {
    const current = await readFile(sourcePath, "utf8");
    await writeFile(
      sourcePath,
      current.replace(
        'replace("   ", "-").replaceAll(" ", "-")',
        'replace(/\\s+/g, "-")',
      ),
    );
  }
  if (prompt.includes("Blank titles are accepted as empty slugs")) {
    const current = await readFile(sourcePath, "utf8");
    if (!current.includes("Blank title")) {
      await writeFile(
        sourcePath,
        current.replace(
          "export function slug(value) {",
          'export function slug(value) {\n  if (!value.trim()) throw new Error("Blank title");',
        ),
      );
    }
  }
  await writeFile(
    submission,
    JSON.stringify({ version: 1, explanation: `${agent} bounded repair` }),
  );
}
