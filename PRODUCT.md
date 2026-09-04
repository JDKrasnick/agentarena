# Agent Arena

## Overview

Agent Arena is an open-source developer tool that runs multiple coding agents against the same software task, allows them to attack one another’s implementations with executable evidence, gives each agent an opportunity to repair its patch, and publishes the strongest competitive conclusion the evidence supports.

The central idea is:

> Make coding agents fight for the merge.

New MVP runs use exactly three model roles: two contestant adapters and one
fresh, identity-blind judge adapter. The harness owns execution, retries,
permission planning and stage gating, and deterministic selection; the judge
owns semantic validity, canonical defect identity, frozen severity, fallback
adjudication, and repair judgments when mechanics remain unavailable. House
scouting, case-building, held-out sibling generation, and harness maintenance
are legacy-only extensions and are not invoked by new runs. The one permitted
new-run quality comparison is a fresh post-validation invocation of the same
configured judge role, used for an equal-HP, equal-active-damage competitive
tie or to provide an independent recommendation for a non-discriminating duel
or catch-up.

Champion and patch-recommendation language is conditional on coverage. Duel
and catch-up require both attack directions in every executed round; siege
requires the attacker-to-defender lane in every executed round. Optional neutral-house
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

Contestants may defend their solution by disproving the attack, repairing their patch, or conceding the defect. The harness reruns all valid tests and produces an evidence-backed winner, draw, or non-discriminating result.

The user receives:

* Multiple completed implementations.
* Additional adversarial tests.
* A recommended patch when correctness or independent quality evidence differentiates one.
* Cost and duration comparisons.
* A replayable battle report.
* A deterministic visual battle replay generated from the recorded evidence,
  including a clickable HTML dossier with test coverage, attack evidence,
  scoring, and handoff.
* A command to review and apply an explicitly accepted solution.

Fights automatically launch the React battle observatory in a dedicated
Electron window. `--no-window` opts out, selecting Ink in an interactive TTY
and line-oriented output when redirected or running in CI. Explicit
`--display window|terminal|plain` modes remain available, and the legacy
`dashboard` value aliases `window` without opening a browser. Both rich displays
support cancellation and one-time queued contestant steering, but not pause,
stage skipping, or arbitrary retries.
Every fight window uses a temporary isolated Chromium profile so independent
fights can remain open concurrently without sharing renderer or session state.
The theme preference remains an atomically written app-wide file outside those
profiles, and Electron launch failures are reported as display failures rather
than battle failures or user cancellation.
The desktop connection badge is snapshot- and paint-aware. The loopback server
sends revisioned snapshots plus bounded heartbeats; `Live` appears only after a
recent revision has committed through the renderer's paint cycle. Quiet or
disconnected streams become `Stale` or `Reconnecting`, and reconnects and
reloads rehydrate from the current `/api/state` revision without mutating the
fight. Electron uses a per-run isolated profile, disables background throttling,
requests a compositor repaint after each committed revision, and reloads its
loopback URL after a renderer failure. Normal GPU composition remains the
default; `AGENT_ARENA_SOFTWARE_RENDERING=1` is the documented diagnostic
fallback.

Attack telemetry distinguishes mounting, landed, and evidence-revision events.
The observatory shows their live counts and timeline, and uses a brief red
health-card pulse when damage lands. Reduced-motion terminals receive the same
numeric damage cue without animated frames.
The overview uses a game-like battle presentation—opposing fighter cards, HP
bars, a VS divider, and move narration—without hiding provider identity,
checks, current work, or the underlying engineering event log.
The arena uses a restrained game-battle structure: opposing provider identities,
separate status/HP regions, a VS divider, live agent output, and an evidence
rail. The terminal represents Claude with a yellow-orange Spark sigil and keeps
provider names primary. The desktop observatory uses the orange Claude product
mark and native PNG rendering. Its React assets and event stream are served only
on a random loopback port inside a sandboxed window; Agent Arena never opens the
observatory in the user's browser.
The registry covers the supported providers plus widely used providers and
coding-agent products for future adapters. No third-party game characters or
sprite assets are used.
Persistent wayfinding shows the numbered round (or opening, recovery, and final
phase), a plain-language stage name and objective, and the active step within
the round attack loop. Attack events retain their originating round.
The desktop observatory makes fighter cards navigable. A fighter detail view
shows its current or recorded workstream, invocation status and duration, full
output, checks, health changes, attack involvement, and live steering when the
active view is selected. The round rail provides read-only replay of recorded
round state and a direct return to the live arena. It does not claim to rewind,
rerun, pause, or mutate live execution; durable resume remains the recovery
mechanism for sealed runs.
The rail distinguishes initially planned rounds from conditional extension
rounds and never renders a round beyond the resolved maximum. Completion
reconciles phase and check totals from the authoritative final live snapshot.
Completion automatically opens an evidence-backed success screen with both
final fighter states, the arena outcome and any independent recommendation, landed defects,
verified health-restoring improvements, and the next human-review command. Its
product-value statement is derived from recorded attack and repair evidence,
not unverified agent narration.
Identity-blind judge artifacts retain their local `patch_a` and `patch_b`
labels, while every final user-facing rationale translates those aliases back
to the corresponding provider or contestant identity.
The desktop window opens in a spacious live-battle layout with taller retained
fighter output. When a terminal result arrives, it automatically contracts into
a focused results view; users can still inspect either fighter or return to the
recorded round timeline before finishing the session.
While an Arena-managed browser session is active, the observatory surfaces an
`Open browser` action for its approved application URL. Arena never opens that
URL automatically. The action opens a separate user-controlled browser view;
the evidence browser remains headless with isolated storage, and the action
disappears when the managed session stops. The temporary action sits beside the
contestant using the session, names that contestant, and uses its live accent
color. A harness-owned baseline session appears in the neutral current-event
area labeled Arena instead of implying contestant ownership.
The desktop observatory ships six supported visual themes: Classic Shell,
Developer Dashboard, Night Transit, Test Lab, Live Arena Broadcast, and 16-Bit Tactics.
Classic Shell is the first-run fallback. A persistent swatch picker remains available in
the arena, replay, fighter detail, and results views; changing it preserves the
current view and live connection. The last valid selection is stored atomically
as an app-wide local Electron preference. Save failures keep the current
selection and surface a non-blocking warning. Theme choice is display-only and
never enters battle events, artifacts, scoring, configuration, or recovery
hashes. Terminal and plain displays remain unchanged.

Developer Dashboard replaces the redundant second Pocket-family variant with a
conventional dark observability workspace: a round timeline, paired contestant
check and summary-log panels, a chronological activity rail, steering controls,
and a compact run-status bar. Night Transit is a subway-wayfinding renderer:
two contestant lines expose real round stations on a printed map field, recorded attack and
repair routes converge on a verification interchange, and an arrivals board
consolidates each attack lifecycle. Test Lab is a warm experiment workspace:
opposing benches flank a central attack sheet built from invocation timing,
checks, health history, adjudication, damage, and repair facts. Both keep
historical rounds read-only and omit unavailable routes or measurements rather
than inventing them. 16-Bit Tactics is an original retro strategy
renderer: opposing status bars, a data-driven tactical node map, recorded attack
and repair routes, an evidence channel, a structured in-map latest-evidence
readout, and inspect commands. At desktop widths
its cartridge chassis fits the available window rather than turning the terrain
into a separately scrolling poster; compact work nodes are derived from recorded
contestant invocations. It ships no third-party characters, logos, sprites, or
game assets. Existing
`night-edition` preferences migrate to `night-transit`; `sticker-league`
preferences migrate to `developer-dashboard`; `evidence-deck`
and `monster-battle` preferences migrate to `retro-tactics`.

Applying an operator steering note changes run integrity from `competitive` to
`assisted`. The health ledger and review recommendation remain available, but
reports describe only an assisted leader and prominently state “Assisted — not
competitively comparable.” Empty notes are rejected and notes with no future
eligible invocation expire unapplied.

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

Only versioned, canonical, serializable data crosses the Arena–RoundEngine
boundary. LLM-facing parsers accept and record unambiguous presentation-level
variance—such as whitespace, enum case, known field aliases, and set ordering—
before validating the canonical contract. They never invent missing semantic
facts. Runtime services, callbacks, worktree objects, abort controllers, and
mutable `RunState` stay outside it. `ContestantFeedback` is a deliberately
limited projection: a lane sees its health, accepted attacks and visible
reproducers, its own attack outcomes, and healed or unresolved defect IDs, but
not opponent transcripts, held-out cases, verifier reasoning, or private repair
details. Expected execution failures are returned as `inconclusive`,
`cancelled`, or `failed` results; exceptions are reserved for invalid
configuration, invalid schemas, and programming invariants.

`Arena` has no direct mechanism imports. Durable recovery treats the immutable
preflight baseline and sealed per-round envelopes as authority. `result.json`
is a compact schema-v11 summary with an ordered applied-envelope ledger and a
digest-linked telemetry projection. Runtime state is V10 and round snapshots,
results, replays, envelopes, and state deltas are V6. Resume
validates the digest chain and runtime drift, applies a sealed boundary exactly
once, and never reruns an interrupted unsealed round under the original run ID.
Production prompts consume only persisted lane-safe `ContestantFeedback`.

Every fight-owned provider process seals one prompt-free invocation record at
`telemetry/invocations/<invocation-id>.json`, including retries, probes, effort
assessment, adjudication, repair judgment, and quality comparison.
`telemetry/summary.json` is an atomic projection by provider, resolved model,
contestant/judge role, stage, and round. Uncached input, cache creation, cache
reads, output, and reasoning-output subsets remain separate, so reasoning is
never counted twice. Missing usage stays partial or unavailable and is never
treated as zero for soft budgets. Subscription CLI cost is null with explicit
provenance; aggregate USD is non-null only with complete authoritative billing
or one stable versioned rate card.

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

Later attacks may explicitly challenge a prior adjudication or match one by
assertion identity and normalized browser actions. The existing neutral judge
receives up to six same-target decisions and classifies the new evidence as
independent, affirming, overturning, or unresolved. Affirmations do not repeat
damage or recoil, but each affirmed reproducer joins the canonical defect's
repair and final-verification set. If an affirmed variant still fails after the
defect was healed, Arena reactivates the existing canonical damage without
adding new damage. Overturns preserve both immutable decisions and append score
corrections; unresolved conflicts remain score-neutral and make coverage
provisional. A browser pass against a changed target patch is repair evidence,
not proof that the earlier observation was wrong.

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
versioned terminal metadata with one eligibility disposition and diagnostic
trail per contestant. Legacy v1 records remain readable; new runs write v2.
Every required-validation attempt records its exit code, signal, wall-clock
timeout state, elapsed and last-output times, termination escalation, logs, and
an exact bounded failure excerpt. Deterministic assertion, typecheck, lint, and
build exits fail immediately; timeouts and runner-shaped terminations receive
one clean retry against the same patch. Disagreeing attempts make eligibility
unstable and the run inconclusive instead of eliminating a contestant.
In a duel, exactly one production patch that
applies and passes required validation wins by forfeit and is the only
reviewable recommendation; no eligible patch is inconclusive. Provider,
transport, authentication, reconnect, and harness failures are inconclusive,
not forfeits. A failed frozen incumbent in catch-up ends inconclusively before
the challenger is invoked, and siege never recommends its test-only attacker.

Pre-review classification is deterministic: external cancellation outranks
harness infrastructure, which outranks a clean harness-enforced timeout, which
outranks provider transport/authentication/MCP evidence, contestant failure,
patch applicability, and required validation. Transport evidence overrides a
nonzero exit only when the invocation produced no usable result; it cannot
reclassify a timeout enforced by Arena. Aggregate provider initialization
metadata is ignored for transport classification. Optional MCP startup warnings
remain in diagnostic logs but do not constitute invocation-level transport
evidence when the provider exits successfully or continues useful work. A
transport failure cancels the peer implementation through a phase-local
controller. The peer's diagnostics are retained, and the peer is labeled as
cancelled by the transport event rather than blamed for a failure.

Every provider-backed stage has one bounded automatic recovery path after its
normal targeted retry establishes a causal provider infrastructure failure and
the stage produced no usable terminal result. Eligible stages are
implementation, review, attack construction, repair, judge, and semantic
adjudication. Transport-like output remains diagnostic evidence; a stale MCP
warning cannot override a valid stage result.

The failed run remains independently reportable while Agent Arena starts up to
three fresh provider processes, each with a deterministic backend-authenticating
sentinel prompt, within a shared 30-second window. If connectivity returns, a
linked child run retains validated upstream state and sealed rounds, discards
incomplete dependent work, and continues from the failed stage. Frozen task
sources, base commit, topology, permissions, MCP allowlist, budgets, and
configuration do not change. Across the complete run chain, at most two
continuations may be created and each provider may trigger at most one; limits
never reset in child runs. Recovery records preserve the run-ID chain, failed
stage, reason, probes, command and cleanup logs, exit state, authentication
evidence, and provider-health results.

Round 1 writes a post-implementation, post-validation recovery checkpoint
before review begins. A later provider-stage continuation starts from that
checkpoint without invoking either implementation again; partial review,
attack, adjudication, and repair work from the failed transaction is discarded.

After recovery capacity is exhausted, the first unrecovered review or attack
failure follows ordinary coverage-loss semantics and the second unrecovered
provider-stage failure anywhere in the chain makes the fight inconclusive.
Implementation, repair, correctness-critical judge work, required validation,
and final validation remain immediately inconclusive whenever their results
cannot be trusted.

Pre-review terminal reports use outcome-specific JSON, Markdown, HTML, SVG,
and console language. A duel forfeit creates only the eligible patch digest,
deterministic recommendation, and human-review handoff; review, attack, repair,
quality-comparison, and coverage stages and artifacts are absent. Resume shows
the stored terminal result and never runs a skipped stage. CLI exit status is
`0` for a completed battle, draw, or valid duel forfeit; `2` for a persisted
inconclusive run; `130` for user cancellation; and `1` for persisted internal
failure, configuration failure, or an uncaught command error. Automatic
recovery returns the replacement run's status and prints the full run-ID chain.

Pull-request authorship is provenance metadata, not proof of who wrote the
code. Explicit bot, co-author, generator, title, or branch signals may select a
provider only under published attribution rules; conflicts remain unknown and
attribution never changes scoring.

---

## Core Workflow

### 1. Repository reconnaissance

Before permission resolution, Agent Arena performs bounded, read-only
reconnaissance and creates the proposed shared execution contract in memory.
It may read only the exact user-supplied task and references, known manifests
and lockfiles, browser-test configuration, literal package scripts, framework
route metadata, and repository instruction files. The harness hashes these
inputs and stops when an explicit task source cannot be retrieved. Text evidence
is capped at 256 KiB per file and 2 MiB in aggregate; lockfiles are stream-hashed
without retaining their contents. Local specification paths are canonicalized
so symbolic links cannot escape the repository. GitHub retrieval is limited to
fixed `gh issue view`, `gh pr view`, and `gh repo view` reads.

This phase does not create run artifacts or worktrees, inspect Git state,
resolve or fetch commits, execute repository commands or project code, start
agents, launch browsers or servers, or install packages. Those actions begin
only after one consolidated capability plan is approved. After approval, the
harness persists the frozen task sources, reconnaissance evidence, and resolved
permission policy before continuing with repository and Git preflight.

This boundary discovers requested authority, records the user's decisions, and
gates whether a run may start. It does not confine an approved agent or test
subprocess to those declared capabilities. Native execution remains advisory;
hard filesystem, network, credential, process, and resource isolation belongs
to the separate strict-worker work tracked in #68.

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

Browser and DOM planning consumes only the frozen task sources and bounded
repository evidence. Task language about visible UI, interaction, responsive
behavior, accessibility, persistence, browser, or DOM behavior makes browser
validation required even when tooling is unavailable; repository-only frontend
evidence makes it optional. Standing instruction files describe the repository
rather than the task, so matches there are optional evidence and never make
browser validation required on their own. Resolution prefers an explicit Arena profile, then
literal Playwright or Cypress configuration, then recognized package scripts.
Ambiguous monorepos remain unresolved rather than selecting an application.

Approved browser execution is `harness_only`. Arena-managed probes broker HTTP
and WebSocket traffic to approved origins, but the unchanged repository-native
browser command is advisory because it executes repository code without a
cross-platform network sandbox. The combined capability therefore advertises
the weaker `advisory` boundary and is never silently approved in `auto` mode.
Arena never installs packages or browser binaries and treats every exact
non-local origin as a separate capability. Built-in adapters use
`playwright-core` with an already installed Chrome/Chromium binary to manage
the service and Arena probes, while the repository's declared browser command
and project matrix run unchanged as the native suite. Each contestant gets an
isolated server and fresh browser storage for independent probes. Managed
Chromium remains headless. The live observatory exposes an explicit action for
opening the active approved application URL in a separate user browser, but it
never opens that view without a click and never treats the separate view as
evidence. The action sits with Fighter A or Fighter B when that contestant owns
the current session and uses a pulsing, contestant-colored treatment reserved
for the session's temporary lifetime. Arena-owned sessions use the neutral
current-event area.

The harness advertises the safe probe menu; the attacking agent chooses a
task-specific family, desktop/mobile/reflow profile, accessible actions, and
expected behavior in its attack submission. Generated checks can use Chromium
desktop at 1440×900, mobile at 390×844 with touch, or 320 CSS-pixel reflow.
DOM-security probes use a dedicated accessible-label fill action whose inert
markup sentinel is supplied and observed by the harness rather than by the
contestant.
Every browser run also includes harness-owned runtime-error, accessible-name,
and 320 CSS-pixel overflow smoke probes. Those mandatory probes fail only on
uncaught runtime errors and their own invariant; console output and requests to
unapproved origins are recorded as diagnostics rather than failures, because the
repository never chose that policy. A contestant-selected probe declares its own
expected behavior and does fail on both. Probe families cover
interaction, responsive layout, keyboard/focus, semantics, task-declared
persistence, runtime DOM integrity, risk-triggered inert DOM-XSS canaries, and
unchanged repository-owned visual baselines. New screenshots are diagnostics,
not pass/fail baselines.

A review finding may become a browser-only attack without a repository test
patch. It lands only when the bounded probe reproduces symmetrically—passing on
the author's patch and failing on the target—and the identity-blind judge
accepts the frozen-task oracle. Complex flows stay in repository-authored test
or fixture patches with a focused command; the JSON probe DSL does not become a
general-purpose script runner.

The reviewing contestant decides whether an already approved exact external
origin provides suitable evidence. It cannot expand network authority after
approval. Authenticated sessions and secret brokering are deferred to #66;
until that contract exists, coverage requiring login remains unavailable.
For Arena-managed probes, the browser broker applies the exact-origin decision
to HTTP(S) and WebSocket traffic, mapping `ws` and `wss` to the corresponding
approved transport origin, and records blocked socket origins with other
network violations. Native repository commands retain the host account's
network authority and are labeled accordingly during approval.

Explicit profiles may choose `dynamic` loopback ports when their startup
command honors the harness-provided `PORT`; otherwise they retain the exact
fixed port and comparative lanes run sequentially. Repository-native suite
results are cached within a run by immutable patch bytes and the exact command,
while service startup and browser probes still execute for each lane.
Profiles also declare whether the native suite reuses Arena's started service
or manages its own service lifecycle. Auto-discovered Playwright `webServer`
commands use the self-managed mode so Arena does not occupy the runner's port.
Both modes receive the resolved `PORT` and base-URL environment; a self-managed
suite binds that reserved port itself before Arena starts its probe service.

Functional assertions run once. Browser/server infrastructure may receive one
bounded retry with guaranteed teardown; a first-fail/second-pass assertion is
flaky, not clean. Before contestant attribution, the same resolved profile and
native suite run on the unpatched baseline. A baseline failure is a
configuration or harness failure; a baseline pass followed by a stable
contestant-only failure is an application failure; evidence that cannot make
that distinction is unverified and causes no damage. Required gaps enter
provisional coverage unless the exact reduced-validation contract was accepted.

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

The MVP scales review–attack–repair work to the task. `effort: auto` is the
default: after frozen inputs, permission planning, dependency checks, and MCP
readiness, the identity-blind judge scores change surface, behavioral
complexity, validation burden, and operational risk from 0–2. Scores 0, 1–2,
3–4, 5–6, and 7–8 select ultra-low, low, medium, high, and ultra-high. Security,
authorization, migration, concurrency, irreversible-data, and external-system
risk impose a high floor; low-confidence assessments are promoted one tier.
The judge receives one retry, after which the harness records a medium fallback.

Profiles plan 1/1/2/3/3 rounds with sealed-round pressure thresholds of
15/20/25/45/60 minutes, 6/8/10/14/18 provider calls, and
500k/750k/1.5m/4m/7m tokens. These are post-round pressure signals, not
preemptive caps: the harness completes mandatory verifier and repair work in
the transactional round already in flight, then records any threshold crossing
at the adaptive boundary. They also select phase budgets. Explicit phase settings
override only their named phase. `--effort` may pin a profile. `--rounds 1..5`
runs exactly that many rounds with medium phase timings and disables adaptive
stopping and extension; it is rejected with `--effort auto`.

Each adaptive boundary durably records competitive landings, shared defects,
explicit-empty lanes, and the consecutive low-signal count. One low-signal
round causes any already-scheduled next round to retain its distinct theme and
add a mandatory non-repetition pivot. Two consecutive low-signal rounds stop
with `repeated_low_signal`; competitive evidence, unresolved adjudication, or
active damage resets the streak. Exact `--rounds` battles never stop early for
low signal, but their continued rounds receive the same pivot instruction.

In each round, the harness first freezes both current implementation patches.
Each eligible reviewer then gets a dedicated read-only budget, configured by
`review_minutes` separately from the focused test-generation budget. The budget
defaults to 10 minutes, accepts smaller positive values, and cannot
exceed 10 minutes. That value is the provider's idle budget: recognized
messages, tool lifecycle events, progress, and completion move the soft
deadline forward, while a separate absolute cap at three times the budget
always terminates the owned process tree. After either timeout, fault-isolated
parsing classifies the complete file as `valid`, `valid_empty`, or a `partial` with at
least one accepted finding. The review record is marked salvaged while its
invocation remains `timed_out`; invalid, empty partial, and missing files
receive the ordinary targeted retry and may lose coverage.

Provider calls emit structured operational activity independently of visible
stdout: assistant messages, tool starts and finishes, progress, and completion.
The harness retains redacted assistant text plus normalized event, stdout, and
stderr artifacts, session ID when available, counts, timestamps, current open
tool, decoding warnings, and deadline cleanup facts. Unknown provider event
variants never fail an invocation. Recognized activity extends only the
provider idle deadline; malformed records, stderr chatter, and transport
keepalives do not. Activity never changes judging, score, or coverage. The
review produces a v2 trusted evidence-handoff packet under
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
`harness_only` checks remain mediated by the harness. The prompt enumerates
`code_inspection`, `task_source`, `test_inspection`, `test_run`,
`tool_summary`, and `other` as the complete provenance vocabulary:
`test_run` records evidence derived from executing a test, while
`test_inspection` records evidence derived from reading test code.

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
| 4 — Generalization extension | Generalize a newly proven damage-bearing defect or finish the bounded repair allowance for an active accepted defect. | Adjacent inputs, state transitions, equivalent protocols, and invariant variants tied to the triggering defect. |
| 5 — Durability extension | Test recurrence, recovery, restart, and durability for a newly qualified trigger. | Regression recurrence, persistence/restart checks, recovery invariants, and bounded failure sequences. |

After every sealed round, the harness records convergence and budget pressure.
Token pressure uses policy v1: `uncached input + output + cache creation +
ceil(cache reads / 10)`. It is evaluated only when every token component is
complete. Raw processed tokens remain the audit total and are never rewritten
to the weighted value. Each adaptive decision persists the raw components,
weighted total, threshold, cache-read weight, and whether new I/O, cache
creation, cache reads, or their combination triggered pressure; user-facing
reports show that breakdown beside any skipped investigation briefs.
Crossing a pressure threshold can stop unqualified continuation but does not
interrupt the completed round; strong accepted evidence may still qualify the
next bounded round.
It stops when both contestants pass required checks, no active damage remains,
there is no new damage-bearing defect, and no repair allowance remains. At most
two additional rounds may extend the profile, never beyond round 5. Every
extension must qualify independently from a new damage-bearing canonical defect
(including partial-judge damage) or an active accepted defect with repair
allowance remaining. Unrelated extension findings remain recorded evidence but
cannot change damage or recoil.

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

Normal attacker context contains only the current lane-safe summary and active
v2 packet. Diagnostic drill-down is available only when that handoff is stale,
malformed, or blocked, and may read one directly referenced artifact capped at
8 KiB. The harness never follows a diagnostic pointer recursively. Handoff
lifecycle state remains internal artifact metadata; reports and observatory
views add no lifecycle section or drill-down control.

New and resumed runs support only v2 handoffs. They reject v1 packets without
reading, migrating, rewriting, or consuming them; this does not remove generic
legacy-run support outside the reviewer-handoff feature.

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

LLM-facing normalization is deliberately softer than persisted contracts.
Known snake/camel field aliases, normalized text, case-insensitive published
enums, sorted unique set fields, omitted untrusted review labels, and the
`execution` provenance alias are canonicalized with an audit record. At the
review-observation provenance path only, case and outer whitespace plus the
safe `TEST_RUN`, `test-run`, and `test run` spellings canonicalize to
`test_run`; exact `test_run` records no normalization. Values such as
`test_execution` remain ambiguous and are rejected. Safe normalization keeps
the finding and creates its handoff without another provider call. A partially
valid enum alias retains its exact original value in that audit record;
oversized descriptive text instead records a bounded preview, original UTF-8
byte count, and SHA-256 digest so audit metadata cannot duplicate unbounded
provider content. A partially valid review immediately keeps its accepted
findings; genuinely rejected
siblings remain the only entries counted as schema-rejected. When no finding
survives, the single review retry receives only the invalid JSON paths,
received values, and allowed provenance vocabulary. Unknown or contradictory
fields, missing evidence, invalid numbers, and unsupported semantic values
remain rejected.

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

When the same stable focused reproducer fails on both contestant patches and
the judge confirms its oracle and relevance, Arena records a `shared_defect`.
It expands the repair target to both patches, applies no damage or recoil, and
reruns the reproducer during both repair paths. This turns useful common-mode
evidence into a neutral quality improvement without pretending it distinguishes
the contestants. Arena persists an active or repaired result for each target;
final validation is authoritative. An unresolved target remains visibly active
and makes that patch ineligible for a champion, quality comparison, or patch
recommendation. If shared evidence is the only defect evidence and any target
remains unresolved, the arena result is a draw rather than a ledger-derived
winner.

A submitted attack that does not land causes recoil damage to its author. Rank 1 costs 5 HP on a miss, rank 2 costs 10 HP, and rank 3 costs 15 HP. Invalid, flaky, unrelated, duplicate, one-sided self-defeating, and blocked attacks all miss. A verified shared defect and harness infrastructure failures cause no recoil.

A lightweight verifier agent may help evaluate disputed attacks, but deterministic execution should remain the primary source of truth.

The term **harness** should refer to deterministic orchestration and execution: worktrees, patches, processes, retries, and recorded pass/fail results. The **attack verifier** performs the narrow semantic judgment about oracle support, relevance, root-defect identity, and severity. Together they form the arena adjudication pipeline.

Each mechanically landed defect retains its executable reproducer. Repair
validation reruns every accepted reproducer for the canonical defect, including
score-neutral affirming variants, and each healed-defect regression check after
every attempt. The defect heals only when the complete set passes. Judge-based
defects use immutable digest-bound repair judgments only when mechanical
confirmation remains unavailable.

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

After the adaptive or fixed round plan completes, ordinary competitive battles
award the surviving contestant with the most HP. When active defect damage is
also equal, a decisive fresh, identity-blind quality verdict breaks an HP tie;
unavailable, equivalent, inconclusive, or twice-failed judging produces a draw.
If only one contestant survives earlier,
the fight ends early. Cost and duration are reported but do not change health.

A completed duel or catch-up is instead **non-discriminating** when every
required attack direction has a usable terminal result, both applicable final
patches pass required validation, their active defect damage is equal, and no
still-valid contestant-authored differential attack landed. Repaired contestant
landings still discriminate; later-overturned decisions do not. The result has
no champion and is not a draw. Raw HP, recoil, shared neutral defects, repair
history, and patch size stay visible but cannot manufacture a champion.

For ordinary competitive results, the **arena champion** is the health-ledger
leader or, at equal HP and equal active defect damage, the patch selected by a
decisive identity-blind quality verdict. A non-discriminating result has no
champion. With selection enabled,
Agent Arena runs the comparison using the configured judge, frozen MCP policy,
anonymized patches, final validation, frozen task contract, and deterministic
quality facts. The judge sees production-only minimality facts; relevant passing
regression coverage may support a cited behavioral judgment, while raw test
volume never does. Its ordered code-health rubric evaluates task/design fit,
material change risk, maintainability, behavior-specific verification,
task-relevant operational quality, and production minimality last. Technical
evidence outranks taste; abstraction, brevity, extra features, speculative
defenses, logging volume, criterion-win counts, and style preferences have no
intrinsic value. A decisive verdict must identify a material advantage, the
strongest counterweight, and why the advantage matters more. Sufficient but
balanced evidence produces `equivalent`; missing, conflicting, or ambiguous
evidence produces `inconclusive`, so the judge never has to force a winner.
Task contents supply requirements evidence, while task and patch contents cannot
alter the judge's role, rubric, protocol, or output contract.
For a non-discriminating battle, a decisive verdict creates only an independent
`implementation_quality` recommendation. An equivalent,
inconclusive, disabled, or twice-failed comparison creates no recommendation;
both patches remain visible in stable contestant order explicitly labeled as
non-quality ordering. Quality never changes HP, damage, healing, recoil,
coverage, or run success.

Every completed run produces a stable review prompt with all eligible patch
choices and full SHA-256 digests. Applying a patch requires a current human
decision bound to the run, prompt, contestant, base commit, and exact digest.
For a non-discriminating result, `--selection champion` is unavailable. A
decisive independent recommendation may be selected normally; otherwise both
eligible patches remain explicit human choices.
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

The user remains responsible for reviewing the evidence, explicitly accepting
an eligible patch, and deciding whether to merge it.

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

Validation commands retain a fixed hard deadline. Provider invocations use the
configured phase budget as an idle timeout, extend that soft deadline on
recognized meaningful activity, and retain a three-times-budget absolute
emergency cap. The harness tracks run-owned descendants across process-group and
session changes, stops reading inherited output pipes at expiry, terminates and
reaps the owned tree within a documented cleanup grace period, and verifies
process identity before every signal. Reports record the timeout kind, last
progress timestamp, elapsed duration, deadline expiry, signal
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
level, execution role, and whether the available boundary is OS-enforced,
harness-brokered, or advisory. The plan authorizes and gates run stages; it is
not itself a sandbox. The user can choose:

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

The MVP permission system provides discovery, approval, stage gating, and an
immutable audit record, not hostile-code confinement. A brokered denial means
the harness will not provide a credential or service, but it may not prevent an
agent from using authority already available to the current OS account.
Advisory restrictions exist only in policy and prompts. Preflight must label
these honestly; sensitive runs should use a sanitized account or external
container with production credentials absent. Issue #68 owns a strict execution
backend that can make filesystem, network, credential, process, and resource
decisions technically enforceable.

Native provider and repository execution is a required high-risk advisory
capability. The consolidated plan names its ambient filesystem, process
environment, network, credential, and configured-integration exposure. `--yes`
displays the same plan and warning before recording non-interactive approval; it
does not turn acknowledgement into confinement.

Before worktree creation or any provider session, Arena inventories MCP servers
from every selected provider setup. The consolidated plan records only provider,
server name, enabled state, authentication readiness, requested execution role,
and requirement level. For a selected Codex server, Arena transiently reads its
non-secret transport definition so it can construct a selected-only child
configuration. It rejects literal environment values, HTTP headers, and
environment-variable references because the current process boundary cannot
expose those values to the MCP transport without also exposing them to the
agent. No-auth servers and Codex-managed OAuth remain supported. The definition
stays in memory or the temporary preflight directory and is never written to
run artifacts, prompts, transcripts, or reports. Arena binds a canonical hash
of each credential-free selected definition into the frozen policy so resume
can reject same-name command, URL, argument, tool-filter, cwd, or timeout drift
without persisting the definition itself. An inventory failure is `unknown`,
never an empty inventory.

The operator chooses one run-scoped MCP policy:

* **Keep configured:** enable only servers already named in Arena configuration.
* **Configure selection:** choose an explicit subset of the discovered inventory.
* **Leave as is:** approve the exact enabled snapshot already present in each
  provider setup. This option is unavailable when any inventory is unknown.

Arena performs an isolated readiness check for the selected servers and then
freezes the exact allowlist. Ready, authenticated servers remain included by
default. Unavailable servers are excluded and recorded as coverage gaps,
including servers configured as required. Reauthentication is always an
explicit operator action.

Each isolated MCP readiness probe runs sequentially and performs a read-only
discovery operation against the selected server; general provider connectivity
alone cannot mark an MCP server ready. Approval is invalid while any requested
server remains unknown or an included server is not ready. After readiness,
Arena displays the exact frozen policy hash,
every requested server's inclusion and readiness, and all resulting coverage
gaps. Before creating worktrees or starting contestant or judge sessions, Arena
warns that it will continue automatically with only servers that passed those
checks. `--review-mcp` instead opens an interactive per-server review: ready
servers require an allow/deny choice, and failed servers let the operator
authenticate with the provider CLI and retry or skip. Arena never performs the
authentication itself. Unselected server identities are omitted from this final
policy, and unavailable or denied servers are never exposed to agents.
Operators authenticate desired servers through the provider CLI;
Arena never reads, copies, or performs MCP authentication. Excluded MCP records
remain in the operator-only policy artifact for audit but are removed from the
run permission manifest, immutable run specification, and every model prompt.
Codex Apps/connectors are a separate MCP-backed authority surface, so Arena
disables that feature for frozen-policy sessions rather than allowing connected
apps to bypass the named server allowlist.

The current MVP has no harness-mediated MCP execution path. A server requested
with the `harness_only` role is therefore unavailable: optional servers are
excluded as coverage gaps, and required servers follow the same reduced-
validation gate. Harness-only servers are never enabled in an agent session.

The frozen MCP policy governs provider command configuration, tool catalogs,
prompts, and sessions for the complete run chain. Unselected, unavailable, and
undeclared servers are absent. Agents cannot widen MCP authority mid-run; a new
capability requires a new approved run. Arena does not mutate global provider
configuration or remote MCP services, and `leave_as_is` approves the discovered
snapshot rather than future provider changes.

If a provider CLI cannot construct a strict run-scoped configuration from the
name-only frozen inventory, Arena fails closed instead of reusing ambient
configuration. Claude named selections are unavailable without explicit server
definitions. Codex requires a known inventory, safely addressable selected
names, and a supported transient definition without literal or
environment-backed credential material. Every frozen-policy Codex child ignores
the ambient user configuration, disables Apps, and receives only the validated
selected definitions. Because Codex MCP calls otherwise request interactive
approval and fail closed in non-interactive `exec` sessions, a child with an
approved selected server uses Codex's explicit approval-and-sandbox bypass. This
does not widen the selected MCP allowlist and remains covered by the required
high-risk native-execution capability disclosed before launch. Optional
unreconstructable selections are excluded as coverage gaps, while required
selections block launch unless reduced validation is accepted. Resume resolves
each selected definition again and fails closed if its canonical hash differs
from the definition approved at preflight.

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
# Frozen, harness-owned dependency setup. `auto` requires a recognized lockfile.
# Equivalent post-patch trees reuse a run-local content-addressed setup cache.
bootstrap: auto
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
effort: auto

limits:
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

mcp:
  policy: keep_configured
  servers:
    - provider: codex
      name: github
      role: agent
      requirement: optional
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
  --effort auto \
  --budget 5
```

The MVP supports two agents, one initial implementation, one to five adaptive
attack–repair rounds, up to three ranked attacks per agent per round, one targeted retry per
distinct failure, one required validation command, and at most one
approved ephemeral integration profile.

---

## Battle Report and Viral Design

The report is a core feature, not an afterthought.

Game mechanics should map directly to real engineering events:

* **Damage:** A verified failing test, weighted by defect severity.
* **Critical hit:** A catastrophic defect dealing 50 HP.
* **Shared defect:** A verified contestant reproducer fails on both patches and
  triggers repair for both without damage or recoil.
* **Block:** An attack successfully disproved; its author takes rank-based recoil.
* **Recoil:** A missed rank 1, 2, or 3 attack costs its author 5, 10, or 15 HP.
* **Holdout:** A repair passes the visible reproducer but remains damaged because
  a pre-frozen sibling case still fails.
* **Fallback:** After one failed mechanical retry, an eligible immutable attack may receive a clearly labeled judge verdict.
* **Heal:** A repaired patch restores the exact HP lost to that attack.
* **Elimination:** A required check remains failing and health becomes 0.
* **Draw:** Multiple competitive patches finish with equal HP and no decisive
  quality verdict.
* **Non-discriminating:** Complete bidirectional coverage finds no effective
  competitive landing; raw HP remains visible but no champion is awarded.

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
* Separate competitive-landing, shared-defect, and schema-rejected-finding
  totals in the console and battle reports.
* An immutable `run-spec.json` with frozen source snapshots and reproducibility metadata.
* A redacted permission manifest with approvals, denials, leases, and omitted checks.
* A credential-free frozen MCP inventory, readiness result, exact allowlist,
  exclusions, coverage gaps, and hash-bound operator acceptance. Invocation
  telemetry records only the policy hash, isolation mode, Apps-disabled state,
  and sorted exposed server names; it never records definitions, arguments,
  environment values, headers, or tokens.
* A JSON result file.
* Every eligible final patch and any independent recommendation.
* A command to review and apply an exact accepted patch.
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
