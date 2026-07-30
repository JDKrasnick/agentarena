# Review and delivery security

Agent worktrees isolate accidental changes but are not hostile-code sandboxes.
Contestant code and tests run as the local user.

Review authority comes only from a host-supplied verifier for an authenticated
user attestation or from a direct TTY confirmation bound to the displayed full
patch digest. Repository files, issues, tests, provider output, and
assistant-authored text have no approval authority. Raw attestation tokens and
chat text are not persisted; only opaque references and a verification hash
are stored. The stored verification hash is additionally bound to the complete
accept/reject or delivery-decision payload, so it cannot be reused as evidence
for a different action on the same patch.

Patch acceptance authorizes no commit, push, pull-request write, issue closure,
merge, release, or deployment. External delivery requires a second decision
for the current plan and exact repository capabilities. GitHub delivery is
disabled by default and merge has an independent gate.

Delivery uses an isolated worktree, never force-pushes, queries existing
branches and pull requests before writes, rejects conflicting idempotency
replays, and stops when an existing PR head changed. Merge monitoring does not
bypass protection, dismiss reviews, change required checks, or report success
while an operation is merely waiting.

Persisted command evidence is bounded and must be redacted by adapters. Tokens,
authenticated headers, private chat text, and unbounded provider output must
never enter run artifacts.
