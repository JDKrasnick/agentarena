# Live validation checklist

Status: release blocker — not performed in this development workspace because
no explicitly authorized disposable GitHub target or paid provider session was
provided.

Before enabling GitHub delivery by default:

- [ ] Read one public issue and one public pull request.
- [ ] Run one cost-bounded fight with two installed, authenticated providers in
      a disposable repository.
- [ ] Create one pull request in a disposable sandbox repository.
- [ ] Update an unchanged sandbox PR head without force push.
- [ ] Exercise merge-after-checks in the disposable repository.
- [ ] Confirm a moved PR head stops delivery.
- [ ] Save the redacted run bundle outside version control.

Every live write requires an explicit user decision naming the disposable
target. `npm run test:live` skips unless `AGENT_ARENA_LIVE=1`; even with that
flag, the script performs no automatic external write.
