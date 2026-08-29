# Agent Arena

Make your coding agents fight for the merge.

Agent Arena is a local Node.js library and CLI that gives two coding agents the same immutable run specification, validates both patches, and runs one to five task-scaled attack–repair rounds. Attacks are executable test patches, not critiques. The harness reproduces them twice, verifies that their expected behavior is supported by frozen task text, resolves damage and recoil simultaneously, gives both contestants bounded repair opportunities, and exports the evidence and final patches.

Surviving the arena is additional evidence, not a correctness guarantee.

## Review in chat

The primary workflow is a chat or IDE host calling the exported typed
operations:

1. `reviewRun` presents the arena outcome, any independent recommendation,
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

The preflight permission plan labels every capability as enforced, brokered, or advisory. Native execution appears as a required, high-risk advisory capability because provider and repository subprocesses may inherit the current account's filesystem, environment, network, credentials, and configured integrations. `--yes` still displays the confirm-mode plan before accepting it noninteractively. `auto` approves only exact safe-allowlist matches with enforced or brokered boundaries; it never silently grants production credentials or deployment access.

After isolated MCP readiness checks, Arena displays the exact final MCP policy
before creating worktrees or starting battle agents. By default, Arena warns and
continues with only the servers that passed readiness and authentication checks;
all others are excluded and hidden from agents. Use `--review-mcp` for an
interactive per-server flow: approve or deny ready servers, or authenticate a
failed server through its provider CLI and ask Arena to retry it. Arena never
reads or copies MCP credentials, and the final policy omits unrelated unselected
server identities.

An optional `agent-arena.yaml` stores repeatable settings:

```yaml
test: npm test
# `auto` selects a locked install (npm ci, frozen pnpm/Yarn/Bun).
# Use `none` only when this repository deliberately needs no setup.
bootstrap: auto
agents: [codex, claude]
models: [gpt-5.2-codex, claude-opus-4-6]
judge: codex
effort: auto
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
  attacks_per_round: 3
  implementation_minutes: 15
  review_minutes: 10
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

`review_minutes` defaults to `10`, accepts positive lower values, and rejects
values above `10`. Provider progress is decoded into safe activity events and
diagnostic artifacts; silence never ends a call before its configured deadline.

`effort` defaults to `auto`; the judge selects an ultra-low through ultra-high
profile from task complexity and risk, and the harness stops on convergence or
runs at most two independently qualified extensions through round 5. Use
`--effort low` (or another explicit tier) to pin a profile. `--rounds 1..5`
instead requests an exact fixed count with medium timings and cannot be combined
with `--effort auto`.

`models`/`--models` is optional and follows contestant order. If omitted, each
provider CLI chooses its configured default. This also permits model-vs-model
mirror matches, for example `--agents codex,codex --models model-a,model-b`.

Explicit CLI flags override YAML.

## Live battle observatory

`fight` and `defend` launch the React observatory in a dedicated Electron window
by default. Pass `--no-window` to use the Ink observatory in an interactive TTY
or stable line-oriented output when redirected or running in CI. The explicit
`--display window|terminal|plain` modes remain available, and the legacy
`dashboard` value aliases `window` without opening a browser.

Both rich displays show contestant output, rounds, evidence, checks, warnings,
and PR/spec/artifact links. They support cancellation and one-time steering for
the next eligible contestant-owned implementation, attack, or repair call.
Retries reuse the prompt that already consumed the note. Applied steering marks the result
**Assisted — not competitively comparable** without discarding its evidence.

In the desktop window, click either fighter to open its complete workstream.
The expanded view preserves the full redacted output stream in terminal order,
including whitespace and chunk boundaries, while arena cards show up to ten
concise invocation summaries. Use **Back to main arena** to return. The
round timeline can replay the recorded state of completed rounds without
changing the active fight. Agent Arena does not currently rewind or rerun live
rounds; `resume` continues from a sealed durable boundary.

The desktop window opens in a spacious, work-area-clamped live layout and keeps
up to ten recent work summaries visible for each fighter. A terminal result
automatically contracts the window into a results-first view with the arena
outcome and any independent recommendation, coverage, run integrity, completed rounds,
final fighter scores, defects, verified repairs, outcome, and evidence links.

Use the top-bar swatches to switch among **Classic Shell** (the first-run
default), **Developer Dashboard**, **Night Transit**, **Test Lab**, **Live Arena
Broadcast**, and **16-Bit Tactics**. Night Transit turns recorded attack and
repair lifecycles into contestant lines, verification routes, and an arrivals
board. Test Lab presents the same truth as opposing benches, an experiment
sheet, invocation timing, checks, and health history. The selected theme
persists locally across battles. Legacy `night-edition` selections migrate to
Night Transit. Switching
themes does not reset the current fighter, recorded round, result review, or
live connection. If the preference cannot be saved, the current window keeps
the selection and reports a non-blocking warning. Theme selection affects only
the desktop window; terminal and plain output are unchanged.

Provider and command output is redacted before it reaches either display,
`events.ndjson`, or final transcript logs. The overview keeps live counts for
mounted and landed attacks and evidence revisions. Terminal damage uses a brief
red glyph/HP cue; reduced-motion mode keeps the numeric cue without animation.

The terminal uses a yellow-orange `✦` Spark sigil for Claude and compact textual
marks for other providers. The desktop React view uses crisp native artwork,
including the official orange Claude mark. The registry also covers
Gemini, Grok, Mistral, DeepSeek, Cohere, Perplexity, Meta AI, GitHub Copilot,
Amazon Bedrock, Qwen, NVIDIA, Azure AI, Groq, Hugging Face, Together AI,
Fireworks AI, OpenRouter, and Cursor. No third-party game art is used.

A persistent status rail identifies the current opening, numbered round,
recovery, or final phase; names the exact stage in plain language; explains its
current objective; and highlights progress through `scout → mount → verify →
damage → repair`. Battle-log entries retain the round in which each move occurred.

On completion, the dashboard opens an evidence-backed result area. It
shows final HP, status, and checks for both fighters; the champion or explicit
non-discriminating result and any recommendation when coverage resolves them; verified defects caught before
ship; health-restoring improvements that survived replay; and the exact review
command. Choose
**Finish session** after review to close the window and its loopback-only local
server. Closing the window during a battle cancels the active run.

Run either mock without provider credentials:

```bash
npm run demo:dashboard
npm run demo:window
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
- Complete duel or catch-up coverage with two required-valid, equally correct
  final patches and no effective contestant landing is non-discriminating: raw
  HP remains visible, but recoil, shared findings, and patch size cannot create
  a champion.
- With selection enabled, a fresh identity-blind configured-judge comparison
  may independently recommend one anonymized patch. Equivalent, inconclusive,
  disabled, or twice-failed comparison leaves both unrecommended.
- Adaptive decisions record low-signal evidence. An already-planned next round
  pivots after the first low-signal boundary; two consecutive low-signal rounds
  stop adaptive play. Exact fixed rounds still continue with the pivot.

Round 3 executes an approved integration profile symmetrically against both frozen patches. If the profile is absent or denied, the round degrades to local contract, security, and resilience probes without a health event.

## Artifacts

Each run is persisted atomically under `.agent-arena/runs/<run-id>/`:

- `BATTLE.md`, the clickable `BATTLE.html` dossier, deterministic `BATTLE.svg`,
  and compact schema-v10 `result.json`
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

For a non-discriminating result, `--selection champion` is unavailable. If the
identity-blind comparison makes no recommendation, inspect both choices and use
`agent-arena accept <run-id> --agent <contestant>` to record an explicit,
digest-bound selection before applying it.

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
