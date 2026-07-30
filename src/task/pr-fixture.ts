import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../core/ids.js";
import {
  PullRequestFixtureSchema,
  type PullRequestFixture,
} from "../core/types.js";
import { captureBinaryPatch, fetchRemoteCommit } from "../repo/git.js";
import { attributePullRequest } from "./authorship.js";
import {
  GitHubPullRequestResolver,
  type PullRequestResolver,
  type ResolvedPullRequest,
} from "./task-contract.js";

export interface PullRequestFixtureOptions {
  reference: string;
  repositoryRoot: string;
  artifactDirectory: string;
  resolver?: PullRequestResolver;
  now?: () => Date;
  fetchCommit?: (
    repositoryRoot: string,
    repository: string,
    commit: string,
  ) => Promise<string>;
  capturePatch?: (
    repositoryRoot: string,
    baseCommit: string,
    headCommit: string,
  ) => Promise<Buffer>;
}

function fixtureMetadata(
  pullRequest: ResolvedPullRequest,
  retrievedAt: string,
  patchPath: string,
  patchSha256: string,
): Omit<PullRequestFixture, "metadataSha256"> {
  if (!pullRequest.baseCommit)
    throw new Error(
      "Pull request metadata does not include a frozen base commit",
    );
  const commits = pullRequest.commits ?? [];
  return {
    version: 1,
    retrievedAt,
    repository: pullRequest.repository,
    number: pullRequest.number,
    url: pullRequest.url,
    title: pullRequest.title,
    body: pullRequest.body,
    ...(pullRequest.author ? { author: pullRequest.author } : {}),
    base: { branch: pullRequest.baseBranch, commit: pullRequest.baseCommit },
    head: {
      branch: pullRequest.headBranch,
      repository: pullRequest.headRepository,
      commit: pullRequest.headCommit,
    },
    commits,
    linkedIssues: pullRequest.linkedIssues ?? [],
    patchPath,
    patchSha256,
    attribution: attributePullRequest({
      title: pullRequest.title,
      headBranch: pullRequest.headBranch,
      commits,
      ...(pullRequest.author ? { author: pullRequest.author } : {}),
    }),
  };
}

/**
 * Materialize one immutable PR source. The patch is written as bytes, rather
 * than UTF-8 text, so Git binary literals, renames, and mode bits are retained.
 */
export async function freezePullRequest(
  options: PullRequestFixtureOptions,
): Promise<PullRequestFixture> {
  const resolver = options.resolver ?? new GitHubPullRequestResolver();
  const pullRequest = await resolver.resolve(
    options.reference,
    options.repositoryRoot,
  );
  if (!pullRequest.baseCommit)
    throw new Error(
      "Pull request metadata does not include a frozen base commit",
    );
  const fetchCommit = options.fetchCommit ?? fetchRemoteCommit;
  const capturePatch = options.capturePatch ?? captureBinaryPatch;
  await fetchCommit(
    options.repositoryRoot,
    pullRequest.repository,
    pullRequest.baseCommit,
  );
  await fetchCommit(
    options.repositoryRoot,
    pullRequest.headRepository,
    pullRequest.headCommit,
  );

  await mkdir(options.artifactDirectory, { recursive: true });
  const patchPath = path.join(options.artifactDirectory, "incumbent.patch");
  const patch = await capturePatch(
    options.repositoryRoot,
    pullRequest.baseCommit,
    pullRequest.headCommit,
  );
  await writeFile(patchPath, patch);
  const retrievedAt = (options.now ?? (() => new Date()))().toISOString();
  const metadata = fixtureMetadata(
    pullRequest,
    retrievedAt,
    patchPath,
    sha256(patch),
  );
  const fixture = PullRequestFixtureSchema.parse({
    ...metadata,
    metadataSha256: sha256(JSON.stringify(metadata)),
  });
  await writeFile(
    path.join(options.artifactDirectory, "pull-request.json"),
    `${JSON.stringify(fixture, null, 2)}\n`,
    "utf8",
  );
  return fixture;
}
