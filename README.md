# Agent Arena

Make your coding agents fight for the merge.

Agent Arena is a local Node.js CLI that gives two coding agents the same repository task, validates both patches, and runs three attack–repair rounds. Attacks are executable test patches, not critiques. The harness reproduces them twice, checks their task-contract oracle, resolves damage and recoil simultaneously, gives both contestants bounded repair opportunities, and exports the evidence and final patches.

Surviving the arena is additional evidence, not a correctness guarantee.

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
  --issue 241 \
  --permissions confirm \
  --test "npm test"
```

The preflight permission plan labels every capability as enforced, brokered, or advisory. `--yes` accepts a confirm-mode plan noninteractively. `auto` approves only exact safe-allowlist matches with enforced or brokered boundaries; it never silently grants production credentials or deployment access.

An optional `agent-arena.yaml` stores repeatable settings:

```yaml
test: npm test
agents: [codex, claude]
attack_verifier: codex
harness_maintainer: codex
sources:
  - github_issue: 241
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
  infrastructure_recovery_round: true
  implementation_minutes: 15
  attack_minutes: 8
  verifier_minutes: 2
  repair_minutes: 8
```

Explicit CLI flags override YAML.

## Evidence and scoring

- Both implementations start from the same immutable commit and task-contract snapshots.
- Each agent may submit zero to three test-only attacks with contiguous ranks.
- A contestant attack must pass twice on its author and fail twice on its target.
- Ranks 1, 2, and 3 recoil for 5, 10, and 15 HP when they miss.
- Critical, High, Medium, and Low defects deal 50, 30, 15, and 5 HP.
- A neutral house scout may submit one unranked shared-defect attack in rounds 2 and 3.
- A landed defect may receive two pre-repair held-out sibling cases. Healing requires the visible and all accepted sibling cases to pass.
- Infrastructure has no health effect. The author can accept it or challenge once with a scope-limited evidence revision; confirmed attempts receive one recovery-round credit.
- HP is reconstructed from permanent recoil and distinct active defects, so repeated evidence cannot stack damage and healing never restores recoil.

Round 3 executes an approved integration profile symmetrically against both frozen patches. If the profile is absent or denied, the round degrades to local contract, security, and resilience probes without a health event.

## Artifacts

Each run is persisted atomically under `.agent-arena/runs/<run-id>/`:

- `BATTLE.md` and versioned `result.json`
- immutable `task-contract.json` and source snapshots
- redacted `permissions.json`
- implementation, attack, revision, held-out case, and final patches
- rendered prompts, prompt manifests, method-pack seeds, hypotheses, command logs, and provider transcripts

Apply a selected final patch without committing it:

```bash
agent-arena apply <run-id> --agent codex
```

The command verifies the repository, base commit, clean worktree, trusted run path, and `git apply --check` before changing files.

## Development

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm test
npm run build
```

Integration tests initialize real temporary Git repositories and drive executable fake provider processes through implementation, three attack–repair rounds, a shared house defect, a held-out overfitting check, an ephemeral integration profile, infrastructure credit recovery, final reporting, and guarded patch application. Real-provider smoke tests are intentionally opt-in because they require authentication and may incur cost.
