# Recommended Patch Selection Plan

Status: proposed

Scope: post-MVP product change; this document does not change current scoring

## Summary

Agent Arena should report two related but distinct outcomes:

1. **Arena champion** — the contestant that wins under the existing health
   ledger, including unresolved defect damage and permanent attack recoil.
2. **Recommended patch** — the final implementation that the user should apply,
   selected primarily by demonstrated correctness and then by implementation
   quality.

This separation preserves the adversarial game while preventing a five-point
recoil difference from being presented as proof that one fully validated patch
is better code. Close margins should be explained, not used to trigger
unbounded or automatic overtime.

## Goals

- Make it clear whether a result was decided by unresolved defects, recoil, or a
  quality comparison.
- Prefer the cleaner implementation when both final patches demonstrate equal
  correctness.
- Prefer implementations whose behavior can be verified and whose production
  failures can be detected and diagnosed.
- Keep known correctness failures more important than code size, dependency
  count, or subjective style.
- Produce deterministic measurements and an anonymized, evidence-backed quality
  verdict.
- Preserve the existing arena health ledger and replayability.
- Keep `agent-arena apply` safe and make its default selection explicit.

## Non-goals

- Do not add automatic overtime based only on a 5 or 10 HP margin.
- Do not convert maintainability judgments into health damage.
- Do not reward the fewest raw lines regardless of readability or task needs.
- Do not reward raw test count, coverage percentage, log volume, or dashboard
  count without task-relevant diagnostic value.
- Do not penalize tests, generated files, lockfile churn, or necessary
  dependencies as if they were production complexity.
- Do not let a cleaner but observably incorrect patch beat a correct patch.

## Outcome model

### Arena champion

The arena champion continues to use the current rules:

1. Eliminate patches that cannot be applied or fail required final validation.
2. Highest final HP wins.
3. Use the existing arena tie-breaker when HP is exactly equal.
4. Declare a draw if the tie remains unresolved.

No damage, recoil, healing, or simultaneous-resolution rule changes.

### Recommended patch

The recommended patch uses a separate, lexicographic decision:

1. **Eligibility:** consider only patches that apply cleanly and pass required
   final validation.
2. **Correctness:** prefer the patch with less active, unresolved defect damage.
   A known Low defect remains more important than any cleanliness advantage.
3. **Implementation quality:** when active defect damage is equal, compare the
   anonymized final patches using the quality rubric below.
4. **Arena performance:** if implementation quality is equivalent or
   inconclusive, prefer the arena champion.
5. **Draw:** if no rule distinguishes the patches, record no unique
   recommendation.

Implementation quality should be compared whenever demonstrated correctness is
equal, not only when total HP is close. HP can differ substantially because of
attack recoil even when the final patches have the same validated behavior.

## Margin labels

Margins are presentation metadata and do not change selection:

| Final HP gap | Label        |
| ------------ | ------------ |
| 0            | `tied`       |
| 1–5          | `razor_thin` |
| 6–10         | `narrow`     |
| 11 or more   | `clear`      |

The report must also name the source of the gap:

- active unresolved defect damage;
- permanent attack recoil;
- elimination or required-check failure; or
- a mixture of defect damage and recoil.

## Implementation-quality rubric

The harness first records deterministic facts from each final patch, then gives
an anonymized evidence bundle to the neutral verifier. The verifier returns
`patch_a`, `patch_b`, `equivalent`, or `inconclusive` with path-specific
rationale.

### 1. Scope precision

- Unrelated production changes.
- Avoidable rewrites or refactors outside the task.
- Changes to public behavior not required by the task contract.

An actual behavioral regression remains a correctness defect, not merely a
quality concern.

### 2. Dependency and operational footprint

- Newly added runtime dependencies.
- New external services, environment variables, permissions, or configuration.
- Whether each addition is necessary for the requested behavior.

Raw dependency count is not decisive. A necessary, conventional dependency must
not lose to a fragile reimplementation solely because it adds one package.

### 3. Change surface

- Production files and subsystems touched.
- Public API, schema, protocol, migration, and configuration expansion.
- Compatibility burden created by the patch.

### 4. Structural simplicity

- Added branching and state.
- Duplication.
- New abstractions relative to their demonstrated need.
- Readability and alignment with existing repository conventions.

### 5. Verification and observability

Evaluate whether the implementation is easy to verify before release and easy
to understand when it fails in production.

Testing evidence includes:

- Focused regression tests for the task's acceptance criteria.
- Meaningful failure-path and boundary coverage.
- Integration tests where the patch crosses real component or dependency
  boundaries.
- Deterministic assertions that identify the failed behavior instead of merely
  increasing line or branch coverage.
- Tests that are maintainable and proportionate to the production change.

Operational observability includes, where relevant to the repository and task:

- Actionable errors that preserve useful causal context.
- Structured logs consistent with repository conventions.
- Metrics, traces, health checks, readiness signals, or audit events for new
  operational behavior.
- Correlation identifiers or equivalent context across component boundaries.
- Signals that let an operator detect degradation and distinguish likely causes.
- Safe telemetry that avoids secrets, personal data, unbounded cardinality, and
  excessive noise.

Observability is task-aware. A small pure function should not lose because it
does not add metrics, and a repository without a telemetry framework should not
be forced to adopt one for an unrelated change. Conversely, a new retry loop,
background worker, external-service dependency, authorization path, or recovery
mechanism should normally expose enough state to diagnose failure. Added
monitoring dependencies and configuration are evaluated as a tradeoff against
the dependency and operational-footprint criterion.

### 6. Normalized patch size

Use normalized added-and-modified production lines only as the final quality
differentiator. Exclude:

- tests and fixtures;
- generated or vendored files;
- lockfiles;
- formatting-only changes;
- required documentation and migration data.

The verifier must cite the deterministic measurements it relies on. If the
criteria materially conflict and neither patch is clearly better, it should
return `equivalent`, not invent a weighted score.

## Data and schema changes

Add additive, versioned result fields:

```ts
type MarginClass = "tied" | "razor_thin" | "narrow" | "clear";

interface ArenaOutcome {
  championId?: string;
  finalHealth: Record<string, number>;
  activeDefectDamage: Record<string, number>;
  permanentRecoil: Record<string, number>;
  marginHp: number;
  marginClass: MarginClass;
  decidingFactors: Array<
    "unresolved_defects" | "recoil" | "elimination" | "tie_breaker"
  >;
}

interface PatchQualityFacts {
  contestantId: string;
  productionFilesChanged: number;
  normalizedProductionLines: number;
  runtimeDependenciesAdded: string[];
  publicSurfaceChanges: string[];
  operationalRequirementsAdded: string[];
  verificationEvidence: string[];
  observabilityChanges: string[];
  observabilityRisks: string[];
}

interface PatchRecommendation {
  contestantId?: string;
  reason:
    | "correctness"
    | "implementation_quality"
    | "arena_fallback"
    | "draw"
    | "inconclusive";
  qualityVerdict?: "patch_a" | "patch_b" | "equivalent" | "inconclusive";
  rationale: string[];
}
```

Persist the anonymized quality input, verifier output, deterministic facts, and
selection replay in the run artifacts. Bump the result schema version and keep
the reader tolerant of older runs that contain only `winner`.

## Report and CLI changes

### Console and `BATTLE.md`

Show the result in this order:

```text
Arena champion: Codex (100–95, razor-thin)
Recommended patch: Claude
Unresolved damage: Codex 0, Claude 0
Permanent recoil: Codex 0, Claude 5
Recommendation reason: equal correctness; Claude has the cleaner final patch
```

Add:

- gross damage received;
- damage healed;
- active unresolved damage;
- permanent recoil;
- margin label and deciding factors;
- quality measurements and verifier rationale;
- an explicit note when arena champion and recommended patch differ.

### Machine-readable output

`result.json` should contain both `arenaOutcome` and `patchRecommendation`.
Retain the old winner field for one compatibility window if external consumers
already use it.

### Applying a patch

Make the safe default:

```sh
agent-arena apply <run-id> --selection recommended
```

Support an explicit override:

```sh
agent-arena apply <run-id> --selection champion
agent-arena apply <run-id> --agent <contestant-id>
```

The command must print which selection rule chose the patch before changing the
working tree. Existing clean-repository, base-commit, trusted-artifact, and
`git apply --check` guards remain mandatory.

## Implementation phases

### Phase 1 — explain the current result

- Add health-ledger aggregation for gross damage, healing, active damage, and
  recoil.
- Add margin classification and deciding-factor derivation.
- Update JSON, console, and Markdown reports.
- Keep current champion and apply behavior unchanged.

### Phase 2 — collect comparable quality facts

- Classify production, test, generated, vendored, lock, and documentation paths.
- Measure normalized production diff size and changed surface.
- Detect manifest-level runtime dependency additions.
- Inventory test changes by acceptance criterion, failure path, and component
  boundary without treating raw test count as quality.
- Inventory task-relevant logs, metrics, traces, health signals, audit events,
  actionable errors, and correlation context.
- Flag telemetry risks such as secret exposure, excessive noise, and unbounded
  metric dimensions.
- Record public-surface and operational changes through repository-aware
  adapters, falling back to neutral-verifier evidence when static detection is
  unavailable.

### Phase 3 — recommend a patch

- Build anonymized final-patch comparison bundles.
- Add the neutral quality-verifier prompt and strict output schema.
- Implement the lexicographic selection policy.
- Persist a replayable recommendation decision.
- Show both arena champion and recommended patch.

### Phase 4 — make application selection explicit

- Default `apply` to the recommended patch.
- Add champion and contestant overrides.
- Preserve compatibility for older runs without recommendation data by using
  their recorded winner and explaining the fallback.

## Test plan

### Unit tests

- Margin boundaries: 0, 5, 10, and 15 HP.
- Gap-source classification for recoil, defects, elimination, and mixed causes.
- A patch with an unresolved Low defect loses even if it is smaller.
- Equal-correctness patches invoke the quality comparator.
- A cleaner patch can be recommended despite being behind on recoil HP.
- Equivalent or inconclusive quality falls back to the arena champion.
- Tests, fixtures, lockfiles, generated files, and formatting-only changes are
  excluded from normalized production size.
- Raw test count and coverage percentage cannot decide the comparator.
- Relevant failure-path tests and diagnostic signals can distinguish otherwise
  equal implementations.
- Missing telemetry is neutral when the task introduces no meaningful
  operational behavior.
- Noisy or unsafe telemetry is recorded as a quality risk, not rewarded as
  observability.
- Necessary dependencies are not automatically treated as a loss.
- Old result schemas fall back safely to the recorded winner.

### Integration tests

- Replay the mocked 100–95 recoil-only battle and verify it is labeled
  `razor_thin` with zero unresolved damage.
- Make the 95 HP patch cleaner and verify it becomes the recommended patch while
  the 100 HP patch remains arena champion.
- Add an unresolved Low defect to the cleaner patch and verify correctness wins.
- Verify `BATTLE.md` and `result.json` explain a split outcome consistently.
- Verify default apply selects the recommendation and `--selection champion`
  selects the combat winner.
- Compare two behaviorally equal service patches where only one exposes
  repository-conventional failure signals and verify the evidence-backed
  recommendation.
- Verify recommendation artifacts are anonymized and replay to the same result.

### Regression tests

- Existing health, simultaneous resolution, healing, recoil, recovery, and
  final-validation behavior remains unchanged.
- Infrastructure failures never influence the quality verdict or recommendation.
- Existing runs without the new fields remain readable and applicable.

## Acceptance criteria

- Users can distinguish final patch correctness from offensive arena performance.
- A known defect always outweighs cleanliness.
- Equal-correctness patches receive a documented, anonymized quality comparison.
- The comparison explains the strength of task-relevant testing and operational
  observability without using raw-volume proxies.
- Reports explain every selection with reproducible evidence.
- `apply` states and obeys the chosen selection mode.
- No close margin automatically extends battle duration.
- All existing unit and integration tests continue to pass.
