import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { sha256, stableId } from "../core/ids.js";
import {
  TaskContractSchema,
  type OracleCitation,
  type TaskContract,
  type TaskSource,
} from "../core/types.js";
import { discoverInstructions } from "../repo/instructions.js";

export interface ResolvedIssue {
  origin: string;
  title: string;
  body: string;
  comments: Array<{ author: string; body: string }>;
}

export interface IssueResolver {
  resolve(reference: string, repositoryRoot: string): Promise<ResolvedIssue>;
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
    return {
      origin: value.url,
      title: value.title,
      body: value.body,
      comments: value.comments.map((comment) => ({
        author: comment.author.login,
        body: comment.body,
      })),
    };
  }
}

interface BuildTaskContractOptions {
  task: string;
  acceptanceCriteria: string[];
  specPaths: string[];
  issueReferences: string[];
  repositoryRoot: string;
  sourceDirectory: string;
  issueResolver?: IssueResolver;
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
        },
        content,
      ),
    );
  }

  for (const configuredPath of options.specPaths) {
    const absolutePath = path.resolve(options.repositoryRoot, configuredPath);
    const content = await readFile(absolutePath, "utf8");
    extractAcceptanceCriteria(content).forEach((criterion) =>
      criteria.add(criterion),
    );
    sources.push(
      await snapshotSource(
        options.sourceDirectory,
        {
          id: stableId("spec", configuredPath),
          kind: "repo_spec",
          origin: configuredPath,
          retrievedAt: now,
          visibility: "shared",
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
