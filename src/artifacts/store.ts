import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RunStateSchema, type RunState } from "../core/types.js";

export class ArtifactStore {
  readonly runDirectory: string;

  constructor(
    artifactRoot: string,
    readonly runId: string,
  ) {
    this.runDirectory = path.join(artifactRoot, runId);
  }

  resolve(...parts: string[]): string {
    const resolved = path.resolve(this.runDirectory, ...parts);
    const relative = path.relative(this.runDirectory, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Artifact path escaped the run directory");
    }
    return resolved;
  }

  async initialize(): Promise<void> {
    await Promise.all(
      [
        "",
        "logs",
        "prompts",
        "patches",
        "attacks",
        "hypotheses",
        "cases",
        "revisions",
        "harness-overlays",
        "sources",
      ].map((directory) => mkdir(this.resolve(directory), { recursive: true })),
    );
  }

  async writeText(relativePath: string, content: string): Promise<string> {
    const target = this.resolve(relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    return target;
  }

  async writeJson(relativePath: string, value: unknown): Promise<string> {
    return this.writeText(relativePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  async writeState(state: RunState): Promise<string> {
    const validated = RunStateSchema.parse(state);
    const target = this.resolve("result.json");
    const temporary = this.resolve(`.result-${randomUUID()}.tmp`);
    await writeFile(
      temporary,
      `${JSON.stringify(validated, null, 2)}\n`,
      "utf8",
    );
    await rename(temporary, target);
    return target;
  }

  async readState(): Promise<RunState> {
    return RunStateSchema.parse(
      JSON.parse(await readFile(this.resolve("result.json"), "utf8")),
    );
  }
}
