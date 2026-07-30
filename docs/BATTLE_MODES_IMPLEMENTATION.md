# Battle Modes Implementation Plan

## Goal

Expand Agent Arena from one symmetric provider-versus-provider fight into three
related battle modes:

1. **Duel** — two contestants independently implement the task and fight.
   Providers may be different or the same.
2. **Siege** — one attacker tries to break an existing PR while one defender
   repairs it.
3. **Catch-up** — an incumbent starts with an existing PR while a challenger
   independently recreates the solution from the PR's task contract before the
   normal duel begins.

All modes keep the current evidence rules: executable attacks, authoritative
oracles, deterministic reproduction, bounded repair, held-out sibling cases,
and harness-owned validation.

## Product decisions

### Contestants are not providers

Introduce stable contestant slots and treat the provider as one attribute:

```ts
type ContestantId = "a" | "b";

interface ContestantConfig {
  id: ContestantId;
  provider: AgentId;
  role: "solver" | "attacker" | "defender" | "incumbent" | "challenger";
  startingPatch?: "none" | "pull_request";
}
```

Every state record, attack origin, target, patch, prompt, transcript, score, and
report row is keyed by `ContestantId`. Provider adapters remain keyed by
`AgentId` and may serve multiple isolated contestant invocations.

This permits `codex` versus `codex` without map-key collisions and prevents
provider names from being mistaken for contestant identity.

### Same-provider fights are isolated mirror matches

The two contestants receive separate worktrees, prompts, submission files,
processes, transcripts, and timeouts. Prompts identify only the contestant slot
and role. No implementation or transcript is shared before the attack stage.

Reports render duplicate providers as `Codex A` and `Codex B`.

### Siege is a scored asymmetric battle

Both sides start at 100 HP:

- A landed attack damages the defender using the existing severity table.
- A successful repair heals the defender under the existing visible and
  held-out-case rules.
- A missed ranked attack applies the existing recoil to the attacker.
- Required-check failure can eliminate the defender.
- The higher final health wins; equal health is a draw.

This makes the result understandable:

- unresolved defects favor the attacker;
- speculative or invalid attacks favor the defender;
- valid defects that are fully repaired preserve both sides' health and may
  produce a draw;
- gross damage, healing, and recoil remain visible even when final health ties.

The attacker never owns a competing production patch. Its submissions are
test/fixture-only attack patches. The defender owns the single mutable
implementation lineage.

### Catch-up hides the incumbent implementation

The harness freezes both the PR base commit and head commit, records the PR
patch, and constructs the task contract from the PR, linked issue, repository
specification, and explicit user criteria.

During catch-up:

- the incumbent starts with the frozen PR patch;
- the challenger starts at the PR base commit;
- the challenger sees requirements but not the incumbent diff;
- the challenger receives the normal bounded implementation phase.

After both patches pass initial validation, the normal three-round duel begins
and each contestant may inspect the other's frozen current patch.

### PR authorship is evidence, not stylistic certainty

Greptile's July 2026 model-inversion study selected its Claude and Codex
datasets using explicit commit trails, PR-title prefixes, and branch prefixes.
Its broader authorship work used stacked metadata signals; it did not establish
that wording alone identifies an agent with 100% accuracy.

Agent Arena will therefore return:

```ts
interface AuthorshipAttribution {
  provider?: AgentId;
  confidence: "confirmed" | "likely" | "unknown";
  evidence: Array<{
    kind:
      | "bot_author"
      | "coauthor_trailer"
      | "branch_prefix"
      | "title_prefix"
      | "generator_marker"
      | "statistical_fingerprint";
    source: string;
    value: string;
  }>;
}
```

`confirmed` requires an explicit marker such as a recognized bot author,
co-author trailer, generator marker, or provider-owned branch convention.
Wording and statistical fingerprints can produce only `likely`. Attribution is
displayed in the report and may recommend a cross-provider opponent, but never
changes health, attack validity, patch selection, or permissions.

Initial rules:

- Claude: recognized Claude bot author or `Co-authored-by: Claude ...`.
- Codex: recognized Codex bot author, `[codex]` title, `codex/` branch, or an
  explicit Codex generator marker.
- Gemini: recognized Gemini bot author, explicit Gemini co-author/generator
  marker, or a documented Gemini-owned branch convention.

Store the matched raw evidence in the frozen PR source snapshot. Do not silently
infer a provider when signals conflict.

References:

- https://www.greptile.com/blog/model-inversion
- https://www.greptile.com/blog/rise-of-the-overnight-agents
- https://arxiv.org/abs/2601.17406

## Configuration and CLI

Keep the current command working:

```bash
agent-arena fight "fix issue #241" --agents codex,claude
```

Allow duplicate providers:

```bash
agent-arena fight "fix issue #241" --agents codex,codex
```

Add siege:

```bash
agent-arena defend \
  --pr 87 \
  --attacker codex \
  --defender claude
```

Add catch-up:

```bash
agent-arena fight \
  --pr 87 \
  --incumbent-from-pr \
  --challenger codex
```

If authorship is confirmed and no challenger or attacker is supplied, recommend
the opposite provider when available. Require an explicit `--use-recommended-
opponent` or interactive confirmation before launching it; attribution must not
silently spend money.

Normalize CLI and YAML input into:

```ts
type BattleMode = "duel" | "siege" | "catch_up";

interface BattleConfig {
  mode: BattleMode;
  contestants: [ContestantConfig, ContestantConfig];
}
```

Continue accepting `agents: [codex, claude]` as legacy duel syntax. Persist only
the normalized model in new run state.

## Implementation sequence

### Phase 1 — Separate contestant and provider identity

1. Add `ContestantIdSchema`, `ContestantConfigSchema`, and `BattleModeSchema` in
   `src/core/types.ts`.
2. Change `ContestantResult.agent` to `id`, `provider`, and `role`.
3. Key contestants, patches, outcomes, quality facts, recommendations, attacks,
   integrations, and review decisions by `ContestantId`.
4. Add `contestantId` to agent invocations while retaining `agent` as provider
   metadata.
5. Replace `opponentOf(config, agent)` with slot-based opponent lookup.
6. Build provider adapters once per provider, but invoke them independently for
   each contestant.
7. Use contestant IDs in all artifact paths so duplicate providers cannot
   overwrite prompts, patches, or logs.
8. Bump run state to schema version 3. Keep readers for versions 1 and 2; migrate
   their provider-keyed contestants to slots at load time.

Primary files:

- `src/core/types.ts`
- `src/config/load-config.ts`
- `src/core/arena.ts`
- `src/core/scoring.ts`
- `src/outcomes/derive-outcome.ts`
- `src/recommendation/select-patch.ts`
- `src/agents/adapter.ts`
- `src/agents/prompts.ts`
- `src/runner/integration.ts`
- `src/reports/*`
- `src/review/*`
- `src/delivery/*`

Ship this phase with mirror-match support before adding new battle topology.

### Phase 2 — Verify mirror-match isolation and useful divergence

Add deterministic automated coverage:

- duplicate providers pass config validation;
- slots receive distinct worktrees and artifact paths;
- the same adapter is invoked twice with separate inputs;
- each slot targets the other slot;
- attacks, recoil, repairs, recommendations, review, apply, and delivery bind to
  contestant ID rather than provider;
- provider identity is removed from anonymized verifier inputs;
- old run-state fixtures still load.

Add a gated live evaluation, excluded from normal CI:

1. Choose three small repositories/tasks with multiple reasonable solutions:
   an input-boundary bug, a state/concurrency bug, and an integration/config bug.
2. Run at least three mirror matches per supported provider with fixed budgets
   and recorded model/CLI versions.
3. Record production-diff hashes, changed-path overlap, normalized line overlap,
   implementation summaries, attack hypotheses, unique root defects, landed
   attacks, and final outcomes.
4. Compare against cross-provider fights on the same tasks.

Do not require patches to differ merely for entertainment. The useful gate is
that mirror matches produce independent transcripts and that, across the live
sample, at least one side contributes a non-duplicate implementation choice,
attack, or root defect. If every run converges, inspect prompt symmetry,
temperature/model controls exposed by the provider, and task diversity before
changing arena rules.

Write the live results to a dated artifact under `.context/` and summarize the
evidence in `docs/LIVE_VALIDATION.md`.

### Phase 3 — Freeze a PR as an incumbent patch

The current `base_from_pr` behavior uses the PR head as the common base. Replace
that behavior for the new modes with a PR fixture containing:

- repository identity and PR number;
- frozen title, body, author, branch, commits, and linked issues;
- base and head commit SHAs;
- binary-safe patch from base to head;
- content hashes and retrieval time;
- authorship attribution and its evidence.

Fetch both commits. Create battle worktrees from the base commit and apply the
frozen incumbent patch explicitly. Preserve the existing `base_from_pr`
behavior as a deprecated compatibility path until its callers move to the new
mode.

Add `src/task/pr-fixture.ts` for freezing and hashing this data and
`src/task/authorship.ts` for pure, unit-testable attribution rules.

### Phase 4 — Add catch-up mode

1. Initialize the incumbent's current patch from the frozen PR artifact.
2. Run required validation on the incumbent before spending the challenger's
   implementation budget.
3. Give only the challenger an implementation invocation from the PR base.
4. Ensure the catch-up prompt contains the immutable task contract but excludes
   the incumbent diff, head commit contents, and judge-only sources.
5. Begin the existing duel rounds after both frozen patches are available.
6. Reuse normal scoring, recommendation, review, apply, and delivery.
7. Report whether the challenger independently converged on the same files or
   approach without treating similarity as proof of copying.

If the incumbent patch is empty, does not apply, or fails required validation,
fail preflight rather than awarding the challenger a free win.

### Phase 5 — Add siege mode

1. Add a topology strategy in the arena orchestration rather than duplicating
   the entire state machine:
   - `initializeContestants`
   - `collectRoundAttacks`
   - `validateCandidateAttack`
   - `collectRepairs`
   - `deriveOutcome`
2. Initialize the defender from the frozen PR patch.
3. Give the attacker a clean investigation worktree with the frozen target
   applied, but prohibit production-file changes in its captured attack patch.
4. Validate attacker evidence using the house-attack mechanical path:
   - test-only path policy;
   - deterministic reproduction twice on the frozen target;
   - baseline/control execution when meaningful;
   - oracle, relevance, severity, and root-defect verification;
   - held-out siblings before repair.
5. Apply landed damage to the defender and misses as recoil to the attacker in
   one simultaneous round event.
6. Invoke only the defender during repair and rerun all required, visible, and
   held-out checks.
7. Disable patch comparison and recommendation selection; the only selectable
   production artifact is the defender's final patch.
8. Derive attacker/defender winner from final health and explain unresolved
   damage, healing, recoil, elimination, or tie.

House attacks are unnecessary by default in siege because the dedicated
attacker already uses non-differential validation. Keep an optional neutral
house lane behind configuration only if later live evidence shows a coverage
gap.

### Phase 6 — Reporting, review, and delivery

Reports must show:

- mode and contestant slot;
- provider and role;
- confirmed/likely/unknown incumbent attribution with exact signals;
- initial source: fresh implementation or frozen PR;
- health timeline for both roles;
- landed, repaired, unresolved, rejected, and recoiled attacks;
- winner and plain-language reason;
- final production artifact lineage.

In siege, human review and delivery bind only the defender's final patch. In
catch-up and duel, preserve the existing recommendation and explicit acceptance
flow.

### Phase 7 — Documentation and release

Update together:

- `PRODUCT.md`
- `docs/MVP.md`
- `docs/MVP_IMPLEMENTATION.md`
- `README.md`
- `docs/ARTIFACTS.md`
- `docs/SECURITY.md`

Document that same-provider processes are isolated but not a security sandbox,
that PR attribution is provenance metadata rather than proof of code authorship,
and that automatic opponent recommendations require approval.

## Test plan

### Unit

- Config normalization and legacy syntax.
- Duplicate-provider contestant identity.
- Slot-based scoring, ranking, recommendation, review, and delivery.
- Authorship signals, conflicts, and unknown results.
- PR fixture hashing and base/head selection.
- Siege damage, recoil, healing, elimination, and ties.
- Mode-specific state transitions and prompt visibility.

### Integration

- Codex-versus-Codex with the fake adapter producing two independent patches.
- Duplicate-provider attack and repair round with no artifact collision.
- Catch-up fight where the challenger cannot read the incumbent patch before
  attack round one.
- Siege with a landed-and-repaired defect.
- Siege with attacker recoil and a defender win.
- Siege with unresolved damage and an attacker win.
- Binary PR patch, rename, mode-bit change, and conflicting attribution signals.
- Apply/review/delivery for every mode.

### Smoke and compatibility

- Existing `fight --agents codex,claude` output remains valid.
- Version 1 and 2 run artifacts remain readable.
- CLI help and YAML examples cover all modes.
- `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` pass.

### Controlled live validation

Run only with explicit authorization and cost bounds. Record exact provider,
model, CLI version, prompt hashes, task contract, duration, and spend metadata.
Never make a release claim about same-agent diversity or authorship accuracy
from the fake adapter alone.

## Recommended delivery order

Use small reviewable changes:

1. Contestant identity and schema migration.
2. Mirror-match CLI, reports, and automated tests.
3. Controlled mirror-match live validation.
4. Frozen PR fixture and deterministic authorship signals.
5. Catch-up topology.
6. Siege topology and asymmetric outcome logic.
7. Documentation, compatibility cleanup, and final live validation.

The first three changes deliver agent-versus-itself independently. PR fixture
work then unlocks catch-up and siege without coupling either mode to GitHub live
state during the fight.
