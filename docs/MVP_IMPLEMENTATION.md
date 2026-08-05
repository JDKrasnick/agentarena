# Agent Arena MVP: Implementation Plan

## Technical direction

Build Agent Arena as a TypeScript CLI for Node.js 22 or newer. Ship it as an npm
package with a single `agent-arena` executable.

The implementation should favor explicit filesystem artifacts and subprocesses
over a database or long-running service. A fight is a state machine whose state
is persisted to `result.json` after every stage, making failures inspectable and
future resume support possible.

Recommended foundation:

- TypeScript with strict compiler settings.
- `commander` for CLI parsing.
- `execa` for subprocess execution and cancellation.
- `zod` for configuration, adapter output, and report schemas.
- `yaml` for `agent-arena.yaml`.
- `pino` for structured internal logging.
- `vitest` for unit and integration tests.

Dependencies should remain small. Git is invoked through its CLI so behavior
matches the developer's repository.

### Implemented battle topology

The persisted schema is version 3. It separates stable contestant identity from
provider identity and normalizes all input into two slots:

```ts
type ContestantId = "a" | "b";
type BattleMode = "duel" | "siege" | "catch_up";
type ContestantRole =
  | "solver"
  | "attacker"
  | "defender"
  | "incumbent"
  | "challenger";

interface ContestantConfig {
  id: ContestantId;
  provider: AgentId;
  model?: string;
  role: ContestantRole;
  startingPatch: "none" | "pull_request";
}
```

Legacy `agents: [provider, provider]` input remains accepted for duels, but new
run artifacts persist normalized contestants. Versions 1 and 2 are migrated
from provider-keyed records into `a` and `b` slots when read.

- Duel invokes two isolated solver slots, including duplicate-provider mirror
  matches.
- Catch-up freezes a pull request, initializes the incumbent from its patch,
  and invokes only the challenger during implementation. The challenger prompt
  excludes the incumbent diff.
- Siege initializes the defender from the frozen patch, validates attacker
  submissions through the asymmetric test-only path, invokes only the defender
  during repair, disables patch recommendation, and exposes only the defender
  to review and delivery.

## Repository layout

```text
src/
  cli.ts
  commands/
    fight.ts
    apply.ts
  config/
    load-config.ts
    schema.ts
  task/
    resolve-sources.ts
    task-contract.ts
    oracle.ts
  permissions/
    discover.ts
    policy.ts
    broker.ts
    leases.ts
  maintenance/
    maintainer.ts
    overlays.ts
    validate-overlay.ts
  core/
    arena.ts
    state-machine.ts
    types.ts
  agents/
    adapter.ts
    codex.ts
    claude.ts
    gemini.ts
    prompts/
      compose.ts
      common.ts
      implementation.ts
      round-1-contract.ts
      round-2-systematic.ts
      round-3-integration.ts
      recovery.ts
      repair.ts
      verifier.ts
      infrastructure-review.ts
  methods/
    select.ts
    catalog.ts
    probe-cards.ts
    seed.ts
  repo/
    preflight.ts
    instructions.ts
    worktrees.ts
    patches.ts
  runner/
    process-runner.ts
    validation.ts
  attacks/
    collect.ts
    collect-house.ts
    build-case-bundle.ts
    validate.ts
    deduplicate.ts
  scoring/
    severity.ts
    health.ts
    resolve-round.ts
  reports/
    markdown.ts
    result-json.ts
  artifacts/
    store.ts
test/
  unit/
  integration/
  fixtures/
```

The CLI layer translates user input into a validated `FightConfig`. It should not
contain orchestration logic.

## Core data model

Use stable IDs and version every persisted schema from the start.

```ts
type AgentId = "codex" | "claude" | "gemini";
type ContestantId = "a" | "b";
type BattleMode = "duel" | "siege" | "catch_up";
type ContestantRole =
  | "solver"
  | "attacker"
  | "defender"
  | "incumbent"
  | "challenger";
type Severity = "critical" | "high" | "medium" | "low";
type BugCategory =
  | "contract_logic"
  | "inputs_errors"
  | "state_lifecycle"
  | "data_integrity"
  | "concurrency_time"
  | "integration_configuration"
  | "security_privacy"
  | "resilience"
  | "performance_resources"
  | "test_build_integrity";
type RoundProfile =
  | "contract_local"
  | "systematic_exploration"
  | "integration_resilience_security"
  | "infrastructure_recovery";
type FailureClass =
  | "contestant_behavior"
  | "agent_submission"
  | "arena_infrastructure";
type RoundNumber = 1 | 2 | 3;
type RoundId = RoundNumber | "recovery";
type AttackRank = 1 | 2 | 3;
type AttackOrigin =
  | {
      kind: "contestant";
      contestant: ContestantId;
      provider: AgentId;
    }
  | { kind: "house"; methodPackId: string };
type PermissionMode = "auto" | "confirm" | "deny";
type CapabilityRole = "agent" | "harness_only" | "both";
type EnforcementLevel = "enforced" | "brokered" | "advisory";
type Stage =
  | "preflight"
  | "resolve_permissions"
  | "implement"
  | "initial_validate"
  | "collect_attacks"
  | "validate_attacks"
  | "review_infrastructure"
  | "revise_evidence"
  | "assign_severity"
  | "resolve_damage"
  | "repair"
  | "validate_repairs"
  | "recovery_round"
  | "final_validate"
  | "report"
  | "complete"
  | "inconclusive"
  | "failed"
  | "cancelled";

interface FightConfig {
  task: string;
  taskContract: TaskContract;
  permissionPolicy: PermissionPolicy;
  mode: BattleMode;
  contestants: [
    {
      id: ContestantId;
      provider: AgentId;
      model?: string;
      role: ContestantRole;
      startingPatch: "none" | "pull_request";
    },
    {
      id: ContestantId;
      provider: AgentId;
      model?: string;
      role: ContestantRole;
      startingPatch: "none" | "pull_request";
    },
  ];
  attackVerifier: AgentId;
  harnessMaintainer: AgentId;
  rounds: 3;
  maxAttacksPerRound: 3;
  maxHouseAttacksByRound: { 1: 0; 2: 1; 3: 1 };
  maxHeldOutCasesPerDefect: 2;
  maxRecoveryAttacks: 3;
  infrastructureRecoveryRound: true;
  testCommand: string;
  integrationProfile?: IntegrationProfile;
  repositoryRoot: string;
  baseCommit: string;
  limits: {
    implementationMs: number;
    attackMs: number;
    verifierMs: number;
    repairMs: number;
  };
}

interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  failureClass?: FailureClass;
  attempts: number;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
}

interface ContestantResult {
  id: ContestantId;
  provider: AgentId;
  model?: string;
  role: ContestantRole;
  status: "pending" | "survived" | "eliminated" | "failed";
  initialHealth: 100;
  finalHealth: number;
  replacementCredits: ReplacementCredit[];
  healthLedger: HealthLedger;
  healthEvents: HealthEvent[];
  initialPatchPath?: string;
  currentPatchPath?: string;
  finalPatchPath?: string;
  implementation?: AgentInvocation;
  rounds: ContestantRoundResult[];
  checks: CheckResult[];
}

interface Attack {
  id: string;
  round: RoundId;
  origin: AttackOrigin;
  rank?: AttackRank;
  targets: ContestantId[];
  claim: string;
  oracle: OracleCitation;
  assertionFingerprint: string;
  requiredCapabilities: string[];
  patchPath: string;
  focusedCommand: string;
  status:
    | "submitted"
    | "invalid"
    | "duplicate"
    | "self_defeating"
    | "unproven"
    | "capability_denied"
    | "blocked"
    | "landed"
    | "provisional_infrastructure"
    | "infrastructure_error"
    | "execution_inconclusive";
  recoil?: 5 | 10 | 15;
  proposedSeverity?: Severity;
  proposedConfidence?: number;
  rootDefectId?: string;
  severity?: Severity;
  damage?: 50 | 30 | 15 | 5;
  damageActive?: boolean;
  severityRationale?: string;
  outcomeReason?: string;
  infrastructureReview?: "accept" | "challenge";
  evidenceRevision?: EvidenceRevision;
  checks: CheckResult[];
  caseBundle?: AttackCaseBundle;
}

interface AttackCaseBundle {
  attackId: string;
  oracle: OracleCitation;
  rootDefectId: string;
  createdBeforeRepairAt: string;
  cases: Array<{
    id: string;
    visibility: "visible" | "held_out";
    category: string;
    patchPath: string;
    contentHash: string;
    status: "accepted" | "rejected" | "revealed";
  }>;
}

interface AttackHypothesis {
  id: string;
  round: RoundId;
  category: BugCategory;
  invariant: string;
  probe: string;
  requiredCapabilities: string[];
  confidence: number;
  submittedAttackId?: string;
}

interface RoundPromptManifest {
  round: RoundId;
  profile: RoundProfile;
  commonPromptVersion: string;
  overlayPromptVersion: string;
  methodPackIds: string[];
  probeCardIds: string[];
  toolVersions: Record<string, string>;
  seed: string;
  renderedPromptPath: string;
  promptHash: string;
}

interface IntegrationProfile {
  setupCommand: string;
  checkCommand: string;
  teardownCommand: string;
  services: string[];
  capabilityIds: string[];
  steadyStateInvariants: string[];
  faultControls: Array<
    "latency" | "timeout" | "disconnect" | "restart" | "partial_response"
  >;
}

interface EvidenceRevision {
  attempt: 1;
  setupChanged: boolean;
  teardownChanged: boolean;
  timeoutChanged: boolean;
  observabilityChanged: boolean;
  focusedCommandChanged: boolean;
  patchPath: string;
  explanation: string;
}

interface HealthEvent {
  attackId?: string;
  round: RoundId;
  type: "target_damage" | "recoil" | "heal" | "elimination";
  amount: number;
  reason: string;
}

interface HealthLedger {
  permanentRecoil: number;
  activeDefects: Array<{
    rootDefectId: string;
    attackId: string;
    damage: 50 | 30 | 15 | 5;
  }>;
  eliminatedByRequiredCheck: boolean;
}

interface TaskContract {
  version: 1;
  task: string;
  acceptanceCriteria: string[];
  sources: TaskSource[];
  createdAt: string;
  contractHash: string;
}

interface TaskSource {
  id: string;
  kind: "user_task" | "issue" | "pull_request" | "repo_spec" | "public_contract";
  origin: string;
  retrievedAt: string;
  contentHash: string;
  snapshotPath: string;
  visibility: "shared" | "judge_only";
}

interface OracleCitation {
  expectedBehavior: string;
  sourceId: string;
  sourceLocation: string;
  rationale: string;
}

interface PermissionPolicy {
  defaultMode: PermissionMode;
  capabilities: CapabilityDecision[];
  reducedValidationAccepted: boolean;
}

interface CapabilityDecision {
  id: string;
  reason: string;
  risk: "low" | "medium" | "high" | "critical";
  requirement: "required" | "optional";
  role: CapabilityRole;
  enforcement: EnforcementLevel;
  mode: PermissionMode;
  scopes: string[];
  status:
    | "approved"
    | "denied"
    | "unavailable"
    | "provisioning_failed";
  expiresAt?: string;
}

interface ContestantRoundResult {
  round: RoundId;
  startingHealth: number;
  submittedAttackIds: string[];
  postAttackHealth: number;
  postAttackStatus: "active" | "downed";
  repair?: AgentInvocation;
  endingHealth: number;
  endingStatus: "active" | "eliminated";
}

interface HarnessOverlay {
  id: string;
  failureId: string;
  patchPath: string;
  scopes: string[];
  permissionChanges: string[];
  validationChecks: CheckResult[];
  status: "proposed" | "approved" | "applied" | "rejected";
}

interface ReplacementCredit {
  id: string;
  sourceAttackId: string;
  issuedRound: RoundNumber;
  reason: "accepted_infrastructure" | "final_infrastructure" | "inconclusive";
  status: "available" | "spent" | "void";
  replacementAttackId?: string;
}
```

`result.json` should include the schema version, run ID, timestamps, task-contract
hash, config, current round and stage, contestants, ordered attacks, health
timeline, replacement credits, harness overlays, final ranking, artifact paths,
and harness version. Write it atomically through a temporary file and rename.

## Prompt and method-pack architecture

Do not use one generic attack prompt three times. `compose.ts` produces each
rendered prompt from immutable, hashable parts:

```ts
renderedPrompt = compose(
  commonContract,
  roundOverlay,
  selectedMethodPack,
  roundState,
);
```

The common contract contains the task contract, frozen implementation patches,
attack and recoil rules, structured output schema, permission manifest, budgets,
prior attack outcomes and canonical root defects, and current health. The
overlay changes the search objective:

- `round-1-contract`: acceptance-criterion tracing, outputs, negative cases,
  boundaries, error paths, and regressions.
- `round-2-systematic`: state and lifecycle modeling, data integrity,
  generated/property tests, mutation survivors, fuzzing, static leads,
  concurrency schedules, cancellation, and cleanup.
- `round-3-integration`: approved topology and test identities, component and
  protocol contracts, configuration variations, trust boundaries, injected
  dependency faults, retry and idempotency behavior, recovery invariants, and
  bounded resource stress.
- `recovery`: post-round-3 state, exact replacement-credit count, new-attack
  requirement, and the rule that another infrastructure failure makes the run
  inconclusive.

Implementation, repair, verifier, and infrastructure-review prompts remain
separate. In particular, an infrastructure evidence revision cannot inherit the
open-ended attack brief because it may alter only setup, teardown, isolation,
timeouts, observability, and the focused command.

Method packs are small, versioned playbooks selected deterministically from
repository language, framework, changed surfaces, available commands, and
approved capabilities. Examples include boundary tables, state machines,
property generators, mutation sampling, fuzz targets, concurrency schedules,
HTTP contract probes, datastore invariants, authorization matrices, and
dependency-fault scenarios. A pack may teach a method or suggest a probe shape;
it may not assert that a contestant is wrong or provide a hidden expected
answer.

Before submission, the attack invocation writes `hypotheses.json` with a
diverse, concise portfolio. This artifact is explicitly not chain-of-thought:
each entry contains only category, observable invariant, proposed probe,
capabilities, and confidence. Scouting has no health effect. `attack-set.json`
then commits zero to three ranked attacks, and only those attacks are scored.

Persist `RoundPromptManifest`, every rendered prompt, the selected pack and
probe-card IDs, tool versions, and the seed. Both contestants receive identical
prompt components and probe cards. Selection must not depend on contestant
identity, patch outcome, or verifier output. Snapshot-test prompt composition so
provider adapters cannot silently drift the tournament rules.

Rounds 2 and 3 also run one neutral house-scout invocation after contestant
submissions are frozen. It receives anonymized patches, the shared task
contract, and the same round method pack, and may submit at most one unranked
attack. This lane exists specifically for common-mode defects that fail on both
patches. It has no recoil or replacement credits and cannot run in round 1,
recovery, or final validation.

After an attack is semantically accepted and before any repair prompt is
rendered, `build-case-bundle.ts` may generate up to two held-out sibling cases.
The case-builder receives only the accepted claim, oracle, canonical root
defect, visible test, and allowed method pack. It must not broaden the
requirement. Freeze and hash the bundle before revealing the visible attack.

## Agent adapter contract

Provider-specific behavior belongs behind one interface:

```ts
interface AgentAdapter {
  readonly id: AgentId;
  checkAvailability(): Promise<Availability>;
  implement(input: ImplementInput, signal: AbortSignal): Promise<AgentInvocation>;
  attack(input: AttackInput, signal: AbortSignal): Promise<AgentInvocation>;
  repair(input: RepairInput, signal: AbortSignal): Promise<AgentInvocation>;
}

interface AttackVerifier {
  assess(
    input: AnonymizedAttackInput,
    signal: AbortSignal,
  ): Promise<AttackVerdict>;
}

interface HarnessMaintainer {
  proposeOverlay(
    input: AnonymizedInfrastructurePacket,
    signal: AbortSignal,
  ): Promise<HarnessOverlayProposal>;
}

interface AttackVerdict {
  relevant: boolean;
  oracleSupported: boolean;
  oracleRationale: string;
  rootDefectId: string;
  severity: Severity;
  rationale: string;
}
```

Each adapter is responsible only for constructing a noninteractive CLI command,
passing the prompt, and normalizing metadata. The harness owns worktrees, Git
diffs, timeouts, validation, and scoring.

Agents edit files directly in their assigned worktree. They do not need to emit
the implementation patch as text. After each invocation, the harness captures
the worktree with:

```bash
git add -N .
git diff --binary --full-index HEAD
```

Structured metadata is written by the agent to a harness-provided path such as
`.agent-arena-submission.json`. Validate it with `zod`; treat it as explanation,
not evidence.

Prompts must state:

- The role and current stage.
- The immutable task contract, authoritative source IDs, and configured test
  command.
- The post-approval capability manifest, including available, harness-only,
  requestable, and denied capabilities.
- The allowed worktree and time limit.
- Required output file and schema.
- That production credentials and unrelated files are forbidden.
- That the harness, not the agent, decides whether checks passed.
- That every claimed expected output must cite a task-contract source.
- That agents request capabilities by ID and never request or print raw secrets.

Provider transcripts go to artifact files and should not be parsed to determine
success.

## Worktree and process isolation

Preflight resolves the repository root and base commit, verifies a clean
worktree, checks both agent executables, and executes the validation command once
on the base commit.

Create temporary directories outside the target repository:

```text
<temp>/agent-arena-<run-id>/
  implement-codex/
  implement-claude/
  round-1/
    attack-codex/
    attack-claude/
  round-2/
    attack-codex/
    attack-claude/
    attack-house/
  round-3/
    attack-codex/
    attack-claude/
    attack-house/
  recovery/
    attack-codex/
    attack-claude/
  harness-overlays/
  held-out-cases/
  validate/
```

Use detached worktrees created from the same `baseCommit`. Do not use branch
names and do not let agents commit. Before removing a worktree, capture all
patches and logs, then call `git worktree remove` and `git worktree prune`.

Subprocesses receive:

- The worktree as `cwd`.
- A minimal allowlist of inherited environment variables.
- Arena-specific variables for output paths and stage metadata.
- Run-scoped test credentials only when the subprocess is the approved
  `harness_only` validation role.
- An `AbortSignal` and stage timeout.
- Separate stdout and stderr files.

On timeout or cancellation, terminate the entire child process group, first
gracefully and then forcefully after a short grace period.

The MVP provides isolation from accidental cross-contamination, not a security
sandbox. The README and preflight output must warn that agent-generated code and
tests execute with the current user's permissions.

Held-out case files remain in a randomized harness-owned temporary directory
outside every contestant worktree. Their paths and contents are omitted from
agent environments, prompts, command lines, and pre-repair logs. The harness
copies or mounts them only into clean validation worktrees after the agent
process exits. This is brokered concealment, not a security boundary against a
malicious process running as the same OS user; record that enforcement level in
`permissions.json`.

Agents never receive credential values. The broker resolves an approved
capability ID to a scoped subprocess environment, socket, or local proxy, then
redacts values from stdout, stderr, command metadata, and reports. Leases expire
at run completion and ephemeral services are torn down during cleanup.

## Permission workflow

Reconnaissance derives capability requests from configured checks, repository
services, task sources, provider adapters, and declared integration profiles.
Before implementation, render one consolidated plan showing each capability's
reason, risk, scope, role, requirement level, authentication method, and policy.

Policy resolution follows these rules:

1. Hard-denied capabilities always remain denied until the user explicitly
   edits the policy. `auto` cannot override them.
2. `auto` approves only exact matches in the user's safe allowlist whose
   enforcement is `enforced` or `brokered`, never `advisory`.
3. `confirm` requires a user decision before the capability is first used.
4. `deny` makes the capability unavailable to the run.
5. Required denials block preflight unless the user explicitly records
   `reducedValidationAccepted: true`.
6. Optional denials do not block the fight and do not change health.

Authentication happens only after policy approval. Prefer an existing scoped
session, then device authorization, then test-only credentials. Never copy
credential material into an agent worktree or prompt. `permissions.json` stores
the decision and redacted provisioning metadata, not secret values.

New capability requests from attack agents are resolved at a round boundary so
both agents see the same updated manifest before execution resumes. A request
that the user denies becomes `capability_denied` with no damage or recoil. If an
agent resubmits an attack requiring a capability already marked denied in its
manifest, that submission is invalid and receives normal rank-based recoil.

The harness must execute an approved integration attack against both frozen
patches with the same lease, service state, network policy, and credential scope.
Capability asymmetry invalidates the comparison and becomes
`infrastructure_error`.

Capability discovery uses the first sufficient level in this order:

1. Existing repository commands, fakes, fixtures, and local dependencies.
2. A run-owned local subprocess.
3. A user-supplied Compose profile.
4. An explicitly approved remote test service.

Escalation records why the prior level cannot exercise the required invariant.
The same level and configuration apply to both patches. The MVP executes an
existing Compose profile as an opaque setup/check/teardown contract; it does not
generate container definitions or arbitrary service topologies.

The plan must not overstate enforcement. `enforced` means an OS or provider
sandbox prevents access outside the scope. `brokered` means the harness controls
credential or service delivery but the agent may retain other authority of the
current OS account. `advisory` is prompt-level policy only. Since the MVP is not
a complete hostile-code sandbox, preflight must require explicit confirmation
for advisory medium-or-higher risk and recommend a sanitized account or external
container when sensitive host credentials exist.

## Failure classification

Health must never change because the arena itself malfunctioned. Every failed
operation is classified before scoring:

- `contestant_behavior`: the contestant's code reproducibly returns the wrong
  value, throws, hangs, or fails a required assertion in an otherwise healthy
  environment.
- `agent_submission`: the agent supplied a malformed patch, invalid command,
  flaky test, unsupported oracle, or exceeded its declared stage budget after a
  healthy process launch.
- `arena_infrastructure`: Git worktree failure, filesystem or process-spawn
  error, missing dependency after successful preflight, service outage, judge
  or contestant-provider outage, authentication/network failure discovered
  mid-run, corrupted artifact, or another harness-owned fault.

A timeout is not classified from the timer alone. A focused command that times
out reproducibly only on the target while the author and control checks complete
is contestant behavior. A timeout across control worktrees, or a failure to
start the process, is infrastructure. An agent invocation that runs beyond its
published budget in a healthy environment is an agent-stage failure.

For an apparent infrastructure failure:

1. Save the complete attempt and diagnostic output.
2. Retry once in a newly created clean worktree and process.
3. Run author, target, base, environment-health, and service-health controls as
   applicable, using a fresh service instance per patch.
4. When controls identify a harness-owned setup or orchestration defect, invoke
   the harness maintainer, validate one symmetric run overlay, and replay the
   original evidence.
5. When causality is still unclear for an attack, persist
   `provisional_infrastructure` and return the failure packet to the attack
   author for self-review.

The author returns `accept` or `challenge`:

- `accept` withdraws the attack and requests no-fault confirmation. Recheck that
  controls support infrastructure rather than malformed or agent-caused
  evidence; only then add one replacement credit. Otherwise classify the attack
  as an invalid miss.
- `challenge` opens the single evidence revision. The revision is not a new
  attack or repair round. It may change setup, teardown, isolation, bounded
  timeouts, observability, and the focused command. It must preserve the claim,
  expected behavior, oracle citation, target, rank, assertions, and root defect.
  Capture it as a separate patch and reject scope expansion.

After the revision, rerun the complete control matrix against the same frozen
pre-repair patches:

- A reproducible target-only failure with healthy author and controls is
  `contestant_behavior` and returns to normal attack adjudication.
- A patch-independent environment failure is `infrastructure_error`.
- Conflicting or insufficient causal evidence is `execution_inconclusive`.
- A changed claim, oracle, assertion, or root defect is `agent_submission` and
  normal miss recoil applies.

The one-revision limit applies per challenged attack and does not consume
another ranked slot. During normal rounds, final `infrastructure_error` and
`execution_inconclusive` outcomes add one replacement credit. During recovery,
either outcome makes the run inconclusive and creates no new credit. No health
event is committed while classification is provisional. Infrastructure and
inconclusive outcomes cause neither target damage nor author recoil; other
attacks continue after the batch is resolved.

Cap replacement credits at three per agent. A fourth confirmed infrastructure
event indicates a systemic harness failure and makes the run inconclusive.

An infrastructure error while generating attacks yields no submission and no
recoil. Infrastructure failure during implementation, repair invocation,
required validation, repair validation, health reconstruction, or final
validation receives the harness's clean retry and control checks, but no
agent-authored evidence revision. If it remains unresolved, the run becomes
`inconclusive`. It must never eliminate a contestant or select a winner. Partial
artifacts and the exact failed operation remain available for replay.

## Harness maintenance

A dedicated `HarnessMaintainer` role handles harness-owned defects. It is not a
contestant, attack verifier, or scorer. It receives anonymized infrastructure
packets and may propose changes only to service orchestration, worktree setup,
environment construction, capability adapters, broker wiring, timeouts,
resource limits, retries, and diagnostics.

It must not modify contestant patches, attack assertions, claims, oracles,
severity verdicts, health ledgers, or ranking.

During a live fight, the maintainer produces an immutable run overlay. Do not
self-modify the installed Agent Arena package. Validate an overlay before use:

1. Confirm it applies symmetrically to both contestants and controls.
2. Run the harness unit and integration profile.
3. Replay the original infrastructure reproducer in clean environments.
4. Confirm required commands and existing landed attacks retain their outcomes.
5. Resolve any added capability through the permission workflow.
6. Persist the overlay patch, prompt, logs, checks, and content hash.

An already-authorized low-risk overlay may apply automatically. Any material
permission, network, filesystem, service, or execution change requires user
confirmation. An overlay that fails validation is rejected and the run becomes
inconclusive.

For a product-level Agent Arena bug, the maintainer also drafts a normal source
patch and adds the failure as a permanent regression fixture. That patch is not
loaded into the active referee. It follows ordinary review and release, after
which the saved fight can be replayed.

Release reliability gates should enforce zero unhandled harness exceptions,
zero health or winner changes from harness faults, a regression fixture for
every confirmed fault, and at least 99.9% infrastructure-free attack evaluation
in stable releases.

## Orchestration state machine

### 1. Preflight

1. Load CLI flags and optional YAML, then validate the merged configuration.
2. Resolve referenced official issues, PRs, local specifications, repository
   instructions, and public contracts into immutable source snapshots.
3. Derive explicit acceptance criteria, build `task-contract.json`, and require
   user-provided task text or `--spec` when an authoritative reference cannot be
   retrieved.
4. Resolve `baseCommit`, inspect configured checks and services, and discover
   their required and optional capabilities.
5. Render the consolidated permission plan and resolve all `auto`, `confirm`,
   `deny`, and hard-deny decisions.
6. Authenticate and provision approved required capabilities with run-scoped
   leases; block or record an explicit reduced validation contract for denials.
7. Check selected agent adapters, attack verifier, harness maintainer, Git/Node
   versions, and provisioned capability health.
8. Run the configured test command on an untouched base worktree.
9. Create the artifact directory, write `permissions.json`, and persist initial
   state.

If the baseline test fails, stop. Supporting known pre-existing failures can be
added after the MVP.

Issue and PR resolution should use official provider APIs or an authenticated
CLI such as `gh` when available. Store the retrieved content and hash once; do
not refetch it between agents or rounds. Shared sources may include official
issue and PR descriptions, acceptance checklists, and maintainer clarifications.
Reference implementation diffs and hidden known-good tests are `judge_only`
unless the user explicitly makes them shared.

### 2. Implement

Create both contestant worktrees before launching either adapter. Run the two
agents concurrently with independent timeouts. Capture a binary patch even when
an adapter exits unsuccessfully so the report is diagnostic.

Reject empty patches. Persist implementation explanation, duration, exit status,
and any provider-reported usage or cost.

### 3. Initial validation

For each nonempty patch, use a fresh validation worktree:

1. Reset to `baseCommit`.
2. Apply the patch with `git apply --index --3way`.
3. Run the configured test command.
4. Record output and resulting status.

Only patches that apply and pass can author attacks in round 1. A contestant
with a usable patch that fails initial validation skips that attack phase but
still receives the round-1 repair opportunity. It must pass required validation
after repair or be eliminated.

### 4. Run three attack–repair rounds

Execute the following stages for round 1, round 2, and round 3. Persist
`currentRound` and the round stage after every transition. Stop early only when
one or both contestants are eliminated at the end of a repair phase.

The mechanical loop is the same, but load a different `RoundProfile` and prompt
overlay in each pass:

1. Round 1 uses `contract_local`.
2. Round 2 uses `systematic_exploration`.
3. Round 3 uses `integration_resilience_security`.

At the round-3 boundary, provision the optional approved integration profile
once per frozen patch in isolated instances. Confirm the same dependency
versions, schema, seed data, clock controls, credential scopes, resource limits,
and service-health checks. Establish a passing steady-state control before fault
injection. Each attack evaluation gets a fresh or proven-clean instance, then
teardown verifies no leaked process, port, file, lease, or test record. If the
profile is absent or denied, the prompt lists the unavailable capability and
uses local contract, security, and resilience probes instead; this has no health
effect.

Required repository integration checks are part of `testCommand` whenever the
repository already requires them and therefore run at baseline and after every
repair. Round 3 adds focused provisioned exploration; it does not postpone
integration correctness.

#### 4.1 Collect ordered attacks

At the start of a round, freeze both current implementation patches. Launch all
eligible attack invocations concurrently and reveal no results until every
submission is captured. A contestant whose current patch does not pass required
validation cannot attack, but still participates in repair.

Each agent receives the opponent's current patch, the task, all prior landed and
missed attacks, the current health timeline, and the rendered round prompt. It
first writes one `hypotheses.json` portfolio, then one `attack-set.json`
containing zero to three entries in rank order. Portfolio entries are not
scored. Each committed attack contains:

- Rank `1`, `2`, or `3`.
- A claim and user-impact statement.
- Expected behavior plus a task-contract source ID, source location, and
  rationale.
- Proposed severity and integer confidence from 0 to 100.
- The most focused command that executes the test.
- Required capability IDs and an optional fallback plan.
- A disjoint list of test or fixture paths belonging to that attack.

Ranks must be contiguous and unique: `[]`, `[1]`, `[1, 2]`, or `[1, 2, 3]`.
Attacks may not share changed paths. The harness captures each attack as its own
path-limited binary diff. A malformed set is treated as a miss for every entry
that can be identified safely; harness failures are never charged to an agent.

After both contestant sets are frozen in rounds 2 and 3, run the neutral house
scout once. It may submit zero or one attack with no rank. Reject additional
entries. The house scout can inspect both anonymized patches to search for a
shared failure, but it receives no contestant identity, confidence history, or
health information.

#### 4.2 Validate and classify attacks

Validate every contestant attack against the frozen, pre-repair patches without
trusting the author:

1. Resolve declared capabilities against the manifest. A newly denied optional
   request becomes `capability_denied`; a request already known to be denied is
   invalid; failed provisioning after approval is `infrastructure_error`.
2. Reject changes outside recognized test and fixture paths.
3. Apply the attack patch to `baseCommit` and run its focused command twice.
   Record baseline behavior; a stable baseline failure is allowed because a
   useful regression test may reproduce the original bug.
4. Confirm the cited source ID and location exist in the immutable task
   contract. A citation's existence does not by itself prove the expected value.
5. Reject exact resubmissions by patch hash and prior canonical root-defect ID.
6. Apply the attack to the author's frozen patch. Its focused command and full
   validation command must pass twice.
7. Apply the attack to the target's frozen patch and run the same commands
   twice.
8. Classify the outcome:
   - potential `landed`: stable pass on the author and stable failure on the
     target, pending relevance and root-defect adjudication.
   - `blocked`: stable pass on both patches.
   - `self_defeating`: failure on the author's patch, regardless of the target.
   - `unproven`: the expected behavior lacks authoritative support.
   - `capability_denied`: the user denied a newly requested optional capability.
   - `invalid`: malformed, flaky, production-changing, or otherwise
     non-executable evidence.
   - `duplicate`: repeats an existing root defect.
   - `provisional_infrastructure`: initial retry and controls cannot distinguish
     patch behavior from environment failure.
   - `infrastructure_error`: the harness could not produce a trustworthy result.
   - `execution_inconclusive`: the bounded revision still cannot establish
     causality.

`blocked`, `self_defeating`, `unproven`, `invalid`, and `duplicate` are misses.
`capability_denied`, provisional infrastructure, final infrastructure errors,
and inconclusive execution cause neither target damage nor recoil. Store every
command result and make every attack diff inspectable in the report.

A house attack follows steps 1–5, then runs twice against each frozen patch
independently. A stable failure on either patch becomes a potential landed
candidate for that contestant; a pass simply means that contestant is
unaffected. If both pass, the house attack is blocked. It has no
`self_defeating` state, recoil, or replacement credit. Infrastructure or
inconclusive execution discards the house attack with no health effect and
records the finding for harness maintenance.

#### 4.3 Let the attacker review provisional infrastructure

Before severity or health resolution, give the contestant author of each
`provisional_infrastructure` attack its logs, redacted control results, allowed
revision schema, and one bounded review invocation.

If the agent returns `accept`, confirm from controls that the failure is
patch-independent, finalize `infrastructure_error`, issue one replacement
credit, and do not run an evidence revision. If controls instead identify an
agent-caused setup or malformed submission, mark it invalid with recoil. If the
agent returns `challenge`, validate that its single revision preserves the
original assertion, claim, oracle, target, rank, and root defect.

Rerun the author, target, base, environment, and service controls in isolated
instances. Reclassify the attack as a mechanically landed candidate,
`infrastructure_error`, `execution_inconclusive`, or invalid. A revision timeout
or provider failure is infrastructure, not an agent miss. No second revision is
allowed. Final infrastructure or inconclusive results issue one replacement
credit.

All provisional attacks in the round complete this stage before any damage or
recoil is committed, preserving simultaneous resolution.

#### 4.4 Adjudicate landed candidates and assign severity

Only mechanically landed candidates reach the neutral verifier. Its anonymized
prompt includes the original task, attack claim and impact statement, test diff,
reproduced pass/fail evidence, and canonical root-defect summaries from prior
rounds. It also receives the cited immutable source and any judge-only oracle
material. It returns whether the expected behavior is supported, relevance, a
canonical root-defect ID, one severity, and a concise rationale using this fixed
mapping:

```ts
const DAMAGE_BY_SEVERITY = {
  critical: 50,
  high: 30,
  medium: 15,
  low: 5,
} as const;

const RECOIL_BY_RANK = {
  1: 5,
  2: 10,
  3: 15,
} as const;
```

The attacker-proposed severity and confidence are stored for comparison but
omitted from the verifier prompt to avoid anchoring. Critical and High require
the concrete impacts defined in `docs/MVP.md`. Ambiguous classifications are
capped at Medium, and the verifier must choose the lowest level fully supported
by the evidence. Persist the verifier provider, model, prompt version, raw
response, selected severity, rationale, and damage. If the verifier times out
or returns invalid output, retry once and defer one final verifier retry until
the end of the round. If it still cannot adjudicate mechanically valid evidence,
the run is inconclusive. Do not replace a valid attack merely because the judge
provider failed.

An unsupported or ambiguous oracle becomes `unproven`; an irrelevant candidate
becomes `invalid`. Contestant-authored versions miss and recoil; house versions
are discarded without recoil. A candidate matching a prior root-defect ID
becomes `duplicate`. When two same-round candidates from one author resolve to
the same new root defect, the lower numerical rank owns the land; the later rank
is a duplicate miss. A house candidate that duplicates a contestant candidate
does not add damage and is recorded as corroborating evidence. These rules
prevent repeated or split tests from stacking target damage.

For every new landed root defect, freeze one visible case and generate zero to
two held-out sibling cases before rendering repair prompts. Validate each
sibling twice and require the verifier to confirm the same oracle and root
defect. For a contestant attack, an accepted sibling must pass the author's
frozen patch and fail the target's. For a house attack, accept it independently
for each contestant on which it reproduces. Reject a sibling without rejecting
the original visible attack. Siblings inherit severity and never create their
own damage entry.

#### 4.5 Resolve the round simultaneously

Do not mutate health while individual attacks are being validated. After every
submission has an outcome:

- Each distinct landed root defect activates one severity-weighted damage entry
  against every affected target, including both contestants for a shared house
  defect.
- Each missed contestant attack applies permanent recoil to its author based on
  rank. House attacks never recoil.
- Capability denials, infrastructure errors, and inconclusive executions apply
  neither damage nor recoil.

Resolve both agents' events from the same pre-resolution snapshot, then persist
the complete event batch. This prevents validation or provider completion order
from deciding who can attack. An agent at 0 HP is `downed`, not yet eliminated,
and still receives the round's repair opportunity.

Health is ledger-based, not calculated by repeatedly clamping event arithmetic:

```ts
health = clamp(
  100 - permanentRecoil - sum(activeDistinctDefectDamage),
  0,
  100,
);
```

This ensures healing removes exactly the damage for that defect without
accidentally restoring recoil.

#### 4.6 Repair

Each contestant receives:

- Its current implementation and required-suite failures.
- Every landed attack that currently fails against it, including earlier rounds.
- Claims, test patches, severity, damage, and exact failing outputs.
- The count and broad categories of held-out sibling cases for each defect, but
  not their inputs, assertions, paths, or raw outputs.
- Missed attacks it authored, so it understands its recoil.
- One repair timeout.

The agent edits its current implementation worktree. Attack tests are mounted
for feedback but excluded when capturing the next implementation patch, so
opponent-authored files do not silently become part of the winner.

Skip the repair invocation only when the required suite passes and no landed
attack currently fails against the contestant.

#### 4.7 Validate repairs, heal, and eliminate

For each repaired patch, use clean worktrees to run the required command, every
visible landed attack, and every accepted held-out sibling from all rounds:

- When an active defect's visible and held-out cases all change to passing,
  deactivate its damage and append a heal for the exact severity amount.
- If any held-out case still fails, keep the single defect damage active, reveal
  that failed case after repair validation, and include it in later repair
  evidence. Do not reveal held-out cases before the current repair completes.
- When a previously healed defect regresses from passing to failing, reactivate
  that same damage; it never stacks with itself.
- Recoil remains permanent.
- If the required command fails after the repair opportunity, set health to 0
  and eliminate the contestant.
- If ledger health remains 0 after healing, eliminate the contestant.

If one contestant survives and no downed contestant holds a replacement credit,
declare an early winner. If neither survives and no credits remain, end with no
winner. Otherwise persist current patches and continue. Required-check
elimination is final even when credits exist.

### 5. Optional infrastructure recovery round

After normal round 3, count replacement credits. Skip recovery when both counts
are zero. More than three credits for either agent makes the run inconclusive.

An eligible agent may spend up to three credits on the same number of new
attacks, ranked contiguously from 1. The recovery round repeats collection,
validation, adjudication, simultaneous resolution, repair, and repair
validation against the post-round-3 frozen patches. Replacement attacks use
normal recoil and damage rules; the credit only restores the slot lost to
infrastructure.

A downed contestant with credits may submit replacements and participate in the
recovery repair phase, but a contestant eliminated by a required-check failure
may not. No new credit or second recovery round is created. Any harness or
execution-inconclusive result during recovery makes the run inconclusive.

Consume all credits when recovery completes and persist the recovery round as
`round: "recovery"`.

### 6. Final validation and health ranking

After normal round 3 and the optional recovery round, validate each surviving
final implementation against the required command and every visible and
held-out case belonging to each distinct landed defect. If case patches
conflict, validate them in separate clean worktrees and record the collision
instead of choosing an application order silently.

Final validation must not introduce score-changing tests after the last repair
opportunity. A house probe, method pack, or newly generated case that discovers
a novel issue at this stage is recorded as an unscored follow-up finding. To
affect health or elimination, it must have been presented as a validated attack
or required check while the contestant still had a bounded repair opportunity.

Recompute health from the persisted ledger, with required-check elimination as a
hard 0-HP override. Rank surviving contestants by final HP, then final patch
size. Return a draw when both are equal.

Round resolution, health calculation, and ranking operate only on persisted
outcomes, severity verdicts, and check results. They must be pure functions with
exhaustive unit tests. Replaying an existing run must never call the verifier
again or produce different HP.

### 7. Report and cleanup

Render `BATTLE.md`, `BATTLE.html`, `BATTLE.svg`, and `result.json`, copy final
patches and relevant logs, and print the recommendation. The reports must show each attack's severity rationale,
rank, infrastructure self-review, replacement credit, evidence revision, final
outcome, target damage or recoil, heals, eliminations, recovery round, and each
contestant's round-by-round HP timeline. Identify neutral house attacks and
shared defects explicitly. Reveal every held-out case, its generation metadata,
hash, result, and relationship to the visible root defect in the completed
report bundle. Only mark the run complete after all artifact writes succeed.

Cleanup temporary worktrees in a `finally` block. Preserve them and print their
paths only when cleanup is unsafe or a developer debug flag is set.

## Applying a result

`agent-arena apply <run-id> --agent <id>`:

1. Resolves the run within the current repository's artifact directory.
2. Verifies the current `HEAD` matches the run's `baseCommit`.
3. Refuses a dirty worktree by default.
4. Runs `git apply --check` against the selected final patch.
5. Applies the patch without committing.
6. Prints the validation command the user should run.

It must never infer a patch from an untrusted arbitrary path unless a future
explicit `--patch` mode is added.

## Testing strategy

### Unit tests

- CLI/YAML precedence and schema failures.
- Task-source priority, immutable snapshots, hashes, and missing-reference
  behavior.
- Oracle citations resolve only within the snapshotted task contract.
- Permission precedence, safe-auto allowlists, hard denies, reduced contracts,
  and lease expiration.
- Enforced, brokered, and advisory scopes are labeled correctly; advisory
  permissions can never be auto-approved.
- Credential redaction across prompts, environments, logs, and reports.
- State transitions and invalid transition rejection.
- Provider command construction.
- Timeout and cancellation normalization.
- Instruction-file discovery and size limits.
- Prompt composition is deterministic; common rules remain identical while the
  three round overlays differ and all hashes change only with declared inputs.
- Method-pack selection depends only on repository facts and approved
  capabilities, never contestant identity or outcome.
- Hypothesis portfolios accept the fixed concise schema and never create health
  events.
- House-attack caps are 0/1/1 across normal rounds, house attacks have no rank
  or recoil, and duplicate house evidence never stacks damage.
- Case bundles are frozen before repair; siblings must share the oracle and root
  defect, inherit severity, and cannot create health entries.
- Held-out content is absent from repair prompts and pre-repair logs, then fully
  revealed in the completed report.
- Integration capability selection chooses the first sufficient level and
  records every escalation.
- Attack path classification and validation decisions.
- Evidence revisions preserve claim, oracle, assertion fingerprint, target,
  rank, and root defect.
- Only challenged provisional infrastructure receives one revision; accepted
  infrastructure issues a credit without revision.
- Replacement credits are one-for-one, traceable, capped at three, and spendable
  only in the recovery round.
- Unsupported and ambiguous output oracles become `unproven`.
- Ordered attack-set schema, contiguous ranks, and disjoint paths.
- Severity parsing and ambiguous-rating caps.
- Verifier timeout, invalid-output retry, and no-fault infrastructure outcome.
- Rank 1/2/3 misses produce 5/10/15 permanent recoil.
- Simultaneous round resolution independent of attack processing order.
- Infrastructure failures never mutate either health ledger.
- Provisional classifications delay the complete simultaneous health batch.
- Harness overlays cannot affect contestant files, assertions, verdicts, or
  health and must pass symmetric validation.
- Capability denial is no-fault on first decision; knowingly reusing a denied
  capability is an invalid miss.
- Damage de-duplication, regression reactivation, healing, elimination, ranking,
  and draw cases.
- Markdown, HTML, SVG, and JSON rendering with stable snapshots and link checks.

### Integration tests

Use tiny fixture repositories initialized during the test:

- Two fake adapter executables produce known patches.
- One patch passes and one fails the baseline suite.
- Three complete attack–repair rounds execute in order.
- Each normal round receives its intended profile and a distinct persisted
  prompt manifest.
- Round 2 can surface a mutation-, generated-input-, or schedule-guided lead,
  but only a committed executable attack is scored.
- A neutral round-2 house attack can expose one defect shared by both patches,
  damage both once, and give both a repair opportunity without recoil.
- A second house submission in one round is rejected without affecting health.
- A visible case plus two pre-frozen held-out siblings prevents a
  special-cased repair from healing; a failed sibling is revealed afterward.
- A sibling that broadens the oracle, is flaky, or fails on an ordinary
  attacker's patch is excluded without invalidating the visible attack.
- Round 3 provisions isolated dependency instances, proves steady state, applies
  an allowed fault, and verifies complete teardown.
- When the integration profile is denied or absent, round 3 degrades to local
  contract/security/resilience probes without a health event.
- An agent can submit zero, one, two, or three attacks with contiguous ranks.
- One landed attack distinguishes the patches.
- Blocked, self-defeating, flaky, production-changing, and duplicate attacks
  recoil against their authors.
- An executable differential with an unsupported expected value is `unproven`
  and recoils rather than landing.
- A harness-only integration capability runs both patches with identical scoped
  credentials without exposing them to either agent.
- An optional capability denial causes no health event, while approved
  provisioning failure becomes infrastructure.
- A valid regression attack fails on the base commit but distinguishes the
  contestant patches.
- Critical, High, Medium, and Low attacks produce 50, 30, 15, and 5 damage.
- Multiple tests for one root defect deal damage once.
- A successful repair heals the original damage and changes the final result.
- A later regression reactivates damage without stacking it.
- Both agents' attacks resolve even when one is downed during the round.
- An end-of-round knockout stops later rounds.
- An attack-level infrastructure failure is retried, receives no health effect,
  and does not stop unrelated attacks.
- A target-caused service crash initially marked provisional becomes contestant
  behavior after one observability revision and isolated replay.
- An attacker accepting infrastructure immediately receives one replacement
  credit and no recoil.
- A patch-independent outage remains infrastructure after one revision.
- Persistently ambiguous causal evidence becomes `execution_inconclusive`.
- A revision that changes the assertion or claim is invalid and recoils.
- The optional recovery round consumes credits, applies normal recoil, includes
  repair, and cannot create another recovery round.
- Infrastructure during recovery makes the run inconclusive.
- Four credits for one agent make the run inconclusive as a systemic harness
  failure.
- A required-check infrastructure failure makes the run inconclusive and writes
  partial artifacts.
- Denying a required capability blocks preflight unless a reduced validation
  contract is explicitly persisted.
- A target-only reproducible timeout is contestant behavior, while a control
  timeout is infrastructure.
- Applying the winner reproduces the expected repository state.
- A novel house probe introduced only during final validation is reported as an
  unscored follow-up and cannot change ranking.

Fake adapters make orchestration tests deterministic and free. Add opt-in smoke
tests for real provider CLIs, excluded from normal CI because they require
authentication and incur cost.

## Delivery sequence

### Milestone 1: deterministic local harness

- Project scaffold, config, artifact store, and state machine.
- Worktree manager and cancellable process runner.
- Fake adapters and end-to-end fixture fight.

Exit criterion: a fully deterministic fake fight produces patches, logs, and a
correct final matrix.

### Milestone 2: real implementations

- Codex and Claude adapters.
- Shared prompts and structured submission files.
- Concurrent implementation and initial validation.

Exit criterion: both agents can independently modify a real small repository and
the harness accurately reports their validation results.

### Milestone 3: adversarial loop

- Attack collection and mechanical validation.
- Versioned common and round-specific prompts, deterministic method packs,
  concise scouting portfolios, and prompt-manifest artifacts.
- Capped neutral house attacks for shared defects and pre-repair visible/held-out
  case bundles.
- Round-3 ephemeral integration topology, steady-state controls, symmetric
  fault injection, least-complexity provisioning, and teardown verification.
- Agent self-review of provisional infrastructure, one bounded evidence
  revision, and replacement credits.
- One optional infrastructure recovery attack–repair round.
- Harness-maintainer overlays with symmetric validation and regression capture.
- Three-round state persistence and simultaneous outcome resolution.
- Ordered attack sets and rank-based recoil.
- Anonymized severity verification and fixed damage mapping.
- Repair prompts, healing, and final validation.
- Pure deterministic health calculation and ranking.

Exit criterion: a seeded three-round fight includes a landed attack, a recoiling
miss, a repair or elimination, and an accurate health timeline in the report.

### Milestone 4: usable release

- `apply` command, cancellation cleanup, clear error messages, package build.
- Gemini adapter if it meets the same contract; otherwise document it as next.
- Duel, mirror, catch-up, and siege CLI documentation.
- Frozen-PR provenance, schema-v3 artifact, and mode-specific security
  documentation.
- Controlled live validation for the battle-mode matrix under explicit
  authorization and cost bounds.
- Installation guide and one polished reproducible demo.

Exit criterion: a new user can complete the definition of done in `docs/MVP.md`
without manually editing arena state.

## Important implementation risks

- **Provider CLI drift:** keep commands inside small adapters and cover argument
  construction with tests.
- **Task-source drift:** snapshot official issues, PRs, specs, and their hashes
  before implementation; never let agents read different live versions.
- **Untrusted execution:** be explicit that worktrees are not sandboxes; avoid
  credentials and add stronger isolation after product validation.
- **Permission overreach:** safe-auto requires exact allowlist matches, the
  broker cannot override hard denies, enforcement limits are disclosed, leases
  are run-scoped, and credentials remain harness-only.
- **Capability asymmetry:** execute comparative evidence with the same lease and
  environment for both patches or mark it infrastructure.
- **Flaky attacks:** run focused checks twice and retain raw logs.
- **Infrastructure misclassification:** retry in clean worktrees, compare control
  executions, allow one scope-limited evidence revision, and prefer an
  inconclusive result over incorrect health changes.
- **Referee self-modification:** allow only validated run overlays during a
  fight; ship permanent harness source changes through normal review and replay.
- **Accommodation bias:** anonymize maintainer inputs and require identical
  overlay scope, services, and permissions for both patches.
- **Patch collisions:** validate every combination in a clean worktree and report
  apply failures as evidence, never silently resolve them.
- **Biased tests:** prohibit production changes, record baseline behavior, expose
  attack diffs, and mechanically validate every result.
- **Prompt convergence:** make the three investigation briefs materially
  different, require category-diverse scouting in round 2, and allow agents to
  submit fewer attacks instead of padding a set.
- **Common-mode blindness:** allow one neutral, fully adjudicated house attack
  in each of rounds 2 and 3; cap it so the experiment remains contestant-led.
- **Repair overfitting:** freeze a small same-invariant holdout before repair,
  require all accepted siblings to pass before healing, and reveal failures
  after validation.
- **Holdout leakage:** keep cases out of contestant worktrees and prompts, label
  local concealment as brokered rather than secure, and add stronger isolation
  only when needed.
- **Probe-card bias:** select cards before identities are known, give both agents
  the same cards, persist versions and seeds, and treat every lead as unproven
  until it satisfies ordinary attack validation.
- **Late surprise:** never let a new house check change health after the last
  repair opportunity; surface score-changing probes during rounds 2 or 3.
- **Severity inflation:** anonymize the verifier input, use a fixed impact rubric,
  cap ambiguous ratings at Medium, and store every rationale.
- **Cost growth:** cap every stage, run only two agents, allow agents to pass
  instead of forcing three attacks, skip unnecessary repairs, and show
  time/usage in the final report.
- **Secrets in logs:** redact known credential-shaped environment values before
  writing command metadata and never persist the full inherited environment.

## First engineering task

Implement the fake-adapter end-to-end path before integrating a real provider.
It forces the worktree lifecycle, state persistence, patch transport, attack
validation, simultaneous round resolution, recoil, repair, ranking, and
reporting contracts to become executable early while keeping development fast
and deterministic.
