import { createHash } from "node:crypto";
import { z } from "zod";

export const ApprovalContextSchema = z.object({
  channel: z.enum(["chat", "cli", "api"]),
  actorRef: z.string().optional(),
  conversationRef: z.string().optional(),
  userMessageRef: z.string().optional(),
  promptId: z.string(),
  provenance: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("host_attestation"), token: z.string().min(1) }),
    z.object({
      kind: z.literal("direct_tty"),
      confirmedPatchSha256: z.string().length(64),
    }),
  ]),
});
export type ApprovalContext = z.infer<typeof ApprovalContextSchema>;

export interface VerifiedApproval {
  attestationHash: string;
  actorRef?: string;
}

export interface ApprovalVerifier {
  verify(
    context: ApprovalContext,
    expectedPatchSha256?: string,
  ): Promise<VerifiedApproval>;
}

export class DirectApprovalVerifier implements ApprovalVerifier {
  verify(
    context: ApprovalContext,
    expectedPatchSha256?: string,
  ): Promise<VerifiedApproval> {
    if (context.provenance.kind !== "direct_tty") {
      return Promise.reject(
        new Error("Host attestation requires a host-supplied verifier"),
      );
    }
    if (
      expectedPatchSha256 &&
      context.provenance.confirmedPatchSha256 !== expectedPatchSha256
    ) {
      return Promise.reject(
        new Error("TTY confirmation is not bound to the selected patch"),
      );
    }
    return Promise.resolve({
      attestationHash: createHash("sha256")
        .update(
          `${context.promptId}\0${context.provenance.confirmedPatchSha256}`,
        )
        .digest("hex"),
      ...(context.actorRef ? { actorRef: context.actorRef } : {}),
    });
  }
}
