import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { sha256, stableId } from "../core/ids.js";
import {
  TaskContractSchema,
  type OracleCitation,
  type TaskContract,
  type TaskSource,
  type TaskReference,
} from "../core/types.js";
import { discoverInstructions } from "../repo/instructions.js";

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
    return {
      origin: reference,
      content: await readFile(path.resolve(repositoryRoot, reference), "utf8"),
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
}

function extractAcceptanceCriteria(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/)?.[1])
    .filter((value): value is string => Boolean(value));
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
  const now = (options.now ?? new Date()).toISOString();
  const issueResolver = options.issueResolver ?? new GitHubIssueResolver();
  const pullRequestResolver =
    options.pullRequestResolver ?? new GitHubPullRequestResolver();
  const localSpecResolver =
    options.localSpecResolver ?? new FileLocalSpecResolver();
  await mkdir(options.sourceDirectory, { recursive: true });
  const sources: TaskSource[] = [];
  const criteria = new Set(options.acceptanceCriteria);

  sources.push(
    await snapshotSource(
      options.sourceDirectory,
      {
        id: "task-user",
        kind: "user_task",
        origin: "command-line task",
        retrievedAt: now,
        visibility: "shared",
      },
      `${options.task}\n`,
    ),
  );

  for (const reference of options.issueReferences) {
    let issue: ResolvedIssue;
    try {
      issue = await issueResolver.resolve(reference, options.repositoryRoot);
    } catch (error) {
      options.warnings?.push(
        `Official issue ${reference} could not be retrieved and was not included in the contract: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
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
    extractAcceptanceCriteria(content).forEach((criterion) =>
      criteria.add(criterion),
    );
    sources.push(
      await snapshotSource(
        options.sourceDirectory,
        {
          id: stableId("issue", issue.origin),
          kind: "issue",
          origin: issue.origin,
          retrievedAt: now,
          visibility: "shared",
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
        },
        content,
      ),
    );
  }

  for (const reference of options.pullRequestReferences ?? []) {
    let pullRequest: ResolvedPullRequest;
    try {
      pullRequest = await pullRequestResolver.resolve(
        reference,
        options.repositoryRoot,
      );
    } catch (error) {
      options.warnings?.push(
        `Official pull request ${reference} could not be retrieved and was not included in the contract: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
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
    extractAcceptanceCriteria(content).forEach((criterion) =>
      criteria.add(criterion),
    );
    sources.push(
      await snapshotSource(
        options.sourceDirectory,
        {
          id: stableId("pull-request", pullRequest.origin),
          kind: "pull_request",
          origin: pullRequest.origin,
          retrievedAt: now,
          visibility: "shared",
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
        },
        content,
      ),
    );
  }

  for (const configuredPath of options.specPaths) {
    const resolvedSpec = await localSpecResolver.resolve(
      configuredPath,
      options.repositoryRoot,
    );
    const content = resolvedSpec.content;
    extractAcceptanceCriteria(content).forEach((criterion) =>
      criteria.add(criterion),
    );
    sources.push(
      await snapshotSource(
        options.sourceDirectory,
        {
          id: stableId("spec", configuredPath),
          kind: "repo_spec",
          origin: resolvedSpec.origin,
          retrievedAt: now,
          visibility: "shared",
          ...(options.taskReferences?.find(
            (candidate) =>
              candidate.kind === "repo_spec" &&
              candidate.path === configuredPath,
          )?.primary
            ? { primary: true }
            : {}),
        },
        content,
      ),
    );
  }

  for (const instruction of await discoverInstructions(
    options.repositoryRoot,
  )) {
    sources.push(
      await snapshotSource(
        options.sourceDirectory,
        {
          id: stableId("instructions", instruction.path),
          kind: "repo_spec",
          origin: instruction.path,
          retrievedAt: now,
          visibility: "shared",
        },
        instruction.content,
      ),
    );
  }

  if (criteria.size === 0) criteria.add(options.task);
  const base = {
    version: 1 as const,
    task: options.task,
    acceptanceCriteria: [...criteria],
    sources,
    createdAt: now,
  };
  const contractHash = sha256(JSON.stringify(base));
  return TaskContractSchema.parse({ ...base, contractHash });
}

export function oracleResolves(
  contract: TaskContract,
  citation: OracleCitation,
): boolean {
  return contract.sources.some((source) => source.id === citation.sourceId);
}
