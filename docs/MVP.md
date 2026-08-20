# Agent Arena MVP

## What we are building

Agent Arena is a local command-line tool that asks two coding agents to solve the
same repository task, then runs three rounds in which they attack the opposing
solution and repair their own. It recommends the solution with the strongest
test evidence and the most remaining health.

The MVP exists to prove one idea:

> Does an adversarial attack-and-repair round produce a better patch than simply
> running multiple coding agents and choosing the first patch that passes?

The result is confidence-qualified. New runs use exactly two contestant adapters
and one fresh, identity-blind judge adapter. Duel and catch-up require both
directions in all three attack rounds; siege requires attacker-to-defender in
all three. Every required coverage-v3 lane records `review`,
`attack_submission`, `evidence_construction`, `execution`,
`semantic_adjudication`, and `repair` when applicable. Direct overlay capture
completes evidence construction without another model call; a schema-valid
`attacks: []` completes the lane with downstream stages not applicable.

Each failed stage or evidence path receives one targeted retry from the failed
stage, with validated upstream output reused. Mechanical
confirmation is preferred. When that path still cannot execute, the neutral
judge may confirm normal damage, reject the claim with ordinary rank recoil,
decline to adjudicate with no score change, or award exact 35% damage only
when the task clearly supports the expected behavior and available evidence
points to the defect. Partial-judge damage is Critical 17.5, High 10.5, Medium
5.25, or Low 1.75 HP; health uses quarter-point precision and repairs heal the
exact currently applied amount.

Unresolved required coverage preserves the health-ledger leader as provisional
but publishes no champion or recommended patch. `agent-arena
resolve-coverage` requires the current assessment digest: `accept-reduced`
promotes the leader with reduced confidence and unlocks ordinary patch review,
while `inconclusive` finalizes without a winner or recommendation. Legacy runs
without an assessment are labeled legacy/unknown rather than assigned a new
confidence claim. Required capability gaps stay visible even when the user
accepted a reduced validation contract.

This release is a dependable local demonstration of that loop. It is not a
general-purpose agent platform.

## Execution architecture and migration

The live dependency direction is:

```text
Arena -> RoundEngine -> mechanisms
```

`Arena` owns preflight, immutable run setup, shared runtime-service lifetime,
round sequencing, final validation, reporting, and battle-level cancellation.
`RoundEngine` owns exactly one transactional round through
`run(snapshot): Promise<RoundResult>`. For round 1 that transaction first
validates any frozen PR contestant, generates every missing production patch,
and runs initial validation; only successful initialization continues into the
ordinary attack–repair phases. Lower-level mechanisms perform narrow operations
and cannot import either orchestration layer.

The boundary carries only strict, versioned, JSON-safe contracts:

- `RunSpec` freezes the task and sources, base commit, battle topology,
  commands, budgets, permissions, and content hash.
- `RoundSnapshot` combines that run specification with a round identity,
  contestant patch and health state, known defects, and the prior replay hash.
- `RoundReplay` records snapshot identity, invocations, attacks, checks,
  repairs, score events, diagnostics, artifact references, and its replay hash.
- `RoundResult` is a completed, inconclusive, cancelled, or failed terminal
  value. Every outcome carries its replay and resulting contestant state.
- `ContestantFeedback` exposes only lane-safe evidence: health, accepted
  incoming attacks and visible reproducers, own-attack outcomes, and healed or
  unresolved defect IDs.

Round 1 first seals implementation eligibility. A local implementation timeout,
failed exit, empty or unappliable patch, or failed required validation is a
forfeit; provider/harness transport, authentication, or reconnect failures are
inconclusive. A one-sided duel promotes the eligible validated patch directly
to review without producing review, attack, repair, quality, or coverage
artifacts. The persisted pre-review terminal outcome controls resume and CLI
status reporting.

Runtime services, callbacks, worktree objects, abort controllers, and mutable
`RunState` never enter these serialized contracts. Expected execution failures
are terminal result values; throws indicate invalid configuration, schema
violations, or programming invariants.

`Arena`'s direct mechanism import allowlist is empty. Each terminal result is
sealed in a digest-chained immutable envelope. Completed envelopes apply through
an ordered exactly-once ledger; inconclusive, cancelled, and failed envelopes
preserve evidence without advancing state. Schema-v8 summaries rebuild detailed
state from the immutable preflight baseline and applied V4 envelopes, while
v1–v7
runs retain their legacy authority model.

## Who it is for

The first user is a developer who:

- Has a local Git repository with an existing automated test suite.
- Has at least two supported coding-agent CLIs installed and authenticated.
- Has a concrete, self-contained coding task.
- Is comfortable reviewing generated code before applying it.

## The core experience

From the root of a clean Git repository, the developer runs:

```bash
agent-arena fight "fix the refresh-token race condition" \
  --agents codex,claude \
  --models gpt-5.2-codex,claude-opus-4-6 \
  --rounds 3 \
  --permissions confirm \
  --test "npm test"
```

Agent Arena then:

1. Freezes the exact task, explicitly supplied acceptance criteria, referenced
   issue/PR/specification text, repository instructions, and reproducibility
   metadata into an immutable RunSpec.
2. Discovers required capabilities and presents a permission and authentication
   plan for the user to approve, modify, or deny.
3. Checks the repository, Git state, required executables, and test command.
4. Creates an isolated Git worktree for each contestant at the same commit.
5. Gives both agents the same RunSpec, repository instructions, limits,
   and test command.
6. Captures each implementation as a patch and runs the configured test command.
7. Runs three attack–repair rounds with different investigation briefs:
   - Round 1 attacks specification compliance and local correctness.
   - Round 2 attacks boundaries, state, data, concurrency, and hidden test
     weaknesses with systematic probe methods.
   - Round 3 attacks real integrations, configuration, security boundaries,
     partial failure, recovery, and resource behavior.
   In each round:
   - The harness freezes both current patches.
   - Both agents get an extended read-only review phase and produce structured
     target-specific findings.
   - Each agent receives its compact review packet and submits zero to three
     sparse, uniquely ranked executable attacks. `AttackSubmissionV2` includes
     oracle metadata, a focused command, required capabilities, disjoint
     rank-specific paths, and optional shared support paths copied into every
     independently replayable target-relative overlay. `attacks: []` explicitly
     records that no reviewed hypothesis is credible.
   - The harness validates every attack and resolves damage or recoil
     simultaneously.
   - Both agents receive the new evidence and the remaining durable repair
     allowance for each active defect: three attempts for Critical/High and two
     for Medium/Low across the run.
   - After every attempt, the harness reruns required checks, all active
     reproducers, and healed regression checks; it stops early when all pass.
8. Runs every final patch against the original suite, all active reproducers,
   and all healed-defect regression checks.
9. Produces a recommendation, health timeline, test matrix, replayable run data,
   a clickable HTML dossier with linked evidence, and a patch the developer can
   inspect or apply.

The command prints progress while the fight is running and ends with a compact
summary:

```text
Agent Arena — final result
Rounds completed: 3/3

                         Codex     Claude
Original test suite      PASS      PASS
Claude's race test       PASS      PASS    HIGH (30)
Codex's logout test      PASS      FAIL    HIGH (30)

Final health             100 HP     70 HP

Winner: Codex
Reason: 100 HP; Claude took 30 unresolved damage
Artifacts: .agent-arena/runs/2026-07-29T142200Z/
Apply: agent-arena apply 2026-07-29T142200Z --agent codex
```

The language can be playful, but the recommendation must always be explained in
plain engineering terms.

## Battle modes

The MVP exposes three battle modes over the same three-round adjudication loop:

- `duel` is the default. Two contestant slots independently implement and
  attack. Duplicate providers are valid mirror matches; each slot still has a
  separate worktree, prompt, process, transcript, timeout, and artifact path.
- `catch_up` freezes a referenced PR at its base and head commits, gives the
  incumbent the frozen patch, and lets the challenger implement from the base
  using requirements that exclude the incumbent diff. The PR patch must be
  non-empty, apply cleanly, and pass required validation before the challenger
  spends an implementation budget.
- `siege` freezes a referenced PR for a defender and gives an attacker a
  test-only evidence role. Landed defects damage the defender, successful
  repairs heal it, and misses recoil against the attacker. Only the defender
  owns a production patch and can be reviewed, applied, or delivered.

All persisted records use stable contestant IDs (`a` and `b`) independently of
provider identity. PR authorship evidence is recorded as confirmed, likely, or
unknown provenance and never changes health or attack validity. Catch-up
requires an explicit incumbent provider when attribution is unknown.

## Final round structure and bug coverage

The three rounds are a progressive investigation, not three copies of the same
prompt. Both agents receive the same versioned common rules and the same
round-specific prompt. A repository-specific method pack may enable relevant
tools, but it must be selected before seeing contestant identities and exposed
symmetrically.

| Stage | Investigation brief | Typical evidence |
| --- | --- | --- |
| Implementation | Build the smallest complete patch from the immutable RunSpec. Reproduce the reported behavior before changing code when practical. | Required repository command and focused implementation tests. |
| Round 1 — contract and local correctness | Trace every acceptance criterion through the changed code. Look for wrong results, missing behavior, regressions, error handling, and input or boundary mistakes. | Examples, table tests, boundary tests, negative cases, and API assertions. |
| Round 2 — systematic exploration | Look beyond obvious examples: state transitions, ordering, persistence, serialization, mutation survivors, generated inputs, concurrency schedules, cancellation, resource cleanup, and patch interactions. | Property-based tests, fuzz or generated cases, mutation-guided tests, schedule tests, static-analysis findings with executable reproducers, state-machine tests, and relevant prior-version or retry/persistence lifecycle probes. |
| Round 3 — integration, resilience, and security | Exercise the patch across its real component boundaries with approved test dependencies. Vary configuration and dependency behavior; test authentication and authorization, retries, idempotency, timeouts, partial failure, recovery, and bounded load. | Ephemeral-service integration tests, protocol assertions, fault injection, security checks, recovery invariants, leak checks, and small deterministic stress tests. |
| Final validation | Re-run the required suite and every already accepted arena check. It discovers no score-changing surprise after the last repair opportunity. | A deterministic patch-by-check matrix and health-ledger replay. |

Round 3 is the proactive integration round, but integration is not deferred until
then. Required repository integration tests run during baseline and after every
repair, and an agent may submit a well-supported integration attack in any
round. Round 3 adds the provisioned test environment and a focused search for
cross-component failures. It does not grant production access.

Before focused failure analysis, each agent receives a separate
`review_minutes` budget for read-only inspection of the opponent's frozen patch.
The resulting packet records the checked invariant, code location, trigger
sequence, expected behavior, confidence, and a suggested minimal regression
test. It is not hidden chain-of-thought and excludes private implementation
transcripts. Only the reviewer that produced the packet receives it before
adjudication; repair prompts contain verifier-confirmed tests rather than raw
findings. Only committed attacks can land or recoil.

Both review and focused failure analysis receive a standardized execution
architecture: battle mode and contestant role, phase sequence, exact worktree
state, validation authority, information boundaries, declared integration
topology, and prior adjudicated root defects. They also receive the full
capability policy. Prompts distinguish directly usable approved `agent`/`both`
capabilities from harness-mediated `harness_only` capabilities and unavailable
denied or failed capabilities, and explain whether each boundary is enforced,
brokered, or advisory.

The MVP uses this cross-cutting bug taxonomy:

- **Contract and logic:** wrong value, omitted requirement, incompatible API
  behavior, or regression.
- **Inputs and errors:** boundary, malformed, adversarial, locale, numeric,
  encoding, or error-propagation behavior.
- **State and lifecycle:** invalid transitions, stale state, ordering, cleanup,
  restart, cancellation, or repeated-operation bugs.
- **Data integrity:** persistence, transaction, migration, serialization,
  caching, duplication, or corruption.
- **Concurrency and time:** race, atomicity, deadlock, lost update, clock,
  timeout, or scheduling failure.
- **Integration and configuration:** protocol, dependency version, schema,
  environment, deployment, permission, or feature-flag mismatch.
- **Security and privacy:** authentication, authorization, session, injection,
  secret exposure, unsafe defaults, or trust-boundary failure.
- **Resilience:** retry storms, non-idempotent replay, partial failure, degraded
  dependency, failover, or recovery failure.
- **Performance and resources:** unbounded work, leak, exhaustion, pathological
  input, or material latency regression.
- **Test and build integrity:** flaky oracle, masked failure, packaging,
  portability, nondeterminism, or a test gap that permits a real task defect.

Probe methods are leads, not verdicts. Mutation, fuzzing, static analysis,
coverage, dependency scanners, and model suggestions affect health only when an
agent turns a finding into a deterministic, task-relevant attack with an
authoritative oracle. House-generated probes must be surfaced during a normal
round so the target receives a repair opportunity; a novel final-validation
finding is reported but cannot change the winner.

### Deferred shared-defect extension

Differential contestant attacks cannot expose a defect shared by both patches.
Neutral house probes remain a readable legacy artifact and a possible future
extension; new MVP runs do not invoke or score them.

Historically, a house attack came from the same versioned method packs and official task
contract, but has no contestant author. It must pass the ordinary determinism,
relevance, oracle, root-defect, and severity checks. It is evaluated
independently against both frozen patches and may land on either or both. Each
affected contestant takes the same severity damage for the shared root defect
and receives the same evidence and repair opportunity. House attacks have no
rank and cannot cause recoil. They are resolved in the same simultaneous event
batch as contestant attacks and cannot duplicate or stack existing defect
damage.

The cap keeps the neutral lane from overtaking the core agent-versus-agent
experiment. A house lead that is not promoted during rounds 2 or 3 is an
unscored report finding.

## MVP boundaries

### Included

- macOS and Linux.
- Local Git repositories.
- Repositories that can be prepared before the fight with normal project tools.
- One user-supplied required validation command and at most one optional
  declared integration profile.
- Two contestants selected from Codex CLI, Claude Code, and Gemini CLI.
- Optional provider-specific model selection for each contestant. Omission uses
  the provider CLI default; explicit selections are recorded in run artifacts.
- A provider adapter boundary, even if only two adapters are release-ready.
- One identity-blind judge invocation for semantic adjudication when required.
- A preflight permission plan with `auto`, `confirm`, and `deny` policies.
- Harness-only, run-scoped access to approved test credentials and services.
- Approved ephemeral local or test-service provisioning.
- Deterministic method packs for property, fuzz, mutation, static,
  concurrency, security, and fault-injection probes when supported by the
  repository and permission plan.
- Independently replayable target-relative attack overlays.
- One implementation round.
- Three attack–repair rounds.
- One targeted retry for each distinct stage or evidence-path failure.
- Zero to three ordered attacks per agent in each round.
- Durable two- or three-attempt repair allowances per canonical defect.
- Process timeout and an optional per-agent spend hint.
- Captured stdout, stderr, exit codes, durations, prompts, and agent transcripts.
- Markdown, JSON, and a deterministic SVG battle replay generated from the same run data.
- Exported final patches.
- A guarded command that applies a selected patch to the current repository.

### Deliberately excluded

- A hosted service or remote workers.
- More than two simultaneous contestants.
- Unreviewed package installation or production service provisioning.
- Multiple integration profiles, unrestricted browser tests, or production
  integrations.
- Arena-generated container environments, network sandboxes, GPU workloads,
  and mobile builds. Running a user-supplied Compose profile is allowed.
- Production credentials or enterprise-grade secret management.
- Deployment, package release, or GitHub writes without a separately
  authenticated, patch-bound delivery decision.
- Elo ratings, persistent leaderboards, GIFs, and hosted or interactive replay
  applications beyond the self-contained HTML dossier.
- A verifier-agent debate. Attack validity is decided by deterministic execution;
  the verifier only checks frozen-text support, relevance, root-defect identity, and
  severity against published rules.

## Product rules

### Immutable run specification

Before implementation begins, the harness builds one immutable `RunSpec`. It
preserves the user's exact task and only acceptance criteria supplied explicitly
by the user. Referenced issues, pull requests, repository specifications,
instruction files, comments, and public contracts are frozen as unclassified
source text; checklist-looking prose is not promoted into requirements and
sources have no precedence.

Every source receives a stable ID, origin, retrieval time, content hash, local
snapshot, and structured GitHub provenance when applicable. The RunSpec also
freezes the base commit, battle topology, commands, budgets, permission
decisions, and a deterministic hash over the complete specification except the
hash field itself. Contestants, repairs, case generation, quality checks, and
the attack verifier receive that same parsed value and do not rely on live
content that could change during the fight.

A referenced PR may contain a reference implementation. Its text and maintainer
comments can be frozen as sources, but its code diff should not be shown to
contestants unless the user explicitly requests that. Reference tests and
known-good outputs remain separate harness evidence with recorded provenance;
they are not hidden RunSpec sources.

If an issue or PR cannot be fetched, preflight must not silently invent its
contents. The user must provide a local specification with `--spec`, supply the
task text directly, or proceed with a report warning that the RunSpec sources are
incomplete.

### Fair starting conditions

Both agents start from the exact same commit and receive the same RunSpec,
test command, repository instructions, time limit, and available context. They
cannot read the opponent worktree during implementation.

### Live observability surface

Fights default to the dedicated React desktop window. The window loads only
Agent Arena assets and a randomly assigned `127.0.0.1` event stream, keeps Node
integration disabled, and does not launch a browser tab. `--no-window` opts out,
using Ink in an interactive TTY and plain output otherwise. Explicit
`--display window|terminal|plain` modes remain available, while `--display
dashboard` remains a compatibility alias for the desktop window. Closing the
window cancels an active battle; after completion, **Finish session** closes the
window and its local server.

Fighter cards open a full-page drill-down within the desktop window. The detail
view exposes recorded invocations, output, checks, health changes, attack
involvement, and live steering, with a persistent route back to the arena. The
round rail can select completed rounds and reconstruct their recorded fighter
and evidence state. This replay is read-only: the MVP has no pause, arbitrary
retry, or execution rewind control. Durable resume continues from a sealed
boundary rather than rolling a completed round backward.

The desktop window uses a larger live-battle size so each fighter card retains
and exposes more output. Once a terminal result is projected, the window
contracts to a results-first layout showing the recommendation, final fighter
health and checks, coverage, run integrity, completed rounds, landed defects,
verified repairs, terminal outcome, evidence links, and controls to review the
recorded battle or finish the session.

The window includes Classic Shell, Developer Dashboard, Night Edition, Live
Arena Broadcast, and 16-Bit Tactics themes. Classic Shell is used until a valid local
selection exists. The always-available swatch picker changes renderer families
without reconnecting the event stream or resetting fighter, replay, or result
navigation. Electron loads the preference before React mounts and stores it
atomically below the user's application-data directory. Corrupt or unknown
preferences fall back to Classic; a failed write keeps the session choice and
shows a non-blocking warning. This preference is excluded from runtime schemas,
battle records, artifacts, scoring, project configuration, and recovery hashes.
Ink and plain CLI behavior is unchanged.

Developer Dashboard is a conventional dark observability renderer with the
dashboard-native three-column structure: round timeline, paired contestant
workspaces, and chronological activity. Each contestant workspace exposes
health, checks, normalized work summaries, steering, and full-detail inspection;
a bottom status bar keeps the run identity and state visible. 16-Bit Tactics
uses a code-native tile field, tactical nodes, authoritative attack and repair
routes, opposing status bars, inspection commands, and an evidence channel. It
keeps the complete cartridge HUD visible at desktop widths and derives compact
work nodes from recorded contestant invocations rather than invented game
state. It does not bundle third-party game characters, logos, sprites, or
screenshots. Stored
`sticker-league` preferences migrate to `developer-dashboard`; `evidence-deck`
and `monster-battle` preferences migrate to `retro-tactics`.

### Permission and authentication plan

Before agents run, repository reconnaissance produces a capability plan covering
tools, services, network destinations, filesystem paths, credentials, and
execution roles. Each capability has:

- A reason and the validation or task stage that needs it.
- A risk level and exact scope.
- A policy: `auto`, `confirm`, or `deny`.
- A requirement level: `required` or `optional`.
- An execution role: `agent`, `harness_only`, or `both`.
- An enforcement level: `enforced`, `brokered`, or `advisory`.
- An authentication state and run-scoped expiration.

The user can choose one overall mode:

- `auto`: automatically approve only capabilities on the configured safe
  allowlist with `enforced` or `brokered` boundaries, such as local test
  commands, repository reads, ephemeral databases, and approved read-only issue
  access.
- `confirm`: show one consolidated preflight plan and ask the user to approve,
  change, or deny each material capability.
- `deny`: deny capabilities unless explicitly allowed in configuration.

`auto` is never permission to use production credentials, deploy infrastructure,
access unrelated home-directory files, expose an SSH agent, or perform
destructive cloud writes. Those remain hard-denied unless the user explicitly
changes policy for a precisely scoped capability.

Authentication is performed by the harness through existing sessions, device
authorization, or test-only credentials after user approval. Raw credentials
are never placed in prompts, agent environments, attack patches, transcripts,
or reports. When an integration needs a secret, a harness-only runner or
credential broker injects it into the validation subprocess and returns only
redacted results to agents.

The MVP does not provide a complete hostile-code sandbox. `brokered` means the
harness withholds and injects a capability, but may not prevent an agent process
from using other authority already available to the current OS user.
`advisory` means the restriction exists only in policy and prompts. Preflight
must display this distinction and cannot claim that an advisory denial is
enforced. Users handling sensitive repositories should run Agent Arena from a
sanitized account or external container and keep production credentials absent.

Both contestants receive the same post-approval capability manifest. An attack
may request an additional optional capability, but it is paused until a policy
decision is available:

- Approved: provision a run-scoped lease and execute the attack for both patches.
- Denied by the user: mark `capability_denied`; no target damage or author recoil.
- Provisioning fails after approval: mark `infrastructure_error`; no health
  effect.
- Already listed as denied and knowingly requested again: mark the attack
  invalid and apply normal miss recoil.

If a required capability is denied or cannot be authenticated, the fight does
not start unless the user explicitly accepts a reduced validation contract. The
final report must prominently list every omitted check; a reduced contract
cannot silently claim the same confidence as a full run.

Capability discovery follows a least-complexity ladder:

1. Reuse existing repository commands, in-process fakes, fixtures, and local
   dependencies.
2. Start a simple local subprocess owned by the run.
3. Execute a user-supplied Compose profile when the repository already needs
   multiple services or stronger cleanup.
4. Use an explicitly approved remote test service only when local options cannot
   exercise the required contract.

The harness escalates only when the simpler level cannot test a stated invariant,
records the reason, and applies the same level to both patches. Agent Arena does
not generate an arbitrary container topology or use a production integration in
the MVP.

### Evidence over opinion

An attack only affects the result when the harness can execute it. In the MVP,
an attack is a patch containing test or fixture changes, a claim, and an
expected behavior with a rationale grounded in the frozen RunSpec text. Source
ID and location fields are optional compatibility metadata. A critique without runnable
evidence is recorded in the report but deals no damage to the target and causes
recoil to its author if it was submitted as an attack.

### Ordered attacks and risk

Each agent may submit zero, one, two, or three attacks per round. Submission is
optional: passing is safer than sending weak evidence. Submitted attacks must be
ranked in this order:

1. The most important defect with the highest confidence of landing.
2. The next most important and credible defect.
3. The weakest or most speculative attack the agent is still willing to risk.

The rank is a commitment, not presentation metadata. A submitted attack that
does not land deals recoil damage to its author:

| Attack rank | Recoil on miss |
| ----------: | -------------: |
| 1 | 5 HP |
| 2 | 10 HP |
| 3 | 15 HP |

An attack misses when it is invalid, flaky, unrelated, duplicates an already
scored root defect, fails against the attacker's own patch, or passes against the
target. Harness infrastructure failures do not cause recoil and are retried.

Recoil cannot be healed. This makes a short list of strong attacks safer than
submitting three guesses, and makes the declared order reflect both expected
impact and confidence.

### Fault-isolated submissions and one correction

Every structured provider submission is copied byte-for-byte to a permanent
`submissions/<round>/<phase>/<actor>/raw.txt` artifact before parsing or
worktree removal. A neighboring `parsed.json` records its SHA-256, overall and
section outcomes (`valid`, `valid_empty`, `partial`, or `invalid`), every
accepted or rejected entry, all versioned normalizations, redacted/truncated
received values, exact JSON paths, validation codes, and allowed enum values.
Reports link both artifacts but never embed raw provider contents.

Review considers the first twelve positions, and contestant attacks accept sparse
unique ranks 1 through 3 without renumbering. Legacy house and case submissions
remain readable but are not generated for new runs.
Duplicate-rank contestant entries are all rejected while unrelated ranks
survive. House hypotheses are validated independently from house attacks.
Contestant hypotheses are accepted only for legacy-read compatibility and
cannot affect scoring or attack validity. Unsupported versions, non-object
envelopes, and unparseable JSON remain wholly invalid.

An independently identifiable malformed attack path receives one immediate
correction opportunity in the same transactional round against the same frozen
patches. The original submission is attempt one. Correction freezes every
field that already validated and permits only missing or rejected fields to
change, so valid siblings continue normally. A missing, timed-out, tampered, or
still-malformed second attempt is discarded permanently and recorded as lost
coverage. No correction queue or later reconciliation round exists for new
runs.

### Conservative attack acceptance

An attack lands only when:

- The test overlay was captured relative to a frozen target-patched Git tree and
  applies cleanly after the same target patch in the verifier worktree.
- The attack runs consistently twice.
- It passes against the attacker's current implementation and fails against the
  targeted opponent's current implementation.
- It does not modify production code.
- It proves a new root defect that has not already dealt damage.
- Its expected output or invariant is clearly supported by the frozen task or source text.

When the target-relative overlay also applies to the starting commit, the
baseline result is recorded but is not itself an acceptance gate: a useful
regression test will often fail there because it reproduces the bug in the
user's task. These checks still do not prove that a test is
semantically correct. The attack verifier must confirm textual support before
damage is applied. Unsupported or genuinely ambiguous expected behavior is
`unproven`, misses, and deals recoil. The report must label landed attacks as
additional evidence, not ground truth.

### Repair reproducers and regression checks

Every mechanically landed defect keeps its executable reproducer. After each
repair attempt the harness runs the required check, every active reproducer,
and every previously healed defect's regression check. A repair heals only the
exact active damage whose evidence now passes. For judge-based defects whose
mechanics remain unavailable, an immutable digest-bound repair judgment records
`repaired`, `not_repaired`, or `unable`; `unable` leaves damage active and
degrades coverage.

### Bounded failure handling and judge fallback

Every distinct model, parse, Git/filesystem, service, transport, capability, or
command failure receives one targeted retry from the failed stage. Attempt one
is persisted before attempt two begins, validated upstream artifacts are reused,
and a third attempt is prohibited. Repeated evidence executions required for
stability are validation samples, not retries.

After attack mechanics exhaust that allowance, the neutral judge may receive
only a schema-valid immutable attack with a claim, oracle, target, and concrete
patch or evidence facts. Definitive confirmation deals full frozen-severity
damage; semantic rejection applies ordinary rank recoil; task-supported,
concretely evidenced but mechanically unavailable behavior deals exactly 35%;
and `unable` changes no score while leaving coverage unresolved. A valid
`unable` verdict is terminal. Implementation, repair availability, required
validation, and final validation are never converted into contestant damage.

The failure-handling ledger records the stage, two-attempt ceiling, diagnostic
links, reused artifacts, terminal disposition, confidence effect, and exact
score effect. Unresolved run-level validation preserves only a provisional
ledger leader until the digest-bound coverage decision resolves the run.

### Deterministic harness retries

Contestants do not edit the referee. New runs use deterministic, harness-owned
service setup, worktree preparation, capability adapters, timeout enforcement,
and diagnostics. They do not invoke a harness-maintainer model or apply a
generated run overlay. A defect in Agent Arena produces diagnostics and a
normal product fix; the installed referee is never rewritten mid-fight.

The reliability target is:

- Zero unhandled harness failures.
- Zero health changes or winner decisions caused by harness failures.
- Every confirmed harness failure becomes a regression fixture.
- At least 99.9% of attack evaluations complete without an infrastructure
  accommodation once the product reaches stable release.

### Severity-based damage

Every contestant starts with 100 HP. A landed adversarial test that fails
against a contestant deals damage based on the impact of the defect it proves,
not on how many assertions or test cases the attacker submitted:

| Severity | Damage | Meaning |
| -------- | -----: | ------- |
| Critical | 50 HP | Security boundary bypass, data loss or corruption, or another catastrophic failure with executable evidence. |
| High | 30 HP | A core acceptance criterion fails, normal usage crashes or hangs, or a major regression produces incorrect results. |
| Medium | 15 HP | A realistic edge case or secondary requirement behaves incorrectly. |
| Low | 5 HP | A limited robustness or measurable performance issue with narrow user impact. |

Style preferences, speculative concerns, and non-executable critiques deal zero
target damage and trigger recoil. Multiple tests demonstrating the same root
defect are one attack and deal target damage once; agents cannot increase damage
by splitting one defect into many test cases or resubmitting it in a later
round.

The attacker proposes a severity and impact statement, but does not control the
final damage. A neutral, anonymized attack verifier confirms relevance and the
root defect, then selects one level using the fixed rubric. The verifier sees
the task, claim, test patch, and reproduced behavior, but not agent identities.
Its verdict and written rationale are saved in the report. It must choose the
lowest severity fully supported by the evidence; disputed or ambiguous High and
Critical ratings are capped at Medium for the MVP.

Damage is shown when the attack first lands. At repair, the contestant receives
every active defect that still has allowance and focused diagnostics. It heals
exactly the applied amount only when repair validation succeeds. Otherwise the
damage remains, and fixing the defect in a later attempt can still restore that
HP. Each defect can have only one active
damage entry: a later regression can reactivate it, but can never stack another
copy. Severity belongs to the proven defect and does not change based on which
contestant it hits.

Both agents submit attacks before any result is revealed. The harness validates
the whole round, then applies target damage and recoil simultaneously. An agent
reduced to 0 by the combined round resolution is considered downed and still
receives that round's repair opportunity. It is eliminated only if it remains at
0 after the repair validation. Recoil cannot be healed. Health is clamped
between 0 and 100.

### Health-based ranking

A contestant is eliminated if its final patch cannot be applied or fails the
configured original validation command; required-check elimination sets its
health to 0 regardless of adversarial damage. A contestant that remains at 0 HP
after a round's repair is also eliminated. If only one contestant remains, the
fight ends early. Otherwise, after three normal rounds:

1. Highest final HP wins.
2. Lower final patch size wins only as a tie-breaker.
3. If still tied, the result is a draw.

Cost and duration are shown but do not affect health. The verifier's constrained
relevance, root-defect, and severity verdict is the only model-assisted
adjudication step. Execution determines the behavioral pass/fail outcome, and
the published damage and recoil tables determine its numeric effect.

### The user owns the merge

Agent Arena distinguishes the health-ledger arena champion from the
correctness-first recommended patch. A patch cannot be applied until a human
accepts an exact contestant, base commit, prompt, and full patch digest.
`agent-arena apply` refuses pending, rejected, stale, or mismatched decisions
and retains the clean-tree and `git apply --check` guards.

Acceptance is not delivery permission. Optional GitHub branch, pull-request,
issue-linkage, and merge operations require a second authenticated decision for
the exact repository and action. Delivery is idempotent, never force-pushes,
stops when a reviewed PR head moves, and monitors an authorized
merge-after-checks request until success or terminal failure. GitHub delivery
and merge are independently disabled by default; release and deployment are
not part of the MVP.

## Configuration

Command-line flags are sufficient for the first run. An optional
`agent-arena.yaml` makes repeated runs convenient:

```yaml
test: npm test
integration:
  setup: docker compose up -d postgres
  check: npm run test:integration
  teardown: docker compose down --volumes
  services: [postgres]
  steady_state_invariants:
    - health endpoint is ready
    - seed account can complete a known-good request
  fault_controls: [timeout, disconnect, restart]
agents:
  - codex
  - claude
judge: codex
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
sources:
  - github_issue: 241
  # - github_pr: 87
  - spec: docs/session-refresh.md
limits:
  rounds: 3
  attacks_per_round: 3
  implementation_minutes: 15
  attack_minutes: 8
  verifier_minutes: 2
  repair_minutes: 8
selection:
  enabled: true
review:
  required_for_apply: true
delivery:
  enabled: false
  merge_enabled: false
```

Explicit CLI flags override the file. The MVP recognizes common repository
instruction files such as `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and
`.github/copilot-instructions.md`, but it does not attempt broad framework or
service discovery. The verifier may use any installed supported adapter,
including one of the contestants, but always receives anonymized evidence in a
fresh invocation; the report identifies which provider performed the rating.
Pull-request sources are requirements-only by default. `--base-from-pr` or
`base_from_pr` is the explicit choice that freezes and fetches the reviewed PR
head as the identical contestant base; no reference diff is shared by default.

`attack_verifier` and `--verifier` remain temporary aliases for `judge` and
`--judge`; they emit deprecation warnings. Quality-verifier,
harness-maintainer, house-scout, and held-out-case settings are accepted with a
warning and ignored for new runs. Completed older runs remain readable with
their original provenance, while an interrupted pre-change run must restart
instead of resuming across contract versions.

### Round prompts

Yes: every round has its own prompt. The harness composes it from:

1. A fixed common contract: task sources, frozen patch, rules, rank recoil,
   output schema, permissions, budgets, prior root defects, and current health.
2. The round brief from the final structure above.
3. A deterministic repository method pack chosen from detected language,
   framework, changed surfaces, and approved capabilities.

Round 1 asks the agent to map requirements to observable behavior. Round 2 asks
for a diverse hypothesis portfolio and systematic probes rather than three
variations of the same example. As advisory options, its method pack suggests
loading a genuine prior-version artifact when versioned contracts or durable
readers change, and tracing a production failure through retry, recovery,
persistence, and resume when retry or recovery policy changes. Agents skip
these probes when the changed surfaces make them irrelevant. Round 3 supplies the approved integration
topology, test identities, dependency contracts, fault controls, and
steady-state invariants. Repair and judge prompts remain separate because their
allowed evidence and success conditions differ.

Prompts, method-pack versions, tool versions, random seeds, and hashes are saved
with the run. Contestants receive identical common and round prompts; only the
opponent patch and agent-specific health history differ. Probe suggestions never
contain a hidden expected answer and the attack verifier does not see the
attacker's confidence or reasoning.

## Run artifacts

Every fight creates a self-contained directory under `.agent-arena/runs/<run-id>/`
containing:

- `BATTLE.md`: complete evidence-linked narrative, phase replay, decisions, and
  final test matrix.
- `BATTLE.html`: responsive, clickable dossier generated from the same run data.
- `BATTLE.svg`: deterministic share image with the result and round digest.
- `run-spec.json`: exact task text, explicit acceptance criteria, frozen sources,
  base commit, topology, commands, budgets, permissions, and deterministic hash.
- `permissions.json`: requested scopes, user decisions, leases, omitted checks,
  and redacted provisioning results.
- `result.json`: compact schema-v8 status, stage, contestant health, outcome,
  recommendation, warnings, artifact pointers, provenance, and ordered
  applied-envelope ledger. Detailed state is rebuilt from `baseline.json` and
  `rounds/<round>/envelope.json`; the immutable `finalization.json` projection
  supplies post-round validation and recommendation details.
- `rounds/<round>/adjudications/`: complete local immutable semantic verdicts, frozen
  severities, evidence provenance, retry diagnostics, canonical-defect history,
  exact score effects, and upgrade links. Pre-change completed runs remain
  reportable as read-only legacy artifacts with `legacy_unknown` provenance;
  interrupted legacy runs require a restart.
- `rounds/<round>/repair-judgments/`: immutable, digest-bound judge decisions
  for defects whose repair cannot be confirmed mechanically.
- `feedback/`: schema-v3 deterministic, digest-linked role-safe agent
  projections targeting 8 KiB and capped at 24 KiB. Private transcripts,
  verbose judge rationale, and opponent-only evidence are never projected.
- `runtime-manifest.json`: repository, frozen-source, dependency, runtime,
  provider/model, command, capability, and service fingerprints for resume
  drift checks.
- `checkpoints/`: sealed-boundary descriptors for read-only replay and future
  fork UI. Invoking agents from history creates a fork with a new run ID.
- `prompts/`: rendered common, implementation, attack-round, repair, and judge
  prompts with versions and hashes.
- `submissions/<round>/<phase>/<actor>/raw.txt`: immutable exact provider bytes.
- `submissions/<round>/<phase>/<actor>/parsed.json`: fault-isolated parse and coverage telemetry.
- Legacy house and case artifacts remain readable but are not written by new runs.
- `methods.json`: selected method packs, probe cards, tool versions, and seeds.
- `patches/<agent>.diff`: each final implementation.
- `attacks/round-<n>/<agent>/<rank>.diff`: every ordered attack patch.
- Each rank overlay includes its declared shared support and can replay independently.
- `rounds/<round>/failures/`: normalized bounded-failure records and diagnostic
  artifact pointers.
- `logs/`: harness command logs and provider transcripts.

Generated worktrees are temporary and may be removed after the report is safely
written. Run artifacts are retained until the user deletes them.

## Failure behavior

Failures should be useful and recoverable:

- A missing agent CLI or invalid test command stops the fight before agents run.
- A contestant that exceeds a declared implementation or repair budget in an
  otherwise healthy environment fails that stage; a process-launch, provider,
  authentication, or network failure is infrastructure and does not cost HP.
- Provider and shell-validation deadlines return control within the configured
  budget plus a 1.5-second cleanup grace. The harness closes its output pipes,
  terminates only identity-verified run-owned descendants even after session or
  process-group changes, reaps the direct child, and records signal escalation,
  cleanup completion, duration, survivors, and transport or MCP failures
  independently.
- If both implementations still fail required validation after round 1's repair,
  there is no winner.
- If an attack is invalid, flaky, blocked, or self-defeating, it misses, the
  report explains why, and its author takes rank-based recoil.
- Harness-owned failures are retried in a clean worktree and never cause damage,
  recoil, healing failure, or elimination.
- An attack-level infrastructure failure receives one targeted retry before an
  eligible immutable attack may use judge fallback; unresolved coverage has no
  health effect.
- A user-denied optional capability marks the affected attack
  `capability_denied`; it has no health effect.
- A denied or unavailable required capability blocks preflight unless the user
  explicitly accepts a reduced validation contract.
- An unresolved infrastructure failure during implementation, repair, required
  validation, or final validation makes the run inconclusive instead of blaming
  a contestant.
- `Ctrl-C` stops child processes, saves partial logs, and removes temporary
  worktrees when safe.
- Unexpected harness failures preserve enough state to diagnose or resume
  manually.

## Research basis

The final structure combines methods that expose different classes of defect:

- [SWE-bench](https://arxiv.org/abs/2310.06770) grounds the arena in real
  repository issues that require cross-file context, environment setup, and
  executable validation; [SWT-Bench](https://arxiv.org/abs/2406.12952) reports
  that issue-derived generated tests can materially improve the precision of
  agent patch selection. This supports the immutable issue/PR contract and
  attack-as-test format.
- [SWE-agent](https://arxiv.org/abs/2405.15793) finds that the
  agent-computer interface materially affects performance. This supports
  explicit round prompts, structured submissions, method packs, and narrow
  tools instead of a vague repeated “find bugs” instruction.
- Google's study of
  [15 million mutants](https://research.google/pubs/long-term-effects-of-mutation-testing/)
  found evidence that mutation-guided test improvement is coupled to real
  faults, while Google's
  [fuzzing experience](https://research.google/pubs/reducing-time-to-fix-for-fuzzer-bugs/)
  reports tens of thousands of security and robustness findings. These become
  round-2 probe generators, never standalone verdicts.
- A study of
  [198 production failures in distributed data-intensive systems](https://www.usenix.org/publications/login/feb15/yuan)
  found that incorrect handling of non-fatal errors dominated catastrophic
  failures. Research on
  [concurrency heisenbugs](https://www.usenix.org/conference/osdi-08/finding-and-reproducing-heisenbugs-concurrent-programs)
  shows why controlled schedules and reproducible traces matter. These findings
  motivate error paths, partial failure, concurrency, and recovery as explicit
  targets.
- The [Google SRE testing chapter](https://sre.google/sre-book/testing-reliability/)
  separates unit, integration, release, and distributed-system testing and
  emphasizes known-good/known-bad requests, timeout behavior, configuration,
  repeated runs, and test reliability. The
  [Principles of Chaos Engineering](https://principlesofchaos.org/) add a
  steady-state hypothesis, realistic faults, control/experiment comparison, and
  minimized blast radius. These shape the isolated round-3 integration lane.
- The
  [OWASP Web Security Testing Guide](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/00-Introduction_and_Objectives/)
  covers configuration, identity, authentication, authorization, sessions,
  input validation, error handling, cryptography, business logic, clients, and
  APIs. Round 3 translates the relevant categories into permission-aware,
  executable security evidence.

The cross-reference is intentionally many-to-many: no single technique covers
the whole bug taxonomy. The arena uses agent creativity to form hypotheses,
specialized methods to expose candidates, deterministic execution to reproduce
behavior, and the frozen RunSpec text to decide what output is supported.

## Definition of done

The MVP is ready when a new user can:

1. Install the CLI and run one documented command in a small TypeScript or Python
   Git repository.
2. Observe two supported agents working from the same commit in isolation.
3. Review one explicit permission plan and see which capabilities are agent,
   harness-only, approved, or denied.
4. Receive two independently generated implementation patches.
5. Observe three attack–repair rounds unless an early elimination ends the
   fight, with at most one retry for each distinct failure.
6. See zero to three ranked attacks per agent per round land or miss for a
   stated, reproducible reason.
7. See severity damage, miss recoil, repairs, heals, and health after every
   round.
8. Observe independently replayable rank overlays include shared support while
   malformed ranks remain isolated from valid siblings.
9. See integration discovery select the simplest sufficient environment and
   record any escalation.
10. Receive a deterministic final matrix, recommendation or draw, and complete
   Markdown, HTML, SVG, and JSON artifacts.
11. See deterministic harness accommodations applied symmetrically, validated,
   and recorded without affecting health.
12. Apply the recommended patch with a command and independently rerun the
    tests.

The launch demo should additionally show an adversarial test finding a real
defect that the repository's existing tests missed. That is the clearest proof
that the arena is more than parallel agent execution.
