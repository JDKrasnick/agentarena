import { readFile } from "node:fs/promises";
import path from "node:path";

const INSTRUCTION_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
] as const;

export interface RepositoryInstruction {
  path: string;
  content: string;
}

export async function discoverInstructions(
  repositoryRoot: string,
  maxBytes = 128 * 1024,
): Promise<RepositoryInstruction[]> {
  const instructions: RepositoryInstruction[] = [];
  let total = 0;
  for (const relativePath of INSTRUCTION_PATHS) {
    try {
      const content = await readFile(
        path.join(repositoryRoot, relativePath),
        "utf8",
      );
      total += Buffer.byteLength(content);
      if (total > maxBytes)
        throw new Error(`Repository instructions exceed ${maxBytes} bytes`);
      instructions.push({ path: relativePath, content });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return instructions;
}
