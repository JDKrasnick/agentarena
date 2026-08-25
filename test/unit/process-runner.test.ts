import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  minimalEnvironment,
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
  it("keeps browser startup credentials out of the inherited environment", () => {
    const environment = minimalEnvironment(
      { PORT: "4173" },
      {
        PATH: "/usr/bin",
        HOME: "/tmp/home",
        GITHUB_TOKEN: "secret-token",
        API_KEY: "secret-key",
        DATABASE_PASSWORD: "secret-password",
        CHROME_BIN: "/Applications/Chrome",
      },
    );

    expect(environment).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      PORT: "4173",
    });
  });

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
        'console.error("MCP authentication failed: OAuth token expired"); console.error("transport connection lost; reconnecting")',
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

  it("does not promote optional MCP states from provider initialization", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-mcp-init-"));
    const init = JSON.stringify({
      type: "system",
      subtype: "init",
      mcpServers: [
        { name: "vercel", status: "needs-auth" },
        { name: "pencil", status: "failed", error: "connection failed" },
      ],
    });
    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", `console.log(${JSON.stringify(init)})`],
      cwd: root,
      timeoutMs: 2_000,
      logPrefix: path.join(root, "logs", "mcp-init"),
      providerStream: "claude",
    });

    expect(result.exitCode).toBe(0);
    expect(result.transportFailures).toBeUndefined();
  });

  it("keeps optional Codex MCP refresh warnings diagnostic-only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-mcp-startup-"));
    const warning =
      "ERROR codex_rmcp_client::oauth::refresh_transaction: " +
      "failed to refresh OAuth tokens for server expo: " +
      "invalid_grant: Invalid or expired refresh token";
    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", `console.error(${JSON.stringify(warning)})`],
      cwd: root,
      timeoutMs: 2_000,
      logPrefix: path.join(root, "logs", "mcp-startup"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.transportFailures).toBeUndefined();
    expect(await readFile(result.stderrPath, "utf8")).toContain(warning);
  });

  it("keeps an optional MCP warning diagnostic-only after useful provider activity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-mcp-active-"));
    const activity = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Reviewing the target." },
    });
    const warning =
      "ERROR codex_rmcp_client::oauth::refresh_transaction: " +
      "failed to refresh OAuth tokens for server expo: " +
      "invalid_grant: Invalid or expired refresh token";
    const program = [
      `console.log(${JSON.stringify(activity)})`,
      `console.error(${JSON.stringify(warning)})`,
      "setInterval(() => undefined, 1000)",
    ].join(";");
    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", program],
      cwd: root,
      timeoutMs: 50,
      logPrefix: path.join(root, "logs", "mcp-active"),
      providerStream: "codex",
    });

    expect(result.timedOut).toBe(true);
    expect(result.providerDiagnostics?.eventCount).toBeGreaterThan(0);
    expect(result.transportFailures).toBeUndefined();
  });

  it("retains an MCP refresh failure when the provider does not continue", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-mcp-fatal-"));
    const warning =
      "ERROR codex_rmcp_client::oauth::refresh_transaction: " +
      "failed to refresh OAuth tokens for server required-server: " +
      "invalid_grant: Invalid or expired refresh token";
    const result = await runProcess({
      executable: process.execPath,
      args: [
        "-e",
        `console.error(${JSON.stringify(warning)}); process.exit(2)`,
      ],
      cwd: root,
      timeoutMs: 2_000,
      logPrefix: path.join(root, "logs", "mcp-fatal"),
    });

    expect(result.exitCode).toBe(2);
    expect(result.transportFailures?.map((failure) => failure.kind)).toEqual([
      "mcp_auth",
    ]);
  });
});
