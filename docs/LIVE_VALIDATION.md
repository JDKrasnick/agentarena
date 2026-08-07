# Live validation checklist

Core duel and GitHub delivery status: complete as of 2026-07-30.

Battle-mode release matrix status: pending explicit authorization.

## 2026-07-31 stopped GPT-5.4 mirror attempt

One explicitly authorized local hard-task run used the disposable
`.context/bank-ledger-arena` fixture with Codex CLI `0.146.0`, model
`gpt-5.4` in both contestant slots, eight-minute implementation and review
budgets, and four-minute attack and repair budgets. The saved run is
`2026-07-31T015903802Z-4a595ee3`.

The attempt stopped without further experimentation because neither contestant
produced an implementation patch, so the redesigned review and regression-test
phases had no eligible target and generated no review or attack invocations.
Contestant A failed during repeated ChatGPT transport/DNS errors. Contestant B
was reported as timed out, but its recorded duration was 3,047,292 ms despite
the configured 480,000 ms implementation budget. The harness then reported a
completed 0-HP draw rather than an inconclusive provider/infrastructure run.

This attempt provides no evidence for the battle-mode release matrix and checks
none of the items below. Before another paid run, investigate provider
connectivity, hard timeout enforcement for the Codex subprocess tree, and
inconclusive classification when both implementations fail before review.

The GitHub delivery boundary was validated against the explicitly authorized
`JDKrasnick/agentarena` repository. Draft PR
[#4](https://github.com/JDKrasnick/agentarena/pull/4) covered idempotent
adoption and moved-head refusal before it was closed. PR
[#5](https://github.com/JDKrasnick/agentarena/pull/5) ran the real GitHub
Actions suite and was merged into a disposable base branch; the base and head
branches were then deleted, and the validation marker was confirmed absent
from `main`.

Before enabling GitHub delivery by default:

- [x] Read one public issue and one public pull request.
- [x] Run one cost-bounded fight with two installed, authenticated providers in
      a disposable repository.
- [x] Create one draft pull request in an explicitly authorized repository.
- [x] Adopt an unchanged PR head without force push.
- [x] Exercise merge-after-checks in the disposable repository.
- [x] Confirm a moved PR head stops delivery.
- [x] Save the redacted run bundle outside version control.

The provider fight used Codex and Claude with one-minute per-invocation limits,
completed all three attack–repair rounds and final validation, and wrote run
`2026-07-30T171501827Z-fb131555`. Its scrubbed bundle is retained under
`.context/live-e2e-evidence/`, which is excluded from version control; a
credential- and local-path-pattern scan passed.

Before making release claims about the battle modes, run the controlled matrix
from `docs/BATTLE_MODES_IMPLEMENTATION.md` with explicit cost bounds:

- [ ] Three mirror matches per supported provider across an input-boundary,
      state/concurrency, and integration/configuration task.
- [ ] Cross-provider controls on the same tasks, with production-diff hashes,
      overlap, hypotheses, unique root defects, landed attacks, and outcomes.
- [ ] One catch-up fight confirming the real challenger transcript and
      implementation prompt contain no incumbent diff or head contents before
      round one.
- [ ] One siege each for healed damage/draw, unresolved damage/attacker win, and
      miss recoil/defender win.
- [ ] Redact and retain the run bundles under `.context/`, record provider,
      model, CLI, prompt hashes, duration, and spend, and scan for credentials
      and local paths.

Every live write requires an explicit user decision naming the disposable
target. `npm run test:live` skips unless `AGENT_ARENA_LIVE=1`; even with that
flag, the script performs no automatic external write.
