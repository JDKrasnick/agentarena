import {
  DeliveryTargetSchema,
  type DeliveryTarget,
  type TaskContract,
} from "../core/types.js";

export interface DeliveryTargetResolution {
  target?: DeliveryTarget;
  ambiguous: boolean;
  candidates: DeliveryTarget[];
  reason?: string;
}

export function deriveDeliveryTarget(
  contract: TaskContract,
  repositoryIdentity?: { repository: string; baseBranch?: string },
): DeliveryTargetResolution {
  const candidates = contract.sources.flatMap((source) => {
    if (source.kind === "issue" && source.github) {
      return [
        DeliveryTargetSchema.parse({
          kind: "github_issue",
          repository: source.github.repository,
          number: source.github.number,
          url: source.github.url,
          baseBranch: source.github.baseBranch,
          sourceId: source.id,
        }),
      ];
    }
    if (source.kind === "pull_request" && source.github) {
      return [
        DeliveryTargetSchema.parse({
          kind: "github_pull_request",
          repository: source.github.repository,
          number: source.github.number,
          url: source.github.url,
          baseBranch: source.github.baseBranch,
          headBranch: source.github.headBranch,
          headRepository: source.github.headRepository,
          headCommit: source.github.headCommit,
          sourceId: source.id,
        }),
      ];
    }
    return [];
  });
  const primarySource = contract.sources.find((source) => source.primary);
  if (primarySource) {
    const selected = candidates.find(
      (candidate) => candidate.sourceId === primarySource.id,
    );
    if (selected) return { target: selected, ambiguous: false, candidates };
  }
  if (candidates.length === 1)
    return { target: candidates[0]!, ambiguous: false, candidates };
  if (candidates.length > 1) {
    return {
      ambiguous: true,
      candidates,
      reason:
        "Multiple plausible GitHub delivery targets require a user choice.",
    };
  }
  if (
    repositoryIdentity &&
    contract.sources.some(
      (source) => source.kind === "repo_spec" || source.kind === "user_task",
    )
  ) {
    return {
      target: {
        kind: "repo_spec",
        repository: repositoryIdentity.repository,
        ...(repositoryIdentity.baseBranch
          ? { baseBranch: repositoryIdentity.baseBranch }
          : {}),
      },
      ambiguous: false,
      candidates: [],
    };
  }
  return {
    target: { kind: "local_task" },
    ambiguous: false,
    candidates: [],
  };
}
