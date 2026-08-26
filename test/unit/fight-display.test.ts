import { describe, expect, it } from "vitest";
import {
  renderFinalMcpPolicy,
  resolveDisplayMode,
} from "../../src/commands/fight.js";
import {
  applyMcpReadiness,
  freezeMcpPolicy,
  mcpServerIdentity,
} from "../../src/mcp/policy.js";

describe("fight display selection", () => {
  it("launches the desktop window by default", () => {
    expect(resolveDisplayMode("auto", true, true)).toBe("window");
    expect(resolveDisplayMode("auto", true, false)).toBe("window");
  });

  it("uses terminal or plain output when the window is disabled", () => {
    expect(resolveDisplayMode("auto", false, true)).toBe("terminal");
    expect(resolveDisplayMode("auto", false, false)).toBe("plain");
    expect(resolveDisplayMode("window", false, true)).toBe("terminal");
  });

  it("preserves explicit non-window display modes", () => {
    expect(resolveDisplayMode("terminal", true, true)).toBe("terminal");
    expect(resolveDisplayMode("plain", true, true)).toBe("plain");
  });

  it("shows requested readiness without exposing unselected unauthenticated servers", () => {
    const initial = freezeMcpPolicy({
      config: {
        policy: "keep_configured",
        servers: [
          {
            provider: "codex",
            name: "selected",
            role: "agent",
            requirement: "optional",
          },
        ],
      },
      inventory: [
        {
          provider: "codex",
          state: "known",
          diagnosticArtifactRefs: [],
          servers: [
            {
              name: "selected",
              enabled: true,
              authentication: "not_required",
              readiness: "unknown",
            },
            {
              name: "private-unauthed",
              enabled: true,
              authentication: "needs_authentication",
              readiness: "unavailable",
            },
          ],
        },
      ],
      reducedValidationAccepted: false,
    });
    const policy = applyMcpReadiness(
      initial,
      new Map([[mcpServerIdentity("codex", "selected"), "ready"]]),
      false,
    );

    const rendered = renderFinalMcpPolicy(policy);
    expect(rendered).toContain("codex/selected: included, not_required, ready");
    expect(rendered).not.toContain("private-unauthed");
  });
});
