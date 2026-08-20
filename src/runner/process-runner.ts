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
const CREDENTIAL_CANDIDATE =
  /\b(?:ghp|github_pat|sk|xox[baprs])[-_A-Za-z0-9]*/g;

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
  secrets?: readonly string[];
  onOutput?: (
    stream: "stdout" | "stderr",
    text: string,
  ) => void | Promise<void>;
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

/** Delays a small tail so credentials split across process chunks are redacted. */
export class StreamingRedactor {
  private pending = "";
  private readonly retainedCharacters: number;

  constructor(private readonly secrets: readonly string[] = []) {
    this.retainedCharacters = Math.max(
      256,
      ...secrets.map((secret) => secret.length + 16),
    );
  }

  push(chunk: string): string {
    this.pending += chunk;
    if (this.pending.length <= this.retainedCharacters) return "";
    const splitAt = this.safeSplitAt(
      this.pending.length - this.retainedCharacters,
    );
    const output = this.pending.slice(0, splitAt);
    this.pending = this.pending.slice(splitAt);
    return redact(output, this.secrets);
  }

  flush(): string {
    const output = redact(this.pending, this.secrets);
    this.pending = "";
    return output;
  }

  private safeSplitAt(initialSplit: number): number {
    let splitAt = initialSplit;
    let moved: boolean;
    do {
      moved = false;
      for (const secret of this.secrets.filter((value) => value.length >= 4)) {
        let match = this.pending.indexOf(
          secret,
          Math.max(0, splitAt - secret.length + 1),
        );
        while (match !== -1 && match < splitAt) {
          if (match + secret.length > splitAt) {
            splitAt = match;
            moved = true;
            break;
          }
          match = this.pending.indexOf(secret, match + 1);
        }
      }

      CREDENTIAL_CANDIDATE.lastIndex = 0;
      for (const match of this.pending.matchAll(CREDENTIAL_CANDIDATE)) {
        const start = match.index;
        const end = start + match[0].length;
        if (start < splitAt && end > splitAt) {
          splitAt = start;
          moved = true;
          break;
        }
      }
    } while (moved);
    return splitAt;
  }
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
  secrets: readonly string[] = [],
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
      failures.push({ kind, detail: redact(detail, secrets).slice(0, 512) });
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
  secrets?: readonly string[];
  onOutput?: ProcessRequest["onOutput"];
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

  let stdout = "";
  let stderr = "";
  let outputQueue: Promise<void> = Promise.resolve();
  const redactors = {
    stdout: new StreamingRedactor(options.secrets),
    stderr: new StreamingRedactor(options.secrets),
  };
  const publish = (stream: "stdout" | "stderr", text: string): void => {
    if (!text) return;
    if (stream === "stdout") stdout += text;
    else stderr += text;
    outputQueue = outputQueue.then(async () => {
      await options.onOutput?.(stream, text);
    });
  };
  const flushStreams = (): void => {
    publish("stdout", redactors.stdout.flush());
    publish("stderr", redactors.stderr.flush());
  };
  subprocess.stdout?.on("data", (chunk: Buffer) =>
    publish("stdout", redactors.stdout.push(chunk.toString("utf8"))),
  );
  subprocess.stderr?.on("data", (chunk: Buffer) =>
    publish("stderr", redactors.stderr.push(chunk.toString("utf8"))),
  );

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
    flushStreams();
    await outputQueue;
    const cleanupResult = cleanup === undefined ? undefined : await cleanup;
    return {
      stdout,
      stderr,
      exitCode: result.exitCode ?? null,
      signal: result.signal ?? null,
      timedOut: expiredAt !== undefined,
      ...(expiredAt !== undefined && cleanupResult !== undefined
        ? { deadline: deadlineResult(expiredAt, cleanupResult) }
        : {}),
    };
  } catch (spawnError) {
    flushStreams();
    await outputQueue;
    const cleanupResult = cleanup === undefined ? undefined : await cleanup;
    return {
      stdout,
      stderr,
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
    ...(request.secrets === undefined ? {} : { secrets: request.secrets }),
    ...(request.onOutput === undefined ? {} : { onOutput: request.onOutput }),
  });
  const failureClass = result.spawnError
    ? (classifySpawnError(result.spawnError) ?? "arena_infrastructure")
    : result.deadline?.cleanupComplete === false
      ? "arena_infrastructure"
      : result.timedOut
        ? timeoutFailureClass
        : undefined;
  if (result.spawnError) {
    result.stderr = redact(describeError(result.spawnError), request.secrets);
    await request.onOutput?.("stderr", result.stderr);
  }
  const stdoutPath = `${request.logPrefix}.stdout.log`;
  const stderrPath = `${request.logPrefix}.stderr.log`;
  await Promise.all([
    writeFile(stdoutPath, redact(result.stdout, request.secrets), "utf8"),
    writeFile(stderrPath, redact(result.stderr, request.secrets), "utf8"),
  ]);
  const transportFailures = findTransportFailures(
    `${result.stdout}\n${result.stderr}`,
    request.secrets,
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
