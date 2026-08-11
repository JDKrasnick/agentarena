# Agent Arena

Make your coding agents fight for the merge.

Agent Arena is a local Node.js library and CLI that gives two coding agents the same immutable run specification, validates both patches, and runs three attack–repair rounds. Attacks are executable test patches, not critiques. The harness reproduces them twice, verifies that their expected behavior is supported by frozen task text, resolves damage and recoil simultaneously, gives both contestants bounded repair opportunities, and exports the evidence and final patches.

Surviving the arena is additional evidence, not a correctness guarantee.

## Review in chat

The primary workflow is a chat or IDE host calling the exported typed
operations:

1. `reviewRun` presents the arena champion, correctness-first recommendation,
   evidence, choices, and exact patch digests.
2. `inspectPatch` reads a summary, diff, checks, or quality evidence.
3. `recordReviewDecision` accepts or rejects only an authenticated user action
   bound to the current prompt, base commit, contestant, and digest.
4. `applyAcceptedPatch` applies only that accepted patch.
5. `planDelivery`, `recordDeliveryDecision`, `executeDelivery`, and
   `getDeliveryStatus` provide a separate, gated GitHub delivery workflow.

The core never parses conversational language. A chat host maps an authenticated
user action to the strict schemas exported from `agent-arena`. Tokens and raw
chat text are not stored.

## Requirements

- Node.js 22 or newer
- Git
- A clean local Git repository with a passing test command
- Two installed and authenticated CLIs from Codex, Claude Code, and Gemini CLI

Agent-generated code and tests execute with your current OS account's permissions. Git worktrees prevent accidental patch cross-contamination; they are not a hostile-code sandbox. Use a sanitized account or an external container when the host has sensitive credentials.

## Install and run

```bash
npm install
npm run build
npm link

agent-arena fight \
  "fix issue #241: collapse repeated whitespace in generated slugs" \
  --agents codex,claude \
  --models gpt-5.2-codex,claude-opus-4-6 \
  --issue 241 \
  --permissions confirm \
  --test "npm test"
```

The preflight permission plan labels every capability as enforced, brokered, or advisory. `--yes` accepts a confirm-mode plan noninteractively. `auto` approves only exact safe-allowlist matches with enforced or brokered boundaries; it never silently grants production credentials or deployment access.

An optional `agent-arena.yaml` stores repeatable settings:

```yaml
test: npm test
agents: [codex, claude]
models: [gpt-5.2-codex, claude-opus-4-6]
judge: codex
sources:
  - github_issue: 241
  # - github_pr: 87
  - spec: docs/session-refresh.md
permissions:
  default: confirm
  allow:
    github_read:
      mode: auto
      scope: issue_and_pr_metadata
      role: harness_only
  deny: [production_credentials, production_deploy]
integration:
  setup: docker compose up -d postgres
  check: npm run test:integration
  teardown: docker compose down --volumes
  services: [postgres]
  capability_ids: [postgres_test]
  steady_state_invariants:
    - health endpoint is ready
  fault_controls: [timeout, disconnect, restart]
limits:
  rounds: 3
  attacks_per_round: 3
  implementation_minutes: 15
  review_minutes: 8
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

`models`/`--models` is optional and follows contestant order. If omitted, each
provider CLI chooses its configured default. This also permits model-vs-model
mirror matches, for example `--agents codex,codex --models model-a,model-b`.

Explicit CLI flags override YAML.

## Live battle observatory

Interactive `fight` and `defend` runs open a compact terminal-native
observatory. It follows the same restrained approach as coding-agent CLIs:
crisp text, small provider sigils, selective color, live tool output, and no
bitmap logo wells. Use `--display auto|dashboard|terminal|plain` explicitly:
`dashboard` launches the optional loopback-only React view, `terminal` forces
the Ink observatory, and `plain` keeps stable line-oriented output for CI.

Both rich displays show contestant output, rounds, evidence, checks, warnings,
and PR/spec/artifact links. They support cancellation and one-time steering for
the next eligible agent invocation. Applied steering marks the result
**Assisted — not competitively comparable** without discarding its evidence.

Provider and command output is redacted before it reaches either display,
`events.ndjson`, or final transcript logs. The overview keeps live counts for
mounted and landed attacks and evidence revisions. Terminal damage uses a brief
red glyph/HP cue; reduced-motion mode keeps the numeric cue without animation.

The terminal uses a yellow-orange `✦` Spark sigil for Claude and compact textual
marks for other providers. The optional React view uses crisp browser-native
artwork, including the official orange Claude mark. The registry also covers
Gemini, Grok, Mistral, DeepSeek, Cohere, Perplexity, Meta AI, GitHub Copilot,
Amazon Bedrock, Qwen, NVIDIA, Azure AI, Groq, Hugging Face, Together AI,
Fireworks AI, OpenRouter, and Cursor. No third-party game art is used.

A persistent status rail identifies the current opening, numbered round,
recovery, or final phase; names the exact stage in plain language; explains its
current objective; and highlights progress through `scout → mount → verify →
damage → repair`. Battle-log entries retain the round in which each move occurred.

On completion, the dashboard opens an evidence-backed result area. It
shows final HP, status, and checks for both fighters; the champion and
recommended patch when coverage resolves them; verified defects caught before
ship; health-restoring improvements that survived replay; and the exact review
command. Choose
**Finish session** after review to close the local server.

Run either mock without provider credentials:

```bash
npm run demo:dashboard
npm run demo:web
```

## Battle modes

The default duel gives both contestant slots a fresh implementation:

```bash
agent-arena fight "fix issue #241" \
  --agents codex,codex \
  --models model-a,model-b \
  --test "npm test"
```

Catch-up freezes an existing PR as contestant A and lets contestant B recreate
the solution from the PR base without seeing the incumbent diff:

```bash
agent-arena fight \
  --pr 87 \
  --incumbent-from-pr \
  --challenger codex \
  --incumbent claude \
  --test "npm test"
```

`--incumbent` may be omitted only when the frozen PR has confirmed provider
attribution. Agent Arena never guesses from writing style or silently launches
a recommended opponent.

Siege gives the attacker a test-only role and the defender the frozen PR
production lineage:

```bash
agent-arena defend \
  --pr 87 \
  --attacker codex \
  --defender claude \
  --test "npm test"
```

Both roles start at 100 HP. Unresolved defects favor the attacker, missed
ranked attacks recoil against it, and fully healed evidence can produce a draw.
Only the defender's final patch can be reviewed, accepted, applied, or
delivered.

`--pr 87` snapshots PR requirements and maintainer clarifications but does not
silently change the implementation base or share the reference diff. A
PR-improvement fight must explicitly use `--base-from-pr 87` (or
`base_from_pr: 87`); Agent Arena freezes and fetches that exact head for both
contestants.

## Evidence and scoring

- Both implementations start from the same immutable commit and RunSpec snapshots.
- Each agent may submit zero to three test-only attacks with contiguous ranks.
- A contestant attack must pass twice on its author and fail twice on its target.
- Ranks 1, 2, and 3 recoil for 5, 10, and 15 HP when they miss.
- Critical, High, Medium, and Low defects deal 50, 30, 15, and 5 HP.
- Each distinct stage failure receives one targeted retry with validated upstream artifacts reused.
- After mechanics exhaust that retry, only a schema-valid immutable attack may use the identity-blind judge fallback; judge evidence is labeled separately from mechanical evidence.
- HP is reconstructed from permanent recoil and distinct active defects, so repeated evidence cannot stack damage and healing never restores recoil.

Round 3 executes an approved integration profile symmetrically against both frozen patches. If the profile is absent or denied, the round degrades to local contract, security, and resilience probes without a health event.

## Artifacts

Each run is persisted atomically under `.agent-arena/runs/<run-id>/`:

- `BATTLE.md`, the clickable `BATTLE.html` dossier, deterministic `BATTLE.svg`,
  and compact schema-v8 `result.json`
- immutable `baseline.json`, sealed round envelopes, runtime drift manifest,
  envelope-head-bound finalization, and checkpoint descriptors
- ordered append-only `events.ndjson` for live observability and replay
- immutable `run-spec.json` and source snapshots
- redacted `permissions.json`
- implementation, attack, diagnostic, and final patches
- rendered prompts, prompt manifests, method-pack seeds, hypotheses, command logs, and provider transcripts
- deterministic quality facts, anonymized verifier input/output, and a
  chat-ready review prompt
- append-only `reviews/`, `delivery/events/`, and idempotent `operations/`

See [the artifact reference](docs/ARTIFACTS.md), [review and delivery
security](docs/SECURITY.md), and [the live release
checklist](docs/LIVE_VALIDATION.md).

Review, explicitly accept, and apply a final patch without committing it:

```bash
agent-arena review <run-id>
agent-arena inspect <run-id> --agent codex --view diff
agent-arena accept <run-id> --selection recommended --apply
```

Resume only from a sealed boundary. Material runtime drift requires approval
bound to the displayed report hash:

```bash
agent-arena resume <run-id> --display console
agent-arena resume <run-id> --approve-drift <report-sha256>
```

Non-interactive clients must provide the full displayed digest with
`--confirm-sha256`. `agent-arena apply <run-id>` accepts no contestant override
and verifies the review ledger, digest, repository, base commit, clean worktree,
trusted run path, and `git apply --check`.

GitHub delivery is disabled by default. When explicitly enabled, inspect the
exact side effects and authorize them separately:

```bash
agent-arena deliver <run-id> --plan --json
agent-arena deliver <run-id> --action create_pull_request \
  --confirm-sha256 <full-digest> --json
agent-arena deliver <run-id> --execute --json
agent-arena deliver <run-id> --status --json
```

## Development

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:smoke
npm test
npm run build
```

Integration and smoke tests use temporary Git repositories, local bare-state
fakes, fake provider executables, and controlled check transitions. No network
or paid provider session runs in CI. `npm run test:live` exits with a clear skip
unless `AGENT_ARENA_LIVE=1`; live reads and disposable-repository writes remain
manual, explicitly authorized release checks.
