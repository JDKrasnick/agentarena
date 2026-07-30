import { createHash, randomUUID } from "node:crypto";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${sha256(parts.join("\u0000")).slice(0, 16)}`;
}

export function createRunId(now = new Date()): string {
  const timestamp = now.toISOString().replaceAll(":", "").replaceAll(".", "");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}
