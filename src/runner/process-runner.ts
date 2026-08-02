import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa, execaCommand } from "execa";
import type { CommandResult, FailureClass } from "../core/types.js";

const INHERITED_ENV = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SHELL",
  "USER",
] as const;
const SECRET_NAME =
  /(token|secret|password|credential|api[_-]?key|private[_-]?key)/i;

export interface ProcessRequest {
  executable: string;
  args?: string[];
  input?: string;
  displayCommand?: string;
  cwd: string;
  timeoutMs: number;
  logPrefix: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  attempts?: number;
}

function minimalEnvironment(
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (!SECRET_NAME.test(name)) env[name] = value;
  }
  return env;
}

export function redact(value: string, secrets: readonly string[] = []): string {
  return secrets
    .filter((secret) => secret.length >= 4)
    .reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), value)
    .replace(
      /\b(?:ghp|github_pat|sk|xox[baprs])[-_A-Za-z0-9]{12,}\b/g,
      "[REDACTED_CREDENTIAL]",
    );
}

function classifySpawnError(error: unknown): FailureClass | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EACCES"
    ? "arena_infrastructure"
    : undefined;
}

export async function runProcess(
  request: ProcessRequest,
): Promise<CommandResult> {
  await mkdir(path.dirname(request.logPrefix), { recursive: true });
  const started = Date.now();
  let stdout = "";
  let stderr: string;
  let exitCode: number | null = null;
  let signal: string | null = null;
  let timedOut = false;
  let failureClass: FailureClass | undefined;

  try {
    const result = await execa(request.executable, request.args ?? [], {
      cwd: request.cwd,
      env: minimalEnvironment(request.env),
      reject: false,
      timeout: request.timeoutMs,
      // Claude Code can keep an active print session alive after SIGTERM. A
      // battle budget is a hard limit, so terminate the agent process at the
      // deadline rather than allowing a stalled submission to block a round.
      killSignal: "SIGKILL",
      forceKillAfterDelay: false,
      all: false,
      ...(request.input === undefined ? {} : { input: request.input }),
      ...(request.signal === undefined ? {} : { cancelSignal: request.signal }),
    });
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exitCode ?? null;
    signal = result.signal ?? null;
    timedOut = result.timedOut;
    if (result.timedOut) failureClass = "agent_submission";
  } catch (error) {
    stderr =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    failureClass = classifySpawnError(error) ?? "arena_infrastructure";
  }

  const stdoutPath = `${request.logPrefix}.stdout.log`;
  const stderrPath = `${request.logPrefix}.stderr.log`;
  await Promise.all([
    writeFile(stdoutPath, redact(stdout), "utf8"),
    writeFile(stderrPath, redact(stderr), "utf8"),
  ]);
  const base = {
    command:
      request.displayCommand ??
      [request.executable, ...(request.args ?? [])]
        .map((part) => JSON.stringify(part))
        .join(" "),
    cwd: request.cwd,
    exitCode,
    signal,
    timedOut,
    attempts: request.attempts ?? 1,
    durationMs: Date.now() - started,
    stdoutPath,
    stderrPath,
  };
  return failureClass ? { ...base, failureClass } : base;
}

export async function runShellCommand(
  command: string,
  options: Omit<
    ProcessRequest,
    "executable" | "args" | "input" | "displayCommand"
  >,
): Promise<CommandResult> {
  const started = Date.now();
  await mkdir(path.dirname(options.logPrefix), { recursive: true });
  let stdout = "";
  let stderr: string;
  let exitCode: number | null = null;
  let signal: string | null = null;
  let timedOut = false;
  let failureClass: FailureClass | undefined;
  try {
    const result = await execaCommand(command, {
      cwd: options.cwd,
      env: minimalEnvironment(options.env),
      reject: false,
      timeout: options.timeoutMs,
      forceKillAfterDelay: 1_000,
      shell: true,
      ...(options.signal === undefined ? {} : { cancelSignal: options.signal }),
    });
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exitCode ?? null;
    signal = result.signal ?? null;
    timedOut = result.timedOut;
  } catch (error) {
    stderr =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    failureClass = classifySpawnError(error) ?? "arena_infrastructure";
  }
  const stdoutPath = `${options.logPrefix}.stdout.log`;
  const stderrPath = `${options.logPrefix}.stderr.log`;
  await Promise.all([
    writeFile(stdoutPath, redact(stdout), "utf8"),
    writeFile(stderrPath, redact(stderr), "utf8"),
  ]);
  const base = {
    command,
    cwd: options.cwd,
    exitCode,
    signal,
    timedOut,
    attempts: options.attempts ?? 1,
    durationMs: Date.now() - started,
    stdoutPath,
    stderrPath,
  };
  return failureClass ? { ...base, failureClass } : base;
}
