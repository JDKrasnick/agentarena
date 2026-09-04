import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const WorktreeLifecycleStateSchema = z.enum([
  "active",
  "retained",
  "removed",
  "cleanup_failure",
]);

export const WorktreeManifestSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  repository: z.object({
    root: z.string().min(1),
    gitCommonDirectory: z.string().min(1),
  }),
  retentionEnabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  executions: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.enum(["initial", "resume", "provider_recovery"]),
      temporaryRoot: z.string().min(1),
      startedAt: z.string().datetime(),
      finalizedAt: z.string().datetime().optional(),
    }),
  ),
  worktrees: z.array(
    z.object({
      id: z.string().min(1),
      executionSessionId: z.string().min(1),
      logicalName: z.string().min(1),
      purpose: z.string().min(1),
      contestantId: z.enum(["a", "b"]).optional(),
      path: z.string().min(1),
      state: WorktreeLifecycleStateSchema,
      createdAt: z.string().datetime(),
      retainedAt: z.string().datetime().optional(),
      removedAt: z.string().datetime().optional(),
      cleanupFailedAt: z.string().datetime().optional(),
      cleanupError: z.string().min(1).optional(),
    }),
  ),
});

export type WorktreeManifest = z.infer<typeof WorktreeManifestSchema>;
export type WorktreeManifestEntry = WorktreeManifest["worktrees"][number];

export async function readWorktreeManifest(
  manifestPath: string,
): Promise<WorktreeManifest> {
  return WorktreeManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
}

export async function writeWorktreeManifest(
  manifestPath: string,
  manifest: WorktreeManifest,
): Promise<void> {
  const validated = WorktreeManifestSchema.parse(manifest);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const temporary = path.join(
    path.dirname(manifestPath),
    "." + path.basename(manifestPath) + "-" + randomUUID() + ".tmp",
  );
  await writeFile(temporary, JSON.stringify(validated, null, 2) + "\n", "utf8");
  try {
    await rename(temporary, manifestPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function retainedWorktreePathsSync(
  manifestPath: string | undefined,
): string[] {
  if (!manifestPath) return [];
  try {
    const manifest = WorktreeManifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, "utf8")),
    );
    return manifest.worktrees
      .filter((entry) => entry.state === "retained" && existsSync(entry.path))
      .map((entry) => entry.path);
  } catch {
    return [];
  }
}
