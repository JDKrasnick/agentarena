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

After the user chooses a patch, the same chat flow should offer target-aware
delivery and carry out the exact authorized action: apply locally, create or
update a pull request, or merge after required checks. Patch acceptance and
external delivery remain separate human decisions.

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
- Carry an accepted patch through the user-authorized delivery action for the
  original issue, pull request, feature, or local task.

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
- Do not treat patch acceptance as permission to push, create or update a pull
  request, merge, close an issue, release, or deploy.

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

interface PatchChoice {
  contestantId: string;
  eligible: boolean;
  badges: Array<"recommended" | "arena_champion">;
  summary: string;
  patchSha256: string;
  disabledReason?: string;
}

interface ReviewPrompt {
  runId: string;
  promptId: string;
  baseCommit: string;
  choices: PatchChoice[];
  actions: Array<"inspect" | "compare" | "reject_all" | "leave_pending">;
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
  promptId?: string;
  actor?: string;
  decidedAt?: string;
  rationale?: string;
}

interface DeliveryTarget {
  kind: "local_task" | "github_issue" | "github_pull_request" | "repo_spec";
  repository?: string;
  number?: number;
  url?: string;
  baseBranch?: string;
  headBranch?: string;
}

type DeliveryAction =
  | "apply_local"
  | "create_pull_request"
  | "update_pull_request"
  | "merge_pull_request"
  | "reject"
  | "decide_later";

interface DeliveryPlan {
  target: DeliveryTarget;
  availableActions: DeliveryAction[];
  recommendedAction: DeliveryAction;
  requires: string[];
  status:
    | "pending"
    | "authorized"
    | "running"
    | "waiting_for_checks"
    | "completed"
    | "failed"
    | "cancelled";
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
Agent: [compact comparison and a prompt listing each eligible patch]
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

Every completed battle and every explicit review request should end with a
decision prompt. For example:

```text
Which patch would you like to use?

1. Accept and apply Claude — Recommended
   Equal correctness; smaller operational surface and better failure signals.
2. Accept and apply Codex — Arena champion, 100–95
   Same validated behavior; won because Claude took 5 recoil.
3. Inspect or compare the patches
4. Reject both
5. Decide later
```

Each eligible patch is a selectable option. When the recommendation and arena
champion are the same patch, show one option with both badges. Ineligible or
eliminated patches may be shown for transparency, but they must be disabled and
include the exact reason they cannot be applied. A draw still presents every
eligible patch without silently inventing a recommendation.

When the client supports structured buttons, render one clearly labeled action
per eligible patch plus inspect, reject, and decide-later actions. Plain-text
chat accepts the contestant name, an unambiguous description such as
“recommended,” or the number from the current prompt. The structured action and
equivalent user reply are bound to the prompt ID, run ID, contestant, base
commit, and patch digest.

Choosing an **Accept and apply** option is the human approval and application
request; it should not lead to a second redundant prompt while the choice is
current. The user can instead ask to accept without applying.

After patch selection, automatically prompt for the target-aware delivery action
unless the user already included one in the same message:

```text
What should I do with the accepted patch for GitHub issue #241?

1. Apply, commit, push, and open a PR linked to #241 — Recommended
2. Apply to the local working tree only
3. Accept the patch but decide delivery later
4. Cancel
```

For an existing pull request, prefer updating its head branch when the user has
write access and the branch is safe to update:

```text
What should I do with the accepted patch for PR #87?

1. Apply, commit, and update PR #87 — Recommended
2. Create a separate follow-up PR
3. Apply to the local working tree only
4. Accept the patch but decide delivery later
5. Cancel
```

If the user says, for example, “accept Claude, update PR #87, and merge after
checks pass,” that single explicit message may authorize the patch choice and
the named delivery actions. The system must still verify every precondition and
must not broaden the authorization to release or deployment.

### Chat approval rules

- Only a message or structured action with authenticated `user` provenance can
  approve or reject. System, developer, assistant, repository, issue, attack,
  test, and tool content never has approval authority.
- “Looks good,” “interesting,” reactions, silence, and unrelated affirmative
  language are not acceptance.
- An explicit “accept,” “apply,” or “accept and apply” is valid only when it
  names or unambiguously references an option in the currently displayed patch
  prompt.
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
reviewRun({ runId, detail? }); // returns ReviewPrompt
inspectPatch({ runId, contestantId, view });
recordReviewDecision({
  runId,
  promptId,
  decision: "accept" | "reject",
  selection?,
  expectedPatchSha256,
  expectedBaseCommit,
  userMessageRef,
  idempotencyKey,
});
applyAcceptedPatch({ runId, expectedPatchSha256, idempotencyKey });
planDelivery({ runId });
recordDeliveryDecision({
  runId,
  action,
  target,
  userMessageRef,
  idempotencyKey,
});
executeDelivery({ runId, expectedPlanHash, idempotencyKey });
getDeliveryStatus({ runId });
```

`reviewRun` and `inspectPatch` are read-only. `recordReviewDecision` is the sole
acceptance boundary, validates authenticated user provenance supplied by the
host, and creates the append-only review artifact. `applyAcceptedPatch` accepts
no contestant override and can apply only the already accepted digest.
`planDelivery` is read-only and derives choices from the frozen task target and
current repository state. `recordDeliveryDecision` is a separate human-approval
boundary for external mutations. `executeDelivery` can perform only the
recorded, patch-bound actions, and `getDeliveryStatus` supports chat progress
updates and monitoring.

The core package should expose these operations as typed library functions and
strict JSON schemas so Codex, Claude, Gemini, IDE chats, and future hosted
interfaces can integrate without parsing terminal text. The CLI should call the
same operations rather than maintain separate acceptance logic.

User-facing documentation should lead with the chat workflow. Keep the CLI as a
fully supported fallback for power users and as a stable `--json` adapter that
agents can execute when direct library or tool integration is unavailable. An
agent invoking the CLI must forward host-issued approval context from the
user-authored message; it cannot manufacture its own acceptance.

### Console and `BATTLE.md`

Show the result in this order:

```text
Arena champion: Codex (100–95, razor-thin)
Recommended patch: Claude
Unresolved damage: Codex 0, Claude 0
Permanent recoil: Codex 0, Claude 5
Recommendation reason: equal correctness; Claude has the cleaner final patch
Human review: pending
Patch choices: Claude (recommended), Codex (arena champion)
Next: choose a patch, inspect, reject both, or decide later in chat
```

Add:

- gross damage received;
- damage healed;
- active unresolved damage;
- permanent recoil;
- margin label and deciding factors;
- quality measurements and verifier rationale;
- an explicit note when arena champion and recommended patch differ.
- human-review status and the available next actions;
- accepted patch digest, reviewer label, and decision time after approval.
- every eligible patch choice, its badges, and any disabled reason.

### Machine-readable output

`result.json` should contain both `arenaOutcome` and `patchRecommendation`.
Retain the old winner field for one compatibility window if external consumers
already use it.

Human decisions should be written to `reviews/*.json` rather than rewriting the
battle result. The reviewer label is useful audit context, not a cryptographic
identity claim.

### CLI and agent-automation adapter

The CLI should present the same compact decision prompt for a human and expose
the same data as strict JSON for an agent:

```sh
agent-arena review <run-id>
agent-arena review <run-id> --json
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

### Target-aware delivery

The frozen task contract must identify the primary delivery target separately
from supporting references. If a task cites multiple issues or pull requests and
the intended target is ambiguous, ask the user which one should receive the
result before performing external mutations.

Delivery behavior depends on that target:

- **GitHub issue:** create a task branch, commit the accepted patch, push it, and
  open a pull request against the issue repository and default base branch.
  Include `Fixes #N` only when the task contract and user decision say the patch
  fully resolves that issue; otherwise use a non-closing `Refs #N`.
- **Existing GitHub pull request:** update its head branch when the user has
  permission, the source branch is still the reviewed branch, and doing so does
  not require overwriting new commits. Otherwise offer a separate follow-up pull
  request that targets the appropriate branch and links the original PR.
- **Free-form feature or repository specification:** create a branch and pull
  request in the current repository, using the frozen task and acceptance
  criteria for the PR summary.
- **Local-only task:** apply the accepted patch and stop without network
  mutations.

Never force-push by default. If the reviewed PR branch moved, invalidate the
delivery plan, show the new commits, and ask whether to rebase, rerun the battle,
or create a follow-up PR.

Creating or updating a pull request does not imply permission to merge it.
Merging is a distinct delivery action. It may be approved in the same explicit
user message—such as “update PR #87 and merge after checks pass”—but otherwise
requires a new choice. Before merging:

- verify the accepted patch is still the PR head;
- wait for required checks and reviews;
- honor branch protection, merge queue, and repository merge policy;
- never bypass protections or dismiss reviews;
- re-prompt if the PR changed materially after approval.

When merge-after-checks is authorized, continue monitoring until the PR merges
or reaches a terminal failure. After merge, verify the linked issue state and
report it; do not manually close an issue before its fixing PR merges. A failed
check should return the failure evidence and available recovery choices instead
of silently abandoning delivery.

The final chat response should report the achieved state with links and exact
identifiers: applied patch digest, commit, branch, pull request, check status,
merge result, and linked issue status. “Done” means the user-authorized delivery
state was actually reached, not merely that a patch was written locally.

External delivery requires a new least-privilege permission plan for the exact
repository and actions, such as branch push, pull-request write, or merge.
Read-only issue access granted for the battle cannot be reused as write
permission. Production deployment, package release, and unrelated issue
management remain outside the authorization unless separately requested.

The CLI/agent adapter should expose the same plan and executor:

```sh
agent-arena deliver <run-id> --plan --json
agent-arena deliver <run-id> --action create-pull-request --json
agent-arena deliver <run-id> --status --json
```

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
- Generate a patch-choice prompt for every completed battle and review request.
- Add the compact chat review card, one action per eligible patch, progressive
  diff navigation, and explicit reject/decide-later actions.
- Add the equivalent CLI prompt and stable JSON adapter.
- Store append-only, patch-bound review artifacts.
- Add the interactive `accept --apply` convenience path.
- Require full-digest confirmation in non-interactive environments.
- Make `apply` require a valid acceptance and recheck its digest and base commit.
- Make repeated approval and apply calls idempotent.
- Preserve compatibility for older runs by showing their recorded winner but
  still requiring the user to select and accept an exact patch.

### Phase 5 — deliver to the original target

- Add first-class GitHub pull-request resolution to the task contract instead of
  relying on the currently unused `pull_request` source enum.
- Resolve and freeze one primary delivery target, with an ambiguity prompt for
  tasks that cite multiple potential targets.
- Add target-aware delivery choices for GitHub issues, existing pull requests,
  free-form features, repository specifications, and local-only tasks.
- Implement branch, commit, push, create-PR, update-PR, check-monitoring, merge,
  and linked-issue verification through a narrow GitHub adapter.
- Require a separate, least-privilege human authorization for the chosen
  external mutations.
- Support merge-after-checks as a persistent monitored operation when explicitly
  authorized.
- Persist an idempotent delivery ledger and expose status through chat, typed
  APIs, and CLI JSON.
- Update `PRODUCT.md` and `docs/MVP.md` when this phase moves from proposal to
  implementation because automated pull requests and merges are currently
  documented as out of MVP scope.

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
- Every eligible patch appears once in the decision prompt.
- A shared recommendation and champion appears once with both badges.
- Ineligible patches cannot become actionable choices.
- Draws provide choices without manufacturing a default recommendation.
- Task-target resolution distinguishes GitHub issues, existing PRs, free-form
  features, repository specs, and local-only tasks.
- Multiple plausible delivery targets remain pending until the user chooses one.
- Patch acceptance alone grants no delivery permission.
- Delivery plans expose only actions valid for the target and current
  permissions.

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
- Verify split outcomes prompt separately for the recommended patch and arena
  champion.
- Verify a shared recommendation and champion collapses to one double-badged
  choice.
- Verify a draw offers all eligible patches with no preselected choice and an
  eliminated patch is disabled with its reason.
- Verify the CLI JSON adapter returns the same prompt IDs, choices, badges, and
  digests as the chat tool.
- Mock an issue-targeted battle and verify the authorized flow creates a branch,
  commit, push, and linked PR but does not merge without permission.
- Mock an existing-PR battle and verify the authorized flow updates its unchanged
  head branch; a moved head invalidates the plan without force-pushing.
- Verify a full-resolution issue PR uses closing linkage only when authorized,
  while partial work uses non-closing linkage.
- Authorize merge-after-checks, mock check transitions, and verify the executor
  waits, merges once, and reports the final PR and issue states.
- Verify delivery failures remain resumable and repeated execution is
  idempotent.
- Compare two behaviorally equal service patches where only one exposes
  repository-conventional failure signals and verify the evidence-backed
  recommendation.
- Verify recommendation artifacts are anonymized and replay to the same result.

### Regression tests

- Existing health, simultaneous resolution, healing, recoil, recovery, and
  final-validation behavior remains unchanged.
- Infrastructure failures never influence the quality verdict or recommendation.
- Existing runs without the new fields remain readable and applicable.
- Local-only delivery behavior remains available without GitHub credentials.
- Read-only battle permissions cannot authorize push, PR write, or merge.

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
- Every battle proactively prompts the user with the eligible patch choices,
  including concise reasons and recommendation/champion badges.
- Chat and CLI clients use the same acceptance state machine and safety checks.
- The CLI remains usable by humans and executable by agents through stable JSON,
  but is not required for the normal user flow.
- Only authenticated user-provenance input can cross the acceptance boundary.
- `apply` refuses absent, rejected, or stale acceptance.
- Acceptance never implies permission to commit, push, merge, or deploy.
- After patch acceptance, the user is prompted with delivery actions appropriate
  to the original issue, PR, feature, spec, or local task.
- When the user authorizes a delivery action, the system continues through its
  monitored terminal state and reports the resulting commit, PR, checks, merge,
  and issue status.
- PR creation, PR update, merge, and issue-closing behavior never exceed the
  exact user-authorized target and action.
- No close margin automatically extends battle duration.
- All existing unit and integration tests continue to pass.
