import type {
  AgentId,
  AuthorshipAttribution,
  AuthorshipEvidence,
} from "../core/types.js";

export interface AuthorshipCandidate {
  author?: string;
  title: string;
  headBranch: string;
  commits?: Array<{ messageHeadline: string; messageBody?: string }>;
}

function evidence(
  kind: AuthorshipEvidence["kind"],
  source: string,
  value: string,
): AuthorshipEvidence {
  return { kind, source, value };
}

function providerForBot(value: string): AgentId | undefined {
  const normalized = value.toLowerCase();
  if (/\b(?:claude|anthropic)[-_ ]?(?:bot|code)?\b/u.test(normalized))
    return "claude";
  if (/\b(?:codex|openai)[-_ ]?(?:bot|code)?\b/u.test(normalized))
    return "codex";
  if (/\b(?:gemini|google)[-_ ]?(?:bot|code)?\b/u.test(normalized))
    return "gemini";
  return undefined;
}

function providerForExplicitMarker(value: string): AgentId | undefined {
  const normalized = value.toLowerCase();
  if (/\bclaude\b/u.test(normalized)) return "claude";
  if (/\bcodex\b/u.test(normalized)) return "codex";
  if (/\bgemini\b/u.test(normalized)) return "gemini";
  return undefined;
}

/**
 * Attribute only from explicit provenance markers. Conflicting providers are
 * deliberately retained as evidence but never resolved to a provider.
 */
export function attributePullRequest(
  candidate: AuthorshipCandidate,
): AuthorshipAttribution {
  const matches: Array<{ provider: AgentId; evidence: AuthorshipEvidence }> =
    [];
  if (candidate.author) {
    const provider = providerForBot(candidate.author);
    if (provider)
      matches.push({
        provider,
        evidence: evidence(
          "bot_author",
          "pull_request.author",
          candidate.author,
        ),
      });
  }

  if (/^\[codex\]/iu.test(candidate.title)) {
    matches.push({
      provider: "codex",
      evidence: evidence("title_prefix", "pull_request.title", candidate.title),
    });
  }
  for (const [provider, prefix] of [
    ["codex", "codex/"],
    ["gemini", "gemini/"],
  ] as const) {
    if (candidate.headBranch.toLowerCase().startsWith(prefix)) {
      matches.push({
        provider,
        evidence: evidence(
          "branch_prefix",
          "pull_request.headBranch",
          candidate.headBranch,
        ),
      });
    }
  }

  for (const commit of candidate.commits ?? []) {
    const text = `${commit.messageHeadline}\n${commit.messageBody ?? ""}`;
    for (const trailer of text.matchAll(/^co-authored-by:\s*(.+)$/gimu)) {
      const value = trailer[1]?.trim();
      if (!value) continue;
      const provider = providerForExplicitMarker(value);
      if (provider)
        matches.push({
          provider,
          evidence: evidence(
            "coauthor_trailer",
            "commit.co-authored-by",
            value,
          ),
        });
    }
    for (const marker of text.matchAll(
      /(?:generated|created) (?:with|by) ([^\n]+)/giu,
    )) {
      const value = marker[1]?.trim();
      if (!value) continue;
      const provider = providerForExplicitMarker(value);
      if (provider)
        matches.push({
          provider,
          evidence: evidence("generator_marker", "commit.message", value),
        });
    }
  }

  const evidenceList = matches.map((match) => match.evidence);
  const providers = new Set(matches.map((match) => match.provider));
  if (providers.size !== 1)
    return { confidence: "unknown", evidence: evidenceList };
  return {
    provider: [...providers][0],
    confidence: "confirmed",
    evidence: evidenceList,
  };
}
