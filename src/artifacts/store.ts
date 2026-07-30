import {
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import { parseRunState } from "../core/run-state.js";
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
        "quality",
        "reviews",
        "delivery/events",
        "operations",
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

  async writeImmutableJson(
    relativePath: string,
    value: unknown,
  ): Promise<string> {
    const target = this.resolve(relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = this.resolve(`.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
      await link(temporary, target);
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = JSON.parse(await readFile(target, "utf8")) as unknown;
      if (JSON.stringify(existing) !== JSON.stringify(value)) {
        throw new Error(`Immutable artifact already exists: ${relativePath}`, {
          cause: error,
        });
      }
      return target;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async replaceDerivedJson(
    relativePath: string,
    value: unknown,
  ): Promise<string> {
    const target = this.resolve(relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = this.resolve(`.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, target);
    return target;
  }

  async readOptionalJson<T>(
    relativePath: string,
    schema: ZodType<T>,
  ): Promise<T | undefined> {
    try {
      return schema.parse(
        JSON.parse(await readFile(this.resolve(relativePath), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async listValidatedArtifacts<T>(
    relativeDirectory: string,
    schema: ZodType<T>,
  ): Promise<T[]> {
    let names: string[];
    try {
      names = await readdir(this.resolve(relativeDirectory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map(async (name) =>
          schema.parse(
            JSON.parse(
              await readFile(this.resolve(relativeDirectory, name), "utf8"),
            ),
          ),
        ),
    );
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
    return parseRunState(
      JSON.parse(await readFile(this.resolve("result.json"), "utf8")),
    );
  }
}
