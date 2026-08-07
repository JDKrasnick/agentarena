import { readFile, writeFile } from "node:fs/promises";
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

if (stage === "implement") {
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
  const source = await readFile(sourcePath, "utf8");
  const repeatedWhitespaceFinding = source.includes('replaceAll(" ", "-")')
    ? [
        {
          invariant: "Every run of whitespace becomes one separator",
          codeLocation: "src/slug.mjs:slug",
          triggerSequence: [
            "Call slug with a title containing three consecutive spaces",
            "Observe the generated slug",
          ],
          expectedBehavior: "The whitespace run becomes one hyphen",
          confidence: 98,
          suggestedMinimalRegressionTest:
            "Add test/arena-repeated-whitespace.test.mjs with a three-space title",
        },
      ]
    : [
        {
          invariant: "Slugs are lowercase",
          codeLocation: "src/slug.mjs:slug",
          triggerSequence: [
            "Call slug with uppercase characters",
            "Observe the generated slug",
          ],
          expectedBehavior: "The result is lowercase",
          confidence: 70,
          suggestedMinimalRegressionTest:
            "Add test/arena-uppercase.test.mjs with mixed-case input",
        },
      ];
  await writeFile(
    submission,
    JSON.stringify({ version: 1, findings: repeatedWhitespaceFinding }),
  );
} else if (stage === "collect_attacks") {
  if (round === "2" && agent === "claude") {
    process.exit(0);
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
