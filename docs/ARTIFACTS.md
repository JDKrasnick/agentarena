# Artifact reference

Completed runs live under `.agent-arena/runs/<run-id>/`.

## Immutable battle evidence

- `result.json` uses schema version 3. `RunStateV1Schema`,
  `RunStateV2Schema`, `RunStateV3Schema`, `AnyRunStateSchema`, and
  `parseRunState` keep version 1 and 2 runs readable by migrating
  provider-keyed contestants into stable `a` and `b` slots. Migrated runs
  receive an explicit arena-fallback recommendation and must be reviewed again
  before application.
- `task-contract.json`, source snapshots, final patches, prompts, attack cases,
  logs, `quality/*`, `review-prompt.json`, and `BATTLE.md` are frozen battle
  evidence.
- `pull-request/pull-request.json` and `pull-request/incumbent.patch` freeze the
  binary-safe base-to-head change,
  repository identity, metadata, hashes, and authorship evidence used by
  catch-up and siege.
- Slot IDs, rather than provider names, key contestant patches, prompts, logs,
  attacks, checks, recommendations, and decisions. This prevents collisions in
  same-provider mirror matches.
- `quality/anonymization-map.json` is kept separately from the verifier input.
  The verifier input contains Patch A/Patch B labels and no contestant/provider
  identity, HP, recoil, or champion.

## Append-only post-fight state

- `reviews/<decision-id>.json` contains an authenticated decision bound to the
  run, prompt, base commit, contestant, and patch SHA-256.
- `delivery/decisions/<decision-id>.json` contains a separate delivery
  authorization.
- `delivery/events/<event-id>.json` contains bounded progress or terminal
  evidence.
- `operations/<idempotency-key-hash>.json` maps one key and payload hash to its
  immutable result. Reusing a key with another payload is an error.

`delivery/plan.json` and `delivery/status.json` are atomically replaced derived
caches; they are never the audit source of truth. All artifact paths pass
through the run-directory escape guard.

In siege, the attacker has no final production patch. Review, acceptance,
application, and delivery artifacts can bind only to the defender. Duel and
catch-up retain both eligible production choices.
