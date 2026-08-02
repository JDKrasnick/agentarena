import { mkdtemp } from "node:fs/promises";
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
});
