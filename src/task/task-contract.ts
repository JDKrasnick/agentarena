import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { mkdir, open, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { sha256, stableId } from "../core/ids.js";
import {
  FightConfigSchema,
  TaskContractSchema,
  type FightConfig,
  type OracleCitation,
  type PermissionPolicy,
  type TaskContract,
  type TaskSource,
  type TaskReference,
} from "../core/types.js";
import { resolveEffortProfile } from "../effort/policy.js";
import { RunSpecSchema, type RunSpec } from "../contracts/round.js";
import {
  discoverInstructions,
  INSTRUCTION_PATHS,
} from "../repo/instructions.js";
import { planBrowserValidation } from "../browser/planner.js";
import { resolveBootstrapContract } from "./bootstrap.js";

export interface ResolvedIssue {
  origin: string;
  title: string;
  body: string;
  comments: Array<{ author: string; body: string }>;
  repository?: string;
  number?: number;
  url?: string;
  baseBranch?: string;
}

export interface TaskSourceResolver<T> {
  resolve(reference: string, repositoryRoot: string): Promise<T>;
}

export type IssueResolver = TaskSourceResolver<ResolvedIssue>;

export interface ResolvedPullRequest extends ResolvedIssue {
  repository: string;
  number: number;
  url: string;
  baseBranch: string;
  headBranch: string;
  headRepository: string;
  headCommit: string;
  baseCommit?: string;
  author?: string;
  commits?: Array<{
    oid: string;
    messageHeadline: string;
    messageBody?: string;
    authors: string[];
  }>;
  linkedIssues?: Array<{
    repository?: string;
    number: number;
    url?: string;
    title?: string;
  }>;
}

export type PullRequestResolver = TaskSourceResolver<ResolvedPullRequest>;

function githubIdentity(url: string): {
  repository?: string;
  number?: number;
} {
  const match =
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/u.exec(url);
  return match?.[1] && match[2]
    ? { repository: match[1], number: Number(match[2]) }
    : {};
}

export interface ResolvedLocalSpec {
  origin: string;
  content: string;
}

export type LocalSpecResolver = TaskSourceResolver<ResolvedLocalSpec>;

export class FileLocalSpecResolver implements LocalSpecResolver {
  async resolve(
    reference: string,
    repositoryRoot: string,
  ): Promise<ResolvedLocalSpec> {
    const root = await realpath(repositoryRoot);
    const resolved = path.resolve(root, reference);
    const relative = path.relative(root, resolved);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error(
        `Specification path escapes the repository: ${reference}`,
      );
    const canonical = await realpath(resolved);
    const canonicalRelative = path.relative(root, canonical);
    if (
      canonicalRelative === ".." ||
      canonicalRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(canonicalRelative)
    )
      throw new Error(
        `Specification path escapes the repository through a symbolic link: ${reference}`,
      );
    return {
      origin: reference,
      content: await readBoundedTextFile(
        canonical,
        `specification ${reference}`,
      ),
    };
  }
}

const GH_READ_OPERATIONS = new Set(["issue view", "pr view", "repo view"]);

async function runGhRead(args: string[], repositoryRoot: string) {
  if (!GH_READ_OPERATIONS.has(args.slice(0, 2).join(" ")))
    throw new Error(
      `Pre-permission gh operation is not read-only: ${args.join(" ")}`,
    );
  return execa("gh", args, { cwd: repositoryRoot, reject: false });
}

export class GitHubIssueResolver implements IssueResolver {
  async resolve(
    reference: string,
    repositoryRoot: string,
  ): Promise<ResolvedIssue> {
    const result = await runGhRead(
      ["issue", "view", reference, "--json", "title,body,comments,url"],
      repositoryRoot,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Unable to resolve issue ${reference}: ${result.stderr || result.stdout}`,
      );
    }
    const value = JSON.parse(result.stdout) as {
      title: string;
      body: string;
      url: string;
      comments: Array<{ author: { login: string }; body: string }>;
    };
    const identity = githubIdentity(value.url);
    let baseBranch: string | undefined;
    if (identity.repository) {
      const repository = await runGhRead(
        ["repo", "view", identity.repository, "--json", "defaultBranchRef"],
        repositoryRoot,
      );
      if (repository.exitCode === 0) {
        const metadata = JSON.parse(repository.stdout) as {
          defaultBranchRef?: { name?: string };
        };
        baseBranch = metadata.defaultBranchRef?.name;
      }
    }
    return {
      origin: value.url,
      url: value.url,
      ...identity,
      ...(baseBranch ? { baseBranch } : {}),
      title: value.title,
      body: value.body,
      comments: value.comments.map((comment) => ({
        author: comment.author.login,
        body: comment.body,
      })),
    };
  }
}

export class GitHubPullRequestResolver implements PullRequestResolver {
  async resolve(
    reference: string,
    repositoryRoot: string,
  ): Promise<ResolvedPullRequest> {
    const result = await runGhRead(
      [
        "pr",
        "view",
        reference,
        "--json",
        "title,body,comments,url,number,author,baseRefName,baseRefOid,headRefName,headRepository,headRefOid,commits,closingIssuesReferences",
      ],
      repositoryRoot,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Unable to resolve pull request ${reference}: ${result.stderr || result.stdout}`,
      );
    }
    const value = JSON.parse(result.stdout) as {
      title: string;
      body: string;
      url: string;
      number: number;
      baseRefName: string;
      headRefName: string;
      headRefOid: string;
      baseRefOid: string;
      headRepository: { nameWithOwner: string };
      author?: { login?: string };
      commits?: Array<{
        oid: string;
        messageHeadline: string;
        messageBody?: string;
        authors?: Array<{ login?: string; name?: string }>;
      }>;
      closingIssuesReferences?: Array<{
        repository?: { nameWithOwner?: string };
        number: number;
        url?: string;
        title?: string;
      }>;
      comments: Array<{ author: { login: string }; body: string }>;
    };
    const identity = githubIdentity(value.url);
    if (!identity.repository)
      throw new Error(
        `Pull request URL is not a stable GitHub URL: ${value.url}`,
      );
    return {
      origin: value.url,
      url: value.url,
      repository: identity.repository,
      number: value.number,
      title: value.title,
      body: value.body,
      comments: value.comments.map((comment) => ({
        author: comment.author.login,
        body: comment.body,
      })),
      baseBranch: value.baseRefName,
      headBranch: value.headRefName,
      headRepository: value.headRepository.nameWithOwner,
      headCommit: value.headRefOid,
      baseCommit: value.baseRefOid,
      ...(value.author?.login ? { author: value.author.login } : {}),
      commits: (value.commits ?? []).map((commit) => ({
        oid: commit.oid,
        messageHeadline: commit.messageHeadline,
        ...(commit.messageBody ? { messageBody: commit.messageBody } : {}),
        authors: (commit.authors ?? []).flatMap((author) =>
          (author.login ?? author.name)
            ? [author.login ?? author.name ?? ""]
            : [],
        ),
      })),
      linkedIssues: (value.closingIssuesReferences ?? []).map((issue) => ({
        ...(issue.repository?.nameWithOwner
          ? { repository: issue.repository.nameWithOwner }
          : {}),
        number: issue.number,
        ...(issue.url ? { url: issue.url } : {}),
        ...(issue.title ? { title: issue.title } : {}),
      })),
    };
  }
}

interface BuildTaskContractOptions {
  task: string;
  acceptanceCriteria: string[];
  specPaths: string[];
  issueReferences: string[];
  pullRequestReferences?: string[];
  taskReferences?: TaskReference[];
  repositoryRoot: string;
  sourceDirectory: string;
  issueResolver?: IssueResolver;
  pullRequestResolver?: PullRequestResolver;
  localSpecResolver?: LocalSpecResolver;
  now?: Date;
  warnings?: string[];
  reconnaissance?: ReconnaissanceSnapshot;
}

export interface ReconnaissanceSource extends Omit<TaskSource, "snapshotPath"> {
  content: string;
}

export interface RepositoryEvidence {
  path: string;
  content: string;
  contentHash: string;
  byteLength: number;
  contentOmitted?: "lockfile_hash_only";
}

export interface ReconnaissanceRequest {
  repositoryRoot: string;
  specPaths: string[];
  issueReferences: string[];
  pullRequestReferences: string[];
  taskReferences: TaskReference[];
}

export interface ReconnaissanceSnapshot {
  version: 1;
  task: string;
  acceptanceCriteria: string[];
  request: ReconnaissanceRequest;
  capturedAt: string;
  sources: ReconnaissanceSource[];
  repositoryEvidence: RepositoryEvidence[];
  resolvedPullRequests: Record<string, ResolvedPullRequest>;
  inputHash: string;
}

export function validateReconnaissance(
  snapshot: ReconnaissanceSnapshot,
  config?: Pick<
    FightConfig,
    | "task"
    | "acceptanceCriteria"
    | "repositoryRoot"
    | "specPaths"
    | "issueReferences"
    | "pullRequestReferences"
    | "taskReferences"
  >,
): ReconnaissanceSnapshot {
  const { inputHash, ...input } = snapshot;
  if (sha256(canonicalJson(input)) !== inputHash)
    throw new Error("Reconnaissance input hash does not match its contents");
  if (config) {
    const expectedRequest = reconnaissanceRequest(config);
    if (
      snapshot.task !== config.task ||
      canonicalJson(snapshot.acceptanceCriteria) !==
        canonicalJson(config.acceptanceCriteria) ||
      canonicalJson(snapshot.request) !== canonicalJson(expectedRequest)
    )
      throw new Error("Reconnaissance does not match the approved fight task");
  }
  const budget = new ReconnaissanceTextBudget();
  for (const [index, criterion] of snapshot.acceptanceCriteria.entries())
    budget.include(`acceptance criterion ${String(index + 1)}`, criterion);
  for (const source of snapshot.sources) {
    if (sha256(source.content) !== source.contentHash)
      throw new Error(`Reconnaissance source hash drifted: ${source.origin}`);
    budget.include(source.origin, source.content);
  }
  for (const pullRequest of Object.values(snapshot.resolvedPullRequests))
    budget.includeSerialized(pullRequest);
  for (const evidence of snapshot.repositoryEvidence) {
    if (
      evidence.contentOmitted === "lockfile_hash_only" &&
      evidence.content !== ""
    )
      throw new Error(
        `Reconnaissance lockfile unexpectedly retained content: ${evidence.path}`,
      );
    if (
      evidence.contentOmitted !== "lockfile_hash_only" &&
      sha256(evidence.content) !== evidence.contentHash
    )
      throw new Error(`Reconnaissance evidence hash drifted: ${evidence.path}`);
    if (evidence.contentOmitted !== "lockfile_hash_only") {
      const byteLength = budget.include(evidence.path, evidence.content);
      if (byteLength !== evidence.byteLength)
        throw new Error(
          `Reconnaissance evidence byte length drifted: ${evidence.path}`,
        );
    }
  }
  return snapshot;
}

export type CollectReconnaissanceOptions = Omit<
  BuildTaskContractOptions,
  "sourceDirectory" | "reconnaissance"
>;

export async function collectFightReconnaissance(
  configValue: FightConfig,
  options: Pick<
    CollectReconnaissanceOptions,
    "issueResolver" | "pullRequestResolver" | "localSpecResolver" | "now"
  > = {},
): Promise<ReconnaissanceSnapshot> {
  const config = FightConfigSchema.parse(configValue);
  return collectReconnaissance({
    task: config.task,
    acceptanceCriteria: config.acceptanceCriteria,
    specPaths: config.specPaths,
    issueReferences: config.issueReferences,
    pullRequestReferences: config.pullRequestReferences,
    taskReferences: config.taskReferences,
    repositoryRoot: config.repositoryRoot,
    ...options,
  });
}

const RECONNAISSANCE_PATHS = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "deno.json",
  "deno.jsonc",
  "pyproject.toml",
  "requirements.txt",
  "requirements-dev.txt",
  "setup.py",
  "setup.cfg",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
  "pdm.lock",
  "tox.ini",
  "pytest.ini",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "Gemfile",
  "Gemfile.lock",
  "playwright.config.ts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.cjs",
  "cypress.config.ts",
  "cypress.config.js",
  "vite.config.ts",
  "vite.config.js",
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  "angular.json",
  "src/routes.ts",
  "src/router.ts",
  "app/routes.ts",
] as const;

const LOCKFILE_PATHS = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
  "pdm.lock",
  "go.sum",
  "Cargo.lock",
  "Gemfile.lock",
]);
const MAX_RECONNAISSANCE_FILE_BYTES = 256 * 1024;
const MAX_RECONNAISSANCE_TEXT_BYTES = 2 * 1024 * 1024;

async function readBoundedTextFile(
  filePath: string,
  label: string,
): Promise<string> {
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const file = await handle.stat();
    if (!file.isFile())
      throw new Error(`Reconnaissance path is not a regular file: ${label}`);
    if (file.size > MAX_RECONNAISSANCE_FILE_BYTES)
      throw new Error(
        `Reconnaissance text ${label} exceeds ${String(MAX_RECONNAISSANCE_FILE_BYTES)} bytes`,
      );

    const chunks: Buffer[] = [];
    let byteLength = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = Buffer.from(chunk as Uint8Array);
      byteLength += bytes.length;
      if (byteLength > MAX_RECONNAISSANCE_FILE_BYTES)
        throw new Error(
          `Reconnaissance text ${label} exceeds ${String(MAX_RECONNAISSANCE_FILE_BYTES)} bytes`,
        );
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, byteLength).toString("utf8");
  } finally {
    await handle.close();
  }
}

function reconnaissanceRequest(
  value: Pick<
    CollectReconnaissanceOptions,
    | "repositoryRoot"
    | "specPaths"
    | "issueReferences"
    | "pullRequestReferences"
    | "taskReferences"
  >,
): ReconnaissanceRequest {
  return {
    repositoryRoot: realpathSync(value.repositoryRoot),
    specPaths: [...value.specPaths],
    issueReferences: [...value.issueReferences],
    pullRequestReferences: [...(value.pullRequestReferences ?? [])],
    taskReferences: [...(value.taskReferences ?? [])],
  };
}

class ReconnaissanceTextBudget {
  private totalBytes = 0;

  include(label: string, content: string): number {
    const byteLength = Buffer.byteLength(content);
    if (byteLength > MAX_RECONNAISSANCE_FILE_BYTES)
      throw new Error(
        `Repository reconnaissance source ${label} exceeds ${String(MAX_RECONNAISSANCE_FILE_BYTES)} bytes`,
      );
    this.retainBytes(byteLength);
    return byteLength;
  }

  includeSerialized(value: unknown): number {
    const byteLength = Buffer.byteLength(canonicalJson(value));
    this.retainBytes(byteLength);
    return byteLength;
  }

  private retainBytes(byteLength: number): void {
    this.totalBytes += byteLength;
    if (this.totalBytes > MAX_RECONNAISSANCE_TEXT_BYTES)
      throw new Error(
        `Repository reconnaissance exceeds ${String(MAX_RECONNAISSANCE_TEXT_BYTES)} bytes`,
      );
  }
}

function assertContainedPath(
  canonicalRoot: string,
  canonicalPath: string,
  displayPath: string,
): void {
  const relative = path.relative(canonicalRoot, canonicalPath);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error(
      `Repository reconnaissance path escapes the repository through a symbolic link: ${displayPath}`,
    );
}

async function hashFile(filePath: string): Promise<{
  contentHash: string;
  byteLength: number;
}> {
  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const file = await handle.stat();
    if (!file.isFile())
      throw new Error(
        `Repository reconnaissance path is not a regular file: ${filePath}`,
      );
    const digest = createHash("sha256");
    let byteLength = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = Buffer.from(chunk as Uint8Array);
      digest.update(bytes);
      byteLength += bytes.length;
    }
    return { contentHash: digest.digest("hex"), byteLength };
  } finally {
    await handle.close();
  }
}

async function collectRepositoryEvidence(
  repositoryRoot: string,
  budget: ReconnaissanceTextBudget,
): Promise<RepositoryEvidence[]> {
  const evidence: RepositoryEvidence[] = [];
  const canonicalRoot = await realpath(repositoryRoot);
  for (const relativePath of RECONNAISSANCE_PATHS) {
    try {
      const evidencePath = path.join(repositoryRoot, relativePath);
      const canonicalPath = await realpath(evidencePath);
      assertContainedPath(canonicalRoot, canonicalPath, relativePath);
      if (LOCKFILE_PATHS.has(relativePath)) {
        const hashed = await hashFile(canonicalPath);
        evidence.push({
          path: relativePath,
          content: "",
          ...hashed,
          contentOmitted: "lockfile_hash_only",
        });
        continue;
      }
      const content = await readBoundedTextFile(canonicalPath, relativePath);
      const byteLength = budget.include(relativePath, content);
      evidence.push({
        path: relativePath,
        content,
        contentHash: sha256(content),
        byteLength,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return evidence;
}

export async function assertReconnaissanceRepositoryInputsCurrent(
  snapshot: ReconnaissanceSnapshot,
): Promise<void> {
  const current = await collectRepositoryEvidence(
    snapshot.request.repositoryRoot,
    new ReconnaissanceTextBudget(),
  );
  if (canonicalJson(current) !== canonicalJson(snapshot.repositoryEvidence))
    throw new Error(
      "Repository reconnaissance evidence changed after permission planning; rerun the fight to approve a fresh capability plan",
    );

  const currentInstructions = new Map(
    (await discoverInstructions(snapshot.request.repositoryRoot)).map(
      (instruction) => [instruction.path, instruction.content],
    ),
  );
  for (const instructionPath of INSTRUCTION_PATHS) {
    const approved = snapshot.sources.find(
      (source) =>
        source.id === stableId("instructions", instructionPath) &&
        source.origin === instructionPath,
    );
    const content = currentInstructions.get(instructionPath);
    if (
      (approved === undefined) !== (content === undefined) ||
      (approved &&
        content !== undefined &&
        approved.contentHash !== sha256(content))
    )
      throw new Error(
        "Repository instructions changed after permission planning; rerun the fight to approve a fresh capability plan",
      );
  }
}

export async function collectReconnaissance(
  options: CollectReconnaissanceOptions,
): Promise<ReconnaissanceSnapshot> {
  const capturedAt = (options.now ?? new Date()).toISOString();
  const budget = new ReconnaissanceTextBudget();
  const issueResolver = options.issueResolver ?? new GitHubIssueResolver();
  const pullRequestResolver =
    options.pullRequestResolver ?? new GitHubPullRequestResolver();
  const localSpecResolver =
    options.localSpecResolver ?? new FileLocalSpecResolver();
  const taskContent = `${options.task}\n`;
  budget.include("command-line task", taskContent);
  for (const [index, criterion] of options.acceptanceCriteria.entries())
    budget.include(`acceptance criterion ${String(index + 1)}`, criterion);
  const sources: ReconnaissanceSource[] = [
    {
      id: "task-user",
      kind: "user_task",
      origin: "command-line task",
      retrievedAt: capturedAt,
      visibility: "shared",
      content: taskContent,
      contentHash: sha256(taskContent),
    },
  ];
  const resolvedPullRequests: Record<string, ResolvedPullRequest> = {};

  for (const reference of options.issueReferences) {
    let issue: ResolvedIssue;
    try {
      issue = await issueResolver.resolve(reference, options.repositoryRoot);
    } catch (error) {
      throw new Error(
        `Explicit issue ${reference} could not be retrieved: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const content = [
      `# ${issue.title}`,
      "",
      issue.body,
      ...issue.comments.flatMap((comment) => [
        "",
        `## Comment by ${comment.author}`,
        "",
        comment.body,
      ]),
      "",
    ].join("\n");
    budget.include(`issue ${reference}`, content);
    sources.push({
      id: stableId("issue", issue.origin),
      kind: "issue",
      origin: issue.origin,
      retrievedAt: capturedAt,
      visibility: "shared",
      content,
      contentHash: sha256(content),
      ...(options.taskReferences?.find(
        (candidate) =>
          candidate.kind === "github_issue" &&
          candidate.reference === reference,
      )?.primary
        ? { primary: true }
        : {}),
      ...(issue.repository && issue.number && issue.url
        ? {
            github: {
              repository: issue.repository,
              number: issue.number,
              url: issue.url,
              ...(issue.baseBranch ? { baseBranch: issue.baseBranch } : {}),
            },
          }
        : {}),
    });
  }

  for (const reference of options.pullRequestReferences ?? []) {
    let pullRequest: ResolvedPullRequest;
    try {
      pullRequest = await pullRequestResolver.resolve(
        reference,
        options.repositoryRoot,
      );
    } catch (error) {
      throw new Error(
        `Explicit pull request ${reference} could not be retrieved: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const content = [
      `# ${pullRequest.title}`,
      "",
      pullRequest.body,
      ...(pullRequest.author ? ["", `Author: ${pullRequest.author}`] : []),
      ...(pullRequest.commits ?? []).flatMap((commit) => [
        "",
        `## Commit ${commit.oid}`,
        "",
        commit.messageHeadline,
        ...(commit.messageBody ? ["", commit.messageBody] : []),
      ]),
      ...pullRequest.comments.flatMap((comment) => [
        "",
        `## Comment by ${comment.author}`,
        "",
        comment.body,
      ]),
      "",
    ].join("\n");
    budget.include(`pull request ${reference}`, content);
    budget.includeSerialized(pullRequest);
    resolvedPullRequests[reference] = pullRequest;
    sources.push({
      id: stableId("pull-request", pullRequest.origin),
      kind: "pull_request",
      origin: pullRequest.origin,
      retrievedAt: capturedAt,
      visibility: "shared",
      content,
      contentHash: sha256(content),
      ...(options.taskReferences?.find(
        (candidate) =>
          candidate.kind === "github_pull_request" &&
          candidate.reference === reference,
      )?.primary
        ? { primary: true }
        : {}),
      github: {
        repository: pullRequest.repository,
        number: pullRequest.number,
        url: pullRequest.url,
        baseBranch: pullRequest.baseBranch,
        headBranch: pullRequest.headBranch,
        headRepository: pullRequest.headRepository,
        headCommit: pullRequest.headCommit,
      },
    });
  }

  for (const configuredPath of options.specPaths) {
    let resolvedSpec: ResolvedLocalSpec;
    try {
      resolvedSpec = await localSpecResolver.resolve(
        configuredPath,
        options.repositoryRoot,
      );
    } catch (error) {
      throw new Error(
        `Explicit specification ${configuredPath} could not be retrieved: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    budget.include(`specification ${configuredPath}`, resolvedSpec.content);
    sources.push({
      id: stableId("spec", configuredPath),
      kind: "repo_spec",
      origin: resolvedSpec.origin,
      retrievedAt: capturedAt,
      visibility: "shared",
      content: resolvedSpec.content,
      contentHash: sha256(resolvedSpec.content),
      ...(options.taskReferences?.find(
        (candidate) =>
          candidate.kind === "repo_spec" && candidate.path === configuredPath,
      )?.primary
        ? { primary: true }
        : {}),
    });
  }

  for (const instruction of await discoverInstructions(
    options.repositoryRoot,
  )) {
    budget.include(`instruction ${instruction.path}`, instruction.content);
    sources.push({
      id: stableId("instructions", instruction.path),
      kind: "repo_spec",
      origin: instruction.path,
      retrievedAt: capturedAt,
      visibility: "shared",
      content: instruction.content,
      contentHash: sha256(instruction.content),
    });
  }

  const repositoryEvidence = await collectRepositoryEvidence(
    options.repositoryRoot,
    budget,
  );
  const input = {
    version: 1 as const,
    task: options.task,
    acceptanceCriteria: [...options.acceptanceCriteria],
    request: reconnaissanceRequest(options),
    capturedAt,
    sources,
    repositoryEvidence,
    resolvedPullRequests,
  };
  return validateReconnaissance({
    ...input,
    inputHash: sha256(canonicalJson(input)),
  });
}

async function snapshotSource(
  sourceDirectory: string,
  source: Omit<TaskSource, "contentHash" | "snapshotPath">,
  content: string,
): Promise<TaskSource> {
  const hash = sha256(content);
  const snapshotPath = path.join(sourceDirectory, `${source.id}.md`);
  await writeFile(snapshotPath, content, "utf8");
  return { ...source, contentHash: hash, snapshotPath };
}

export async function buildTaskContract(
  options: BuildTaskContractOptions,
): Promise<TaskContract> {
  const reconnaissance = validateReconnaissance(
    options.reconnaissance ?? (await collectReconnaissance(options)),
    {
      task: options.task,
      acceptanceCriteria: options.acceptanceCriteria,
      repositoryRoot: options.repositoryRoot,
      specPaths: options.specPaths,
      issueReferences: options.issueReferences,
      pullRequestReferences: options.pullRequestReferences ?? [],
      taskReferences: options.taskReferences ?? [],
    },
  );
  await mkdir(options.sourceDirectory, { recursive: true });
  const sources: TaskSource[] = [];
  for (const source of reconnaissance.sources) {
    const { content, contentHash: expectedHash, ...metadata } = source;
    const persisted = await snapshotSource(
      options.sourceDirectory,
      metadata,
      content,
    );
    if (persisted.contentHash !== expectedHash)
      throw new Error(`Reconnaissance source drifted: ${source.origin}`);
    sources.push(persisted);
  }

  const base = {
    version: 1 as const,
    task: reconnaissance.task,
    acceptanceCriteria: reconnaissance.acceptanceCriteria,
    sources,
    createdAt: reconnaissance.capturedAt,
  };
  const contractHash = sha256(JSON.stringify(base));
  return TaskContractSchema.parse({ ...base, contractHash });
}

export interface BuildRunSpecOptions extends Omit<
  BuildTaskContractOptions,
  | "task"
  | "acceptanceCriteria"
  | "specPaths"
  | "issueReferences"
  | "pullRequestReferences"
  | "taskReferences"
> {
  runId: string;
  baseCommit: string;
  config: FightConfig;
  permissions: PermissionPolicy;
  mcpPolicyHash?: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function calculateRunSpecHash(
  spec: Omit<RunSpec, "contentHash">,
): string {
  return sha256(canonicalJson(spec));
}

export async function buildRunSpec(
  options: BuildRunSpecOptions,
): Promise<RunSpec> {
  const config = FightConfigSchema.parse(options.config);
  const reconnaissance =
    options.reconnaissance ??
    (await collectFightReconnaissance(config, {
      ...(options.issueResolver
        ? { issueResolver: options.issueResolver }
        : {}),
      ...(options.pullRequestResolver
        ? { pullRequestResolver: options.pullRequestResolver }
        : {}),
      ...(options.localSpecResolver
        ? { localSpecResolver: options.localSpecResolver }
        : {}),
      ...(options.now ? { now: options.now } : {}),
    }));
  const snapshot = await buildTaskContract({
    ...options,
    task: config.task,
    acceptanceCriteria: config.acceptanceCriteria,
    specPaths: config.specPaths,
    issueReferences: config.issueReferences,
    pullRequestReferences: config.pullRequestReferences,
    taskReferences: config.taskReferences,
    reconnaissance,
  });
  const commands: RunSpec["commands"] = [
    {
      id: "required-test",
      kind: "required",
      command: config.testCommand,
      timeoutMs: config.limits.attackMs,
      required: true,
    },
  ];
  const bootstrap =
    config.resolvedBootstrap ??
    (await resolveBootstrapContract({
      repositoryRoot: config.repositoryRoot,
      bootstrap: config.bootstrap,
      timeoutMs: config.limits.attackMs,
    }));
  if (bootstrap.disposition === "command")
    commands.unshift({
      id: "bootstrap",
      kind: "install",
      command: bootstrap.command!,
      timeoutMs: bootstrap.timeoutMs,
      required: true,
    });
  if (config.integrationProfile) {
    commands.push(
      {
        id: "integration-setup",
        kind: "integration_setup",
        command: config.integrationProfile.setupCommand,
        timeoutMs: config.limits.attackMs,
        required: false,
      },
      {
        id: "integration-check",
        kind: "integration_check",
        command: config.integrationProfile.checkCommand,
        timeoutMs: config.limits.attackMs,
        required: false,
      },
      {
        id: "integration-teardown",
        kind: "integration_teardown",
        command: config.integrationProfile.teardownCommand,
        timeoutMs: config.limits.attackMs,
        required: false,
      },
    );
  }
  const browserValidation = planBrowserValidation(config, reconnaissance);
  if (browserValidation?.profile) {
    commands.push(
      {
        id: "browser-startup",
        kind: "browser_startup",
        command: browserValidation.profile.startupCommand,
        timeoutMs: config.limits.attackMs,
        required: browserValidation.requirement === "required",
      },
      {
        id: "browser-test",
        kind: "browser_test",
        command: browserValidation.profile.testCommand,
        timeoutMs: config.limits.attackMs,
        required: browserValidation.requirement === "required",
      },
      ...(browserValidation.profile.teardownCommand
        ? [
            {
              id: "browser-teardown",
              kind: "browser_teardown" as const,
              command: browserValidation.profile.teardownCommand,
              timeoutMs: config.limits.attackMs,
              required: false,
            },
          ]
        : []),
    );
  }
  const browserCapability = options.permissions.capabilities.find(
    (capability) => capability.id === "browser_dom_validation",
  );
  const blockedRequiredBrowserOrigin = options.permissions.capabilities.find(
    (capability) =>
      capability.id.startsWith("browser_origin_") &&
      capability.requirement === "required" &&
      capability.status !== "approved",
  );
  const browserDecision =
    browserCapability?.status === "approved" && blockedRequiredBrowserOrigin
      ? blockedRequiredBrowserOrigin.status
      : browserCapability?.status;
  const effortProfile =
    config.resolvedEffortProfile ??
    resolveEffortProfile(
      config.effortMode === "auto" ? "medium" : config.effortMode,
      {
        ...(config.phaseOverrides.implementation
          ? { implementationMs: config.limits.implementationMs }
          : {}),
        ...(config.phaseOverrides.review
          ? { reviewMs: config.limits.reviewMs }
          : {}),
        ...(config.phaseOverrides.attack
          ? { attackMs: config.limits.attackMs }
          : {}),
        ...(config.phaseOverrides.judge
          ? { judgeMs: config.limits.verifierMs }
          : {}),
        ...(config.phaseOverrides.repair
          ? { repairMs: config.limits.repairMs }
          : {}),
      },
    );
  const base = {
    version: 3 as const,
    runId: options.runId,
    task: {
      task: snapshot.task,
      acceptanceCriteria: snapshot.acceptanceCriteria,
      sources: snapshot.sources.map((source) => ({
        id: source.id,
        kind: source.kind,
        origin: source.origin,
        retrievedAt: source.retrievedAt,
        contentHash: source.contentHash,
        snapshotPath: source.snapshotPath,
        ...(source.github ? { github: source.github } : {}),
      })),
      createdAt: snapshot.createdAt,
    },
    baseCommit: options.baseCommit,
    topology: {
      mode: config.mode,
      contestants: config.contestants,
    },
    commands,
    bootstrap,
    budgets: {
      ...config.limits,
      roundEnvelopeMs: effortProfile.roundEnvelopeMs,
      maxProviderCallsPerRound: effortProfile.maxProviderCallsPerRound,
      maxTokensPerRound: effortProfile.maxTokensPerRound,
    },
    effort: {
      mode: config.effortMode,
      fixedRounds: config.fixedRounds,
      ...(config.fixedRounds ? { exactRounds: config.rounds } : {}),
      ...(config.effortAssessment
        ? { assessment: config.effortAssessment }
        : {}),
      profile: effortProfile,
      phaseOverrides: config.phaseOverrides,
    },
    permissions: {
      mode: options.permissions.defaultMode,
      reducedValidationAccepted: options.permissions.reducedValidationAccepted,
      capabilities: options.permissions.capabilities.map((capability) => ({
        id: capability.id,
        reason: capability.reason,
        risk: capability.risk,
        requirement: capability.requirement,
        role: capability.role,
        enforcement: capability.enforcement,
        decision: capability.status,
        scopes: capability.scopes,
      })),
    },
    ...(options.mcpPolicyHash ? { mcpPolicyHash: options.mcpPolicyHash } : {}),
    ...(browserValidation && browserCapability
      ? {
          browserValidation: {
            ...browserValidation,
            decision: browserDecision ?? browserCapability.status,
            approvedScopes:
              browserDecision === "approved"
                ? [
                    ...browserCapability.scopes,
                    ...options.permissions.capabilities
                      .filter(
                        (capability) =>
                          capability.id.startsWith("browser_origin_") &&
                          capability.status === "approved",
                      )
                      .flatMap((capability) => capability.scopes),
                  ]
                : [],
          },
        }
      : {}),
  };
  return RunSpecSchema.parse({
    ...base,
    contentHash: calculateRunSpecHash(base),
  });
}

export function oracleResolves(
  contract: TaskContract,
  citation: OracleCitation,
): boolean {
  return (
    citation.sourceId !== undefined &&
    contract.sources.some((source) => source.id === citation.sourceId)
  );
}
