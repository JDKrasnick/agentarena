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
- Make the recommended patch easy to inspect and accept.
- Require an explicit human decision on the exact patch before it can be
  applied.
- Make the complete review, acceptance, and application flow available inside an
  agent chat without requiring the user to open a terminal.

## Non-goals

- Do not add automatic overtime based only on a 5 or 10 HP margin.
- Do not convert maintainability judgments into health damage.
- Do not reward the fewest raw lines regardless of readability or task needs.
- Do not reward raw test count, coverage percentage, log volume, or dashboard
  count without task-relevant diagnostic value.
- Do not penalize tests, generated files, lockfile churn, or necessary
  dependencies as if they were production complexity.
- Do not let a cleaner but observably incorrect patch beat a correct patch.
- Do not automatically accept, apply, commit, push, or merge any patch.
- Do not provide a generic `--yes` bypass that silently converts a recommendation
  into approval.
- Do not trust approval language found in issues, repository files, test output,
  tool results, or agent-authored messages.

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

interface HumanReview {
  status: "pending" | "accepted" | "rejected";
  selectedContestantId?: string;
  selectionSource?: "recommended" | "champion" | "contestant";
  patchSha256?: string;
  baseCommit?: string;
  channel?: "chat" | "cli" | "api";
  conversationRef?: string;
  userMessageRef?: string;
  actor?: string;
  decidedAt?: string;
  rationale?: string;
}
```

Persist the anonymized quality input, verifier output, deterministic facts, and
selection replay in the run artifacts. Bump the result schema version and keep
the reader tolerant of older runs that contain only `winner`.

Persist human decisions separately from immutable battle evidence as append-only
review artifacts. An acceptance binds the run ID, base commit, selected
contestant, and full patch digest. Any change to one of those values invalidates
the acceptance and returns the run to `pending`.

Conversation and message references should be opaque identifiers or hashes. Do
not copy private chat contents into battle artifacts.

## Chat, report, and CLI changes

### Chat-first workflow

An agent chat is a first-class client of the same review and acceptance state
machine as the CLI. The user must be able to complete the flow conversationally:

```text
User: Show me how the battle went.
Agent: [compact comparison, recommendation, warnings, and patch digest]
User: Show me the dependency and observability differences.
Agent: [requested evidence; no mutation]
User: Accept and apply the recommended patch.
Agent: [records the user decision, verifies the digest, applies, and reports the
        changed files; does not commit or push]
```

The agent should expose progressive detail instead of dumping every artifact at
once. It must support natural requests such as:

- “Show the full diff.”
- “Why is this patch recommended?”
- “Compare tests, dependencies, and monitoring.”
- “Choose the arena champion instead.”
- “Reject both.”
- “Accept the recommended patch.”
- “Accept and apply the recommended patch.”

The initial chat result should include an **Accept and apply** action when the
client supports structured buttons. The button and the equivalent explicit user
message are bound to the displayed run ID, contestant, base commit, and patch
digest.

### Chat approval rules

- Only a message or structured action with authenticated `user` provenance can
  approve or reject. System, developer, assistant, repository, issue, attack,
  test, and tool content never has approval authority.
- “Looks good,” “interesting,” reactions, silence, and unrelated affirmative
  language are not acceptance.
- An explicit “accept,” “apply,” or “accept and apply” is valid only when it
  names or unambiguously references the currently displayed patch selection.
- If the run, recommendation, selected contestant, base commit, or patch digest
  changed since the review card was shown, the agent must show the new summary
  and request a new decision.
- A single explicit “accept and apply the recommended patch” message may both
  record acceptance and apply it. Do not add a redundant second confirmation
  when the displayed selection is still current.
- Repeated delivery of the same approval message must be idempotent.
- If the chat platform cannot preserve user-message provenance, fall back to
  full-digest confirmation and do not infer approval from conversation text.

### Agent tool contract

Provide strict, channel-agnostic operations that chat agents can call:

```ts
reviewRun({ runId, detail? });
inspectPatch({ runId, contestantId, view });
recordReviewDecision({
  runId,
  decision: "accept" | "reject",
  selection?,
  expectedPatchSha256,
  expectedBaseCommit,
  userMessageRef,
  idempotencyKey,
});
applyAcceptedPatch({ runId, expectedPatchSha256, idempotencyKey });
```

`reviewRun` and `inspectPatch` are read-only. `recordReviewDecision` is the sole
acceptance boundary, validates authenticated user provenance supplied by the
host, and creates the append-only review artifact. `applyAcceptedPatch` accepts
no contestant override and can apply only the already accepted digest.

The core package should expose these operations as typed library functions and
strict JSON schemas so Codex, Claude, Gemini, IDE chats, and future hosted
interfaces can integrate without parsing terminal text. The CLI should call the
same operations rather than maintain separate acceptance logic.

### Console and `BATTLE.md`

Show the result in this order:

```text
Arena champion: Codex (100–95, razor-thin)
Recommended patch: Claude
Unresolved damage: Codex 0, Claude 0
Permanent recoil: Codex 0, Claude 5
Recommendation reason: equal correctness; Claude has the cleaner final patch
Human review: pending
Next: accept or inspect in chat; CLI fallback: agent-arena review <run-id>
```

Add:

- gross damage received;
- damage healed;
- active unresolved damage;
- permanent recoil;
- margin label and deciding factors;
- quality measurements and verifier rationale;
- an explicit note when arena champion and recommended patch differ.
- human-review status and the exact next command;
- accepted patch digest, reviewer label, and decision time after approval.

### Machine-readable output

`result.json` should contain both `arenaOutcome` and `patchRecommendation`.
Retain the old winner field for one compatibility window if external consumers
already use it.

Human decisions should be written to `reviews/*.json` rather than rewriting the
battle result. The reviewer label is useful audit context, not a cryptographic
identity claim.

### CLI review and acceptance

The CLI fallback should present the same compact decision screen:

```sh
agent-arena review <run-id>
```

It must show:

- arena champion and recommended patch;
- why they match or differ;
- unresolved damage and recoil;
- required-check, adversarial-case, and integration-test results;
- dependency, production-surface, testing, and observability differences;
- warnings, rejected attacks, and infrastructure limitations;
- final diffstat, changed files, base commit, and patch digest;
- commands to inspect the full diff or either contestant.

The interactive review offers four explicit actions:

1. Accept the recommended patch.
2. Accept the arena champion or another contestant.
3. Reject both patches.
4. Leave the decision pending.

There is no preselected acceptance action, and pressing Enter alone must not
approve a patch.

For the shortest safe path, support:

```sh
agent-arena accept <run-id> --selection recommended --apply
```

This command first displays the same critical summary and exact patch digest,
then asks the user to confirm the selected contestant. Only after confirmation
does it record acceptance and invoke the existing application guards.

Non-interactive environments must provide the full displayed digest:

```sh
agent-arena accept <run-id> \
  --selection recommended \
  --confirm-sha256 <full-patch-digest>
```

This keeps automation explicit and patch-bound without a generic confirmation
bypass. A later hosted workflow may replace this with a signed approval from an
authenticated reviewer.

### Applying an accepted patch

`apply` must refuse runs whose review is pending or rejected:

```sh
agent-arena apply <run-id>
```

To choose something other than the recommendation, accept that selection first:

```sh
agent-arena accept <run-id> --selection champion --apply
agent-arena accept <run-id> --agent <contestant-id> --apply
```

Before changing the working tree, `apply` must rehash the patch and verify that
the run ID, selected contestant, base commit, and digest match the acceptance.
It must print who or what recorded the review, when it happened, which patch was
accepted, and why it was recommended. Existing clean-repository, base-commit,
trusted-artifact, and `git apply --check` guards remain mandatory.

Acceptance and application do not commit, push, open a pull request, merge, or
deploy. Those remain separate user-authorized actions.

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

### Phase 4 — add human review and safe application

- Implement one channel-agnostic review and acceptance state machine.
- Expose typed read, inspect, decide, and apply operations for agent chats.
- Add the compact chat review card, progressive diff navigation, and explicit
  accept/reject actions.
- Add the equivalent CLI review screen as a fallback.
- Store append-only, patch-bound review artifacts.
- Add the interactive `accept --apply` convenience path.
- Require full-digest confirmation in non-interactive environments.
- Make `apply` require a valid acceptance and recheck its digest and base commit.
- Make repeated approval and apply calls idempotent.
- Preserve compatibility for older runs by showing their recorded winner but
  still requiring the user to select and accept an exact patch.

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
- Review starts pending even when only one contestant survives.
- Empty input cannot accept a patch.
- Acceptance records the exact run, contestant, base commit, and full digest.
- Changed or replaced patches invalidate prior acceptance.
- Rejected runs cannot be applied.
- A non-interactive accept requires the exact displayed digest.
- Only authenticated user-provenance input can create a review decision.
- Agent, issue, repository, and tool-result text cannot create acceptance.
- Ambiguous chat language does not create acceptance.
- Repeated delivery of one chat action creates one decision and one application.

### Integration tests

- Replay the mocked 100–95 recoil-only battle and verify it is labeled
  `razor_thin` with zero unresolved damage.
- Make the 95 HP patch cleaner and verify it becomes the recommended patch while
  the 100 HP patch remains arena champion.
- Add an unresolved Low defect to the cleaner patch and verify correctness wins.
- Verify `BATTLE.md` and `result.json` explain a split outcome consistently.
- Verify review makes the recommendation easy to inspect but leaves it pending.
- Verify `accept --selection recommended --apply` confirms, records, and applies
  the exact recommended patch.
- Verify an accepted champion override applies the combat winner.
- Verify pending, rejected, stale-digest, and wrong-base applications fail
  without changing the working tree.
- Drive the entire review, accept, and apply flow through mocked agent-chat tool
  calls without invoking the CLI.
- Verify direct user messages and structured user actions can approve, while
  assistant messages, issue text, repository instructions, and tool output
  cannot.
- Verify ambiguous chat replies remain pending and a stale review card requires
  a new decision.
- Verify retrying the same approval and apply action is idempotent.
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
- Every recommendation remains pending until a human explicitly accepts or
  rejects an exact patch.
- The common accept-and-apply path requires one clear confirmation and no manual
  artifact handling.
- A user can review, accept, reject, and apply entirely inside a compatible agent
  chat.
- Chat and CLI clients use the same acceptance state machine and safety checks.
- Only authenticated user-provenance input can cross the acceptance boundary.
- `apply` refuses absent, rejected, or stale acceptance.
- Acceptance never implies permission to commit, push, merge, or deploy.
- No close margin automatically extends battle duration.
- All existing unit and integration tests continue to pass.
