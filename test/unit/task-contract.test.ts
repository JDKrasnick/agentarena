import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTaskContract,
  oracleResolves,
  type IssueResolver,
} from "../../src/task/task-contract.js";

describe("task contract", () => {
  it("snapshots a mocked official issue once with hashes and criteria", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-contract-"));
    let calls = 0;
    const resolver: IssueResolver = {
      resolve() {
        calls += 1;
        return Promise.resolve({
          origin: "https://github.com/acme/service/issues/241",
          title: "Slug whitespace normalization",
          body: "- [ ] Collapse every whitespace run to one hyphen.",
          comments: [
            { author: "maintainer", body: "Tabs count as whitespace." },
          ],
        });
      },
    };
    const contract = await buildTaskContract({
      task: "Implement issue #241",
      acceptanceCriteria: [],
      specPaths: [],
      issueReferences: ["241"],
      repositoryRoot: root,
      sourceDirectory: path.join(root, "snapshots"),
      issueResolver: resolver,
      now: new Date("2026-01-02T03:04:05Z"),
    });
    expect(calls).toBe(1);
    expect(contract.acceptanceCriteria).toContain(
      "Collapse every whitespace run to one hyphen.",
    );
    const issue = contract.sources.find((source) => source.kind === "issue");
    expect(issue?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(issue!.snapshotPath, "utf8")).toContain(
      "Tabs count as whitespace",
    );
    expect(
      oracleResolves(contract, {
        expectedBehavior: "x",
        sourceId: issue!.id,
        sourceLocation: "body",
        rationale: "official issue",
      }),
    ).toBe(true);
  });

  it("never invents a missing official issue and retains an explicit task with a warning", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "arena-contract-missing-"),
    );
    const warnings: string[] = [];
    const contract = await buildTaskContract({
      task: "Use the supplied local behavior instead",
      acceptanceCriteria: ["Return a stable result"],
      specPaths: [],
      issueReferences: ["404"],
      repositoryRoot: root,
      sourceDirectory: path.join(root, "snapshots"),
      issueResolver: {
        resolve() {
          return Promise.reject(new Error("not found"));
        },
      },
      warnings,
    });
    expect(contract.sources.map((source) => source.kind)).toEqual([
      "user_task",
    ]);
    expect(warnings[0]).toMatch(/could not be retrieved/);
  });
});
