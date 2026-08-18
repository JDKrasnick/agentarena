# Artifact reference

Completed runs live under `.agent-arena/runs/<run-id>/`.

## Immutable battle evidence

- New `result.json` files use compact schema version 8. The immutable
  `baseline.json` and digest-chained `rounds/<round>/envelope.json` files are the
  authoritative history; current round records use contract V4 and the summary records the ordered snapshot, replay, and
  envelope hashes already applied. Versions 1–7 remain readable without being
  converted to the new authority model. Version 1 and 2 states still migrate
  provider-keyed contestants into stable `a` and `b` slots in memory.
- `finalization.json` is an immutable, envelope-head-bound projection of final
  validation checks, ranking, quality facts, recommendation, and review data.
  This keeps post-round report, review, delivery, and inspection reconstruction
  equivalent without putting full round history back into `result.json`.
- `runtime-manifest.json` freezes repository identity, base commit, sources,
  dependency files, runtimes, provider CLIs/models, commands, capabilities, and
  service fingerprints. Approval-required resume drift is bound to a saved
  report hash; repository/source/history corruption is a hard stop.
- `checkpoints/<round>.json` describes each sealed boundary. Fork contracts bind
  a new run to its parent checkpoint and intervention. Symmetric steering is the
  default; asymmetric steering is assisted and not competitively comparable.
- `feedback/round-*/` contains immutable lane-specific structured views and
  reader manifests. Inline feedback is capped at 24 KiB and excludes opponent
  transcripts, verifier prose, unrevealed held-out cases, and private repair
  strategy.
- `run-spec.json`, source snapshots, final patches, prompts,
  `attack-reviews/round-*/`, attack cases, logs, `quality/*`,
  `review-prompt.json`, `BATTLE.md`, `BATTLE.html`, and `BATTLE.svg` are frozen
  battle evidence. Attack review artifacts contain structured findings and the
  frozen target-patch digest, but repair prompts receive only
  verifier-confirmed regression tests.
- `BATTLE.html` is the clickable evidence dossier, `BATTLE.md` is the complete
  text replay and handoff, and `BATTLE.svg` is a deterministic share image.
  Links are relative to the run directory and only reference recorded artifacts
  contained by that directory.
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
- `events/lifecycle.ndjson` records typed resume, drift, approval, and durable-replay
  events with continuing sequence numbers. One torn trailing record is safely
  discarded when reconstructing the log.

`delivery/plan.json` and `delivery/status.json` are atomically replaced derived
caches; they are never the audit source of truth. All artifact paths pass
through the run-directory escape guard.

In siege, the attacker has no final production patch. Review, acceptance,
application, and delivery artifacts can bind only to the defender. Duel and
catch-up retain both eligible production choices.
