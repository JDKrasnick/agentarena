# Agent Arena MVP

## What we are building

Agent Arena is a local command-line tool that asks two coding agents to solve the
same repository task, then runs a task-scaled sequence in which they attack the opposing
solution and repair their own. It publishes a winner only when the competitive
evidence differentiates the solutions, and otherwise preserves the exact result
and any independent recommendation without overstating it.

The MVP exists to prove one idea:

> Does an adversarial attack-and-repair round produce a better patch than simply
> running multiple coding agents and choosing the first patch that passes?

The result is confidence-qualified. New runs use exactly two contestant adapters
and one fresh, identity-blind judge adapter. Duel and catch-up require both
directions in every executed attack round; siege requires attacker-to-defender
in every executed round. Every required coverage-v3 lane records `review`,
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

Attack submissions may identify a prior adjudication as a challenge. Matching
assertion fingerprints and normalized browser family, profile, target, and
non-assert action sequences also supply likely prior decisions to the same
judge call, bounded to six same-target records. The judge returns an
independent, affirm, overturn, or unresolved relationship with its rationale.
Affirmations never score twice; overturns append recoil refunds or defect-damage
corrections and mark withdrawn defects superseded; unresolved challenges keep
the prior score temporarily but prevent full-confidence completion.

Unresolved required coverage preserves the health-ledger leader as provisional
but publishes no champion or recommended patch. `agent-arena
resolve-coverage` requires the current assessment digest: `accept-reduced`
promotes the leader with reduced confidence and unlocks ordinary patch review,
while `inconclusive` finalizes without a winner or recommendation. Legacy runs
without an assessment are labeled legacy/unknown rather than assigned a new
confidence claim. Required capability gaps stay visible even when the user
accepted a reduced validation contract.

Complete duel or catch-up coverage can instead produce a successful
`non_discriminating` result: both final patches must be applicable and pass
required validation, active defect damage must be equal, and no still-valid
contestant-authored differential landing may exist. Repaired competitive
landings still discriminate, while later-overturned decisions do not. This is
not a draw and publishes no champion; recoil, raw HP, shared neutral findings,
repair history, and patch size remain visible evidence only.

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

New runs write the v2 pre-review contract with an overall terminal status and a
separate eligibility, cause code, and diagnostic-artifact list for each
contestant; completed v1 records remain readable. Classification precedence is
external cancellation, harness infrastructure, provider transport/MCP/auth or
reconnect evidence, contestant timeout or failed invocation, then patch
applicability and required validation. Transport evidence supersedes timeout or
nonzero exit only when no usable implementation result was produced. Aggregate
provider initialization metadata is ignored for transport classification.
Optional MCP startup warnings remain in diagnostic logs but do not escalate
when the provider exits successfully or continues useful work. An
invocation-level transport failure stops the peer implementation with a
phase-local controller and records that peer as transport-cancelled rather than
failed.

After the normal targeted retry, every provider-backed stage may recover only
from a causally established provider infrastructure failure that produced no
usable terminal result. This includes implementation, review, attack
construction, repair, judge, and semantic-adjudication work. Transport-shaped
output is diagnostic evidence rather than a verdict, so a stale MCP warning
cannot override a valid stage result.

The harness launches at most three fresh backend-authenticating sentinel probes
in a shared 30-second window. A successful probe creates a linked child run
that retains validated upstream state and sealed rounds, discards incomplete
dependent work, and continues from the failed stage. Frozen task sources, base
commit, topology, permissions, MCP allowlist, budgets, and configuration remain
unchanged; live issues and pull requests are not fetched again. Recovery
artifacts record probe results, failed stage, causal evidence, disposition,
continuation ordinal, replacement run ID, and the full run-ID chain.

Two continuations are the hard chain-wide cap, and one provider may trigger at
most one continuation. After capacity is exhausted, the first unrecovered
review or attack failure follows ordinary coverage semantics and the second
unrecovered provider-stage failure anywhere in the chain makes the fight
inconclusive. Implementation, repair, correctness-critical judge work,
required validation, and final validation remain immediately inconclusive when
their results cannot be trusted.

The command layer returns the final run ID, status, and rendered summary. The
built CLI exits `0` for a completed battle, draw, or valid duel forfeit; `2` for
a persisted inconclusive run; `130` for cancellation; and `1` for persisted
internal failure, invalid configuration, or an uncaught command error. Recovery
prints the complete run-ID chain and returns the last replacement's exit code.
Resume renders a stored terminal result and never invokes stages skipped by the
terminal outcome.

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
  --effort auto \
  --permissions confirm \
  --test "npm test"
```

Agent Arena then:

1. Reads and hashes the exact task, explicitly supplied acceptance criteria,
   referenced issue/PR/specification text, repository instructions, and bounded
   static repository evidence in memory.
2. Discovers the complete required capability set and presents one permission
   and authentication plan for the user to approve, modify, or deny.
3. After approval, freezes the in-memory inputs into an immutable RunSpec, then
   checks the repository, Git state, required executables, and test command.
4. Creates an isolated Git worktree for each contestant at the same commit.
5. Gives both agents the same RunSpec, repository instructions, limits,
   and test command.
6. Captures each implementation as a patch and runs the configured test command.
7. Runs one to five task-scaled attack–repair rounds with different investigation briefs:
   - Round 1 attacks specification compliance and local correctness.
   - Round 2 attacks boundaries, state, data, concurrency, and hidden test
     weaknesses with systematic probe methods.
   - Round 3 attacks real integrations, configuration, security boundaries,
     partial failure, recovery, and resource behavior.
   - Round 4 generalizes an independently qualified damage-bearing defect.
   - Round 5 tests recurrence, durability, and recovery for a newly qualified
     extension trigger.
   In each round:
   - The harness freezes both current patches.
   - Both agents get an extended read-only review phase and produce structured
     target-specific findings.
   - The harness creates a fresh v2 trusted evidence-handoff packet for each
     target lane under
     [`TRUSTED_EVIDENCE_HANDOFF_RFC.md`](TRUSTED_EVIDENCE_HANDOFF_RFC.md),
     validates its target and permission fingerprints immediately before use,
     and injects it immediately before attack instructions.
   - Each agent inspects the frozen target in its assigned worktree and submits
     zero to three sparse, uniquely ranked executable attacks.
     `AttackSubmissionV2` includes oracle metadata, a focused command, required
     capabilities, disjoint rank-specific paths, and optional shared support
     paths copied into every independently replayable target-relative overlay.
     `attacks: []` explicitly records that no reviewed hypothesis is credible.
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

The rounds are a progressive investigation, not copies of the same
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
| Round 4 — generalization extension | Generalize only the newly qualified damage-bearing defect, or complete a remaining repair allowance for an active accepted defect. | Adjacent inputs, equivalent transitions, related protocols, and invariant variants tied to the trigger. |
| Round 5 — durability extension | Probe recurrence, restart, recovery, and durability for a newly qualified trigger. | Persistence/restart checks, recurrence tests, recovery invariants, and bounded failure sequences. |
| Final validation | Re-run the required suite and every already accepted arena check. It discovers no score-changing surprise after the last repair opportunity. | A deterministic patch-by-check matrix and health-ledger replay. |

`effort: auto` runs one identity-blind assessment after readiness and before
implementation. The judge scores change surface, behavioral complexity,
validation burden, and operational risk from 0–2. Score bands select ultra-low,
low, medium, high, or ultra-high; security, authorization, migration,
concurrency, irreversible-data, and external-system risks impose a high floor,
and confidence below 0.7 promotes one tier. One failed assessment is retried;
two failures produce a recorded medium fallback.

The five profiles plan 1/1/2/3/3 rounds with 15/20/25/45/60-minute round
envelopes, 6/8/10/14/18 provider calls per round, and
500k/750k/1.5m/4m/7m tokens per round. Convergence is evaluated after each
sealed round. At most two independently qualified extensions may run, never
past round 5. An extension requires a new damage-bearing canonical defect,
including partial-judge damage, or an active accepted defect with repair
allowance remaining. Findings outside that scope are recorded with no scoring
effect. `--rounds 1..5` is an exact fixed override using medium timings; it
disables adaptive behavior and cannot be combined with `--effort auto`.

Every adaptive decision persists competitive landings, shared findings,
explicit-empty lanes, low-signal state, and its consecutive streak. A first
low-signal boundary makes any already-planned next round pivot to its distinct
theme and forbids repeated claims or probe shapes without new evidence. A
second consecutive low-signal boundary stops with `repeated_low_signal`.
Competitive evidence, unresolved adjudication, or active damage resets the
streak. Fixed rounds remain exact and carry the pivot without stopping early.

Round 3 is the proactive integration round, but integration is not deferred until
then. Required repository integration tests run during baseline and after every
repair, and an agent may submit a well-supported integration attack in any
round. Round 3 adds the provisioned test environment and a focused search for
cross-component failures. It does not grant production access.

Before focused failure analysis, each agent receives a separate
`review_minutes` budget for read-only inspection of the opponent's frozen patch.
The budget defaults to 10 minutes and has a 10-minute ceiling. Every provider
and judge invocation records normalized message, tool lifecycle, progress, and
result activity without tool arguments or private reasoning. A review deadline
still terminates and cleans up the owned process tree. Only a complete
schema-valid `valid` or `valid_empty` file already present after cleanup is
salvaged into the normal handoff path; the underlying invocation stays
`timed_out`. Partial, invalid, and missing output follow the existing one-retry
path.

The resulting v2 packet records harness-attested target and complete resolved
permission fingerprints plus at most 12 ordered reviewer hypotheses. Each
hypothesis includes its invariant, structured observations and provenance, code
locations, trigger sequence, oracle and task-source rationale, expected
behavior, confidence, required capabilities, and focused regression plan. Stable
finding IDs reject exact duplicates while preserving the first priority; they
never identify canonical defects. Deterministic tail compaction records omitted
IDs and enforces a 16 KiB canonical UTF-8 ceiling.

Immediately before attack invocation, the harness recomputes both fingerprints.
A stale or malformed packet skips invocation and receives one targeted review
refresh; a second failure loses coverage for that lane. Repair, target mutation,
permission changes, and round transitions invalidate packets immediately. A
typed `handoff_blocker` containing affected finding IDs and missing permission
or context is mutually exclusive with attacks and receives one targeted
refresh; persistence loses coverage without damage or recoil. A valid
`attacks: []` is instead successful packet consumption and completes the lane.

The packet is engineering evidence rather than hidden chain-of-thought. Every
observation remains explicitly a reviewer hypothesis; the packet excludes
private implementation transcripts, private reasoning, provider identity,
credentials, and raw frozen patch bytes. Only the reviewer that produced it
receives it immediately before the attack instructions and inspects the target
through the assigned worktree. Repair prompts contain verifier-confirmed tests
rather than raw findings, and only committed attacks can land or recoil. Cited
files, nearby tests, and direct dependencies remain inspectable. Broader
repository rediscovery is allowed and warned about when visible, then recorded
as `targeted`, `broad`, or `unknown`; this telemetry never affects health,
scoring, retries, coverage, or selection.

Normal attacker context contains only the current lane-safe summary and active
v2 packet. When the handoff is stale, malformed, or blocked, the attacker may
read at most one directly referenced diagnostic artifact of 8 KiB or less. The
harness does not traverse pointers from that artifact. Lifecycle sidecars stay
internal and add no report section, observatory element, or human drill-down
control.

Only v2 handoffs are supported. New runs and resumes reject v1 packets and do
not read, migrate, rewrite, or consume them. Existing generic legacy-run
support outside reviewer handoffs is unchanged.

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
- One to five task-scaled attack–repair rounds.
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
- Arena-generated container environments, network sandboxes, hard confinement
  of agent or test subprocesses, GPU workloads, and mobile builds. Running a
  user-supplied Compose profile is allowed.
- Production credentials or enterprise-grade secret management.
- Automatic MCP reauthentication, credential inspection, global provider
  configuration mutation, remote MCP repair, and mid-run capability expansion.
- Replaying sealed rounds or resetting recovery budgets per child run.
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

If an explicitly referenced issue, PR, or specification cannot be fetched,
preflight stops before approval. The user must make the source retrievable,
provide a local specification with `--spec`, or supply the complete task text
directly; a new run never proceeds with an incomplete task contract.

Pre-permission reconnaissance is a narrow read boundary. It may inspect only
the exact task sources, known manifests and lockfiles, browser-test
configuration, literal package scripts, framework route metadata, and known
instruction files. It keeps all content in memory and hashes the full input.
Text evidence is capped at 256 KiB per file and 2 MiB total. Lockfiles are
stream-hashed and represented by digest and size rather than retained text.
Local specs must remain inside the repository after canonical path resolution,
including symbolic links. The only pre-approval GitHub CLI operations are the
fixed read forms `gh issue view`, `gh pr view`, and `gh repo view`; constructive
or destructive Git and GitHub operations remain forbidden.
It must not create artifacts or worktrees, inspect repository cleanliness,
resolve or fetch commits, execute repository commands or project code, start
agents, launch browsers or servers, or install packages. After consolidated
approval, the harness persists `reconnaissance.json`, source snapshots, and the
resolved permission policy before performing Git and runtime preflight.

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

The window includes Classic Shell, Developer Dashboard, Night Transit, Test Lab,
Live Arena Broadcast, and 16-Bit Tactics themes. Classic Shell is used until a valid local
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
a bottom status bar keeps the run identity and state visible. Night Transit
projects append-only battle telemetry into two contestant lines, real round
stations, a verification interchange, and a consolidated arrivals board. Test
Lab uses opposing benches, a central experiment sheet, invocation timestamps
and durations, health-history charts, check grids, and a recent-test tray. Both
renderers use only recorded dashboard facts, retain live Inspect and cancellation
actions, move side rails below the workspace at narrow widths, and make replay
explicitly read-only. 16-Bit Tactics
uses a code-native tile field, tactical nodes, authoritative attack and repair
routes, opposing status bars, inspection commands, an evidence channel, and a
structured in-map readout for the latest recorded event. It
keeps the complete cartridge HUD visible at desktop widths and derives compact
work nodes from recorded contestant invocations rather than invented game
state. It does not bundle third-party game characters, logos, sprites, or
screenshots. Stored `night-edition` preferences migrate to `night-transit`;
`sticker-league` preferences migrate to `developer-dashboard`; `evidence-deck`
and `monster-battle` preferences migrate to `retro-tactics`.

### Permission discovery, approval, and audit

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

The plan discovers requested authority, obtains a user decision, gates whether
required run stages may start, and creates an immutable audit record. Approval
does not restrict the ambient filesystem, network, credential, or process
authority of a native agent or test subprocess. Hard confinement requires the
separate strict-worker execution backend tracked in #68.

The user can choose one overall mode:

- `auto`: automatically approve only capabilities on the configured safe
  allowlist with `enforced` or `brokered` boundaries, such as local test
  commands, repository reads, ephemeral databases, and approved read-only issue
  access.
- `confirm`: show one consolidated preflight plan and ask the user to approve,
  change, or deny each material capability.
- `deny`: deny capabilities unless explicitly allowed in configuration.

### Browser and DOM validation

The static browser planner consumes the approved reconnaissance snapshot and
never executes configuration. Task evidence makes `browser_dom_validation`
required when it names visible UI, interaction, responsive behavior,
accessibility, persistence, browser, or DOM requirements. Task evidence means
the task statement, its acceptance criteria, and resolved issue, pull-request,
or specification sources. Standing instruction files such as `AGENTS.md` and
`CLAUDE.md` are excluded: they describe the repository rather than the task and
routinely use words like "render" or "navigation" for unrelated reasons.
Frontend evidence found only in instruction files, manifests, scripts, routes,
or literal browser configuration makes the capability optional; otherwise it is
absent.

Profile resolution uses this order: explicit `browser` configuration, literal
Playwright/Cypress configuration, recognized package scripts, then unavailable.
Arena does not guess between monorepo applications. An explicit profile names
`runner`, `startup`, `health_url`, `base_url`, `test`, optional `teardown`, a
native-suite service mode, projects, and allowed origins. The main permission
request is `harness_only` and scoped to exact commands and loopback origins.
Arena-managed probes broker their HTTP and WebSocket traffic, but the unchanged
repository-native command has no cross-platform network sandbox. The combined
capability therefore advertises `advisory` enforcement and cannot be silently
approved in `auto` mode. Every non-loopback origin is still a separate exact,
explicit capability; package installation, browser downloads, and wildcard
origins are never implied.

Each contestant runs in its own patched worktree and service process. Readiness
polling, timeouts, process-group teardown, fresh contexts, and clean storage are
harness responsibilities. The readiness window scales with the stage budget
rather than using a fixed constant, so a contestant whose patch makes the
service slower to boot is not misread as an application failure; the repository
suite is likewise capped below the full budget so it cannot starve the probes. Generated probes use Chromium desktop 1440×900,
mobile 390×844 with touch, or a 320 CSS-pixel reflow check. The attacking agent
chooses the task-specific probe family, profile, accessible actions, and
expected behavior from this safe envelope. Repository browser projects are not
translated into Arena profiles: the repository's configured browser command
and complete project matrix run unchanged as the native suite. Requests outside
approved origins are blocked and recorded for Arena-managed HTTP(S) and
WebSocket traffic. `ws` and `wss` use the corresponding approved HTTP transport
origin. The approval UI states that a native repository runner retains the host
account's network authority.

Arena-managed Chromium runs headlessly. After a managed session becomes ready,
the live observatory shows an `Open browser` action for the resolved approved
application URL and removes it when the session stops. The action never opens
automatically and launches a separate user-controlled browser view with storage
independent from the evidence context; activity there cannot affect the probe
result. The action sits beside the contestant using the session, names that
contestant, and carries its live accent color for the temporary lifetime.
Harness-owned baseline sessions appear in the neutral current-event area and
are labeled Arena rather than assigned to a contestant.

Runtime-error/DOM-integrity, accessible-name, and 320 CSS-pixel overflow smoke
probes are mandatory on every browser run; the attacker-selected probe is
additive. Because the repository never opted into the mandatory probes, they
fail only on uncaught runtime errors and their own family invariant. Console
messages and requests to unapproved origins are recorded on the result and in
artifacts but do not fail a mandatory probe: an approved profile allows exactly
the application's own origins, and ordinary applications legitimately reference
CDNs. A contestant-selected probe states its own expected behavior, so console
errors and blocked origins do fail it, which is what makes an undeclared
network dependency a usable attack. A browser-only attack may omit repository paths and a focused command.
The harness records it as reproducible evidence only after it passes on the
author worktree, fails on the target worktree, and survives normal oracle
adjudication. More complex flows use repository-authored tests or fixtures and
their focused command rather than adding general-purpose script to the probe
DSL.

Built-in Playwright, Cypress, and custom adapters use `playwright-core` with an
already installed Chrome/Chromium binary for Arena-managed navigation,
isolation, and artifacts. The adapter does not replace the repository runner;
Playwright, Cypress, WebDriver, or other repository tests still execute through
the exact approved native command.

An explicit profile may set `port_mode: dynamic` when its startup command
honors the harness-provided `PORT`. The permission scope then covers a dynamic
port on the exact loopback protocol and host. Fixed-port profiles continue to
run comparative lanes sequentially. Native-suite results are reused within the
run only when the exact command and immutable patch bytes match; service and
probe lifecycles are never skipped.

`native_suite_mode` is `reuse_started_service` by default. Both modes receive
`PORT`, `BASE_URL`, `PLAYWRIGHT_BASE_URL`, and `CYPRESS_BASE_URL` for the
resolved runtime address; the modes differ in who owns the service lifecycle,
not in who chooses the port. `reuse_started_service` runs against the service
Arena already started. `self_managed` runs the native suite first and expects
it to bind the reserved port itself, before Arena starts its probe service.
Literal Playwright configurations with a `webServer.command` resolve to
`self_managed`, avoiding duplicate ownership of the configured port.

The reviewer decides whether an already approved external origin is appropriate
evidence, but cannot add an origin after consolidated approval. Authenticated
routes, credential sources, and ephemeral storage-state handoff remain
deliberately unsupported pending #66; secret-dependent checks are unverified.

Probe families cover role/name/label-based interaction, responsive overflow and
clipping, keyboard/focus behavior, accessible semantics, declared persistence,
console/runtime/hydration/DOM integrity, risk-triggered inert DOM-XSS canaries,
and existing visual snapshots without creating or updating baselines. Core
accessibility checks do not constitute automated WCAG conformance.
The bounded `fill_dom_xss_canary` action selects an accessible field by label;
the harness supplies an inert markup sentinel and fails the probe only when the
application interprets that sentinel as DOM markup.

Functional assertions are not retried. Browser/server infrastructure gets one
bounded retry; teardown runs after every attempt. Results are `verified`,
`failed`, or `unverified`, with structured reasons for denial, missing tools or
browsers, launch/health failure, blocked origins, and interruption. Real
application failures remain valid evidence. Harness failures cause no damage;
required unverified coverage flows into the provisional/inconclusive process,
while optional gaps remain diagnostic.

Failure attribution uses a baseline control. The resolved service lifecycle and
native suite first run on the unpatched base. If that control cannot launch,
become healthy, or pass, the result is a harness/configuration failure. If the
control passes and the same bounded validation fails deterministically only on
a contestant worktree, it is a contestant application failure. Ambiguous cases
remain unverified and cannot affect health.

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

The MVP permission system is not a hostile-code sandbox. `brokered` means the
harness withholds and injects a capability, but may not prevent an agent process
from using other authority already available to the current OS user.
`advisory` means the restriction exists only in policy and prompts. Preflight
must display this distinction and cannot claim that an advisory denial is
enforced. Users handling sensitive repositories should run Agent Arena from a
sanitized account or external container and keep production credentials absent.

Native provider and repository execution is represented as a required,
high-risk advisory capability whose scope names the ambient filesystem, process
environment, network, and configured provider integrations. `--yes` displays
the same consolidated plan and native-runtime warning before it records
non-interactive approval.

Both contestants receive the same post-approval capability manifest. An attack
may request an additional optional capability, but it is paused until a policy
decision is available:

- Approved: provision a run-scoped lease and execute the attack for both patches.
- Denied by the user: mark `capability_denied`; no target damage or author recoil.
- Provisioning fails after approval: mark `infrastructure_error`; no health
  effect.
- Already listed as denied and knowingly requested again: mark the attack
  invalid and apply normal miss recoil.

Before worktree creation or any provider session, Arena inventories MCP servers
from every selected provider setup. Inventory records only provider, server
name, enabled state, authentication readiness, requested role, and requirement
level; credentials are never read, copied, or displayed. A failed inventory is
recorded as `unknown`, not as an empty setup.

The operator selects exactly one MCP policy for the run: `keep_configured`
enables only servers named in Arena configuration; `configure_selection` uses
an explicit subset of discovered servers; and `leave_as_is` approves the exact
enabled provider snapshot. `leave_as_is` is unavailable if any provider
inventory is unknown, so the operator must provide explicit Arena configuration
or stop.

Selected servers receive isolated readiness checks before launch. Ready,
authenticated servers remain included by default. Unavailable servers are
excluded and become visible coverage gaps, including servers configured as
required. Reauthentication remains an operator action.

Each isolated MCP readiness probe runs sequentially and performs a read-only
discovery operation against the selected server; a healthy provider backend
alone is insufficient. Approval is invalid while any requested server remains
unknown or an included server is not ready.
Arena then displays the exact frozen policy hash, requested-server readiness,
exclusions, and coverage gaps before it creates worktrees or invokes contestants
or judges. By default it warns and automatically continues with exactly the
servers that passed readiness and authentication checks. `--review-mcp`
requires an interactive TTY and reviews each requested server: ready servers
receive an allow/deny choice, while failed servers can be authenticated through
the provider CLI and retried or skipped. Arena does not perform authentication.
The final policy omits unselected server identities, and unavailable, skipped,
or denied servers never enter agent sessions. Users authenticate desired servers through the provider CLI; Arena
does not read, copy, or perform MCP authentication. Excluded MCP records remain
in the operator-only policy artifact for audit but are absent from the run
permission manifest, immutable run specification, and every model prompt.
Codex Apps/connectors are a separate MCP-backed authority surface and are
disabled for frozen-policy sessions so they cannot bypass the named server
allowlist.

The MVP does not yet provide harness-mediated MCP execution. A `harness_only`
MCP selection is unavailable, so optional servers become coverage gaps and
required servers use the same reduced-validation gate. These servers are never
enabled in contestant or judge sessions.

The resulting allowlist is immutable across provider commands, tool catalogs,
prompts, sessions, retries, and recovery children. Unselected, unavailable, and
undeclared servers are absent, and an agent cannot add MCP authority during a
run. New capability requires a new run and approval plan. Arena never mutates
global provider configuration or remote MCP services; `leave_as_is` binds the
discovered snapshot rather than future setup changes.

If a provider CLI cannot construct a strict run-scoped configuration from the
name-only frozen inventory, Arena fails closed rather than falling back to
ambient configuration. Claude named selections require explicit server
definitions. Codex requires a known inventory and server names that its dotted
configuration path can address safely. Optional Claude selections become
coverage gaps, and required selections block launch unless reduced validation
is accepted.

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
fight ends early. Otherwise, after the adaptive or fixed plan completes:

1. Highest final HP wins.
2. Lower final patch size wins only as a tie-breaker.
3. If still tied, the result is a draw.

Those steps apply only after competitive evidence has differentiated the
battle. With complete required bidirectional coverage, two eligible,
required-valid patches with equal active defect damage and zero still-valid
contestant differential landings produce `non_discriminating`: `winner` is
null, `draw` is false, stable contestant order is retained, and no champion is
published. Siege, forfeits, eliminations, infrastructure outcomes, and coverage
gaps keep their existing classifications.

Cost and duration are shown but do not affect health. The verifier's constrained
relevance, root-defect, and severity verdict is the only model-assisted
adjudication step. Execution determines the behavioral pass/fail outcome, and
the published damage and recoil tables determine its numeric effect.

### The user owns the merge

Agent Arena distinguishes an arena champion from an independently recommended
patch. A non-discriminating battle has no champion. With selection enabled, one
fresh identity-blind invocation of the configured judge may compare anonymized,
equally correct patches using the frozen task contract, final validation, and
recorded quality facts under the frozen MCP policy. A decisive verdict may
recommend a patch without changing the competitive result. Equivalent,
inconclusive, disabled, or twice-failed comparison produces no recommendation,
and neither patch size nor the raw ledger may supply a fallback. A patch cannot
be applied until a human accepts an exact contestant, base commit, prompt, and
full patch digest. `--selection champion` is unavailable for this result. A
decisive independent recommendation may be selected normally; without one,
both eligible patches remain available only by explicit contestant selection.
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
mcp:
  policy: keep_configured
  servers:
    - provider: codex
      name: github
      role: agent
      requirement: optional
sources:
  - github_issue: 241
  # - github_pr: 87
  - spec: docs/session-refresh.md
effort: auto
limits:
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
- `reconnaissance.json`: approved in-memory task sources, bounded repository
  evidence, provenance, and the pre-permission input hash.
- `permissions.json`: requested scopes, user decisions, leases, omitted checks,
  and redacted provisioning results.
- `mcp-policy.json`: credential-free provider inventories, the selected
  run-scoped policy, authentication/readiness metadata, the exact frozen
  allowlist, exclusions, coverage gaps, policy hash, and the hash-bound final
  operator decision.
- `result.json`: compact schema-v10 status, stage, contestant health, outcome,
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
- `rounds/<round>/handoffs/`: canonical v2 reviewer-to-attacker packets,
  fingerprint validation, omission metadata, refreshes, blockers,
  invalidations, consumption outcomes, bounded diagnostic pointers, and
  inspection telemetry. V1 handoff artifacts are unsupported and rejected.
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
- `transport-recovery.json`: compatibility-named provider recovery ledger with
  the failed stage, causal evidence, health probes, chain-wide continuation
  ordinal, replacement link, and complete run-ID chain.

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
- Provider recovery applies after the targeted retry to implementation, review,
  attack construction, repair, judge, and semantic-adjudication stages only
  when causal evidence supports infrastructure failure and no usable terminal
  result exists. Sealed rounds are retained and never replayed.
- Round 1 persists a post-implementation, post-validation recovery checkpoint.
  A later provider-stage child reuses those exact validated patches without
  rerunning implementation and discards partial downstream round work.
- Across one run chain, at most two provider-recovery continuations may be
  created and each provider may trigger at most one. The limits do not reset in
  child runs.
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
3. Review one explicit capability plan, then accept the exact post-readiness
   MCP policy before any battle agent starts; both decisions show which
   capabilities are agent, harness-only, approved, unavailable, or denied.
4. Receive two independently generated implementation patches.
5. Observe the selected adaptive or fixed attack–repair rounds unless an early
   elimination ends the fight, with at most one retry for each distinct failure.
6. See zero to three ranked attacks per agent per round land or miss for a
   stated, reproducible reason.
7. See severity damage, miss recoil, repairs, heals, and health after every
   round.
8. Observe independently replayable rank overlays include shared support while
   malformed ranks remain isolated from valid siblings.
9. See integration discovery select the simplest sufficient environment and
   record any escalation.
10. Receive a deterministic final matrix, winner, draw, or non-discriminating
    result, any independent recommendation, and complete
   Markdown, HTML, SVG, and JSON artifacts.
11. See deterministic harness accommodations applied symmetrically, validated,
   and recorded without affecting health.
12. Explicitly accept an eligible patch, apply that digest-bound choice with a
    command, and independently rerun the tests.

The launch demo should additionally show an adversarial test finding a real
defect that the repository's existing tests missed. That is the clearest proof
that the arena is more than parallel agent execution.
