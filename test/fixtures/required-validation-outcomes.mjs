import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const statePath = process.argv[2];
if (!statePath) throw new Error("state path is required");
const scenario = process.argv[3] ?? "timeout-then-pass";
if (path.resolve(process.cwd()) === path.dirname(path.resolve(statePath))) {
  console.log("baseline validation passed");
  process.exit(0);
}
const source = await readFile(
  path.join(process.cwd(), "src", "slug.mjs"),
  "utf8",
);
if (source.includes('replace(" ", "-")')) {
  console.log("baseline validation passed");
  process.exit(0);
}

let invocation = 0;
try {
  invocation = Number(await readFile(statePath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
invocation += 1;
await writeFile(statePath, String(invocation), "utf8");

if (invocation === 1) {
  console.log("168 runtime tests passed; waiting for teardown");
  setInterval(() => undefined, 1_000);
} else if (
  (invocation === 2 && scenario === "timeout-then-pass") ||
  scenario === "timeout-then-all-pass"
) {
  console.log("168 runtime tests passed; teardown completed");
} else {
  console.error(
    "src/runner.ts(42,3): error TS7030: Not all code paths return a value.",
  );
  process.exitCode = 2;
}
