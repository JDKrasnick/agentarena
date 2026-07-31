import { describe, expect, it } from "vitest";
import { DirectApprovalVerifier } from "../../src/review/approval.js";

describe("approval boundary", () => {
  it("rejects a mismatched patch-bound TTY confirmation", async () => {
    await expect(
      new DirectApprovalVerifier().verify(
        {
          channel: "cli",
          promptId: "prompt",
          provenance: {
            kind: "direct_tty",
            confirmedPatchSha256: "a".repeat(64),
          },
        },
        "b".repeat(64),
      ),
    ).rejects.toThrow("not bound");
  });

  it("does not accept host attestations without a host verifier", async () => {
    await expect(
      new DirectApprovalVerifier().verify({
        channel: "chat",
        promptId: "prompt",
        provenance: { kind: "host_attestation", token: "secret" },
      }),
    ).rejects.toThrow("host-supplied");
  });
});
