# Agent Arena

**Make your coding agents fight for the merge.**

Agent Arena is a local CLI and TypeScript library that gives two coding agents
the same task, lets them challenge each other's implementations, and hands you
the patches, tests, and evidence to decide what to merge.

[Quick start](#quick-start) · [How it works](#how-it-works) ·
[Battle modes](#battle-modes) · [Review and handoff](#review-and-handoff) ·
[Documentation](#documentation)

## Why I built this

I kept repeating the same workflow: ask an agent to implement a change, ask
another to review it, send the findings back for fixes, rerun checks, and decide
which version to keep. Using different agents gave me different perspectives,
but I was doing the coordination myself—moving context between sessions,
checking claims, and keeping track of what had actually been tested.

Agent Arena automates that implement–review–repair pipeline. Two agents work
independently, inspect each other's solutions, and try to turn their concerns
into reproducible failures. Each gets a chance to repair its patch before the
final comparison. The goal is to make those different perspectives useful and
choose the strongest implementation the available evidence supports.

The handoff matters as much as the competition: what changed, what broke, what
was repaired, which checks ran, and what still needs human attention. I want to
finish with a patch I can review and a record I can follow back to the evidence.

## What you get

- **Independent implementations** in separate Git worktrees, using Codex CLI,
  Claude Code, or Gemini CLI. Same-provider model comparisons are supported too.
- **Adversarial review and repair**, with executable attacks and regression
  checks carried through final validation.
- **An explained result**, including health, accepted defects, repairs, and an
  independent patch recommendation when the evidence supports one.
- **A reviewable handoff** with final patches, a check matrix, logs, a clickable
  HTML evidence dossier, and a deterministic visual replay.
- **A live battle view** in a dedicated desktop window, with terminal and plain
  output modes for other workflows.

Surviving the arena is additional evidence, not a correctness guarantee. The
result can be a winner, draw, non-discriminating comparison, or inconclusive
run. You review and explicitly accept the exact patch before it is applied.

## Quick start

### Requirements

- macOS or Linux, Node.js 22 or newer, and Git.
- Installed and authenticated coding-agent CLIs for the providers you select.
  Available adapters are Codex CLI, Claude Code, and Gemini CLI.
- A clean local Git repository with a passing automated test command.

### Install from source

```bash
git clone https://github.com/JDKrasnick/agentarena.git
cd agentarena
npm ci
npm run build
npm link
```

Then run a fight **from the repository you want to change**:

```bash
agent-arena fight "fix repeated whitespace in generated slugs" \
  --agents codex,claude \
  --permissions confirm \
  --test "npm test"
```

Arena presents a permission plan before starting battle agents. Native agent
and test processes run with your OS account's permissions; Git worktrees isolate
patches but are not a hostile-code sandbox. Use a sanitized account or an external
container for repositories that need stronger isolation. See the
[security model](docs/SECURITY.md).

Try the displays with mock data and no provider credentials:

```bash
npm run demo:dashboard  # Terminal
npm run demo:window     # Desktop window
```

## How it works

```text
Task + frozen requirements
          │
          ├── Agent A → implementation A
          └── Agent B → implementation B
                         │
                  Validate both patches
                         │
            Review → attack → verify → repair
                         │
                  Final regression checks
                         │
           Compare → evidence handoff → human review
```

1. **Freeze the task.** Arena snapshots the base commit, requirements,
   repository instructions, and approved capabilities into an immutable run
   specification. Issue, PR, and local spec references can supply context.
2. **Implement independently.** Each contestant gets a separate worktree and
   the same task contract. Arena captures and validates both patches.
3. **Review and attack.** Contestants inspect the opposing patch and submit up
   to three ranked attacks per round. Mechanical confirmation requires an
   attack to pass twice on its author and fail twice on its target. A fresh,
   identity-blind judge checks whether the claimed behavior follows from the
   frozen requirements; bounded fallback judgments are labeled separately.
4. **Repair and recheck.** Contestants receive accepted evidence and bounded
   repair opportunities. Arena reruns required checks, active reproducers, and
   regression tests for previously healed defects.
5. **Compare and hand off.** Final validation and recorded evidence determine
   the result. Reports retain eligible patches and the reasoning behind
   any recommendation.

Fights run one to five task-scaled attack–repair rounds. `--effort auto` is the
default; an explicit effort tier pins a profile. `--rounds 1..5` selects an exact
count with medium timings and cannot be combined with `--effort auto`.

### Evidence and scoring

Both contestants start at 100 HP. Confirmed Critical, High, Medium, and Low
defects deal 50, 30, 15, and 5 HP respectively. Missed attacks incur rank-based
recoil of 5, 10, or 15 HP. A distinct defect scores once; a verified repair heals
its active damage, while recoil remains permanent.

Competitive results follow the health ledger. A fresh identity-blind quality
comparison may break a tie when HP and active defect damage are both equal.
For a fully covered duel or catch-up, when both final patches pass required
checks, have equal active defect damage, and no still-valid contestant attack
distinguishes them, Arena reports a **non-discriminating** result. A separate
quality comparison may still recommend an implementation without declaring a
champion.

Incomplete required attack coverage leaves the result provisional and blocks
ordinary review and apply. The user must resolve the exact coverage assessment
as reduced-confidence or inconclusive. See the
[full evidence and outcome rules](docs/MVP.md#product-rules).

## Battle modes

| Mode         | Starting point                                          | Purpose                                                                                      |
| ------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Duel**     | Two independent implementations of one task             | Compare approaches and challenge both patches.                                               |
| **Catch-up** | A frozen PR versus a fresh implementation from its base | Test whether a challenger can produce a stronger solution without seeing the incumbent diff. |
| **Siege**    | A frozen PR with a defender and a test-only attacker    | Find defects and repair the defender's patch. Only the defender's patch is deliverable.      |

The quick-start command runs a duel. To compare models from the same provider:

```bash
agent-arena fight "fix repeated whitespace in generated slugs" \
  --agents codex,codex \
  --models model-a,model-b \
  --test "npm test"
```

Replace `model-a` and `model-b` with IDs supported by your provider CLI. Model
selection follows contestant order; omitting `--models` uses each CLI's
configured default.

For an existing PR:

```bash
# Catch-up: recreate the solution independently, then compare.
agent-arena fight "fix issue #241" --pr 87 --incumbent-from-pr \
  --incumbent claude --challenger codex --test "npm test"

# Siege: attack and repair the existing patch.
agent-arena defend --pr 87 \
  --attacker codex --defender claude --test "npm test"
```

`--incumbent` can be omitted only when PR attribution is confirmed. On its own,
`--pr` supplies requirements context; use `--base-from-pr 87` explicitly when
both contestants should start from that PR's head.

## Review and handoff

Each run lives under `.agent-arena/runs/<run-id>/`. Start with `BATTLE.md` or
the clickable `BATTLE.html` dossier for the outcome, check matrix, defects,
repairs, and linked evidence. Final patches, `result.json`, source snapshots,
prompts, redacted transcripts, and the event history remain available for
inspection. `BATTLE.svg` provides a deterministic share image.

Review, inspect, and explicitly accept an available recommendation:

```bash
agent-arena review <run-id>
agent-arena inspect <run-id> --agent a --view diff
agent-arena accept <run-id> --selection recommended --apply
```

Patch commands use contestant IDs `a` and `b`, as shown by `review`, rather than
provider names. If there is no recommendation, inspect the eligible choices and
select one with `agent-arena accept <run-id> --agent <contestant>`. Acceptance binds to the
exact patch digest and base commit. `agent-arena apply <run-id>` applies the
accepted patch after clean-tree and apply checks, without committing it.
Non-interactive acceptance requires the full displayed `--confirm-sha256`.

Acceptance does not authorize a commit, push, PR, or merge. Optional GitHub
delivery is separately authorized and disabled by default; see
[review and delivery security](docs/SECURITY.md).

Interrupted runs can resume from a sealed boundary:

```bash
agent-arena resume <run-id> --display console
```

Material runtime drift requires approval bound to the displayed report hash via
`--approve-drift <report-sha256>`. For debugging, `fight --keep-worktrees`
retains successfully created worktrees; `agent-arena cleanup-worktrees <run-id>`
removes them afterward.

## Configuration and live view

An optional `agent-arena.yaml` makes settings repeatable:

```yaml
test: npm test
bootstrap: auto
agents: [codex, claude]
judge: codex
effort: auto
permissions:
  default: confirm
  deny: [production_credentials, production_deploy]
review:
  required_for_apply: true
delivery:
  enabled: false
  merge_enabled: false
```

Explicit CLI flags override YAML. `bootstrap: auto` selects a locked dependency
install. The [configuration reference](docs/MVP.md#configuration) covers model
selection, sources, limits, and an optional integration profile.

MCP readiness and authentication checks run before battle agents start. Arena
displays the final policy and excludes failed servers. `--review-mcp` enables
interactive per-server review and provider-managed authentication retries.

`fight` and `defend` open the live React observatory in a dedicated Electron
window. Use `--no-window` for an interactive terminal display or plain output
when redirected; `--display window|terminal|plain` selects a mode explicitly.

The rich displays show contestant output, checks, rounds, and evidence. In the
desktop window, select a fighter to inspect its workstream or a completed round
to replay recorded state. Six local themes are available. Cancellation and
one-time contestant steering are supported; applied steering marks the result
**Assisted — not competitively comparable**.

### Chat and IDE integration

The library exports typed operations for hosts that present review in chat:
`reviewRun`, `inspectPatch`, `recordReviewDecision`, and `applyAcceptedPatch`.
Delivery has separate planning, decision, execution, and status operations.
The host maps authenticated user actions to strict schemas; the core does not
parse conversational approval or store raw chat text or attestation tokens.

## Documentation

| Guide                                      | Contents                                                           |
| ------------------------------------------ | ------------------------------------------------------------------ |
| [Product](PRODUCT.md)                      | Motivation, workflow, architecture, and product behavior.          |
| [MVP specification](docs/MVP.md)           | Scope, evidence rules, configuration, and failure behavior.        |
| [Artifact reference](docs/ARTIFACTS.md)    | Run files, immutable evidence, review records, and delivery state. |
| [Security](docs/SECURITY.md)               | Execution boundaries and review/delivery authorization.            |
| [Live validation](docs/LIVE_VALIDATION.md) | Manual release checks using real providers.                        |

## Development

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

For focused checks, use `test:unit`, `test:integration`, or `test:smoke`.
Integration and smoke tests use temporary repositories, fake provider
executables, and controlled check transitions. CI runs without network or paid
provider sessions. Live checks are manual; `npm run test:live` skips unless
`AGENT_ARENA_LIVE=1` is set.

## License

[MIT](LICENSE)
