import { cp, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { ArtifactStore } from "../../src/artifacts/store.js";

if (process.env.AGENT_ARENA_LIVE !== "1") {
  process.stdout.write(
    "SKIP: set AGENT_ARENA_LIVE=1 to authorize real, paid Codex battles in disposable local repositories.\n",
  );
  process.exit(0);
}

const { values } = parseArgs({
  options: {
    case: { type: "string", default: "outbox" },
    rounds: { type: "string", default: "2" },
    models: { type: "string" },
    "require-signal": { type: "boolean", default: false },
  },
});
const name = values.case;
if (name !== "cache" && name !== "outbox")
  throw new Error("--case must be cache or outbox");
if (!/^[1-5]$/.test(values.rounds))
  throw new Error("--rounds must be an integer from 1 through 5");

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixture = path.join(projectRoot, "test", "fixtures", "stateful", name);
const outputRoot = path.join(projectRoot, ".context", "live-stateful");
await mkdir(outputRoot, { recursive: true });
const repositoryRoot = await mkdtemp(path.join(outputRoot, `${name}-`));
await mkdir(path.join(repositoryRoot, "src"));
await mkdir(path.join(repositoryRoot, "test"));
await cp(path.join(fixture, "TASK.md"), path.join(repositoryRoot, "TASK.md"));
await cp(
  path.join(fixture, "implementation.mjs"),
  path.join(repositoryRoot, "src", "index.mjs"),
);
await cp(
  path.join(fixture, "baseline.mjs"),
  path.join(repositoryRoot, "test", "baseline.test.mjs"),
);
if (name === "outbox")
  await cp(
    path.join(fixture, "store.mjs"),
    path.join(repositoryRoot, "src", "store.mjs"),
  );
await writeFile(
  path.join(repositoryRoot, "package.json"),
  JSON.stringify({
    name: `arena-live-${name}`,
    private: true,
    type: "module",
    scripts: { test: "node --test" },
  }),
);
await writeFile(
  path.join(repositoryRoot, ".gitignore"),
  ".agent-arena/\nnode_modules/\n",
);
await writeFile(
  path.join(repositoryRoot, "agent-arena.yaml"),
  `test: node --test
bootstrap: none
agents: [codex, codex]
judge: codex
limits:
  implementation_minutes: 2
  review_minutes: 2
  attack_minutes: 2
  verifier_minutes: 1
  repair_minutes: 2
mcp:
  policy: configure_selection
  servers: []
delivery:
  enabled: false
`,
);
for (const args of [
  ["init", "-q"],
  ["config", "user.name", "Arena Local Validation"],
  ["config", "user.email", "arena-local@example.test"],
  ["add", "."],
  ["commit", "-qm", "Stateful live battle baseline"],
])
  await execa("git", args, { cwd: repositoryRoot });
await execa("node", ["--test"], { cwd: repositoryRoot });
await execa("npm", ["run", "build"], { cwd: projectRoot, stdio: "inherit" });
process.stdout.write(`Disposable battle repository: ${repositoryRoot}\n`);
const battle = await execa(
  process.execPath,
  [
    path.join(projectRoot, "dist", "cli.js"),
    "fight",
    "Implement the complete behavioral contract in TASK.md, preserving the existing API and adding deterministic regression tests.",
    "--spec",
    "TASK.md",
    "--rounds",
    values.rounds,
    ...(values.models ? ["--models", values.models] : []),
    "--display",
    "plain",
    "--yes",
  ],
  { cwd: repositoryRoot, stdio: "inherit", reject: false },
);
const artifactRoot = path.join(repositoryRoot, ".agent-arena", "runs");
const runs = (await readdir(artifactRoot)).sort();
const runId = runs.at(-1);
if (!runId) throw new Error("The battle created no durable run");
const store = new ArtifactStore(artifactRoot, runId, { durableV5: true });
const state = await store.readState();
const healthEvents = Object.values(state.contestants).flatMap(
  (contestant) => contestant.healthEvents,
);
const signalObserved = healthEvents.some((event) => event.amount !== 0);
const summary = {
  repositoryRoot,
  runId,
  status: state.status,
  coverage: state.coverageAssessment?.confidence,
  outcome:
    state.arenaOutcome && "kind" in state.arenaOutcome
      ? state.arenaOutcome.kind
      : undefined,
  health: Object.values(state.contestants).map((contestant) => ({
    id: contestant.id,
    model: contestant.model ?? "provider default",
    hp: contestant.finalHealth,
    events: contestant.healthEvents,
  })),
  signalObserved,
  verdict: state.patchQualityVerdict?.verdict,
};
await writeFile(
  path.join(repositoryRoot, ".agent-arena", "LIVE-CHECK.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
// A non-discriminating result is valid. --require-signal is a release-check
// assertion on observed evidence, never an instruction to change the score.
if (
  battle.exitCode !== 0 ||
  state.status !== "complete" ||
  state.coverageAssessment?.confidence !== "full_confidence" ||
  (values["require-signal"] && !signalObserved)
)
  process.exitCode = 1;
