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

Contestants may optionally pin provider-specific model IDs. Model selection is
per contestant, including mirror matches that use the same provider twice. When
a contestant model is omitted, Agent Arena leaves model selection to that
provider CLI's configured default. The selected model is persisted with the
battle configuration and invocation metadata.

The agents then receive their opponents’ solutions and attempt to break them. A credible attack must include evidence such as a failing test, reproducible command, integration failure, security issue, benchmark, or static-analysis result.

Contestants may defend their solution by disproving the attack, repairing their patch, or conceding the defect. The harness reruns all valid tests and produces an evidence-backed winner.

The user receives:

* Multiple completed implementations.
* Additional adversarial tests.
* A recommended patch.
* Cost and duration comparisons.
* A replayable battle report.
* A deterministic visual battle replay generated from the recorded evidence,
  including a clickable HTML dossier with test coverage, attack evidence,
  scoring, and handoff.
* A command to apply the winning solution.

The project is intended to be both useful and entertaining. The adversarial testing provides engineering value, while the competition format creates a memorable and shareable GitHub project.

### Battle modes

The same evidence and health system supports three topologies:

- **Duel:** two contestant slots independently implement the task and attack
  each other. Slots may use different providers or isolated invocations of the
  same provider.
- **Catch-up:** an incumbent starts from a frozen pull-request patch while a
  challenger independently implements from the PR base without seeing that
  patch. The normal duel begins only after both patches pass initial validation.
- **Siege:** an attacker submits test-only evidence against a frozen
  pull-request patch and a defender owns its production lineage and repairs.
  Only the defender's final patch is reviewable or deliverable.

Pull-request authorship is provenance metadata, not proof of who wrote the
code. Explicit bot, co-author, generator, title, or branch signals may select a
provider only under published attribution rules; conflicts remain unknown and
attribution never changes scoring.

---

## Core Workflow

### 1. Repository reconnaissance

Before the agents begin, Agent Arena inspects the repository and creates a shared execution contract.

It also creates an immutable task contract from the user's prompt and authoritative references. When a task points to an official issue, pull request, specification, or public standard, Agent Arena snapshots its description, acceptance criteria, maintainer clarifications, origin, retrieval time, and content hash before any agent runs. Every contestant and judge receives the same snapshot.

Requirements from an official PR may be shared, but a reference implementation diff should remain hidden unless the user explicitly makes it part of the task. Known-good tests or outputs may be retained as judge-only oracle evidence with their provenance recorded.

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

* The same immutable task contract and official source snapshots.
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

### 4. Attack rounds

Each surviving agent receives anonymized opponent patches and changes roles from solver to attacker.

The MVP runs three attack–repair rounds after the initial implementation. In each round, an agent may submit up to three executable attacks ranked from most important and most likely to land to weakest and most speculative. Submitting fewer than three is valid.

Each round has its own symmetric, versioned prompt and investigation brief:

| Round | Focus | Injected bug-finding methods |
| --- | --- | --- |
| 1 — Contract and local correctness | Acceptance criteria, wrong output, regressions, negative cases, boundaries, and error handling. | Requirement-to-code tracing, examples, table tests, boundary analysis, and focused API assertions. |
| 2 — Systematic exploration | State transitions, persistence, serialization, ordering, concurrency, cleanup, cancellation, and test-suite blind spots. | Property and state-machine tests, generated inputs, fuzzing, mutation-guided probes, static leads, and controlled schedules. |
| 3 — Integration, resilience, and security | Real component boundaries, dependency contracts, configuration, authentication and authorization, timeouts, retries, idempotency, partial failure, recovery, and resource behavior. | Approved ephemeral services, protocol checks, fault injection, security checks, deterministic stress, and steady-state invariants. |

Required repository integration checks still run at baseline and after every
repair, and agents may submit integration attacks in any round. Round 3 is the
proactive deep-integration pass with the approved test topology; it is not the
first time integrations are exercised and it never grants production access.

Before ranking attacks, each agent gets a no-score scouting phase in which it
records a concise hypothesis portfolio: bug category, invariant, proposed
probe, required capability, and confidence. Only the zero to three committed
attacks can land or recoil. This encourages breadth without rewarding
unexecutable speculation.

The shared taxonomy covers contract and logic, inputs and errors, state and
lifecycle, data integrity, concurrency and time, integration and configuration,
security and privacy, resilience, performance and resources, and test/build
integrity. Automated methods are leads rather than verdicts: a mutation
survivor, fuzzer input, static warning, scanner alert, or model suggestion must
still become deterministic executable evidence with an authoritative oracle.
Any house-generated score-changing probe must be surfaced in a normal round so
the target gets a repair opportunity. Final validation only reruns known checks;
a novel late finding is reported but does not alter the winner.

Ordinary contestant attacks are differential and therefore cannot expose a bug
shared by both patches. The MVP permits at most one neutral house attack in
round 2 and one in round 3. A house attack has no contestant author or rank,
passes the same executable-evidence and oracle checks, and is evaluated
independently against both frozen patches. It may deal the same
severity-weighted root-defect damage to either or both contestants, causes no
recoil, and gives every affected contestant the normal repair opportunity.

The strongest attack is an executable test:

```text
Gemini attacks Patch B

Claim:
Two simultaneous refresh requests can overwrite the valid session token.

Evidence:
tests/session-refresh-race.test.ts

Oracle:
Official issue #241 acceptance criterion 3 requires the valid token to survive
concurrent refresh.

Result:
Patch A: PASS
Patch B: FAIL
Patch C: PASS
```

Purely rhetorical or stylistic criticism should not affect the result unless it identifies a measurable maintainability or correctness problem.

Both agents submit their ranked attack sets before any result is revealed. The harness resolves all target damage and attacker recoil simultaneously so process order cannot influence the fight.

Every attack prompt is composed from a fixed common contract, the round brief,
and a deterministic repository method pack. The common portion includes the
immutable task sources, frozen patches, prior attacks and root defects, current
health, permission manifest, budgets, recoil table, and output schema. Prompts,
method versions, tool versions, seeds, and hashes are run artifacts. Recovery,
repair, verifier, and infrastructure-review invocations use separate prompts
because they have different allowed actions.

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

A valid test should generally reproduce consistently and evaluate meaningful external behavior. To land, it must pass against the attacker's current patch and fail against the target's current patch.

That differential is necessary but not sufficient: it does not prove that the attacker's expected output is correct. Each attack must cite an oracle in the immutable task contract. A neutral attack verifier checks whether the claimed output or invariant is actually supported by the official task, issue or PR acceptance criteria, repository specification, public contract, or documented domain invariant. Unsupported or ambiguous expectations are `unproven`, deal no target damage, and count as a miss.

A submitted attack that does not land causes recoil damage to its author. Rank 1 costs 5 HP on a miss, rank 2 costs 10 HP, and rank 3 costs 15 HP. Invalid, flaky, unrelated, duplicate, self-defeating, and blocked attacks all miss. Harness infrastructure failures cause no recoil.

A lightweight verifier agent may help evaluate disputed attacks, but deterministic execution should remain the primary source of truth.

The term **harness** should refer to deterministic orchestration and execution: worktrees, patches, processes, retries, and recorded pass/fail results. The **attack verifier** performs the narrow semantic judgment about oracle support, relevance, root-defect identity, and severity. Together they form the arena adjudication pipeline.

For each landed defect, the visible attack is paired with up to two held-out
sibling cases generated and frozen before repair. The siblings must exercise
the same cited invariant and root defect, pass the attacker's patch and fail the
target's frozen patch for a contestant attack, and pass the ordinary
determinism and verifier checks. House siblings are evaluated independently per
contestant. The repair prompt reveals the invariant, visible reproducer, and
held-out case categories but not their exact inputs. Damage heals only when the
repair passes the visible and held-out cases. A failed held-out case is revealed
after that repair validation and every case is disclosed in the final report.
Held-out cases never increase severity or stack damage.

Harness-owned failures must never change health, but a true target defect must not be dismissed merely because it looks infrastructural. Git, filesystem, process-launch, environment, service, or provider failures are first retried in a clean worktree with author, target, base, and service-health controls.

If attack causality remains unclear, the result is `provisional_infrastructure` and the attacker reviews its own failure packet. It may accept the infrastructure diagnosis and request no-fault withdrawal, or challenge the diagnosis with exactly one bounded evidence revision. Acceptance creates a replacement credit only when harness controls confirm the failure was patch-independent rather than malformed or agent-caused. A revision may improve setup, teardown, isolation, timeout limits, logging, tracing, probes, or the focused command, but may not change the claim, expected behavior, oracle, assertion, target, rank, or root defect. The harness then reruns both frozen patches with isolated service instances.

A reproducible target-only failure returns to normal attack adjudication. A patch-independent environment failure becomes `infrastructure_error`. Evidence that remains causally ambiguous becomes `execution_inconclusive`. Either final no-fault status creates one replacement credit, while a revision that changes the original claim or assertion is an invalid miss. Round health waits for all provisional attacks to finish review so resolution remains simultaneous.

After normal round 3, one optional recovery attack–repair round lets each agent spend up to three replacement credits on newly ranked attacks. Replacement attacks use normal recoil and damage; only the infrastructure-lost slot is free. A second infrastructure failure in recovery makes the run inconclusive, and more than three credits for one agent is treated as a systemic harness failure rather than starting an unbounded loop.

A separate harness-maintainer agent owns accommodations. It may propose symmetric, versioned run overlays for service lifecycle, worktree setup, capability adapters, broker wiring, timeouts, resource limits, retries, and diagnostics. It cannot alter contestant code, attack assertions, or scoring. An overlay is applied only after harness tests, clean replay, permission review, and symmetric validation pass. Product-level harness source patches are drafted with regression fixtures but are not loaded into the referee mid-fight.

If an individual attack cannot be generated at all, it causes neither damage nor recoil. If implementation, repair, required validation, or final validation cannot be trusted after harness retries and controls, the whole run is inconclusive; the system must not eliminate a contestant or declare a winner from infrastructure failure.

### 6. Defense and repair

After each attack phase, each contestant receives the validated attacks against its current patch.

For each attack, it must:

* Disprove the claim with executable evidence.
* Repair the implementation.
* Or concede the issue.

Agents should heal damage for acknowledging and repairing valid defects. The system should not reward stubborn rhetorical defense.

Each contestant receives one bounded repair opportunity per round. A successful
repair must pass the visible reproducer and all accepted held-out sibling cases
before it heals the severity damage for that defect. Miss recoil is permanent.
The next round attacks the repaired patches, and all previously landed cases
remain in the validation set.

### 7. Final validation and ranking

All revised patches run against:

* The original repository test suite.
* Their own submitted tests.
* The union of validated visible and held-out adversarial cases.
* Validated neutral house cases from rounds 2 and 3.
* Optional integration, security, and performance checks.

Correctness should dominate the ranking through a health system. Every contestant starts at 100 HP. A landed attack deals damage based on the severity of the defect it proves, rather than awarding points for the raw number of tests an agent submits:

| Severity | Damage | Example impact |
| -------- | -----: | -------------- |
| Critical | 50 HP | Security boundary bypass, data loss, or corruption. |
| High | 30 HP | Core acceptance criterion failure, crash, hang, or major regression. |
| Medium | 15 HP | Realistic edge-case or secondary-requirement failure. |
| Low | 5 HP | Narrow robustness or measurable performance issue. |

Multiple cases proving the same root defect deal target damage once. A blocked
or otherwise missed contestant attack deals no target damage and instead
applies rank-based recoil to its author; neutral house attacks never recoil. A
successful repair heals only after all accepted visible and held-out cases for
the defect pass. An unresolved failure leaves the damage active, and a later
regression can reactivate it without stacking it. Recoil cannot be healed.

Health is calculated from a ledger: `100 - permanent recoil - active distinct defect damage`, clamped between 0 and 100. Round events resolve simultaneously. A contestant downed by the combined round resolution still receives that round's repair opportunity and is eliminated only if it remains at 0 afterward. A final patch that cannot be applied or fails a required repository check is eliminated and set to 0 HP regardless of its remaining health.

Attackers may propose a severity, but they do not control damage. A neutral verifier should apply the published rubric to anonymized executable evidence, choose the lowest level fully supported, and provide a saved rationale. Ambiguous High or Critical ratings should be capped at Medium. The harness then calculates health deterministically from landed tests, persisted severity verdicts, recoil, and repair results.

After three normal attack–repair rounds and any required infrastructure recovery round, the surviving contestant with the most HP wins. Patch simplicity may break an HP tie; otherwise the result is a draw. If only one contestant survives earlier and no downed opponent holds replacement credits, the fight ends early. Cost and duration are reported but do not change health.

The **arena champion** remains this health-ledger result. After final
validation, Agent Arena separately derives deterministic patch-quality facts
and may ask a neutral, identity-blind verifier to compare equally correct
patches. The resulting **recommended patch** is correctness-first: failed or
inapplicable patches are removed, less active defect damage always wins, quality
may decide only equal-correctness patches, and an equivalent or inconclusive
quality verdict falls back to the arena champion. Quality never changes HP,
damage, healing, recoil, or the champion.

Every completed run produces a stable review prompt with all eligible patch
choices and full SHA-256 digests. Applying a patch requires a current human
decision bound to the run, prompt, contestant, base commit, and exact digest.
Acceptance does not authorize commits, pushes, pull-request writes, issue
closure, or merge.

Optional GitHub delivery is a separately authorized, least-privilege
post-fight operation. It uses deterministic branches and append-only
idempotency records, refuses moved pull-request heads and force pushes, honors
repository checks and protection, and monitors merge-after-checks requests to a
terminal result. GitHub writes and merge are independently gated and disabled
by default. Deployment and release remain outside Agent Arena.

The final report should include a patch-versus-test matrix:

| Validation                    | Patch A | Patch B | Patch C |
| ----------------------------- | ------: | ------: | ------: |
| Existing tests                |    Pass |    Pass |    Pass |
| Concurrency attack (High, 30) |    Pass |    Fail |    Pass |
| Invalid-input attack (Med, 15) |    Pass |    Pass |    Fail |
| Integration checks            |    Pass |    Pass |    Pass |
| Miss recoil                   |   -5 HP |  -10 HP |    0 HP |
| Final health                  |   95 HP |   60 HP |   85 HP |
| Result                        |  Winner | Survived | Survived |

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

Permissions and authentication must be resolved explicitly before the fight.
Reconnaissance should generate one consolidated plan covering tools, services,
network destinations, filesystem paths, credential scopes, risk, requirement
level, execution role, and whether enforcement is OS-enforced, harness-brokered,
or advisory. The user can choose:

* **Auto:** approve only enforced or brokered capabilities matching a
  preconfigured safe allowlist.
* **Confirm:** approve, modify, or deny material capabilities in one preflight
  review.
* **Deny:** deny by default unless configuration explicitly allows a capability.

`auto` must not silently authorize production credentials, deployment access,
unrelated host files, an SSH agent, or destructive cloud operations. Required
capability denials block the fight unless the user explicitly accepts a reduced
validation contract. Optional denials are recorded and have no health effect.

Authentication should be performed by the harness through existing scoped
sessions, device authorization, ephemeral services, or test-only credentials.
Secrets belong to a run-scoped credential broker and harness-only validation
processes, never to agent prompts, worktrees, transcripts, or reports. Both
contestants must be evaluated with identical capabilities and scopes.

The MVP is not a complete hostile-code sandbox. A brokered denial means the
harness will not provide a credential or service, but it may not prevent an
agent from using authority already available to the current OS account.
Advisory restrictions exist only in policy and prompts. Preflight must label
these honestly; sensitive runs should use a sanitized account or external
container with production credentials absent.

An agent may declare extra capabilities for an integration attack. A newly
denied optional request becomes `capability_denied` and causes no damage or
recoil. Provisioning failure after approval is `infrastructure_error`. Reusing a
capability that the agent already knew was denied is an invalid submission and
receives normal miss recoil.

Integration discovery always chooses the simplest sufficient environment:
existing repository commands, fakes, fixtures, and local dependencies first;
then a run-owned local subprocess; then a user-supplied Compose profile; and
only then an explicitly approved remote test service. Escalation requires a
recorded reason that the simpler level cannot exercise the cited invariant and
must be symmetric across patches. The MVP can execute an existing Compose
profile but does not invent arbitrary container infrastructure.

Real integration testing requires explicit configuration. An optional `agent-arena.yaml` file can define services, commands, credentials, roles, and network policies:

```yaml
test: pnpm test
integration:
  setup: docker compose up -d postgres
  check: pnpm test:integration
  teardown: docker compose down --volumes
  services: [postgres]
  steady_state_invariants:
    - health endpoint is ready
    - seed account can complete a known-good request
  fault_controls: [timeout, disconnect, restart]

sources:
  - github_issue: 241
  - spec: docs/session-refresh.md

agents:
  - claude
  - codex
  - gemini

attack_verifier: codex
harness_maintainer: codex

limits:
  rounds: 3
  attacks_per_round: 3
  infrastructure_recovery_round: true
  timeout_minutes: 20

permissions:
  default: confirm
  allow:
    github_read:
      mode: auto
      scope: issue_and_pr_metadata
    postgres_test:
      mode: auto
      role: harness_only
  deny:
    - production_credentials
    - production_deploy
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
  --agents claude,codex \
  --rounds 3 \
  --budget 5
```

The MVP supports two agents, one initial implementation, three attack–repair
rounds, up to three ranked attacks per agent per round, one optional
infrastructure recovery round, one required validation command, and at most one
approved ephemeral integration profile.

---

## Battle Report and Viral Design

The report is a core feature, not an afterthought.

Game mechanics should map directly to real engineering events:

* **Damage:** A verified failing test, weighted by defect severity.
* **Critical hit:** A catastrophic defect dealing 50 HP.
* **Shared hit:** A neutral house attack proves the same defect against both
  patches and damages both without recoil.
* **Block:** An attack successfully disproved; its author takes rank-based recoil.
* **Recoil:** A missed rank 1, 2, or 3 attack costs its author 5, 10, or 15 HP.
* **Holdout:** A repair passes the visible reproducer but remains damaged because
  a pre-frozen sibling case still fails.
* **Review:** A provisionally infrastructural attack is accepted as no-fault or challenged with one evidence revision.
* **Freebie:** A confirmed infrastructure attempt earns one recovery-round replacement credit.
* **Heal:** A repaired patch restores the exact HP lost to that attack.
* **Elimination:** A required check remains failing and health becomes 0.
* **Draw:** Multiple patches finish with equal HP and tie-breakers.

Example terminal output:

```text
╔══════════════ AGENT ARENA ══════════════╗
║ Task: Fix concurrent session refresh   ║
╠═════════════════════════════════════════╣
║ Claude  100 HP   Tests: 148/148         ║
║ Codex     0 HP   Eliminated             ║
╚═════════════════════════════════════════╝

Round 2 — Codex attack #3 against Claude:
Claim disproved by the existing concurrency test.
Block. Codex takes 15 recoil.

Round 3 — Claude attack #1 against Codex:
Expired sessions can be revived after logout.

Adversarial test: FAIL against Codex
Critical hit: 50 damage.

Codex attempted repair.
Repair failed.
Required validation after repair: FAIL.
Elimination: 0 HP.

WINNER: CLAUDE
Cost: $2.83
Duration: 11m 14s
```

Each run should generate:

* `BATTLE.md`
* An immutable task-contract file with official source snapshots and hashes.
* A redacted permission manifest with approvals, denials, leases, and omitted checks.
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
* Harness failures hiding real contestant defects.
* Large time and API costs.
* Users treating the winner as proof of correctness.

The project should clearly state that surviving the arena provides additional evidence, not a correctness guarantee.

The most important success metric is:

> How often does the adversarial attack-and-repair stage produce a better patch than simply running several agents and selecting the first one that passes existing tests?

Harness reliability is a release gate: zero unhandled harness failures, zero
health or winner changes caused by harness faults, a permanent regression
fixture for every confirmed fault, and at least 99.9% infrastructure-free attack
evaluation in stable releases.

Even when the improvement is modest, the battle format may still succeed as an entertaining and viral open-source project. The first release should therefore prioritize a simple command, convincing output, reproducibility, and shareable results.
