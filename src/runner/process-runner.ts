import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execa, execaCommand } from "execa";
import type { CommandResult, FailureClass } from "../core/types.js";
import {
  ProcessTreeSupervisor,
  type ProcessCleanupResult,
} from "./process-supervisor.js";

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

export function minimalEnvironment(
  extra: Record<string, string> = {},
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = inherited[name];
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

function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown process error";
  }
}

function findTransportFailures(
  output: string,
): NonNullable<CommandResult["transportFailures"]> {
  const failures: NonNullable<CommandResult["transportFailures"]> = [];
  for (const line of output.split("\n")) {
    const detail = line.trim();
    if (!detail) continue;
    const kind =
      /mcp/i.test(detail) && /(oauth|refresh|expired|auth)/i.test(detail)
        ? "mcp_auth"
        : /reconnect(?:ing|ed)?/i.test(detail)
          ? "reconnect"
          : /(transport|connection)\s+(?:error|failed|closed|lost)/i.test(
                detail,
              )
            ? "transport"
            : undefined;
    if (
      kind &&
      !failures.some(
        (failure) => failure.kind === kind && failure.detail === detail,
      )
    ) {
      failures.push({ kind, detail: redact(detail).slice(0, 512) });
    }
    if (failures.length === 20) break;
  }
  return failures;
}

interface SupervisedOptions {
  executable: string;
  args: string[];
  shell: boolean;
  input?: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface SupervisedResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError?: unknown;
  deadline?: NonNullable<CommandResult["deadline"]>;
}

function deadlineResult(
  expiredAt: string,
  cleanup: ProcessCleanupResult,
): NonNullable<CommandResult["deadline"]> {
  return {
    expiredAt,
    graceMs: cleanup.graceMs,
    cleanupDurationMs: cleanup.durationMs,
    cleanupComplete: cleanup.cleanupComplete,
    signalEscalation: cleanup.signalEscalation,
    remainingDescendants: cleanup.remainingDescendants,
  };
}

async function supervise(
  options: SupervisedOptions,
): Promise<SupervisedResult> {
  const owner = randomUUID();
  let subprocess;
  try {
    const executionOptions = {
      cwd: options.cwd,
      env: { ...options.env, AGENT_ARENA_PROCESS_OWNER: owner },
      reject: false as const,
      all: false as const,
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.signal === undefined ? {} : { cancelSignal: options.signal }),
    };
    subprocess = options.shell
      ? execaCommand(options.executable, {
          ...executionOptions,
          shell: true,
        })
      : execa(options.executable, options.args, executionOptions);
  } catch (spawnError) {
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      timedOut: false,
      spawnError,
    };
  }

  const supervisor =
    subprocess.pid === undefined
      ? undefined
      : new ProcessTreeSupervisor(subprocess.pid, owner);
  supervisor?.startTracking();
  let cleanup: Promise<ProcessCleanupResult> | undefined;
  let expiredAt: string | undefined;
  const beginCleanup = (): void => {
    if (cleanup !== undefined) return;
    subprocess.stdin?.destroy();
    subprocess.stdout?.destroy();
    subprocess.stderr?.destroy();
    cleanup = supervisor
      ? supervisor.cleanup((signal) => {
          try {
            subprocess.kill(signal);
          } catch {
            // The direct child may already have exited; execa reaps it.
          }
        })
      : Promise.resolve({
          durationMs: 0,
          graceMs: 0,
          cleanupComplete: false,
          signalEscalation: [],
          remainingDescendants: [],
        });
  };
  const deadlineTimer = setTimeout(() => {
    expiredAt = new Date().toISOString();
    beginCleanup();
  }, options.timeoutMs);
  const abortListener = (): void => beginCleanup();
  if (options.signal?.aborted) beginCleanup();
  else options.signal?.addEventListener("abort", abortListener, { once: true });

  try {
    const result = await subprocess;
    const cleanupResult = cleanup === undefined ? undefined : await cleanup;
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? null,
      signal: result.signal ?? null,
      timedOut: expiredAt !== undefined,
      ...(expiredAt !== undefined && cleanupResult !== undefined
        ? { deadline: deadlineResult(expiredAt, cleanupResult) }
        : {}),
    };
  } catch (spawnError) {
    const cleanupResult = cleanup === undefined ? undefined : await cleanup;
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      timedOut: expiredAt !== undefined,
      spawnError,
      ...(expiredAt !== undefined && cleanupResult !== undefined
        ? { deadline: deadlineResult(expiredAt, cleanupResult) }
        : {}),
    };
  } finally {
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", abortListener);
    supervisor?.stopTracking();
  }
}

async function run(
  request: ProcessRequest,
  executable: string,
  args: string[],
  shell: boolean,
  command: string,
  timeoutFailureClass?: FailureClass,
): Promise<CommandResult> {
  await mkdir(path.dirname(request.logPrefix), { recursive: true });
  const started = Date.now();
  const result = await supervise({
    executable,
    args,
    shell,
    cwd: request.cwd,
    env: minimalEnvironment(request.env),
    timeoutMs: request.timeoutMs,
    ...(request.input === undefined ? {} : { input: request.input }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
  const failureClass = result.spawnError
    ? (classifySpawnError(result.spawnError) ?? "arena_infrastructure")
    : result.deadline?.cleanupComplete === false
      ? "arena_infrastructure"
      : result.timedOut
        ? timeoutFailureClass
        : undefined;
  if (result.spawnError) {
    result.stderr = describeError(result.spawnError);
  }
  const stdoutPath = `${request.logPrefix}.stdout.log`;
  const stderrPath = `${request.logPrefix}.stderr.log`;
  await Promise.all([
    writeFile(stdoutPath, redact(result.stdout), "utf8"),
    writeFile(stderrPath, redact(result.stderr), "utf8"),
  ]);
  const transportFailures = findTransportFailures(
    `${result.stdout}\n${result.stderr}`,
  );
  const base = {
    command,
    cwd: request.cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    attempts: request.attempts ?? 1,
    durationMs: Date.now() - started,
    stdoutPath,
    stderrPath,
    ...(result.deadline ? { deadline: result.deadline } : {}),
    ...(transportFailures.length > 0 ? { transportFailures } : {}),
  };
  return failureClass ? { ...base, failureClass } : base;
}

export function runProcess(request: ProcessRequest): Promise<CommandResult> {
  return run(
    request,
    request.executable,
    request.args ?? [],
    false,
    request.displayCommand ??
      [request.executable, ...(request.args ?? [])]
        .map((part) => JSON.stringify(part))
        .join(" "),
    "agent_submission",
  );
}

export function runShellCommand(
  command: string,
  options: Omit<
    ProcessRequest,
    "executable" | "args" | "input" | "displayCommand"
  >,
): Promise<CommandResult> {
  return run({ ...options, executable: command }, command, [], true, command);
}
