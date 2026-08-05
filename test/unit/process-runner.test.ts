import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runProcess } from "../../src/runner/process-runner.js";

describe("process runner timeouts", () => {
  it("hard-kills a stalled agent at the configured deadline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-timeout-"));
    const started = Date.now();

    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(() => undefined, 1000)"],
      cwd: root,
      timeoutMs: 100,
      logPrefix: path.join(root, "logs", "stalled-agent"),
    });

    expect(result.timedOut).toBe(true);
    expect(result.failureClass).toBe("agent_submission");
    expect(result.signal).toBe("SIGKILL");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it.skipIf(process.platform === "win32")(
    "kills a launcher and its pipe-holding child at the configured deadline",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "arena-tree-timeout-"));
      const childPidPath = path.join(root, "child.pid");
      const childProgram = "setInterval(() => undefined, 1000)";
      const launcherProgram = [
        'const { spawn } = require("node:child_process")',
        'const { writeFileSync } = require("node:fs")',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(childProgram)}], { stdio: ["ignore", "inherit", "inherit"] })`,
        `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid))`,
        "setInterval(() => undefined, 1000)",
      ].join(";");
      const started = Date.now();

      const result = await runProcess({
        executable: process.execPath,
        args: ["-e", launcherProgram],
        cwd: root,
        timeoutMs: 100,
        logPrefix: path.join(root, "logs", "launcher-with-child"),
      });

      expect(result.timedOut).toBe(true);
      expect(result.failureClass).toBe("agent_submission");
      expect(Date.now() - started).toBeLessThan(2_000);

      const childPid = Number(await readFile(childPidPath, "utf8"));
      expect(() => process.kill(childPid, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      );
    },
  );
});
