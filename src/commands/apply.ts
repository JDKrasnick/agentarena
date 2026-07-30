import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { AgentIdSchema, RunStateSchema, type AgentId } from "../core/types.js";
import {
  assertCleanRepository,
  resolveCommit,
  resolveRepositoryRoot,
} from "../repo/git.js";

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await execa("git", args, { cwd, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
}

export async function applyResult(options: {
  runId: string;
  agent: AgentId;
  repositoryRoot?: string;
  forceDirty?: boolean;
}): Promise<string> {
  const repositoryRoot = await resolveRepositoryRoot(
    options.repositoryRoot ?? process.cwd(),
  );
  if (!options.forceDirty) await assertCleanRepository(repositoryRoot);
  const resultPath = path.join(
    repositoryRoot,
    ".agent-arena",
    "runs",
    options.runId,
    "result.json",
  );
  const state = RunStateSchema.parse(
    JSON.parse(await readFile(resultPath, "utf8")),
  );
  const agent = AgentIdSchema.parse(options.agent);
  if (state.config.repositoryRoot !== repositoryRoot) {
    throw new Error("Run belongs to a different repository");
  }
  const currentCommit = await resolveCommit(repositoryRoot);
  if (currentCommit !== state.config.baseCommit) {
    throw new Error(
      `Current HEAD ${currentCommit} does not match run base ${state.config.baseCommit ?? "unknown"}`,
    );
  }
  const patchPath = state.contestants[agent]?.finalPatchPath;
  if (!patchPath) throw new Error(`Run has no final patch for ${agent}`);
  const expectedRoot = await realpath(
    path.resolve(repositoryRoot, ".agent-arena", "runs", options.runId),
  );
  const resolvedPatch = await realpath(path.resolve(patchPath));
  if (!resolvedPatch.startsWith(`${expectedRoot}${path.sep}`)) {
    throw new Error("Result patch path is outside the trusted run directory");
  }
  await git(repositoryRoot, ["apply", "--check", resolvedPatch]);
  await git(repositoryRoot, ["apply", resolvedPatch]);
  return `Applied ${agent}'s patch. Run: ${state.config.testCommand}`;
}
