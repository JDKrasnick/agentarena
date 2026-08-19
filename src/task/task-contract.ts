import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { RunSpecSchema, type RunSpec } from "../contracts/round.js";
import { discoverInstructions } from "../repo/instructions.js";
import { planBrowserValidation } from "../browser/planner.js";

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
    const resolved = path.resolve(repositoryRoot, reference);
    const relative = path.relative(repositoryRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error(
        `Specification path escapes the repository: ${reference}`,
      );
    return {
      origin: reference,
      content: await readFile(resolved, "utf8"),
    };
  }
}

export class GitHubIssueResolver implements IssueResolver {
  async resolve(
    reference: string,
    repositoryRoot: string,
  ): Promise<ResolvedIssue> {
    const result = await execa(
      "gh",
      ["issue", "view", reference, "--json", "title,body,comments,url"],
      { cwd: repositoryRoot, reject: false },
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
      const repository = await execa(
        "gh",
        ["repo", "view", identity.repository, "--json", "defaultBranchRef"],
        { cwd: repositoryRoot, reject: false },
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
    const result = await execa(
      "gh",
      [
        "pr",
        "view",
        reference,
        "--json",
        "title,body,comments,url,number,author,baseRefName,baseRefOid,headRefName,headRepository,headRefOid,commits,closingIssuesReferences",
      ],
      { cwd: repositoryRoot, reject: false },
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
}

export interface ReconnaissanceSnapshot {
  version: 1;
  task: string;
  acceptanceCriteria: string[];
  capturedAt: string;
  sources: ReconnaissanceSource[];
  repositoryEvidence: RepositoryEvidence[];
  resolvedPullRequests: Record<string, ResolvedPullRequest>;
  inputHash: string;
}

export function validateReconnaissance(
  snapshot: ReconnaissanceSnapshot,
  config?: Pick<FightConfig, "task" | "acceptanceCriteria">,
): ReconnaissanceSnapshot {
  const { inputHash, ...input } = snapshot;
  if (sha256(canonicalJson(input)) !== inputHash)
    throw new Error("Reconnaissance input hash does not match its contents");
  if (
    config &&
    (snapshot.task !== config.task ||
      canonicalJson(snapshot.acceptanceCriteria) !==
        canonicalJson(config.acceptanceCriteria))
  )
    throw new Error("Reconnaissance does not match the approved fight task");
  for (const source of snapshot.sources) {
    if (sha256(source.content) !== source.contentHash)
      throw new Error(`Reconnaissance source hash drifted: ${source.origin}`);
  }
  for (const evidence of snapshot.repositoryEvidence) {
    if (sha256(evidence.content) !== evidence.contentHash)
      throw new Error(`Reconnaissance evidence hash drifted: ${evidence.path}`);
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

async function collectRepositoryEvidence(
  repositoryRoot: string,
  maxBytes = 512 * 1024,
): Promise<RepositoryEvidence[]> {
  const evidence: RepositoryEvidence[] = [];
  let total = 0;
  for (const relativePath of RECONNAISSANCE_PATHS) {
    try {
      const content = await readFile(
        path.join(repositoryRoot, relativePath),
        "utf8",
      );
      total += Buffer.byteLength(content);
      if (total > maxBytes)
        throw new Error(`Repository reconnaissance exceeds ${maxBytes} bytes`);
      evidence.push({
        path: relativePath,
        content,
        contentHash: sha256(content),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return evidence;
}

export async function collectReconnaissance(
  options: CollectReconnaissanceOptions,
): Promise<ReconnaissanceSnapshot> {
  const capturedAt = (options.now ?? new Date()).toISOString();
  const issueResolver = options.issueResolver ?? new GitHubIssueResolver();
  const pullRequestResolver =
    options.pullRequestResolver ?? new GitHubPullRequestResolver();
  const localSpecResolver =
    options.localSpecResolver ?? new FileLocalSpecResolver();
  const sources: ReconnaissanceSource[] = [
    {
      id: "task-user",
      kind: "user_task",
      origin: "command-line task",
      retrievedAt: capturedAt,
      visibility: "shared",
      content: `${options.task}\n`,
      contentHash: sha256(`${options.task}\n`),
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
    resolvedPullRequests[reference] = pullRequest;
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
  );
  const input = {
    version: 1 as const,
    task: options.task,
    acceptanceCriteria: [...options.acceptanceCriteria],
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
  const base = {
    version: 1 as const,
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
    budgets: config.limits,
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
    ...(browserValidation && browserCapability
      ? {
          browserValidation: {
            ...browserValidation,
            decision: browserCapability.status,
            approvedScopes:
              browserCapability.status === "approved"
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
  } satisfies Omit<RunSpec, "contentHash">;
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
