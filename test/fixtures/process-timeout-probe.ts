import { writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  runProcess,
  runShellCommand,
} from "../../src/runner/process-runner.js";

const [mode, ownershipToken, statePath, outcomePath, logPrefix, timeoutText] =
  process.argv.slice(2);

if (
  (mode !== "process" && mode !== "shell") ||
  !ownershipToken ||
  !statePath ||
  !outcomePath ||
  !logPrefix ||
  !timeoutText
) {
  throw new Error(
    "usage: process-timeout-probe.ts <process|shell> <token> <state> <outcome> <log-prefix> <timeout-ms>",
  );
}

const timeoutMs = Number(timeoutText);
const fixturePath = fileURLToPath(
  new URL("./escaped-descendant.mjs", import.meta.url),
);
const started = performance.now();

const result =
  mode === "process"
    ? await runProcess({
        executable: process.execPath,
        args: [
          fixturePath,
          "launcher",
          ownershipToken,
          statePath,
          "orphan-before-deadline",
        ],
        cwd: process.cwd(),
        timeoutMs,
        logPrefix,
      })
    : await runShellCommand(
        [
          process.execPath,
          fixturePath,
          "launcher",
          ownershipToken,
          statePath,
          "orphan-before-deadline",
        ]
          .map((part) => `'${part.replaceAll("'", `'\\''`)}'`)
          .join(" "),
        {
          cwd: process.cwd(),
          timeoutMs,
          logPrefix,
        },
      );

await writeFile(
  outcomePath,
  JSON.stringify({
    elapsedMs: performance.now() - started,
    result,
    logDirectory: path.dirname(logPrefix),
  }),
  "utf8",
);
