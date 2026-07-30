# Recommended Patch Implementation Plan

Status: ready for implementation

Depends on: `PRODUCT.md`, `docs/MVP.md`, and
`docs/RECOMMENDED_PATCH_PLAN.md`

## Objective

Implement the recommended-patch proposal as a sequence of independently
testable changes:

1. Explain the existing arena result accurately.
2. Compare equally correct final patches for implementation quality.
3. Recommend the patch a developer should ship without changing arena scoring.
4. Present patch choices and evidence in an agent chat.
5. Require human, patch-bound approval before local application.
6. Resolve the original task target.
7. Carry out separately authorized GitHub delivery through its terminal state.

The arena champion remains the result of the current health ledger. The
recommended patch is a separate correctness-first selection. No phase changes
damage, recoil, healing, simultaneous resolution, recovery, or the existing
champion calculation.

## Current baseline

The repository currently has:

- A versioned `RunStateSchema` and `TaskContractSchema` in
  `src/core/types.ts`.
- A three-round fight orchestrator in `src/core/arena.ts`.
- Immutable final patch artifacts for each contestant.
- Health ledger, events, ranking, and final checks in `result.json`.
- Markdown and console reports.
- A local `apply --agent` command with repository, base-commit, path, and
  `git apply --check` guards.
- GitHub issue snapshots through `gh issue view`.
- Free-form task, acceptance-criteria, local-spec, and repository-instruction
  sources.
- Twenty-five passing unit and integration tests using fake provider adapters
  and mocked issue data.

Known prerequisites and gaps:

- `npm run test:smoke` fails because no smoke test exists.
- No live provider plus live issue run has been completed.
- Pull requests exist in the task-source enum but have no resolver or CLI/config
  input.
- `BATTLE.md` does not summarize replacement credits, infrastructure reviews,
  or harness overlays.
- Current application has no review artifact or human-approval state.
- Current code has no PR creation, PR update, merge, or issue-state delivery.

## Fixed design decisions

These decisions should not be reopened during implementation unless product
requirements change:

1. **Champion and recommendation stay separate.** Existing HP ranking continues
   to name the arena champion.
2. **Correctness is lexicographic.** Eligibility and active unresolved defect
   damage precede every cleanliness consideration.
3. **Quality does not affect HP.** It produces a pairwise recommendation only.
4. **No automatic overtime.** Margin labels explain close results but do not
   extend battles.
5. **Chat is the primary user experience.** Typed APIs and strict JSON are the
   source of truth; the CLI is a supported client and agent-executable fallback.
6. **Acceptance is not delivery authorization.** Apply, push, PR write, merge,
   issue closure, release, and deploy are separate capabilities.
7. **Human decisions bind exact artifacts.** Run ID, prompt ID, contestant, base
   commit, and full patch digest are mandatory.
8. **External operations are idempotent and monitored.** Retrying cannot create
   duplicate reviews, commits, PRs, or merges.
9. **GitHub is the first delivery provider.** Other trackers require later
   adapters.
10. **No automatic deployment or release.** They remain outside this plan.

## Target architecture

Keep the current arena orchestration focused on producing trustworthy battle
evidence. Add post-fight modules with narrow responsibilities:

```text
src/
  outcomes/
    derive-outcome.ts
  quality/
    classify-path.ts
    collect-facts.ts
    manifest-adapters.ts
    verifier.ts
  recommendation/
    select-patch.ts
  review/
    prompt.ts
    service.ts
    store.ts
    approval.ts
  delivery/
    target.ts
    plan.ts
    service.ts
    store.ts
    github.ts
    monitor.ts
  chat/
    contracts.ts
  commands/
    review.ts
    accept.ts
    deliver.ts
```

The arena writes final evidence and a recommendation. Review and delivery
services consume those artifacts after the fight; they do not mutate health or
attack history.

## Dependency sequence

| Phase                | Depends on              | Highest mutation level      |
| -------------------- | ----------------------- | --------------------------- |
| 0 — hardening        | Current MVP             | Test and report files       |
| 1 — outcome          | 0                       | Completed run artifacts     |
| 2 — quality facts    | 1                       | Completed run artifacts     |
| 3 — recommendation   | 2                       | Completed run artifacts     |
| 4 — chat review      | 3                       | Read-only review APIs       |
| 5 — accepted apply   | 4                       | Local working tree          |
| 6 — task targets     | 0 and schema groundwork | Read-only GitHub fetch      |
| 7 — PR delivery      | 5 and 6                 | Git push and PR write       |
| 8 — merge monitoring | 7                       | Explicitly authorized merge |

Phase 6 can be developed alongside Phases 2–5 after the shared schema migration
helpers land. Phase 7 must not begin until both the approval boundary and target
resolver are complete.

## Artifact model and compatibility

### Result schema

Introduce explicit schemas rather than widening the current literal version:

```ts
const RunStateV1Schema = /* current schema */;
const RunStateV2Schema = RunStateV1Schema.omit({ schemaVersion: true }).extend({
  schemaVersion: z.literal(2),
  arenaOutcome: ArenaOutcomeSchema,
  patchQualityFacts: z.partialRecord(AgentIdSchema, PatchQualityFactsSchema),
  patchRecommendation: PatchRecommendationSchema,
  reviewPrompt: ReviewPromptSchema,
  deliveryTarget: DeliveryTargetSchema.optional(),
});

const AnyRunStateSchema = z.discriminatedUnion("schemaVersion", [
  RunStateV1Schema,
  RunStateV2Schema,
]);
```

Add `parseRunState` and `migrateRunStateV1` helpers. Older runs must remain:

- readable;
- reportable;
- reviewable through an explicit patch choice;
- applicable only after a new review decision;
- local-only unless a delivery target can be proven without guessing.

For an old run, derive health totals from its ledger and events. Treat its
recorded winner as an `arena_fallback` recommendation. Do not retroactively run
a quality verifier unless the user requests a replay.

### Mutable post-fight state

Keep `result.json`, patch files, prompts, and battle evidence immutable after
completion.

Store post-fight activity separately:

```text
reviews/
  <decision-id>.json
delivery/
  plan.json
  events/
    <event-id>.json
operations/
  <idempotency-key-hash>.json
```

Review decisions and delivery events are append-only. A derived current-status
file may be cached, but it is never the source of truth.

Every event contains:

- schema version;
- stable event ID;
- parent event ID or hash where applicable;
- run ID;
- patch digest;
- idempotency-key hash;
- timestamp;
- redacted evidence;
- resulting status.

Use atomic temporary-file plus rename writes. A duplicate idempotency key must
return the recorded result. A conflicting payload for the same key must fail.

### Artifact store

Extend `ArtifactStore.initialize()` with `reviews`, `delivery/events`, and
`operations`. Add:

- `writeImmutableJson`;
- `readOptionalJson`;
- `listValidatedArtifacts`;
- atomic replacement only for explicitly derived caches.

Every path continues through `ArtifactStore.resolve()` and its escape guard.

## Phase 0 — prerequisite hardening

### 0.1 Repair smoke testing

Add `test/smoke/cli.test.ts` and make `npm run test:smoke` pass.

The smoke test should:

- build the package;
- run `dist/cli.js --help`;
- create a real temporary Git repository;
- put fake `codex` and `claude` executables on an isolated `PATH`;
- run the CLI through one complete fight;
- parse `result.json` and `BATTLE.md`;
- apply a selected patch through the current command;
- rerun the repository test.

Do not contact provider or GitHub services in CI.

Add an opt-in `test:live` script that exits with a clear skip unless an explicit
environment flag is present. The live script must never run in normal CI.

### 0.2 Complete current reporting

Before changing selection, update `src/reports/markdown.ts` to show:

- replacement credits issued, spent, or void;
- infrastructure-review decisions;
- infrastructure and inconclusive attacks;
- harness-maintainer overlays and validation scopes;
- gross damage, healing, active damage, and permanent recoil.

Add focused report tests rather than asserting only that a report exists.

### 0.3 Live validation checkpoint

Run one manually authorized, cost-bounded fight using:

- a disposable repository;
- a live public GitHub issue or a dedicated sandbox issue;
- two actually installed provider adapters;
- no production credentials;
- no external write permissions.

Save the redacted run bundle under a non-versioned test-results location and
record only the checklist and outcome in project documentation.

### Phase 0 exit gate

- `npm run test:smoke` passes locally and in CI.
- Existing 25 tests remain green.
- Reports expose recovery and infrastructure evidence.
- One live read-only issue/provider run has completed or is explicitly recorded
  as a release blocker with its unavailable provider dependency.

## Phase 1 — outcome explanation

### 1.1 Derive health totals

Add pure `deriveArenaOutcome(runState)` logic. For every contestant compute:

- initial and final health;
- gross landed damage received;
- gross healing;
- active unresolved defect damage;
- permanent recoil;
- required-check elimination;
- HP margin;
- `tied`, `razor_thin`, `narrow`, or `clear` margin class;
- deciding factors: defects, recoil, elimination, or tie-breaker.

Use `healthLedger.activeDefects` and `permanentRecoil` as current truth. Use
health events for gross damage and healing. Assert that recomputed final health
matches the persisted result.

### 1.2 Preserve arena ranking

Do not edit `rankContestants`. `arenaOutcome.championId` mirrors its output.
Add regression tests proving every previous ranking fixture is unchanged.

### 1.3 Report the split explicitly

Update console, `BATTLE.md`, and JSON output to show:

- arena champion;
- final margin and class;
- source of the margin;
- unresolved damage;
- recoil;
- gross damage and healing.

### Phase 1 exit gate

- Boundary tests cover 0, 5, 10, and 15 HP.
- The mocked 100–95 fight reports zero unresolved damage and five recoil.
- No scoring snapshot or champion changes.

## Phase 2 — deterministic patch-quality facts

### 2.1 Collect from immutable patches

Collect facts before temporary worktrees are removed, then persist the evidence
used to derive them. The collector must also be replayable from the final patch
and base commit.

Add Git helpers for:

- changed paths;
- binary-path detection;
- added/deleted lines;
- whitespace-insensitive diff statistics;
- file-mode and rename changes;
- production/test/generated/vendor/lock/documentation classification.

Allow repository configuration to override classification patterns.

### 2.2 Manifest adapters

Define a small adapter interface:

```ts
interface ManifestAdapter {
  supports(path: string): boolean;
  compare(baseContent: string, patchContent: string): ManifestDelta;
}
```

Initial adapters:

- npm `package.json`;
- Python `pyproject.toml` and requirements files;
- Go `go.mod`;
- Rust `Cargo.toml`;
- Ruby `Gemfile`.

Unsupported manifests remain saved as evidence and are marked `unknown`; do not
guess dependency semantics.

Separate runtime, development, and optional dependencies where the ecosystem
supports it.

### 2.3 Verification and observability evidence

Record evidence, not a raw score:

- test files and fixtures changed;
- acceptance criteria cited by added tests where detectable;
- failure-path and integration-boundary test hunks;
- logging, metric, trace, health, readiness, and audit-related changes;
- new operational configuration;
- possible secret exposure, unbounded metric labels, or noisy logging risks.

These signals are inputs to the neutral verifier. Pattern counts cannot decide
the winner.

### 2.4 Public and operational surface

Record:

- production files and subsystems touched;
- exported or public-surface hunks when supported by a language adapter;
- schema, protocol, migration, and configuration changes;
- new environment variables, services, permissions, and ports.

If a fact cannot be established mechanically, return `unknown` with evidence
paths.

### Phase 2 exit gate

- Facts replay identically from a saved patch.
- Tests, generated files, vendored files, lockfiles, and formatting-only changes
  do not inflate normalized production size.
- Binary patches and unsupported manifests produce explicit unknowns, not
  crashes.
- Necessary versus unnecessary dependencies is not decided mechanically.

## Phase 3 — neutral quality comparison and recommendation

### 3.1 Quality-verifier adapter

Add `PatchQualityVerifier` and `CommandPatchQualityVerifier` beside the existing
provider adapters.

Input bundle:

- frozen task contract;
- final validation matrix;
- active defect summaries;
- anonymized Patch A and Patch B;
- deterministic facts and cited diff hunks;
- fixed quality rubric;
- strict output schema.

Output:

```ts
{
  version: 1;
  verdict: "patch_a" | "patch_b" | "equivalent" | "inconclusive";
  criteria: Array<{
    name: string;
    verdict: "patch_a" | "patch_b" | "equivalent" | "unknown";
    evidence: string[];
    rationale: string;
  }>;
  rationale: string[];
}
```

Persist the anonymization map separately from the verifier prompt. The verifier
must not receive health, recoil, provider identity, or arena champion.

A verifier timeout, malformed response, or provider failure produces
`inconclusive`; it does not invalidate the battle.

### 3.2 Selection algorithm

Implement a pure `selectRecommendedPatch` function:

1. Remove patches that fail final applicability or required validation.
2. Prefer less active unresolved defect damage.
3. If active damage is equal, use the quality verdict.
4. If quality is equivalent or inconclusive, use the arena champion.
5. If there is still no unique choice, return a draw.

Return both a selected contestant and a machine-readable reason. Preserve every
intermediate comparison for replay.

### 3.3 Arena finalization

Insert quality collection and recommendation after final validation and ranking,
but before report rendering and worktree cleanup.

Quality verification must:

- have a bounded timeout and cost record;
- use read-only capabilities;
- never run patch code;
- never modify health;
- never hide a completed arena result if it fails.

### Phase 3 exit gate

- A cleaner 95 HP patch can be recommended over a 100 HP champion when the only
  difference is recoil.
- A patch with an active Low defect loses to a correct patch regardless of
  cleanliness.
- Equivalent and inconclusive comparisons fall back deterministically.
- Anonymized inputs contain no contestant or provider identity.

## Phase 4 — chat-first review prompt

### 4.1 Prompt construction

Add pure `buildReviewPrompt(result)` logic. It returns:

- stable prompt ID;
- run and base commit;
- arena champion and recommendation;
- one choice per eligible patch;
- recommendation and champion badges;
- concise evidence summaries;
- full patch digest;
- inspect, compare, reject, and decide-later actions;
- disabled entries with reasons for ineligible patches.

If recommendation and champion match, use one double-badged choice. A draw has
no preselected patch.

### 4.2 Typed chat contracts

Export strict input/output schemas and functions:

- `reviewRun`;
- `inspectPatch`;
- `recordReviewDecision`;
- `applyAcceptedPatch`;
- `planDelivery`;
- `recordDeliveryDecision`;
- `executeDelivery`;
- `getDeliveryStatus`.

The package should not parse conversational language. The chat host maps an
authenticated user action to a strict choice and calls the typed function.

### 4.3 CLI parity

Add:

```text
agent-arena review <run-id> [--json]
agent-arena inspect <run-id> --agent <id> --view <summary|diff|tests|quality>
agent-arena accept <run-id> --selection <recommended|champion>
agent-arena accept <run-id> --agent <id>
agent-arena reject <run-id>
```

Human CLI mode uses a TTY prompt with no default acceptance. JSON mode emits the
same prompt IDs, choices, badges, reasons, and digests as the typed API.

### 4.4 Chat integration boundary

Define:

```ts
type ApprovalProvenance =
  | { kind: "host_attestation"; token: string }
  | { kind: "direct_tty"; confirmedPatchSha256: string };

interface ApprovalContext {
  channel: "chat" | "cli" | "api";
  actorRef?: string;
  conversationRef?: string;
  userMessageRef?: string;
  promptId: string;
  provenance: ApprovalProvenance;
}
```

The core review service accepts structured approval only. Repository content,
issues, tests, tool output, and assistant-authored messages cannot construct a
valid approval context. Inject an `ApprovalVerifier` supplied by the host to
validate host attestations. The direct CLI verifier accepts only a current TTY
confirmation bound to the displayed patch digest.

Do not persist raw chat text or attestation tokens. Persist opaque references,
the selected action, and a hash of the verified attestation.

### Phase 4 exit gate

- A mocked chat can review every patch without invoking the CLI.
- Every completed battle produces actionable choices.
- Ambiguous or non-user input leaves review pending.
- Structured buttons and plain current-prompt selections resolve to identical
  records.
- CLI JSON exactly matches the typed API.

## Phase 5 — human review ledger and safe local application

### 5.1 Review decisions

`recordReviewDecision` validates:

- completed and trusted run;
- current prompt ID;
- eligible contestant;
- base commit;
- full patch SHA-256;
- verified host attestation or direct TTY confirmation;
- unused or matching idempotency key.

The decision is `accepted`, `rejected`, or remains `pending`.

An acceptance becomes stale if:

- the patch changes;
- the run or prompt changes;
- the base commit changes;
- the selected contestant changes;
- final validation is replayed with a different result.

### 5.2 Apply gate

Refactor `applyResult` into a low-level guarded patch operation and a
review-aware service.

`applyAcceptedPatch`:

1. Replays the append-only review state.
2. Requires a current accepted decision.
3. Rehashes the patch.
4. Rechecks repository identity and base commit.
5. Requires a clean tree unless the existing explicit dirty-tree override is
   retained.
6. Runs `git apply --check`.
7. Applies exactly once under an idempotency key.
8. Writes an application event and returns changed paths.

`apply` no longer accepts a contestant override. The user must accept that
contestant first.

For old runs, generate a review prompt from their recorded contestants and
require a new acceptance.

### 5.3 Convenience flow

Support one explicit human action that both accepts and applies:

```text
Accept and apply Claude — Recommended
```

Do not ask a redundant second confirmation while the prompt remains current.
Pressing Enter, “looks good,” or an assistant-authored message never applies.

### Phase 5 exit gate

- Pending, rejected, stale, mismatched, and missing approvals cannot mutate the
  working tree.
- Accepted current patches apply exactly once.
- A changed patch digest invalidates acceptance.
- Existing repository and `git apply` guards remain covered.

## Phase 6 — first-class task and delivery targets

### 6.1 Task reference schema

Replace parallel issue/spec arrays internally with a discriminated reference
model while preserving current CLI and YAML compatibility:

```ts
type TaskReference =
  | { kind: "github_issue"; reference: string; primary?: boolean }
  | { kind: "github_pull_request"; reference: string; primary?: boolean }
  | { kind: "repo_spec"; path: string; primary?: boolean };
```

Add `--pr` and YAML `github_pr`. Continue supporting `--issue`, `--spec`, and
existing `sources`.

At most one primary delivery target may be frozen automatically. Multiple
plausible targets require a user choice.

### 6.2 GitHub resolver

Extract a `TaskSourceResolver` interface and implement:

- `GitHubIssueResolver` through `gh issue view`;
- `GitHubPullRequestResolver` through `gh pr view`;
- local spec resolver.

Snapshot PR title, body, comments, repository, number, base branch, head branch,
head repository, and head commit.

The PR diff remains judge-only or omitted unless the user explicitly requests
sharing it. Contestants receive requirements and maintainer clarifications by
default, not a reference implementation.

### 6.3 Fight base

Freeze the exact implementation base:

- issue, feature, and spec tasks default to the current repository HEAD;
- PR-improvement tasks use the reviewed PR head commit only after an explicit
  user choice and fetch;
- record repository identity, remote, base branch, and source SHA.

Both contestants still start from the same commit.

### 6.4 Delivery target

Derive a `DeliveryTarget` containing stable GitHub identifiers rather than only
display URLs. If the source cannot prove a target, use `local_task`.

### Phase 6 exit gate

- Issue, PR, feature/spec, and local targets resolve distinctly.
- PR requirements snapshot once and do not leak its diff by default.
- Multiple target ambiguity blocks delivery, not the battle.
- Both contestants receive identical frozen sources and base commit.

## Phase 7 — delivery planning and GitHub writes

### 7.1 Separate delivery authorization

After patch acceptance, `planDelivery` derives valid actions:

- local apply;
- create PR;
- update existing PR;
- merge existing or created PR;
- reject;
- decide later.

Display exact repository, branch, PR, issue linkage, requested permissions, and
side effects.

`recordDeliveryDecision` requires a separate authenticated user action. A patch
acceptance record is insufficient.

### 7.2 GitHub adapter

Implement an injectable `GitHubDeliveryAdapter` using `git` and `gh`:

- inspect authentication and repository access;
- fetch exact refs;
- create a deterministic delivery branch;
- create a commit in an isolated delivery worktree;
- push without force;
- create or find a PR by deterministic head branch;
- update an existing PR head only when unchanged;
- read checks, reviews, mergeability, and issue state;
- request merge or merge queue using repository policy.

Use an isolated delivery worktree so PR creation does not switch or dirty the
user's current branch.

Branch naming:

```text
agent-arena/<target-kind>-<number-or-slug>-<run-id-prefix>
```

Before push, verify the committed tree contains exactly the accepted patch over
the frozen base.

### 7.3 Issue linkage

Use closing linkage only when:

- the target is a same-repository issue;
- the frozen task represents full resolution;
- the user authorized issue-closing delivery.

Otherwise use `Refs #N`. Never close an issue before merge.

### 7.4 Existing PR safety

Update a PR branch only when:

- the frozen head repository and branch still match;
- the current head SHA equals the reviewed SHA;
- the user has write access;
- no force push is required.

If the head moved, stop and offer:

- rerun or rebase and revalidate;
- create a follow-up PR;
- cancel.

### 7.5 Idempotency

Use deterministic branch and commit inputs. Before every write, query existing
state:

- reuse an existing matching commit;
- do not push an already pushed ref;
- reuse an existing matching PR;
- do not post duplicate comments;
- do not request merge twice.

### Phase 7 exit gate

- Fake GitHub integration tests create one branch, commit, and PR across retries.
- Issue work creates linked PRs.
- PR work updates only unchanged authorized heads.
- A moved head stops without force push.
- Read-only battle permission cannot perform any write.

## Phase 8 — merge monitoring and terminal completion

### 8.1 Monitor

Add a cancellable monitor with bounded exponential backoff for:

- required checks;
- required reviews;
- mergeability;
- merge queue;
- merged or closed state.

Emit progress events suitable for chat updates. Redact credentials and bound
stored output.

### 8.2 Merge authorization

Merge only when the delivery decision explicitly includes merge. Accept
“merge after checks” in the same user action as PR update/create, but persist it
as a distinct authorized action.

Never:

- bypass branch protection;
- dismiss reviews;
- alter required checks;
- force push;
- choose a merge method disallowed by repository policy.

Material PR changes after approval invalidate merge authorization and require a
new review.

### 8.3 Terminal reporting

The final result includes:

- accepted patch and digest;
- commit SHA;
- branch;
- PR URL and number;
- checks and reviews;
- merge result;
- linked issue state;
- any remaining user action.

If checks fail, return evidence and recovery choices. Do not report completion
while the requested operation is merely queued or waiting.

### Phase 8 exit gate

- Mocked check transitions exercise pending, success, failure, cancellation, and
  timeout.
- Merge happens once only after authorization and policy success.
- Linked issue state is verified after merge.
- Chat receives progress and an accurate terminal result.

## Testing strategy

### Unit

Add focused suites:

```text
test/unit/outcome.test.ts
test/unit/quality-facts.test.ts
test/unit/manifest-adapters.test.ts
test/unit/recommendation.test.ts
test/unit/review-prompt.test.ts
test/unit/review-ledger.test.ts
test/unit/task-target.test.ts
test/unit/delivery-plan.test.ts
test/unit/delivery-ledger.test.ts
test/unit/approval-boundary.test.ts
```

Use table-driven tests for margin boundaries, recommendation precedence,
approval staleness, patch choices, target/action matrices, and idempotency.

### Integration

Add:

```text
test/integration/recommendation.test.ts
test/integration/chat-review.test.ts
test/integration/accepted-apply.test.ts
test/integration/task-sources.test.ts
test/integration/github-delivery.test.ts
test/integration/merge-monitor.test.ts
test/smoke/cli.test.ts
```

Use:

- temporary real Git repositories;
- local bare remotes;
- fake `gh` executable backed by a JSON state file;
- fake provider adapters;
- controlled check-state transitions;
- no network or paid sessions in CI.

### Live, opt-in

Maintain a manual checklist for:

- live issue read;
- live PR read;
- one real provider fight;
- sandbox-repository PR creation;
- sandbox PR update;
- merge-after-checks in a disposable repository.

Every live write requires explicit user authorization and a disposable target.

### CI

Keep Node 22 and 24. Add:

- smoke job;
- unit and integration coverage report without a hard percentage initially;
- package API/type export check;
- artifact-schema fixture tests;
- fake GitHub delivery tests.

Do not add secrets or live GitHub writes to pull-request CI.

## Observability and operations

Every review and delivery operation emits:

- operation ID;
- run ID;
- stage;
- start/end time;
- attempt count;
- target kind;
- redacted command result;
- status transition;
- next poll time when monitoring;
- terminal reason.

Expose events through the progress callback used by chat and persist bounded
structured records. Never persist tokens, raw authenticated headers, private
chat text, or unbounded provider output.

Track:

- quality-verifier duration and cost;
- review wait time;
- apply failures by guard;
- delivery failures by stage;
- check wait duration;
- stale approval and moved-head frequency;
- idempotent replay hits.

## Documentation changes

Update documentation when the corresponding phase ships:

- `PRODUCT.md`: distinguish arena champion from recommended patch and define
  human-authorized delivery.
- `docs/MVP.md`: remove automated PR/merge from non-goals only when delivery is
  actually implemented; document its permission boundaries.
- `README.md`: lead with chat workflow and provide CLI/JSON fallback.
- CLI help: explain review, accept, apply, and delivery states.
- Artifact reference: document schema versions and append-only ledgers.
- Security section: explain chat-host provenance, local execution, and GitHub
  write scopes.

Do not update source-of-truth documents ahead of implemented behavior except to
mark future functionality clearly.

## Rollout

Ship behind independent configuration gates:

```yaml
selection:
  enabled: true
review:
  required_for_apply: true
delivery:
  enabled: false
  merge_enabled: false
```

Recommended release sequence:

1. Outcome explanation and reporting.
2. Quality facts and advisory recommendation.
3. Chat/CLI review prompt.
4. Required approval for local apply.
5. PR task resolution and delivery planning.
6. GitHub create/update PR.
7. Merge monitoring.

Do not enable merge in the same release that first introduces GitHub writes.

## Risks and mitigations

### Subjective quality verdicts

Mitigation: deterministic facts, anonymization, strict evidence citations,
equivalent/inconclusive fallback, and no HP effect.

### Shorter-code gaming

Mitigation: normalized size is last; correctness, scope, dependencies,
maintainability, tests, and observability precede it.

### Prompt-injected approval

Mitigation: only authenticated user provenance or direct TTY confirmation can
create a decision. Content channels have no approval authority.

### Stale patch or PR

Mitigation: bind approval to patch digest and base; bind delivery to immutable
head SHA; invalidate on change.

### Duplicate external mutations

Mitigation: deterministic branches, immutable operation records, idempotency
keys, and query-before-write behavior.

### Permission escalation

Mitigation: separate read, push, PR-write, and merge capability decisions scoped
to one repository and target.

### Cross-ecosystem quality facts

Mitigation: adapter interface, explicit unknown values, and verifier evidence
instead of guessed semantics.

### Chat-host integration differences

Mitigation: strict typed core API, JSON parity, opaque provenance references,
and CLI fallback.

## Final definition of done

The implementation is complete when:

- All existing arena behavior and scoring tests remain unchanged.
- The report explains gross damage, healing, unresolved damage, recoil,
  infrastructure recovery, and overlays.
- The arena champion and recommended patch are independently visible.
- Equal-correctness patches receive a replayable, anonymized quality comparison.
- Every battle produces chat-ready patch choices.
- A user can inspect, accept, reject, and apply through chat.
- No patch applies without a current human decision bound to its digest.
- Issue, PR, feature/spec, and local task targets resolve correctly.
- A separately authorized delivery reaches its requested terminal state.
- PR creation/update and merge are idempotent and policy-compliant.
- CLI JSON and typed APIs return equivalent state.
- Unit, integration, smoke, package, and CI checks pass on Node 22 and 24.
- Live read and disposable-repository write checklists have been completed before
  enabling GitHub delivery by default.
