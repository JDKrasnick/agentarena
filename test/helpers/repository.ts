import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";

async function git(repository: string, args: string[]): Promise<void> {
  await execa("git", args, { cwd: repository });
}

export async function createSlugRepository(): Promise<string> {
  const repository = await mkdtemp(
    path.join(os.tmpdir(), "agent-arena-fixture-"),
  );
  await mkdir(path.join(repository, "src"), { recursive: true });
  await mkdir(path.join(repository, "test"), { recursive: true });
  await writeFile(
    path.join(repository, "package.json"),
    `${JSON.stringify(
      {
        name: "mock-slug-service",
        version: "1.0.0",
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(repository, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "mock-slug-service",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "mock-slug-service",
            version: "1.0.0",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(repository, "src", "slug.mjs"),
    `export function slug(value) {\n  return value.trim().toLowerCase().replace(" ", "-");\n}\n`,
  );
  await writeFile(
    path.join(repository, "test", "slug.test.mjs"),
    `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { slug } from "../src/slug.mjs";\ntest("creates a basic slug", () => assert.equal(slug("Hello World"), "hello-world"));\n`,
  );
  await writeFile(
    path.join(repository, ".gitignore"),
    ".agent-arena/\nnode_modules/\n",
  );
  await git(repository, ["init", "-q"]);
  await git(repository, ["config", "user.email", "arena@example.test"]);
  await git(repository, ["config", "user.name", "Agent Arena Test"]);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-qm", "fixture baseline"]);
  return repository;
}
