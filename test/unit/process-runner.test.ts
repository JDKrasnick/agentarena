import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  runProcess,
  runShellCommand,
} from "../../src/runner/process-runner.js";
import { PROCESS_CLEANUP_GRACE_MS } from "../../src/runner/process-supervisor.js";

async function waitUntilGone(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
  }
  throw new Error(`Process ${String(pid)} survived supervisor cleanup`);
}

describe("process runner supervision", () => {
  it.skipIf(!["darwin", "linux"].includes(process.platform))(
    "bounds and removes a launcher tree whose descendants escape process groups and hold pipes",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "arena-tree-timeout-"));
      const launcherPidPath = path.join(root, "launcher.pid");
      const childPidPath = path.join(root, "child.pid");
      const grandchildPidPath = path.join(root, "grandchild.pid");
      const grandchildProgram = [
        'process.stdout.write("grandchild-ready\\n")',
        "setInterval(() => undefined, 1000)",
      ].join(";");
      const childProgram = [
        'const { spawn } = require("node:child_process")',
        'const { writeFileSync } = require("node:fs")',
        `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildProgram)}], { detached: true, stdio: ["ignore", "inherit", "inherit"] })`,
        `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid))`,
        "setInterval(() => undefined, 1000)",
      ].join(";");
      const launcherProgram = [
        'const { spawn } = require("node:child_process")',
        'const { writeFileSync } = require("node:fs")',
        `writeFileSync(${JSON.stringify(launcherPidPath)}, String(process.pid))`,
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(childProgram)}], { detached: true, stdio: ["ignore", "inherit", "inherit"] })`,
        `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid))`,
        "setTimeout(() => process.exit(0), 25)",
      ].join(";");
      const timeoutMs = 300;
      const started = Date.now();

      const result = await runProcess({
        executable: process.execPath,
        args: ["-e", launcherProgram],
        cwd: root,
        timeoutMs,
        logPrefix: path.join(root, "logs", "escaped-tree"),
      });

      expect(result.timedOut).toBe(true);
      expect(result.failureClass).toBe("agent_submission");
      expect(result.deadline?.graceMs).toBe(PROCESS_CLEANUP_GRACE_MS);
      expect(result.deadline?.cleanupComplete).toBe(true);
      expect(result.deadline?.remainingDescendants).toEqual([]);
      expect(result.deadline?.cleanupDurationMs).toBeLessThanOrEqual(
        PROCESS_CLEANUP_GRACE_MS,
      );
      expect(
        result.deadline?.signalEscalation.some(
          (event) => event.signal === "SIGTERM",
        ),
      ).toBe(true);
      expect(Date.now() - started).toBeLessThan(
        timeoutMs + PROCESS_CLEANUP_GRACE_MS,
      );

      const launcherPid = Number(await readFile(launcherPidPath, "utf8"));
      const childPid = Number(await readFile(childPidPath, "utf8"));
      const grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));
      await Promise.all([
        waitUntilGone(launcherPid),
        waitUntilGone(childPid),
        waitUntilGone(grandchildPid),
      ]);
    },
  );

  it("applies the same deadline contract to shell commands", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-shell-timeout-"));
    const result = await runShellCommand(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => undefined, 1000)")}`,
      {
        cwd: root,
        timeoutMs: 50,
        logPrefix: path.join(root, "logs", "shell"),
      },
    );

    expect(result.timedOut).toBe(true);
    expect(result.deadline).toBeDefined();
    expect(result.failureClass).toBeUndefined();
  });

  it.skipIf(!["darwin", "linux"].includes(process.platform))(
    "never signals an unrelated process",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "arena-ownership-"));
      const unrelated = spawn(
        process.execPath,
        ["-e", "setInterval(() => undefined, 1000)"],
        { detached: true, stdio: "ignore" },
      );
      try {
        await runProcess({
          executable: process.execPath,
          args: ["-e", "setInterval(() => undefined, 1000)"],
          cwd: root,
          timeoutMs: 50,
          logPrefix: path.join(root, "logs", "owned-only"),
        });

        expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
      } finally {
        unrelated.kill("SIGKILL");
      }
    },
  );

  it("records transport and MCP authentication failures separately from timeout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-transport-"));
    const result = await runProcess({
      executable: process.execPath,
      args: [
        "-e",
        'console.error("MCP OAuth refresh token expired"); console.error("transport connection lost; reconnecting")',
      ],
      cwd: root,
      timeoutMs: 2_000,
      logPrefix: path.join(root, "logs", "transport"),
    });

    expect(result.timedOut).toBe(false);
    expect(result.deadline).toBeUndefined();
    expect(result.transportFailures?.map((failure) => failure.kind)).toEqual([
      "mcp_auth",
      "reconnect",
    ]);
  });
});
