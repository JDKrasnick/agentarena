import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export type BootstrapRequest = "auto" | "none" | { command: string };

export interface BootstrapContract {
  source: "auto" | "explicit" | "none";
  disposition: "command" | "none";
  command?: string;
  dependencyInputs: Array<{ path: string; sha256: string }>;
  timeoutMs: number;
  digest: string;
}

const hash = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

async function present(root: string, relative: string): Promise<boolean> {
  try {
    return (await stat(path.join(root, relative))).isFile();
  } catch {
    return false;
  }
}

async function inputs(root: string, paths: string[]) {
  return Promise.all(
    paths.map(async (relative) => ({
      path: relative,
      sha256: hash(await readFile(path.join(root, relative))),
    })),
  );
}

/** Resolve setup once, before permission approval and RunSpec sealing. */
export async function resolveBootstrapContract(input: {
  repositoryRoot: string;
  bootstrap: BootstrapRequest;
  timeoutMs: number;
}): Promise<BootstrapContract> {
  const request = input.bootstrap;
  let source: BootstrapContract["source"] = "auto";
  let disposition: BootstrapContract["disposition"] = "command";
  let command: string | undefined;
  let dependencyPaths: string[] = [];

  if (request === "none") {
    source = "none";
    disposition = "none";
  } else if (typeof request === "object") {
    source = "explicit";
    command = request.command;
    // Explicit setup still binds the common dependency inputs when present.
    dependencyPaths = (
      await Promise.all(
        [
          "package.json",
          "package-lock.json",
          "pnpm-lock.yaml",
          "yarn.lock",
          "bun.lock",
          "bun.lockb",
        ].map(async (file) =>
          (await present(input.repositoryRoot, file)) ? file : undefined,
        ),
      )
    ).flatMap((file) => (file ? [file] : []));
  } else {
    const packageJson = await present(input.repositoryRoot, "package.json");
    const locked = [
      ["package-lock.json", "npm ci"],
      ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
      ["yarn.lock", "yarn install --immutable"],
      ["bun.lock", "bun install --frozen-lockfile"],
      ["bun.lockb", "bun install --frozen-lockfile"],
    ] as const;
    const matches = [] as Array<readonly [string, string]>;
    for (const entry of locked)
      if (await present(input.repositoryRoot, entry[0])) matches.push(entry);
    if (!packageJson && matches.length === 0) {
      disposition = "none";
      source = "none";
    } else if (matches.length !== 1) {
      throw new Error(
        'Bootstrap auto-discovery is ambiguous. Configure `bootstrap: { command: "…" }` or `bootstrap: none`.',
      );
    } else {
      const [lockfile, detected] = matches[0]!;
      command = detected;
      dependencyPaths = [];
      for (const file of ["package.json", lockfile])
        if (await present(input.repositoryRoot, file))
          dependencyPaths.push(file);
      // Yarn Classic does not support --immutable; identify it from packageManager.
      if (lockfile === "yarn.lock" && packageJson) {
        const pkg = JSON.parse(
          await readFile(
            path.join(input.repositoryRoot, "package.json"),
            "utf8",
          ),
        ) as { packageManager?: string };
        if (pkg.packageManager?.startsWith("yarn@1"))
          command = "yarn install --frozen-lockfile";
      }
    }
  }
  dependencyPaths = dependencyPaths.filter(
    (value, index, values) => values.indexOf(value) === index,
  );
  const dependencyInputs = await inputs(input.repositoryRoot, dependencyPaths);
  const draft = {
    source,
    disposition,
    ...(command ? { command } : {}),
    dependencyInputs,
    timeoutMs: input.timeoutMs,
  };
  return { ...draft, digest: hash(JSON.stringify(draft)) };
}
