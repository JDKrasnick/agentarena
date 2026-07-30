import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { sha256 } from "../../src/core/ids.js";
import { freezePullRequest } from "../../src/task/pr-fixture.js";
import { createSlugRepository } from "../helpers/repository.js";

describe("pull request fixtures", () => {
  it("freezes both commits and a binary-safe patch with provenance", async () => {
    const repositoryRoot = await createSlugRepository();
    const baseCommit = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
    ).stdout;
    const originalPath = path.join(repositoryRoot, "src", "slug.mjs");
    const renamedPath = path.join(repositoryRoot, "src", "slug-renamed.mjs");
    await rename(originalPath, renamedPath);
    await writeFile(
      renamedPath,
      `${await readFile(renamedPath, "utf8")}\nexport const changed = true;\n`,
    );
    await chmod(renamedPath, 0o755);
    await writeFile(
      path.join(repositoryRoot, "src", "fixture.bin"),
      Buffer.from([0, 255, 1, 254, 2, 253]),
    );
    await execa("git", ["add", "-A"], { cwd: repositoryRoot });
    await execa(
      "git",
      [
        "commit",
        "-m",
        "Generated with Codex\n\nCo-authored-by: Codex <codex@example.test>",
      ],
      { cwd: repositoryRoot },
    );
    const headCommit = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
    ).stdout;
    const fetched: Array<[string, string]> = [];
    const fixture = await freezePullRequest({
      reference: "9",
      repositoryRoot,
      artifactDirectory: path.join(repositoryRoot, ".agent-arena", "fixture"),
      resolver: {
        resolve: () =>
          Promise.resolve({
            origin: "https://github.com/acme/repo/pull/9",
            url: "https://github.com/acme/repo/pull/9",
            repository: "acme/repo",
            number: 9,
            title: "[codex] Tighten slug validation",
            body: "Preserve empty fields.",
            author: "codex-bot",
            comments: [],
            baseBranch: "main",
            baseCommit,
            headBranch: "codex/slug",
            headRepository: "acme/repo",
            headCommit,
            commits: [
              {
                oid: headCommit,
                messageHeadline: "Generated with Codex",
                messageBody: "Co-authored-by: Codex <codex@example.test>",
                authors: ["codex-bot"],
              },
            ],
            linkedIssues: [
              {
                repository: "acme/repo",
                number: 7,
                url: "https://github.com/acme/repo/issues/7",
                title: "Slug normalization",
              },
            ],
          }),
      },
      fetchCommit: (_root, repository, commit) => {
        fetched.push([repository, commit]);
        return Promise.resolve(commit);
      },
      now: () => new Date("2026-07-30T12:00:00.000Z"),
    });
    const patch = await readFile(fixture.patchPath);
    expect(fetched).toEqual([
      ["acme/repo", baseCommit],
      ["acme/repo", headCommit],
    ]);
    const patchText = patch.toString("utf8");
    expect(patchText).toContain("rename from src/slug.mjs");
    expect(patchText).toContain("rename to src/slug-renamed.mjs");
    expect(patchText).toContain("new mode 100755");
    expect(patchText).toContain("GIT binary patch");
    expect(patchText).toContain("export const changed = true");
    expect(fixture.patchSha256).toBe(sha256(patch));
    expect(fixture.metadataSha256).toHaveLength(64);
    expect(fixture.attribution).toMatchObject({
      provider: "codex",
      confidence: "confirmed",
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(path.dirname(fixture.patchPath), "pull-request.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      base: { commit: baseCommit },
      head: { commit: headCommit },
    });
  });
});
