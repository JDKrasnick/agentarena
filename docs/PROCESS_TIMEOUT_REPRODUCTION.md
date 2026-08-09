# Escaped-descendant timeout reproduction

Issues #11 and #40 are represented by focused expected-failure tests. They
exercise both `runProcess` and `runShellCommand` without changing production
runner behavior. The temporary expected-failure annotations link directly to
the production-fix ticket, #40.

Run the reproduction on Node.js 22 on macOS or Linux:

```bash
npm run test:process-timeout-repro
```

The fixture creates a launcher, detached child, and detached grandchild. Every
process records its ownership token, PID, parent PID, process group, session,
role, and lifecycle timestamps. The descendants resist graceful termination
and retain an inherited output stream. An independent probe watchdog fires
after the 500 ms runner timeout plus the fixed 2,000 ms cleanup grace and an
additional 2,000 ms diagnostic margin.

Until #40 is fixed, the two expected-failure cases print diagnostics similar to:

```text
#40 runProcess reproduction {
  "runnerReturned": false,
  "watchdogFired": true,
  "ownedAliveAtDeadline": [ ... child and grandchild records ... ]
}
```

The safety test is an ordinary passing test. It includes an unrelated sentinel
PID in the cleanup candidates and proves that ownership-token revalidation
prevents the sentinel from being signaled.

After the production fix lands, replace both `test.fails(...)` declarations in
`test/reproduction/process-timeout-reproduction.test.ts` with `test(...)`. Do not
weaken the deadline or descendant-cleanup assertions. The focused command must
then pass with `runnerReturned: true`, `watchdogFired: false`, and no owned
descendants alive before fixture cleanup.
