# Agent Arena

## Overview

Agent Arena is an open-source developer tool that runs multiple coding agents against the same software task, allows them to attack one another’s implementations with executable evidence, gives each agent an opportunity to repair its patch, and selects a winner based primarily on test results.

The central idea is:

> Make coding agents fight for the merge.

A developer supplies a task:

```bash
agent-arena fight "fix issue #241"
```

Agent Arena launches Claude Code, Codex, Gemini CLI, OpenCode, or other supported agents in separate Git worktrees. Each agent independently explores the repository, implements a solution, adds tests, and submits a patch.

The agents then receive their opponents’ solutions and attempt to break them. A credible attack must include evidence such as a failing test, reproducible command, integration failure, security issue, benchmark, or static-analysis result.

Contestants may defend their solution by disproving the attack, repairing their patch, or conceding the defect. The harness reruns all valid tests and produces an evidence-backed winner.

The user receives:

* Multiple completed implementations.
* Additional adversarial tests.
* A recommended patch.
* Cost and duration comparisons.
* A replayable battle report.
* A command to apply the winning solution.

The project is intended to be both useful and entertaining. The adversarial testing provides engineering value, while the competition format creates a memorable and shareable GitHub project.

---

## Core Workflow

### 1. Repository reconnaissance

Before the agents begin, Agent Arena inspects the repository and creates a shared execution contract.

It detects:

* Languages and frameworks.
* Package managers.
* Build and installation commands.
* Unit, integration, lint, and type-check commands.
* Existing repository instructions.
* Docker and Compose files.
* Required local services.
* Environment-variable templates.
* Available coding-agent CLIs.

It should read common instruction files such as:

```text
AGENTS.md
CLAUDE.md
GEMINI.md
.github/copilot-instructions.md
```

The reconnaissance stage creates a capability manifest:

```yaml
repository:
  language: typescript
  package_manager: pnpm

commands:
  install: pnpm install
  test: pnpm test
  integration: pnpm test:integration
  lint: pnpm lint
  typecheck: pnpm typecheck

capabilities:
  - shell
  - filesystem
  - git
  - browser

restrictions:
  production_credentials: denied
  host_filesystem: denied
```

Agents may still explore the codebase, but they do not need to rediscover basic commands or available tools independently.

### 2. Independent implementation

Each contestant receives:

* The same task.
* The same starting commit.
* The same time and cost budget.
* The same repository instructions.
* The same capability manifest.
* A separate Git worktree and process environment.

Agents cannot inspect their opponents during this stage.

Each agent must produce:

* A code patch.
* Tests demonstrating the intended behavior.
* A short implementation explanation.
* Assumptions and unresolved limitations.
* Execution time and cost metadata.

### 3. Initial validation

The harness, rather than the contestant, runs required validation commands.

These may include:

* Existing repository tests.
* Agent-generated tests.
* Build commands.
* Linting.
* Type checking.
* Security checks.
* Integration tests.

An agent cannot claim success without evidence from the harness.

Patches that fail essential checks may be eliminated immediately or allowed into the repair stage with a penalty.

### 4. Attack round

Each surviving agent receives anonymized opponent patches and changes roles from solver to attacker.

The attacker is instructed to find concrete defects, including:

1. Missing edge cases.
2. Incorrect assumptions.
3. Regressions.
4. Race conditions.
5. Security vulnerabilities.
6. Performance problems.
7. Incomplete handling of the issue requirements.

The strongest attack is an executable test:

```text
Gemini attacks Patch B

Claim:
Two simultaneous refresh requests can overwrite the valid session token.

Evidence:
tests/session-refresh-race.test.ts

Result:
Patch A: PASS
Patch B: FAIL
Patch C: PASS
```

Purely rhetorical or stylistic criticism should not affect the result unless it identifies a measurable maintainability or correctness problem.

### 5. Attack validation

Opponent-generated tests cannot automatically be trusted.

An attack should be rejected when it is:

* Unrelated to the original task.
* Nondeterministic.
* Dependent on private implementation details.
* Incorrectly configured.
* Already failing for unrelated reasons.
* Designed specifically to favor the attacker’s implementation.
* Based on unrealistic or impossible behavior.

A valid test should generally reproduce consistently and evaluate meaningful external behavior.

A lightweight verifier agent may help evaluate disputed attacks, but deterministic execution should remain the primary source of truth.

### 6. Defense and repair

Each contestant receives the validated attacks against its patch.

For each attack, it must:

* Disprove the claim with executable evidence.
* Repair the implementation.
* Or concede the issue.

Agents should receive points for acknowledging and repairing valid defects. The system should not reward stubborn rhetorical defense.

Each contestant receives a bounded repair budget, such as one repair round, a maximum duration, or a token limit.

### 7. Final validation and ranking

All revised patches run against:

* The original repository test suite.
* Their own submitted tests.
* The union of validated adversarial tests.
* Optional integration, security, and performance checks.

Correctness should dominate the ranking.

Suggested ranking order:

1. Task acceptance criteria.
2. Existing repository tests.
3. Validated adversarial tests.
4. Security and regression checks.
5. Integration tests.
6. Performance.
7. Patch simplicity.
8. Cost.
9. Completion time.

The final report should include a patch-versus-test matrix:

| Validation           | Patch A |    Patch B |    Patch C |
| -------------------- | ------: | ---------: | ---------: |
| Existing tests       |    Pass |       Pass |       Pass |
| Concurrency attack   |    Pass |       Fail |       Pass |
| Invalid-input attack |    Pass |       Pass |       Fail |
| Integration checks   |    Pass |       Pass |       Pass |
| Result               |  Winner | Eliminated | Eliminated |

The user remains responsible for reviewing and merging the winning patch.

---

## Agent Autonomy and Tool Access

Agent Arena is autonomous after launch, but it is not promptless.

Each agent receives a structured role prompt, available tools, permissions, budget, and stopping rules.

The harness may expose meta-tools such as:

```text
list_capabilities()
inspect_capability("browser")
read_repository_instructions()
run_validation_profile("integration")
request_capability("postgres")
report_blocker(...)
```

The orchestration layer should enforce a state machine:

```text
EXPLORE
IMPLEMENT
VALIDATE
ATTACK
REPAIR
FINAL_VALIDATE
```

Agents cannot skip required stages simply because they believe their work is complete.

When an agent needs an unavailable capability, it submits a structured request:

```json
{
  "capability": "stripe_test_account",
  "reason": "Required to validate webhook retries",
  "fallback": "Use a local signed-webhook simulator"
}
```

The harness may approve the capability, deny it, or provide a fallback.

Real integration testing requires explicit configuration. An optional `agent-arena.yaml` file can define services, commands, credentials, roles, and network policies:

```yaml
setup:
  - docker compose up -d
  - pnpm db:migrate

checks:
  - pnpm test
  - pnpm test:integration
  - pnpm lint

agents:
  - claude
  - codex
  - gemini

limits:
  rounds: 1
  timeout_minutes: 20
```

Credentials should be test-only, scoped to an individual run, and hidden from transcripts and opponents.

Production integrations and enterprise-grade secret management should not be required for the initial release.

---

## MVP

The first version should optimize for a reliable local demonstration rather than broad infrastructure support.

### Initial agent support

Start with:

* Claude Code.
* Codex CLI.
* Gemini CLI.

Use a provider adapter interface so additional agents can be added later.

Each adapter should support:

* Noninteractive execution.
* Custom role and task prompts.
* Working-directory isolation.
* Time and token limits.
* Transcript capture.
* Exit-status reporting.
* Cost estimation when available.

### Initial repository support

Focus on:

* Git repositories with existing tests.
* TypeScript and Node.js.
* Python.
* CPU-only workflows.
* Public repositories or locally available private repositories.
* Standard package managers and test commands.

Avoid initially supporting:

* Production cloud environments.
* GPU workloads.
* Mobile application builds.
* Large monorepos.
* Arbitrary infrastructure deployment.
* Production credentials.

### First CLI

```bash
agent-arena fight "fix issue #241" \
  --agents claude,codex,gemini \
  --rounds 1 \
  --budget 5
```

A smaller first milestone could support only two agents, one attack round, one repair round, and one configured test command.

---

## Battle Report and Viral Design

The report is a core feature, not an afterthought.

Game mechanics should map directly to real engineering events:

* **Damage:** A verified failing test.
* **Critical hit:** A major security or correctness defect.
* **Block:** An attack successfully disproved.
* **Heal:** A patch repaired successfully.
* **Elimination:** A required check remains failing.
* **Draw:** Multiple patches survive all validation.

Example terminal output:

```text
╔══════════════ AGENT ARENA ══════════════╗
║ Task: Fix concurrent session refresh   ║
╠═════════════════════════════════════════╣
║ Claude   92 HP   Tests: 148/148         ║
║ Codex     0 HP   Eliminated             ║
║ Gemini   71 HP   Tests: 147/148         ║
╚═════════════════════════════════════════╝

Claude attacks Codex:
Expired sessions can be revived after logout.

Adversarial test: FAIL against Codex
Critical hit.

Codex attempted repair.
Repair failed.

WINNER: CLAUDE
Cost: $2.83
Duration: 11m 14s
```

Each run should generate:

* `BATTLE.md`
* A JSON result file.
* The winning patch.
* A command to apply the winner.
* An HTML battle replay.
* Cost and timing summaries.
* A model win/loss record.
* An optional terminal animation or GIF.

The project should be marketed through the fights it produces rather than through its orchestration architecture.

Strong launch content would include:

* A recognizable open-source issue.
* Multiple plausible initial implementations.
* A surprising adversarial failure.
* A visible comeback or elimination.
* A final test matrix.
* A reproducible command.

The project’s tagline should be:

> Make your coding agents fight for the merge.

---

## Differentiation and Risks

Existing tools already run multiple agents in parallel, isolate them in worktrees, compare patches, and let users choose a winner.

Agent Arena’s differentiation is the complete adversarial loop:

1. Independent implementations.
2. Cross-attacks using executable tests.
3. Validation of those attacks.
4. Bounded repair rounds.
5. Ranking based on a shared hostile test suite.

The main risks are:

* Agents creating invalid or overly specific tests.
* Debate increasing cost without improving patches.
* Agents gaming the scoring system.
* Untrusted code execution.
* Provider-specific CLI behavior.
* Large time and API costs.
* Users treating the winner as proof of correctness.

The project should clearly state that surviving the arena provides additional evidence, not a correctness guarantee.

The most important success metric is:

> How often does the adversarial attack-and-repair stage produce a better patch than simply running several agents and selecting the first one that passes existing tests?

Even when the improvement is modest, the battle format may still succeed as an entertaining and viral open-source project. The first release should therefore prioritize a simple command, convincing output, reproducibility, and shareable results.
