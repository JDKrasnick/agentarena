import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitHubCliDeliveryAdapter } from "../../src/delivery/github.js";

describe("GitHub CLI delivery adapter", () => {
  it("reads normalized required checks through the gh subprocess boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-gh-adapter-"));
    const bin = path.join(root, "bin");
    const logPath = path.join(root, "gh.log");
    await mkdir(bin, { recursive: true });
    const executable = path.join(bin, "gh");
    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "pr" && args[1] === "view" && args.includes("isDraft")) {
  process.stdout.write(JSON.stringify({ isDraft: true }));
} else if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify({
    url: "https://github.com/acme/repo/pull/9",
    number: 9,
    state: "OPEN",
    mergedAt: null,
    headRefOid: "head",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [],
    reviewDecision: "APPROVED",
    reviews: []
  }));
} else if (args[0] === "pr" && args[1] === "checks") {
  if (process.env.FAKE_GH_NO_CHECKS === "1") {
    process.stderr.write("no checks reported on the validation branch");
    process.exit(1);
  }
  const pending = process.env.FAKE_GH_PENDING === "1";
  process.stdout.write(JSON.stringify([
    {
      name: "build",
      state: pending ? "IN_PROGRESS" : "SUCCESS",
      bucket: pending ? "pending" : "pass"
    }
  ]));
  if (pending) process.exitCode = 8;
} else if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write(JSON.stringify({
    mergeCommitAllowed: true,
    squashMergeAllowed: true,
    rebaseMergeAllowed: true
  }));
} else if (args[0] === "pr" && ["ready", "merge"].includes(args[1])) {
  process.stdout.write("");
} else {
  process.stderr.write("unexpected gh invocation: " + args.join(" "));
  process.exitCode = 2;
}
`,
    );
    await chmod(executable, 0o755);
    const previousPath = process.env.PATH;
    const previousLog = process.env.FAKE_GH_LOG;
    const previousPending = process.env.FAKE_GH_PENDING;
    const previousNoChecks = process.env.FAKE_GH_NO_CHECKS;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    process.env.FAKE_GH_LOG = logPath;
    try {
      const state = await new GitHubCliDeliveryAdapter(root).getPullRequest(
        "acme/repo",
        9,
      );
      expect(state).toMatchObject({
        state: "open",
        checks: "success",
        reviews: "approved",
        headSha: "head",
      });
      process.env.FAKE_GH_PENDING = "1";
      await expect(
        new GitHubCliDeliveryAdapter(root).getPullRequest("acme/repo", 9),
      ).resolves.toMatchObject({ checks: "pending" });
      delete process.env.FAKE_GH_PENDING;
      process.env.FAKE_GH_NO_CHECKS = "1";
      await expect(
        new GitHubCliDeliveryAdapter(root).getPullRequest("acme/repo", 9),
      ).resolves.toMatchObject({ checks: "pending" });
      const calls = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(calls).toHaveLength(6);
      expect(calls[1]).toContain("--required");
      delete process.env.FAKE_GH_NO_CHECKS;
      await new GitHubCliDeliveryAdapter(root).requestMerge(
        "acme/repo",
        9,
        "head",
      );
      const mergeCalls = (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const readyIndex = mergeCalls.findIndex(
        (call) => call[0] === "pr" && call[1] === "ready",
      );
      const mergeIndex = mergeCalls.findIndex(
        (call) => call[0] === "pr" && call[1] === "merge",
      );
      expect(readyIndex).toBeGreaterThan(-1);
      expect(mergeIndex).toBeGreaterThan(readyIndex);
      expect(mergeCalls[mergeIndex]).toContain("--auto");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousLog === undefined) delete process.env.FAKE_GH_LOG;
      else process.env.FAKE_GH_LOG = previousLog;
      if (previousPending === undefined) delete process.env.FAKE_GH_PENDING;
      else process.env.FAKE_GH_PENDING = previousPending;
      if (previousNoChecks === undefined) delete process.env.FAKE_GH_NO_CHECKS;
      else process.env.FAKE_GH_NO_CHECKS = previousNoChecks;
    }
  });
});
