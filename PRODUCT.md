# Agent Arena

## Overview

Agent Arena is an open-source developer tool that runs multiple coding agents against the same software task, allows them to attack one another’s implementations with executable evidence, gives each agent an opportunity to repair its patch, and selects a winner based primarily on test results.

The central idea is:

> Make coding agents fight for the merge.

New MVP runs use exactly three model roles: two contestant adapters and one
fresh, identity-blind judge adapter. The harness owns execution, retries,
capability enforcement, and deterministic selection; the judge owns semantic
validity, canonical defect identity, frozen severity, fallback adjudication,
and repair judgments when mechanics remain unavailable. House scouting,
case-building, quality comparison, held-out sibling generation, and harness
maintenance are legacy-only extensions and are not invoked by new runs.

Champion and patch-recommendation language is conditional on coverage. Duel
and catch-up require both attack directions in each of the three rounds; siege
requires the attacker-to-defender lane in each round. Optional neutral-house
scouting is outside this calculation. A valid explicit empty attack submission
completes a lane, while a lane with no usable terminal result leaves only a
provisional health-ledger leader. The user must bind an `accept-reduced` or
`inconclusive` decision to the exact coverage-assessment digest before an
unresolved run can become final. Ordinary patch review and apply remain blocked
while coverage is provisional.

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

### Execution architecture

The live fight path has three layers:

```text
Arena -> RoundEngine -> mechanisms
```

- `Arena` owns preflight and the battle lifecycle: immutable run creation,
  worktree and service lifetime, round sequencing, final validation, reporting,
  and cancellation of the overall battle.
- `RoundEngine` owns one transactional round. Round 1 includes missing
  implementation generation and initial validation before the normal
  attack–repair phases. Its operation accepts a self-contained
  `RoundSnapshot` and returns a typed `RoundResult` with a required immutable
  `RoundReplay` and round-state delta.
- Mechanisms perform narrow operations such as review, case generation,
  validation, repair, and scoring. They do not depend upward on `RoundEngine` or
  `Arena`.

Only versioned, strict, serializable data crosses the Arena–RoundEngine
boundary. Runtime services, callbacks, worktree objects, abort controllers, and
mutable `RunState` stay outside it. `ContestantFeedback` is a deliberately
limited projection: a lane sees its health, accepted attacks and visible
reproducers, its own attack outcomes, and healed or unresolved defect IDs, but
not opponent transcripts, held-out cases, verifier reasoning, or private repair
details. Expected execution failures are returned as `inconclusive`,
`cancelled`, or `failed` results; exceptions are reserved for invalid
configuration, invalid schemas, and programming invariants.

`Arena` has no direct mechanism imports. Durable recovery treats the immutable
preflight baseline and sealed per-round envelopes as authority. `result.json`
is a compact schema-v8 summary with an ordered applied-envelope ledger. Runtime
state is V7 and round snapshots, results, replays, envelopes, and state deltas
are V4. Resume
validates the digest chain and runtime drift, applies a sealed boundary exactly
once, and never reruns an interrupted unsealed round under the original run ID.
Production prompts consume only persisted lane-safe `ContestantFeedback`.

Every attack outcome is normalized into an immutable, versioned adjudication
record before scoring. Semantic verdict, rejection basis, canonical defect,
frozen severity, evidence basis, duplicate state, diagnostics, multiplier,
exact target score effect, and rank-derived recoil are separate fields; scoring
never trusts free-form attack status, caller-supplied damage, or a supplied
recoil amount. Definitive mechanical or judge evidence deals
full severity damage, while a supported partial-judge ruling deals exactly 35%
(17.5/10.5/5.25/1.75 HP). A later definitive corroboration applies only the
delta to full damage, preserves the original severity, and does not re-damage a
healed defect unless the current patch genuinely regresses.

Complete adjudications and rationale remain local. Agent packets are
deterministic, digest-linked role-safe projections targeting 8 KiB with a 24
KiB ceiling; they retain current and unresolved defects, concise verdict,
severity, basis, multiplier, effective damage, expected behavior, visible
reproducers, and artifact pointers while excluding private transcripts,
opponent-only evidence, and verbose judge rationale.

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

Before any review or attack work, implementation eligibility is sealed as
schema-v7 terminal metadata. In a duel, exactly one production patch that
applies and passes required validation wins by forfeit and is the only
reviewable recommendation; no eligible patch is inconclusive. Provider,
transport, authentication, reconnect, and harness failures are inconclusive,
not forfeits. A failed frozen incumbent in catch-up ends inconclusively before
the challenger is invoked, and siege never recommends its test-only attacker.

Pull-request authorship is provenance metadata, not proof of who wrote the
code. Explicit bot, co-author, generator, title, or branch signals may select a
provider only under published attribution rules; conflicts remain unknown and
attribution never changes scoring.

---

## Core Workflow

### 1. Repository reconnaissance

Before the agents begin, Agent Arena inspects the repository and creates a shared execution contract.

It also creates an immutable `RunSpec` from the user's exact prompt, explicitly
supplied acceptance criteria, and frozen source text. When a task points to an
issue, pull request, specification, or public standard, Agent Arena snapshots
the complete resolved text, origin, retrieval time, content hash, and structured
GitHub provenance before any agent runs. It does not extract or prioritize
requirements from that text. Every contestant and judge receives the same
specification.

Pull-request text may be frozen as a source, but a reference implementation diff
should remain outside the shared task sources unless the user explicitly makes
it part of the task. Known-good tests or outputs are separate harness evidence,
with their provenance recorded.

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

* The same immutable RunSpec and frozen source snapshots.
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

The MVP runs three review–attack–repair rounds after the initial implementation.
In each round, the harness first freezes both current implementation patches.
Each eligible reviewer then gets a dedicated read-only budget, configured by
`review_minutes` separately from the focused test-generation budget. The review
produces a v2 trusted evidence-handoff packet under
[`docs/TRUSTED_EVIDENCE_HANDOFF_RFC.md`](docs/TRUSTED_EVIDENCE_HANDOFF_RFC.md).
The packet contains harness-attested target and permission fingerprints plus at
most 12 ordered reviewer hypotheses naming the invariant, observations and
provenance, code locations, trigger sequence, oracle rationale, expected
behavior, confidence, required capabilities, and focused regression plan. Exact
duplicates are rejected by stable finding ID while semantic defect identity
remains the judge's responsibility. Deterministic tail compaction enforces a 16
KiB canonical UTF-8 ceiling and records every omission.

The review prompt also describes the arena execution architecture, the
reviewer's place in the freeze–review–test–verify–repair sequence, the assigned
worktree state, the declared integration topology, and previously adjudicated
root defects. It includes the complete approved/denied capability policy with
scope, execution role, and `enforced`, `brokered`, or `advisory` semantics.
Agents may use only approved `agent` or `both` capabilities directly;
`harness_only` checks remain mediated by the harness.

Immediately before attack invocation, the harness recomputes both fingerprints.
A stale or malformed packet skips invocation and receives one targeted review
refresh; persistent failure is coverage loss. Repair, target mutation,
permission change, and round transition invalidate the packet immediately, so
only adjudicated lane-safe feedback carries forward. The same contestant then
receives the canonical packet immediately before attack instructions and
inspects the frozen target through its assigned worktree; the raw patch is not
embedded in the prompt.

The attacker may submit zero to three sparse, uniquely ranked
`AttackSubmissionV2` entries. Each entry declares oracle metadata, a focused
command, required capabilities, and disjoint test/fixture paths. Shared support
paths may be declared once and are copied into every independently replayable
target-relative overlay. A malformed rank does not suppress valid siblings;
invalid shared support rejects only dependent attacks. `attacks: []` is explicit
successful lane completion. A mutually exclusive typed `handoff_blocker` may
identify affected finding IDs and missing permission or context; it receives one
targeted refresh, after which persistence is coverage loss without a score
effect.

Each round has its own symmetric, versioned prompt and investigation brief:

| Round | Focus | Injected bug-finding methods |
| --- | --- | --- |
| 1 — Contract and local correctness | Acceptance criteria, wrong output, regressions, negative cases, boundaries, and error handling. | Requirement-to-code tracing, examples, table tests, boundary analysis, and focused API assertions. |
| 2 — Systematic exploration | State transitions, persistence, serialization, ordering, concurrency, cleanup, cancellation, and test-suite blind spots. | Property and state-machine tests, generated inputs, fuzzing, mutation-guided probes, static leads, controlled schedules, and—when relevant—prior-version artifact compatibility or full retry/persistence lifecycle probes. |
| 3 — Integration, resilience, and security | Real component boundaries, dependency contracts, configuration, authentication and authorization, timeouts, retries, idempotency, partial failure, recovery, and resource behavior. | Approved ephemeral services, protocol checks, fault injection, security checks, deterministic stress, and steady-state invariants. |

Required repository integration checks still run at baseline and after every
repair, and agents may submit integration attacks in any round. Round 3 is the
proactive deep-integration pass with the approved test topology; it is not the
first time integrations are exercised and it never grants production access.

The read-only findings packet is engineering evidence rather than hidden
chain-of-thought. It excludes private implementation-generation transcripts and
provider identity, credentials, and all private reasoning. Its observations are
explicitly reviewer hypotheses, never harness facts or canonical defects. Raw
findings are available only to the same contestant's focused
failure-description phase, while implementation owners receive only
verifier-confirmed regression tests during repair. Cited files, nearby tests,
and direct dependencies remain inspectable. Broad rediscovery is allowed,
warned about when visible, and recorded as `targeted`, `broad`, or `unknown`;
telemetry never affects validity, retries, coverage, health, scoring, or
selection. Only the zero to three committed attacks can land or recoil.

The shared taxonomy covers contract and logic, inputs and errors, state and
lifecycle, data integrity, concurrency and time, integration and configuration,
security and privacy, resilience, performance and resources, and test/build
integrity. Automated methods are leads rather than verdicts: a mutation
survivor, fuzzer input, static warning, scanner alert, or model suggestion must
still become deterministic executable evidence with an authoritative oracle.
Any house-generated score-changing probe must be surfaced in a normal round so
the target gets a repair opportunity. Final validation only reruns known checks;
a novel late finding is reported but does not alter the winner.

Ordinary duel and catch-up attacks are differential: the overlay must pass on
the author and fail on the target. Siege attacks instead record base/control
diagnostics, defender failure, and semantic adjudication because the attacker
has no production patch. Model-generated house attacks are not part of new MVP
runs.

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

Structured provider output is fault-isolated. The harness preserves the exact
submitted bytes before parsing or worktree cleanup, then validates review
findings and contestant attacks independently. A malformed optional section or sibling cannot suppress valid
scoring evidence. Contestant attack ranks are unique values from 1 through 3;
they may be sparse, are never renumbered, and every entry sharing a duplicate
rank is rejected. Explicit empty sections remain distinct from missing or lost
coverage. House, case-builder, and contestant scouting inputs are legacy-only,
non-scoring artifacts.

Each independently identifiable malformed attack path receives one immediate
correction opportunity in the same transactional round against the same frozen
patches. The original malformed entry is attempt one. Correction freezes every
field that already validated and supplies only missing or rejected fields;
valid siblings continue normally. A missing, timed-out, tampered, or malformed
second attempt is permanently recorded as lost coverage. No correction work is
carried into another round.

Case-judge worktrees start from the frozen base implementation. The case judge
receives an anonymized failure description and immutable RunSpec, snapshots
that tree before generation, captures its test-only overlay, and replays it in
verifier worktrees that contain the same target patch. Isolated files such as
`test/arena-*.mjs` are preferred so target-owned test changes are not rewritten
unless necessary.

Every attack prompt is composed from a fixed common contract, the round brief,
and a deterministic repository method pack. The common portion includes the
immutable task sources, frozen patches, prior attacks and root defects, current
health, permission manifest, budgets, recoil table, and output schema. Prompts,
method versions, tool versions, seeds, and hashes are run artifacts. Repair and
judge invocations use separate prompts because they have different allowed
evidence and actions.

Round 2 method packs expose versioned-contract compatibility and policy-wiring
lifecycle probes as advisory options. Agents may pursue them when the frozen
patch changes schema versions, durable readers or writers, retry behavior,
recovery, or persistence. They are not required for unrelated patches. A
compatibility probe should prefer a genuine prior-version fixture; a lifecycle
probe should exercise a production path through failure, retry, recovery,
persistence, and resume rather than testing only an isolated helper.

### 5. Attack validation

Contestant failure descriptions and neutral case-judge tests cannot automatically
be trusted.

An attack should be rejected when it is:

* Unrelated to the original task.
* Nondeterministic.
* Dependent on private implementation details.
* Incorrectly configured.
* Already failing for unrelated reasons.
* Designed specifically to favor the attacker’s implementation.
* Based on unrealistic or impossible behavior.

A valid neutral test should generally reproduce consistently and evaluate meaningful external behavior. To land, it must pass against the attacker's current patch and fail against the target's current patch.

That differential is necessary but not sufficient: it does not prove that the
attacker's expected output is correct. Each attack states the expected behavior
and why the frozen task or source text supports it. A neutral attack verifier
reads that text and decides whether it clearly supports the claim; the presence
of a source ID is never sufficient by itself. Unsupported or ambiguous
expectations are `unproven`, deal no target damage, and count as a miss.

A submitted attack that does not land causes recoil damage to its author. Rank 1 costs 5 HP on a miss, rank 2 costs 10 HP, and rank 3 costs 15 HP. Invalid, flaky, unrelated, duplicate, self-defeating, and blocked attacks all miss. Harness infrastructure failures cause no recoil.

A lightweight verifier agent may help evaluate disputed attacks, but deterministic execution should remain the primary source of truth.

The term **harness** should refer to deterministic orchestration and execution: worktrees, patches, processes, retries, and recorded pass/fail results. The **attack verifier** performs the narrow semantic judgment about oracle support, relevance, root-defect identity, and severity. Together they form the arena adjudication pipeline.

Each mechanically landed defect retains its executable reproducer. Repair
validation reruns every active reproducer and each healed-defect regression
check after every attempt. Judge-based defects use immutable digest-bound repair
judgments only when mechanical confirmation remains unavailable.

Harness-owned failures must never change health, but a true target defect must not be dismissed merely because it looks infrastructural. Git, filesystem, process-launch, environment, service, or provider failures are first retried in a clean worktree with author, target, base, and service-health controls.

If attack mechanics remain unavailable after the one targeted retry, the
neutral judge may adjudicate only a schema-valid immutable attack with a claim,
oracle, target, and concrete patch or evidence facts. Definitive confirmation
deals full frozen-severity damage, semantic rejection applies ordinary rank
recoil, task-supported concrete but mechanically unavailable evidence deals
exactly 35%, and `unable` changes no score while leaving coverage unresolved.
The retry and disposition are persisted in the failure-handling ledger.

The deterministic harness owns symmetric, versioned run accommodations for
service lifecycle, worktree setup, capability adapters, broker wiring,
timeouts, resource limits, retries, and diagnostics. New runs do not invoke a
harness-maintainer model.

If an individual attack cannot be generated at all, it causes neither damage nor recoil. If implementation, repair, required validation, or final validation cannot be trusted after harness retries and controls, the whole run is inconclusive; the system must not eliminate a contestant or declare a winner from infrastructure failure.

### 6. Defense and repair

After each attack phase, each contestant receives the validated attacks against its current patch.

For each attack, it must:

* Disprove the claim with executable evidence.
* Repair the implementation.
* Or concede the issue.

Agents should heal damage for acknowledging and repairing valid defects. The system should not reward stubborn rhetorical defense.

Every canonical Critical/High defect receives three total repair attempts across
the run; Medium/Low receives two. Each non-infrastructure terminal invocation
consumes one attempt for every included defect and receives the full configured
`repair_minutes` timeout. Required checks, all active reproducers, and healed
regression checks run after each attempt; success stops the loop early. A healed
defect that regresses gets a fresh allowance, while corroboration does not.
Mechanically evidenced repairs are confirmed by execution. When mechanics remain
unavailable, the judge persists a digest-bound `repaired`, `not_repaired`, or
`unable` record without changing the original claim, oracle, canonical ID,
severity, or multiplier.

### 7. Final validation and ranking

All revised patches run against:

* The original repository test suite.
* Their own submitted tests.
* Every active reproducer and healed-defect regression check.
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
applies rank-based recoil to its author. A successful repair heals only after
the required check and applicable defect evidence pass. An unresolved failure
leaves the damage active, and a later
regression can reactivate it without stacking it. Recoil cannot be healed.

Health is calculated from a ledger: `100 - permanent recoil - active distinct defect damage`, clamped between 0 and 100. Round events resolve simultaneously. A contestant downed by the combined round resolution still receives that round's repair opportunity and is eliminated only if it remains at 0 afterward. A final patch that cannot be applied or fails a required repository check is eliminated and set to 0 HP regardless of its remaining health.

Attackers may propose a severity, but they do not control damage. A neutral verifier should apply the published rubric to anonymized executable evidence, choose the lowest level fully supported, and provide a saved rationale. Ambiguous High or Critical ratings should be capped at Medium. The harness then calculates health deterministically from landed tests, persisted severity verdicts, recoil, and repair results.

After three attack–repair rounds, the surviving contestant with the most HP wins. Patch simplicity may break an HP tie; otherwise the result is a draw. If only one contestant survives earlier, the fight ends early. Cost and duration are reported but do not change health.

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

Every provider and validation command runs under the same hard deadline
contract. The harness tracks run-owned descendants across process-group and
session changes, stops reading inherited output pipes at expiry, terminates and
reaps the owned tree within a documented cleanup grace period, and verifies
process identity before every signal. Reports record deadline expiry, signal
escalation, whether cleanup completed, cleanup duration, any surviving descendants, and detected
transport, reconnect, or MCP authentication failures separately.

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
recorded reason that the simpler level cannot exercise the stated invariant and
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

judge: codex

limits:
  rounds: 3
  attacks_per_round: 3
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
rounds, up to three ranked attacks per agent per round, one targeted retry per
distinct failure, one required validation command, and at most one
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
* **Fallback:** After one failed mechanical retry, an eligible immutable attack may receive a clearly labeled judge verdict.
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
* An immutable `run-spec.json` with frozen source snapshots and reproducibility metadata.
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
