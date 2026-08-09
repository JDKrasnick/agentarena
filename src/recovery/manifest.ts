import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import type { ArtifactStore } from "../artifacts/store.js";
import { calculateCanonicalHash, type RunSpec } from "../contracts/round.js";
import type { FightConfig, PermissionPolicy } from "../core/types.js";
import { resolveGitHubRepositoryIdentity } from "../repo/git.js";
import {
  DependencyManifestSchema,
  DriftApprovalSchema,
  DriftReportSchema,
  type DependencyManifest,
  type DriftApproval,
  type DriftEntry,
  type DriftReport,
} from "./contracts.js";

const DEPENDENCY_FILES = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "pyproject.toml",
  "poetry.lock",
  "requirements.txt",
  "uv.lock",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "Gemfile",
  "Gemfile.lock",
] as const;

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashWithout(value: object, field: string): string {
  const copy = { ...(value as Record<string, unknown>) };
  delete copy[field];
  return calculateCanonicalHash(copy);
}

async function fileHashes(root: string): Promise<Record<string, string>> {
  const entries: Array<[string, string]> = [];
  for (const relative of DEPENDENCY_FILES) {
    try {
      entries.push([
        relative,
        sha256(await readFile(path.join(root, relative))),
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return Object.fromEntries(entries);
}

async function cliVersion(provider: string): Promise<string | undefined> {
  try {
    const result = await execa(provider, ["--version"], {
      reject: false,
      timeout: 5_000,
    });
    const value = `${result.stdout}\n${result.stderr}`.trim();
    return result.exitCode === 0 && value ? value.slice(0, 512) : undefined;
  } catch {
    return undefined;
  }
}

export async function captureDependencyManifest(options: {
  store: ArtifactStore;
  runSpec: RunSpec;
  config: FightConfig;
  permissions: PermissionPolicy;
  display?: string;
  now?: Date;
}): Promise<DependencyManifest> {
  const identity = await resolveGitHubRepositoryIdentity(
    options.config.repositoryRoot,
  );
  const providers = await Promise.all(
    options.config.contestants.map(async (contestant) => {
      const version = await cliVersion(contestant.provider);
      return {
        contestantId: contestant.id,
        provider: contestant.provider,
        ...(contestant.model ? { model: contestant.model } : {}),
        ...(version ? { cliVersion: version } : {}),
      };
    }),
  );
  const frozenSources = Object.fromEntries(
    await Promise.all(
      options.runSpec.task.sources.map(async (source) => {
        const relative = path.relative(
          options.store.runDirectory,
          source.snapshotPath,
        );
        try {
          if (!relative.startsWith("..") && !path.isAbsolute(relative))
            return [
              source.id,
              sha256(await readFile(options.store.resolve(relative))),
            ] as const;
          throw new Error("relocated source");
        } catch {
          const relocated = path.join(
            options.store.runDirectory,
            "sources",
            path.basename(source.snapshotPath),
          );
          try {
            return [source.id, sha256(await readFile(relocated))] as const;
          } catch {
            return [source.id, sha256(`missing:${source.id}`)] as const;
          }
        }
      }),
    ),
  );
  const draft = {
    version: 1 as const,
    runId: options.runSpec.runId,
    capturedAt: (options.now ?? new Date()).toISOString(),
    repository: {
      identity: identity?.repository ?? `local:${options.runSpec.baseCommit}`,
      path: options.config.repositoryRoot,
      baseCommit: options.runSpec.baseCommit,
    },
    frozenSources,
    dependencyFiles: await fileHashes(options.config.repositoryRoot),
    runtime: {
      node: process.version,
      os: `${os.platform()} ${os.release()}`,
      architecture: os.arch(),
      packageManager: process.env.npm_config_user_agent ?? "unknown",
    },
    providers,
    commandsHash: calculateCanonicalHash(options.runSpec.commands),
    capabilitiesHash: calculateCanonicalHash(options.permissions.capabilities),
    credentialsHash: calculateCanonicalHash(
      options.permissions.capabilities.map((capability) => ({
        id: capability.id,
        status: capability.status,
        expiresAt: capability.expiresAt,
      })),
    ),
    servicesHash: calculateCanonicalHash(
      options.config.integrationProfile ?? null,
    ),
    displayHash: calculateCanonicalHash(options.display ?? "console"),
    manifestHash: "0".repeat(64),
  };
  draft.manifestHash = hashWithout(draft, "manifestHash");
  return DependencyManifestSchema.parse(draft);
}

export async function writeDependencyManifest(
  options: Parameters<typeof captureDependencyManifest>[0],
) {
  const manifest = await captureDependencyManifest(options);
  await options.store.writeImmutableJson("runtime-manifest.json", manifest);
  return manifest;
}

export async function readDependencyManifest(
  store: ArtifactStore,
): Promise<DependencyManifest> {
  const manifest = DependencyManifestSchema.parse(
    JSON.parse(await readFile(store.resolve("runtime-manifest.json"), "utf8")),
  );
  if (manifest.manifestHash !== hashWithout(manifest, "manifestHash"))
    throw new Error("Runtime manifest hash mismatch");
  return manifest;
}

export async function createDriftReport(options: {
  original: DependencyManifest;
  current: DependencyManifest;
  repositoryRoot: string;
  now?: Date;
}): Promise<DriftReport> {
  const entries: DriftEntry[] = [];
  const add = (
    code: (typeof entries)[number]["code"],
    severity: (typeof entries)[number]["severity"],
    subject: string,
    before?: string,
    after?: string,
  ) =>
    entries.push({
      code,
      severity,
      subject,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    });
  if (
    options.original.repository.identity !== options.current.repository.identity
  )
    add(
      "repository_mismatch",
      "hard_stop",
      "repository identity",
      options.original.repository.identity,
      options.current.repository.identity,
    );
  try {
    await execa(
      "git",
      ["cat-file", "-e", `${options.original.repository.baseCommit}^{commit}`],
      {
        cwd: options.repositoryRoot,
      },
    );
  } catch {
    add(
      "base_commit_missing",
      "hard_stop",
      "base commit",
      options.original.repository.baseCommit,
    );
  }
  if (options.original.repository.path !== options.current.repository.path)
    add(
      "path_relocated",
      "informational",
      "repository path",
      options.original.repository.path,
      options.current.repository.path,
    );
  const compareHash = (
    before: unknown,
    after: unknown,
    code: (typeof entries)[number]["code"],
    severity: (typeof entries)[number]["severity"],
    subject: string,
  ) => {
    const left = calculateCanonicalHash(before);
    const right = calculateCanonicalHash(after);
    if (left !== right) add(code, severity, subject, left, right);
  };
  compareHash(
    options.original.frozenSources,
    options.current.frozenSources,
    "source_corrupt",
    "hard_stop",
    "frozen sources",
  );
  compareHash(
    options.original.dependencyFiles,
    options.current.dependencyFiles,
    "dependency_changed",
    "approval_required",
    "dependency manifests and lockfiles",
  );
  compareHash(
    options.original.runtime.node,
    options.current.runtime.node,
    "toolchain_changed",
    "approval_required",
    "Node runtime",
  );
  if (
    options.original.runtime.packageManager !==
    options.current.runtime.packageManager
  )
    add(
      "toolchain_changed",
      "approval_required",
      "package manager",
      options.original.runtime.packageManager,
      options.current.runtime.packageManager,
    );
  if (options.original.commandsHash !== options.current.commandsHash)
    add(
      "toolchain_changed",
      "approval_required",
      "run commands",
      options.original.commandsHash,
      options.current.commandsHash,
    );
  if (
    options.original.runtime.os !== options.current.runtime.os ||
    options.original.runtime.architecture !==
      options.current.runtime.architecture
  )
    add(
      "os_changed",
      "approval_required",
      "operating system",
      `${options.original.runtime.os}/${options.original.runtime.architecture}`,
      `${options.current.runtime.os}/${options.current.runtime.architecture}`,
    );
  compareHash(
    options.original.providers,
    options.current.providers,
    "provider_changed",
    "approval_required",
    "provider CLI or model",
  );
  if (options.original.capabilitiesHash !== options.current.capabilitiesHash)
    add(
      "capability_changed",
      "approval_required",
      "capability policy",
      options.original.capabilitiesHash,
      options.current.capabilitiesHash,
    );
  if (options.original.credentialsHash !== options.current.credentialsHash)
    add(
      "credential_changed",
      "approval_required",
      "credential and lease state",
      options.original.credentialsHash,
      options.current.credentialsHash,
    );
  if (options.original.servicesHash !== options.current.servicesHash)
    add(
      "service_changed",
      "approval_required",
      "integration services",
      options.original.servicesHash,
      options.current.servicesHash,
    );
  if (options.original.displayHash !== options.current.displayHash)
    add(
      "display_changed",
      "informational",
      "display capabilities",
      options.original.displayHash,
      options.current.displayHash,
    );
  const draft = {
    version: 1 as const,
    runId: options.original.runId,
    createdAt: (options.now ?? new Date()).toISOString(),
    entries,
    reportHash: "0".repeat(64),
  };
  draft.reportHash = calculateCanonicalHash({
    version: draft.version,
    runId: draft.runId,
    entries: draft.entries,
  });
  return DriftReportSchema.parse(draft);
}

export async function approveDrift(options: {
  store: ArtifactStore;
  report: DriftReport;
  reportHash: string;
  approvedBy: string;
  now?: Date;
}): Promise<DriftApproval> {
  if (options.report.reportHash !== options.reportHash)
    throw new Error("Drift approval is not bound to the current report hash");
  const draft = {
    version: 1 as const,
    runId: options.report.runId,
    reportHash: options.report.reportHash,
    approvedAt: (options.now ?? new Date()).toISOString(),
    approvedBy: options.approvedBy,
    approvalHash: "0".repeat(64),
  };
  draft.approvalHash = hashWithout(draft, "approvalHash");
  const approval = DriftApprovalSchema.parse(draft);
  await options.store.writeImmutableJson(
    `drift/approvals/${approval.approvalHash}.json`,
    approval,
  );
  return approval;
}
