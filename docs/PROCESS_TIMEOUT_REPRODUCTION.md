# Escaped-descendant timeout reproduction

Issues #11 and #40 are represented by focused regression tests. They exercise
both `runProcess` and `runShellCommand` against the production process-tree
supervisor.

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

The two runner cases print diagnostics similar to:

```text
#40 runProcess reproduction {
  "runnerReturned": true,
  "watchdogFired": false,
  "ownedAliveAtDeadline": []
}
```

The safety tests include an unrelated sentinel PID in the cleanup candidates,
prove that ownership-token revalidation prevents the sentinel from being
signaled, validate the escaped process topology, and cover cleanup from partial
lifecycle records.
