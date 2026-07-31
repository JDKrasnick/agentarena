import { describe, expect, it } from "vitest";
import { attributePullRequest } from "../../src/task/authorship.js";

describe("pull request authorship attribution", () => {
  it("confirms explicit provider provenance", () => {
    expect(
      attributePullRequest({
        author: "codex-bot",
        title: "Parser cleanup",
        headBranch: "feature/parser",
        commits: [],
      }),
    ).toEqual({
      provider: "codex",
      confidence: "confirmed",
      evidence: [
        {
          kind: "bot_author",
          source: "pull_request.author",
          value: "codex-bot",
        },
      ],
    });
  });

  it("accepts provider-specific title, branch, and co-author markers", () => {
    const result = attributePullRequest({
      title: "[codex] Tighten parser validation",
      headBranch: "codex/parser",
      commits: [
        {
          messageHeadline: "Tighten parser validation",
          messageBody: "Co-authored-by: Codex <codex@example.test>",
        },
      ],
    });
    expect(result.provider).toBe("codex");
    expect(result.confidence).toBe("confirmed");
    expect(result.evidence.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "title_prefix",
        "branch_prefix",
        "coauthor_trailer",
      ]),
    );
  });

  it("never resolves conflicting explicit signals", () => {
    const result = attributePullRequest({
      author: "claude-bot",
      title: "[codex] Tighten parser validation",
      headBranch: "feature/parser",
    });
    expect(result.confidence).toBe("unknown");
    expect(result.evidence.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["bot_author", "title_prefix"]),
    );
  });
});
