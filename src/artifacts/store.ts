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
import {
  RunStateV3Schema,
  RunStateV4Schema,
  RunStateV5Schema,
  type RunState,
} from "../core/types.js";
import {
  AnyRunSummarySchema,
  RunSummaryV5Schema,
  RunSummaryV6Schema,
  type AppliedEnvelope,
  type RunSummaryV5,
  type RunSummaryV6,
} from "../recovery/contracts.js";
import { buildRunSummary, reconstructRunState } from "../recovery/durable.js";

export class ArtifactStore {
  readonly runDirectory: string;

  constructor(
    artifactRoot: string,
    readonly runId: string,
    private readonly options: { durableV5?: boolean } = {},
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
        "coverage",
        "reviews",
        "delivery/events",
        "operations",
        "rounds",
        "checkpoints",
        "feedback",
        "events",
        "forks",
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

  async writeImmutableBytes(
    relativePath: string,
    content: Uint8Array,
  ): Promise<string> {
    const target = this.resolve(relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = this.resolve(`.${randomUUID()}.tmp`);
    await writeFile(temporary, content);
    try {
      await link(temporary, target);
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(target);
      if (!existing.equals(Buffer.from(content))) {
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

  async writeState(
    state: RunState,
    appliedEnvelopes?: readonly AppliedEnvelope[],
  ): Promise<string> {
    let existingVersion: unknown;
    try {
      existingVersion = (
        JSON.parse(await readFile(this.resolve("result.json"), "utf8")) as {
          schemaVersion?: unknown;
        }
      ).schemaVersion;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (state.schemaVersion === 3 || existingVersion === 3) {
      const validated = RunStateV3Schema.parse(state);
      return this.replaceDerivedJson("result.json", validated);
    }
    if (existingVersion === 4) {
      const validated = RunStateV4Schema.parse(state);
      return this.replaceDerivedJson("result.json", validated);
    }
    if (existingVersion === undefined && !this.options.durableV5) {
      const validated = RunStateV5Schema.parse(state);
      return this.replaceDerivedJson("result.json", validated);
    }
    if (existingVersion === 5 && !this.options.durableV5) {
      const validated = RunStateV5Schema.parse(state);
      return this.replaceDerivedJson("result.json", validated);
    }
    if (existingVersion !== undefined && existingVersion !== 6)
      throw new Error("Cannot replace an unsupported result schema");
    const validated = RunStateV5Schema.parse(state);
    const current = await this.readSummary();
    const summary = await buildRunSummary({
      store: this,
      state: validated,
      appliedEnvelopes: appliedEnvelopes ?? current?.appliedEnvelopes ?? [],
      ...(current ? { provenance: current.provenance } : {}),
    });
    const target = this.resolve("result.json");
    const temporary = this.resolve(`.result-${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    await rename(temporary, target);
    return target;
  }

  async readState(): Promise<RunState> {
    const value = JSON.parse(
      await readFile(this.resolve("result.json"), "utf8"),
    ) as unknown;
    const version = (value as { schemaVersion?: unknown }).schemaVersion;
    const isDurableSummary =
      (version === 5 || version === 6) &&
      Array.isArray((value as { appliedEnvelopes?: unknown }).appliedEnvelopes);
    if (!isDurableSummary) return parseRunState(value);
    return reconstructRunState({
      store: this,
      summary: AnyRunSummarySchema.parse(value),
    });
  }

  async readSummary(): Promise<RunSummaryV5 | RunSummaryV6 | undefined> {
    try {
      const value = JSON.parse(
        await readFile(this.resolve("result.json"), "utf8"),
      ) as unknown;
      const candidate = value as {
        schemaVersion?: number;
        appliedEnvelopes?: unknown;
      };
      if (
        ![5, 6].includes(candidate.schemaVersion ?? -1) ||
        !Array.isArray(candidate.appliedEnvelopes)
      )
        return undefined;
      return (value as { schemaVersion: number }).schemaVersion === 5
        ? RunSummaryV5Schema.parse(value)
        : RunSummaryV6Schema.parse(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}
