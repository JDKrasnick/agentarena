import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RuleBasedVerifier } from "../../src/agents/adapter.js";
import { RoundEngine } from "../../src/core/round-engine.js";
import { FightConfigSchema } from "../../src/core/types.js";
import {
  collectFightReconnaissance,
  validateReconnaissance,
} from "../../src/task/task-contract.js";

function config(root: string, overrides: Record<string, unknown> = {}) {
  return FightConfigSchema.parse({
    task: "Fix issue #41",
    agents: ["codex", "claude"],
    attackVerifier: "codex",
    rounds: 3,
    maxAttacksPerRound: 3,
    testCommand: "npm test",
    repositoryRoot: root,
    artifactRoot: path.join(root, ".agent-arena", "runs"),
    permissionMode: "confirm",
    limits: {
      implementationMs: 1,
      reviewMs: 1,
      attackMs: 1,
      verifierMs: 1,
      repairMs: 1,
    },
    ...overrides,
  });
}

describe("bounded pre-permission reconnaissance", () => {
  it("keeps exact task sources and repository evidence in memory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-recon-"));
    await writeFile(
      path.join(root, "package.json"),
      '{"scripts":{"test":"vitest run"}}\n',
    );
    await writeFile(path.join(root, "AGENTS.md"), "Keep it focused.\n");
    const before = await readdir(root);
    const issueResolver = {
      resolve: vi.fn().mockResolvedValue({
        origin: "https://github.com/acme/repo/issues/41",
        repository: "acme/repo",
        number: 41,
        url: "https://github.com/acme/repo/issues/41",
        title: "Browser behavior",
        body: "Preserve visible focus.",
        comments: [],
      }),
    };

    const snapshot = await collectFightReconnaissance(
      config(root, { issueReferences: ["41"] }),
      { issueResolver, now: new Date("2026-08-18T12:00:00Z") },
    );

    expect(issueResolver.resolve).toHaveBeenCalledOnce();
    expect(snapshot.sources.map((source) => source.origin)).toEqual([
      "command-line task",
      "https://github.com/acme/repo/issues/41",
      "AGENTS.md",
    ]);
    expect(snapshot.repositoryEvidence).toMatchObject([
      { path: "package.json" },
    ]);
    expect(snapshot.inputHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readdir(root)).toEqual(before);
    expect(() => validateReconnaissance(snapshot)).not.toThrow();
  });

  it("stops when an explicit source cannot be retrieved", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-recon-source-"));
    await expect(
      collectFightReconnaissance(config(root, { issueReferences: ["404"] }), {
        issueResolver: {
          resolve: vi.fn().mockRejectedValue(new Error("not found")),
        },
      }),
    ).rejects.toThrow("Explicit issue 404 could not be retrieved");
    expect(await readdir(root)).toEqual([]);
  });

  it("does not read an explicit specification outside the repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-recon-spec-"));
    await expect(
      collectFightReconnaissance(
        config(root, { specPaths: ["../outside.md"] }),
      ),
    ).rejects.toThrow("Specification path escapes the repository");
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects a specification symlink that resolves outside the repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-recon-link-"));
    const outside = path.join(
      os.tmpdir(),
      `arena-outside-${String(Date.now())}.md`,
    );
    await writeFile(outside, "outside\n");
    await symlink(outside, path.join(root, "spec.md"));
    await expect(
      collectFightReconnaissance(config(root, { specPaths: ["spec.md"] })),
    ).rejects.toThrow("symbolic link");
  });

  it("rejects a specification that is not a regular file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-recon-special-"));
    await mkdir(path.join(root, "spec.md"));

    await expect(
      collectFightReconnaissance(config(root, { specPaths: ["spec.md"] })),
    ).rejects.toThrow("not a regular file");
  });

  it.each(["package.json", "package-lock.json"])(
    "rejects an outside-repository %s symlink",
    async (evidencePath) => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "arena-recon-evidence-link-"),
      );
      const outside = path.join(
        os.tmpdir(),
        `arena-evidence-outside-${String(Date.now())}.json`,
      );
      await writeFile(outside, '{"secret":"outside"}\n');
      await symlink(outside, path.join(root, evidencePath));

      await expect(collectFightReconnaissance(config(root))).rejects.toThrow(
        "Repository reconnaissance path escapes the repository through a symbolic link",
      );
    },
  );

  it("caps text evidence per file and hashes lockfiles without retaining them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-recon-bounds-"));
    const lockContent = `${"lock-entry\n".repeat(40_000)}`;
    await writeFile(path.join(root, "package-lock.json"), lockContent);
    const snapshot = await collectFightReconnaissance(config(root));
    expect(snapshot.repositoryEvidence).toMatchObject([
      {
        path: "package-lock.json",
        content: "",
        byteLength: Buffer.byteLength(lockContent),
        contentOmitted: "lockfile_hash_only",
      },
    ]);
    expect(snapshot.repositoryEvidence[0]?.contentHash).toMatch(
      /^[a-f0-9]{64}$/u,
    );

    await writeFile(
      path.join(root, "package.json"),
      "x".repeat(256 * 1024 + 1),
    );
    await expect(collectFightReconnaissance(config(root))).rejects.toThrow(
      "package.json exceeds 262144 bytes",
    );
  });

  it("retains Python manifests and stream-hashes Python lockfiles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-recon-python-"));
    const manifest = '[project]\nname = "arena-example"\n';
    const lockfiles = ["Pipfile.lock", "poetry.lock", "uv.lock", "pdm.lock"];
    await writeFile(path.join(root, "pyproject.toml"), manifest);
    for (const lockfile of lockfiles)
      await writeFile(
        path.join(root, lockfile),
        `${lockfile}\n`.repeat(30_000),
      );

    const snapshot = await collectFightReconnaissance(config(root));

    const retainedManifest = snapshot.repositoryEvidence.find(
      (evidence) => evidence.path === "pyproject.toml",
    );
    expect(retainedManifest).toMatchObject({
      path: "pyproject.toml",
      content: manifest,
      byteLength: Buffer.byteLength(manifest),
    });
    expect(retainedManifest?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    for (const lockfile of lockfiles) {
      const retainedLockfile = snapshot.repositoryEvidence.find(
        (evidence) => evidence.path === lockfile,
      );
      expect(retainedLockfile).toMatchObject({
        path: lockfile,
        content: "",
        byteLength: Buffer.byteLength(`${lockfile}\n`.repeat(30_000)),
        contentOmitted: "lockfile_hash_only",
      });
      expect(retainedLockfile?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("applies per-file and aggregate bounds to every retained text source", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "arena-recon-source-bounds-"),
    );
    await writeFile(path.join(root, "spec.md"), "x".repeat(256 * 1024 + 1));
    await expect(
      collectFightReconnaissance(config(root, { specPaths: ["spec.md"] })),
    ).rejects.toThrow("specification spec.md exceeds 262144 bytes");

    const issueBody = "x".repeat(240 * 1024);
    await expect(
      collectFightReconnaissance(
        config(root, {
          specPaths: [],
          issueReferences: Array.from({ length: 9 }, (_, index) =>
            String(index + 1),
          ),
        }),
        {
          issueResolver: {
            resolve: vi.fn((reference: string) =>
              Promise.resolve({
                origin: `https://github.com/acme/repo/issues/${reference}`,
                title: "Bounded source",
                body: issueBody,
                comments: [],
              }),
            ),
          },
        },
      ),
    ).rejects.toThrow("Reconnaissance text exceeds 2097152 bytes");
  });

  it("resolves permission policy before Git, artifacts, worktrees, or agents", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-recon-gate-"));
    const adapterFactory = vi.fn(() => {
      throw new Error("agent must not start before approval");
    });
    const engine = new RoundEngine({
      adapters: {},
      adapterFactory,
      verifier: new RuleBasedVerifier("codex"),
    });

    await expect(engine.fight(config(root))).rejects.toThrow(
      "Required capabilities were not approved",
    );
    expect(adapterFactory).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it("persists the approved reconnaissance and policy before Git preflight", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-recon-audit-"));
    const engine = new RoundEngine({
      adapters: {},
      verifier: new RuleBasedVerifier("codex"),
    });

    await expect(
      engine.fight(config(root, { nonInteractiveApproval: true })),
    ).rejects.toThrow("git rev-parse");

    const artifactRoot = path.join(root, ".agent-arena", "runs");
    const runDirectories = await readdir(artifactRoot);
    expect(runDirectories).toHaveLength(1);
    const runDirectory = path.join(artifactRoot, runDirectories[0]!);
    const reconnaissance = JSON.parse(
      await readFile(path.join(runDirectory, "reconnaissance.json"), "utf8"),
    ) as { inputHash?: string };
    const permissions = JSON.parse(
      await readFile(path.join(runDirectory, "permissions.json"), "utf8"),
    ) as { capabilities?: unknown[] };
    expect(reconnaissance.inputHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(permissions.capabilities).not.toHaveLength(0);
  });

  it("rejects drift in a supplied reconnaissance snapshot before preflight", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arena-recon-drift-"));
    const fightConfig = config(root);
    const snapshot = await collectFightReconnaissance(fightConfig);
    snapshot.sources[0]!.content = "different task\n";

    const engine = new RoundEngine({
      adapters: {},
      verifier: new RuleBasedVerifier("codex"),
    });
    await expect(
      engine.fight(fightConfig, undefined, snapshot),
    ).rejects.toThrow("input hash does not match");
    expect(await readdir(root)).toEqual([]);
  });
});
