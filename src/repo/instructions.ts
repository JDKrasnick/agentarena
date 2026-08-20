import { readFile, realpath, stat } from "node:fs/promises";
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
  const canonicalRoot = await realpath(repositoryRoot);
  let total = 0;
  for (const relativePath of INSTRUCTION_PATHS) {
    try {
      const instructionPath = await realpath(
        path.join(repositoryRoot, relativePath),
      );
      const relative = path.relative(canonicalRoot, instructionPath);
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error(
          `Repository instruction path escapes the repository through a symbolic link: ${relativePath}`,
        );
      const file = await stat(instructionPath);
      if (!file.isFile())
        throw new Error(
          `Repository instruction path is not a regular file: ${relativePath}`,
        );
      if (file.size > maxBytes)
        throw new Error(`Repository instructions exceed ${maxBytes} bytes`);
      const content = await readFile(instructionPath, "utf8");
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
