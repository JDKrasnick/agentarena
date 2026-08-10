import { z } from "zod";
import { calculateCanonicalHash, canonicalJson } from "../contracts/round.js";

export const JUDGE_PACKET_TARGET_BYTES = 8 * 1024;
export const JUDGE_PACKET_MAX_BYTES = 24 * 1024;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const JudgeArtifactPointerSchema = z
  .object({
    artifactId: z.string().min(1),
    sha256: Sha256Schema,
    description: z.string().min(1),
    path: z.string().min(1).optional(),
  })
  .strict();

const JudgePacketBodySchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["attack", "repair"]),
    taskDigest: Sha256Schema,
    evidenceDigest: Sha256Schema,
    immutableAttackDigest: Sha256Schema.optional(),
    task: z.object({
      request: z.string(),
      acceptanceCriteria: z.array(z.string()),
    }),
    claim: z.string().min(1),
    oracle: z.string().min(1),
    diagnostics: z.string(),
    diagnosticsTruncated: z.boolean(),
    artifactPointers: z.array(JudgeArtifactPointerSchema),
  })
  .strict();

export const JudgePacketSchema = JudgePacketBodySchema.extend({
  packetDigest: Sha256Schema,
}).strict();
export type JudgePacket = z.infer<typeof JudgePacketSchema>;

export interface BuildJudgePacketInput {
  kind: "attack" | "repair";
  task: { request: string; acceptanceCriteria: string[] };
  claim: string;
  oracle: string;
  diagnostics: string;
  artifactPointers?: z.infer<typeof JudgeArtifactPointerSchema>[];
  immutableAttackDigest?: string;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value));
}

/** Build a digest-linked, identity-blind packet without contestant metadata. */
export function buildJudgePacket(input: BuildJudgePacketInput): JudgePacket {
  const evidence = {
    claim: input.claim,
    oracle: input.oracle,
    diagnostics: input.diagnostics,
    artifactPointers: input.artifactPointers ?? [],
  };
  const body = JudgePacketBodySchema.parse({
    version: 1,
    kind: input.kind,
    taskDigest: calculateCanonicalHash(input.task),
    evidenceDigest: calculateCanonicalHash(evidence),
    ...(input.immutableAttackDigest
      ? { immutableAttackDigest: input.immutableAttackDigest }
      : {}),
    task: input.task,
    claim: input.claim,
    oracle: input.oracle,
    diagnostics: input.diagnostics,
    diagnosticsTruncated: false,
    artifactPointers: input.artifactPointers ?? [],
  });
  if (byteLength(body) > JUDGE_PACKET_TARGET_BYTES) {
    const fixedBytes = byteLength({
      ...body,
      diagnostics: "",
      diagnosticsTruncated: true,
    });
    const budget = Math.max(0, JUDGE_PACKET_TARGET_BYTES - fixedBytes - 16);
    body.diagnostics = Buffer.from(input.diagnostics)
      .subarray(0, budget)
      .toString("utf8");
    body.diagnosticsTruncated = true;
  }
  if (byteLength(body) > JUDGE_PACKET_MAX_BYTES)
    throw new Error(
      "Judge packet exceeds 24 KiB; move large evidence into artifact pointers",
    );
  return JudgePacketSchema.parse({
    ...body,
    packetDigest: calculateCanonicalHash(body),
  });
}

export function verifyJudgePacket(packet: JudgePacket): boolean {
  const { packetDigest, ...body } = JudgePacketSchema.parse(packet);
  return calculateCanonicalHash(body) === packetDigest;
}
