import { describe, expect, it } from "vitest";
import {
  evidenceFingerprint,
  normalizedBrowserActionFingerprint,
  priorAdjudicationContext,
} from "../../src/attacks/challenges.js";
import { normalizeAttackAdjudication } from "../../src/core/scoring.js";
import type { Attack } from "../../src/core/types.js";

function attack(id: string, round: 1 | 2 | 3): Attack {
  return {
    id,
    round,
    origin: { kind: "contestant", contestant: "a", provider: "codex" },
    rank: 1,
    targets: ["b"],
    claim: "Keyboard submission fails",
    impact: "The form cannot be submitted",
    oracle: {
      expectedBehavior: "Enter submits the form",
      rationale: "The frozen task requires keyboard operation",
    },
    assertionFingerprint: "keyboard-submit",
    requiredCapabilities: ["browser_dom_validation"],
    patchPath: "/tmp/evidence.diff",
    focusedCommand: "true",
    evidenceKind: "browser_probe",
    browserProbe: {
      id: `${id}-probe`,
      family: "keyboard_focus",
      profile: "desktop",
      expectedBehavior: "Enter submits",
      actions: [
        { kind: "goto", path: "/form" },
        { kind: "press", key: "Enter" },
        { kind: "assert_text", text: id },
      ],
    },
    status: "blocked",
    checks: [],
  };
}

describe("contextual adjudication challenges", () => {
  it("matches renamed browser probes by normalized non-assert actions", () => {
    const prior = attack("round-two", 2);
    const challenge = attack("round-three", 3);
    expect(normalizedBrowserActionFingerprint(prior)).toBe(
      normalizedBrowserActionFingerprint(challenge),
    );
    prior.adjudication = normalizeAttackAdjudication(prior);
    const context = priorAdjudicationContext(challenge, [prior]);
    expect(context).toHaveLength(1);
    expect(context[0]).toMatchObject({
      adjudicationId: prior.adjudication.id,
      verdict: "rejected",
    });
  });

  it("keeps unrelated browser action sequences independent", () => {
    const prior = attack("prior", 2);
    prior.assertionFingerprint = "different-assertion";
    prior.browserProbe!.actions = [{ kind: "goto", path: "/other" }];
    const challenge = attack("challenge", 3);
    expect(evidenceFingerprint(prior)).not.toBe(evidenceFingerprint(challenge));
  });

  it("places an explicit prior adjudication first in the six-record context", () => {
    const history = Array.from({ length: 8 }, (_, index) => {
      const candidate = attack(`prior-${String(index)}`, 2);
      candidate.assertionFingerprint = `assertion-${String(index)}`;
      candidate.adjudication = normalizeAttackAdjudication(candidate);
      return candidate;
    });
    const challenge = attack("challenge", 3);
    challenge.challengeAdjudicationId = history[7]!.adjudication!.id;
    const context = priorAdjudicationContext(challenge, history);
    expect(context).toHaveLength(6);
    expect(context[0]?.adjudicationId).toBe(challenge.challengeAdjudicationId);
  });
});
