# Live validation checklist

Status: complete as of 2026-07-30.

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

Every live write requires an explicit user decision naming the disposable
target. `npm run test:live` skips unless `AGENT_ARENA_LIVE=1`; even with that
flag, the script performs no automatic external write.

## Mirror-match evidence

Separate from the delivery validation above, a disposable local mirror sample
completed one Codex mirror, one Claude mirror, and one Codex-versus-Claude
control on 2026-07-30. Exact run IDs, prompt/patch evidence, and the E2E
failure-path fix it uncovered are recorded in
`.context/live-evaluation/2026-07-30.md`.

The sample shows isolated transcripts and distinct patch hashes. It does not
yet satisfy the planned three-mirrors-per-provider diversity gate, so it must
not be used to make a release claim about same-provider diversity.
