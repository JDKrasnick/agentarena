import { appendFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const [role, ownershipToken, statePath] = process.argv.slice(2);

if (!role || !ownershipToken || !statePath) {
  throw new Error("usage: escaped-descendant.mjs <role> <token> <state-path>");
}

function processIdentity() {
  if (process.platform === "win32") {
    return { parentPid: process.ppid, processGroupId: null, sessionId: null };
  }

  const result = spawnSync(
    "ps",
    [
      "-o",
      process.platform === "darwin" ? "ppid=,pgid=,sess=" : "ppid=,pgid=,sid=",
      "-p",
      String(process.pid),
    ],
    { encoding: "utf8" },
  );
  const [parentPid, processGroupId, sessionId] = result.stdout
    .trim()
    .split(/\s+/)
    .map(Number);
  return {
    parentPid: Number.isFinite(parentPid) ? parentPid : process.ppid,
    processGroupId: Number.isFinite(processGroupId) ? processGroupId : null,
    sessionId: Number.isFinite(sessionId) ? sessionId : null,
  };
}

function record(event, details = {}) {
  appendFileSync(
    statePath,
    `${JSON.stringify({
      token: ownershipToken,
      role,
      event,
      pid: process.pid,
      ...processIdentity(),
      wallTimeMs: Date.now(),
      monotonicMs: performance.now(),
      ...details,
    })}\n`,
  );
}

function resist(signal) {
  process.on(signal, () => record("signal-resisted", { signal }));
}

resist("SIGTERM");
resist("SIGINT");
record("started");

if (role === "launcher" || role === "child") {
  const nextRole = role === "launcher" ? "child" : "grandchild";
  const descendant = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), nextRole, ownershipToken, statePath],
    {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  descendant.unref();
  record("spawned-descendant", {
    descendantPid: descendant.pid,
    descendantRole: nextRole,
  });
}

// Keeping an inherited output stream open is the part of the fixture that can
// prevent Execa from settling after it has killed the direct launcher.
process.stdout.write(`${role}:${ownershipToken}:ready\n`);
setInterval(() => {}, 1_000);
await new Promise(() => {});
