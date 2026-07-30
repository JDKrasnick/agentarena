if (process.env.AGENT_ARENA_LIVE !== "1") {
  process.stdout.write(
    "SKIP: set AGENT_ARENA_LIVE=1 only for an explicitly authorized, cost-bounded live checklist.\n",
  );
  process.exit(0);
}

process.stderr.write(
  "Live validation requires the documented disposable-repository checklist; no automatic live writes are performed by this script.\n",
);
process.exitCode = 1;
