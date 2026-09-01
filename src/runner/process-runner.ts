import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execa, execaCommand } from "execa";
import type { CommandResult, FailureClass } from "../core/types.js";
import {
  ProcessTreeSupervisor,
  type ProcessCleanupResult,
} from "./process-supervisor.js";
import {
  ProviderStreamDecoder,
  type ProviderActivity,
  type ProviderStreamDiagnostics,
  type ProviderStreamKind,
} from "../agents/provider-stream.js";
import {
  sealInvocationUsage,
  type ProviderInvocationMetadata,
} from "../telemetry/usage.js";

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

export const PROVIDER_ABSOLUTE_TIMEOUT_MULTIPLIER = 3;

function resolvedAbsoluteTimeoutMs(
  softTimeoutMs: number,
  providerStream: ProviderStreamKind | undefined,
  override: number | undefined,
): number {
  if (!providerStream) return softTimeoutMs;
  return Math.max(
    softTimeoutMs,
    override ?? softTimeoutMs * PROVIDER_ABSOLUTE_TIMEOUT_MULTIPLIER,
  );
}

export interface ProcessRequest {
  executable: string;
  args?: string[];
  input?: string;
  displayCommand?: string;
  cwd: string;
  timeoutMs: number;
  absoluteTimeoutMs?: number;
  logPrefix: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  attempts?: number;
  secrets?: readonly string[];
  onOutput?: (
    stream: "stdout" | "stderr",
    text: string,
  ) => void | Promise<void>;
  providerStream?: ProviderStreamKind;
  onActivity?: (activity: ProviderActivity) => void | Promise<void>;
  providerInvocation?: ProviderInvocationMetadata;
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

function isProviderInitializationRecord(detail: string): boolean {
  if (!detail.startsWith("{")) return false;
  try {
    const record = JSON.parse(detail) as Record<string, unknown>;
    return (
      record.type === "init" ||
      (record.type === "system" && record.subtype === "init")
    );
  } catch {
    return false;
  }
}

function isAmbientMcpStartupWarning(detail: string): boolean {
  return (
    /codex_rmcp_client::oauth::refresh_transaction/i.test(detail) &&
    /for server\s+[^\s:]+/i.test(detail)
  );
}

function findTransportFailures(
  output: string,
  secrets: readonly string[] = [],
  ambientMcpWasNonFatal = false,
): NonNullable<CommandResult["transportFailures"]> {
  const failures: NonNullable<CommandResult["transportFailures"]> = [];
  for (const line of output.split("\n")) {
    const detail = line.trim();
    if (!detail) continue;
    // Provider init records describe every configured MCP server. An optional
    // server may be unauthenticated or unavailable while the agent itself is
    // healthy, so the aggregate record is not evidence of an invocation-level
    // transport failure.
    if (isProviderInitializationRecord(detail)) continue;
    // Codex reports optional MCP OAuth refresh failures during startup on
    // stderr, then continues the turn normally. Preserve that warning in the
    // stderr artifact without promoting it to an invocation failure.
    if (ambientMcpWasNonFatal && isAmbientMcpStartupWarning(detail)) continue;
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
  absoluteTimeoutMs?: number;
  signal?: AbortSignal;
  secrets?: readonly string[];
  onOutput?: ProcessRequest["onOutput"];
  providerStream?: ProviderStreamKind;
  onActivity?: ProcessRequest["onActivity"];
}

interface SupervisedResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError?: unknown;
  deadline?: NonNullable<CommandResult["deadline"]>;
  timeoutPolicy?: NonNullable<CommandResult["timeoutPolicy"]>;
  providerEvents?: readonly ProviderActivity[];
  providerDiagnostics?: ProviderStreamDiagnostics;
  providerRawOutput?: string;
}

function deadlineResult(
  kind: NonNullable<CommandResult["deadline"]>["kind"],
  expiredAt: string,
  elapsedMs: number,
  lastProgressAt: string | undefined,
  cleanup: ProcessCleanupResult,
): NonNullable<CommandResult["deadline"]> {
  return {
    kind,
    expiredAt,
    elapsedMs,
    ...(lastProgressAt ? { lastProgressAt } : {}),
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
  const startedAtMs = Date.now();
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
  let providerRawOutput = "";
  let outputQueue: Promise<void> = Promise.resolve();
  const redactors = {
    stdout: new StreamingRedactor(options.secrets),
    stderr: new StreamingRedactor(options.secrets),
  };
  const decoder = options.providerStream
    ? new ProviderStreamDecoder(options.providerStream)
    : undefined;
  let recordProviderProgress = (): void => undefined;
  const publish = (stream: "stdout" | "stderr", text: string): void => {
    if (!text) return;
    if (stream === "stdout") stdout += text;
    else stderr += text;
    outputQueue = outputQueue.then(async () => {
      await options.onOutput?.(stream, text);
    });
  };
  const flushStreams = (): void => {
    if (decoder) publishProviderUpdate(decoder.flush());
    publish("stdout", redactors.stdout.flush());
    publish("stderr", redactors.stderr.flush());
  };
  const publishProviderUpdate = (
    update: ReturnType<ProviderStreamDecoder["push"]>,
  ): void => {
    for (let index = 0; index < update.deadlineProgressCount; index += 1) {
      recordProviderProgress();
    }
    for (const activity of update.activities) {
      outputQueue = outputQueue.then(async () => {
        await options.onActivity?.(activity);
      });
    }
    for (const text of update.assistantText) {
      publish("stdout", redactors.stdout.push(`${text}\n`));
    }
    for (const text of update.assistantDeltas) {
      publish("stdout", redactors.stdout.push(text));
    }
  };
  subprocess.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (decoder) {
      providerRawOutput += text;
      publishProviderUpdate(decoder.push(text));
    } else publish("stdout", redactors.stdout.push(text));
  });
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
  let expiredElapsedMs: number | undefined;
  let timeoutKind: NonNullable<CommandResult["deadline"]>["kind"] | undefined;
  let lastProgressAt: string | undefined;
  let progressExtensions = 0;
  let softDeadlineAt = startedAtMs + options.timeoutMs;
  const absoluteTimeoutMs = resolvedAbsoluteTimeoutMs(
    options.timeoutMs,
    options.providerStream,
    options.absoluteTimeoutMs,
  );
  const absoluteDeadlineAt = startedAtMs + absoluteTimeoutMs;
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
  const expire = (
    kind: NonNullable<CommandResult["deadline"]>["kind"],
  ): void => {
    if (expiredAt !== undefined || cleanup !== undefined) return;
    timeoutKind = kind;
    expiredAt = new Date().toISOString();
    expiredElapsedMs = Date.now() - startedAtMs;
    beginCleanup();
  };
  let softDeadlineTimer: NodeJS.Timeout | undefined;
  const scheduleSoftDeadline = (): void => {
    if (softDeadlineTimer) clearTimeout(softDeadlineTimer);
    softDeadlineTimer = setTimeout(
      () => {
        if (Date.now() < softDeadlineAt) {
          scheduleSoftDeadline();
          return;
        }
        if (decoder && Date.now() >= absoluteDeadlineAt) {
          expire("absolute");
          return;
        }
        expire(decoder ? "idle" : "fixed");
      },
      Math.max(1, softDeadlineAt - Date.now()),
    );
  };
  recordProviderProgress = (): void => {
    if (!decoder || expiredAt !== undefined || cleanup !== undefined) return;
    const progressedAtMs = Date.now();
    lastProgressAt = new Date(progressedAtMs).toISOString();
    const extendedDeadline = Math.min(
      progressedAtMs + options.timeoutMs,
      absoluteDeadlineAt,
    );
    if (extendedDeadline > softDeadlineAt) {
      softDeadlineAt = extendedDeadline;
      progressExtensions += 1;
      scheduleSoftDeadline();
    }
  };
  scheduleSoftDeadline();
  const absoluteDeadlineTimer = decoder
    ? setTimeout(
        () => expire("absolute"),
        Math.max(1, absoluteDeadlineAt - Date.now()),
      )
    : undefined;
  const timeoutPolicy: NonNullable<CommandResult["timeoutPolicy"]> = {
    mode: decoder ? "progress_extended" : "fixed",
    softTimeoutMs: options.timeoutMs,
    absoluteTimeoutMs,
    startedAt: new Date(startedAtMs).toISOString(),
    initialSoftDeadlineAt: new Date(
      startedAtMs + options.timeoutMs,
    ).toISOString(),
    absoluteDeadlineAt: new Date(absoluteDeadlineAt).toISOString(),
    progressExtensions,
  };
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
      timeoutPolicy: {
        ...timeoutPolicy,
        ...(lastProgressAt ? { lastProgressAt } : {}),
        progressExtensions,
      },
      ...(expiredAt !== undefined && cleanupResult !== undefined
        ? {
            deadline: deadlineResult(
              timeoutKind!,
              expiredAt,
              expiredElapsedMs!,
              lastProgressAt,
              cleanupResult,
            ),
          }
        : {}),
      ...(decoder
        ? {
            providerEvents: decoder.eventLog(),
            providerDiagnostics: decoder.diagnostics(),
            providerRawOutput,
          }
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
      timeoutPolicy: {
        ...timeoutPolicy,
        ...(lastProgressAt ? { lastProgressAt } : {}),
        progressExtensions,
      },
      ...(expiredAt !== undefined && cleanupResult !== undefined
        ? {
            deadline: deadlineResult(
              timeoutKind!,
              expiredAt,
              expiredElapsedMs!,
              lastProgressAt,
              cleanupResult,
            ),
          }
        : {}),
      ...(decoder
        ? {
            providerEvents: decoder.eventLog(),
            providerDiagnostics: decoder.diagnostics(),
            providerRawOutput,
          }
        : {}),
    };
  } finally {
    if (softDeadlineTimer) clearTimeout(softDeadlineTimer);
    if (absoluteDeadlineTimer) clearTimeout(absoluteDeadlineTimer);
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
    ...(request.absoluteTimeoutMs === undefined
      ? {}
      : { absoluteTimeoutMs: request.absoluteTimeoutMs }),
    ...(request.input === undefined ? {} : { input: request.input }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.secrets === undefined ? {} : { secrets: request.secrets }),
    ...(request.onOutput === undefined ? {} : { onOutput: request.onOutput }),
    ...(request.providerStream === undefined
      ? {}
      : { providerStream: request.providerStream }),
    ...(request.onActivity === undefined
      ? {}
      : { onActivity: request.onActivity }),
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
  const eventLogPath = `${request.logPrefix}.events.jsonl`;
  await Promise.all([
    writeFile(stdoutPath, redact(result.stdout, request.secrets), "utf8"),
    writeFile(stderrPath, redact(result.stderr, request.secrets), "utf8"),
    ...(result.providerEvents
      ? [
          writeFile(
            eventLogPath,
            result.providerEvents
              .map((event) => JSON.stringify(event))
              .join("\n") + (result.providerEvents.length ? "\n" : ""),
            "utf8",
          ),
        ]
      : []),
  ]);
  const transportFailures = findTransportFailures(
    `${result.providerRawOutput ?? result.stdout}\n${result.stderr}`,
    request.secrets,
    result.exitCode === 0 ||
      result.providerEvents?.some((event) =>
        ["message", "tool_started", "tool_finished", "result"].includes(
          event.kind,
        ),
      ) === true,
  );
  const base = {
    command: redact(command, request.secrets),
    cwd: request.cwd,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    attempts: request.attempts ?? 1,
    durationMs: Date.now() - started,
    stdoutPath,
    stderrPath,
    timeoutPolicy: result.timeoutPolicy ?? {
      mode: request.providerStream ? "progress_extended" : "fixed",
      softTimeoutMs: request.timeoutMs,
      absoluteTimeoutMs: resolvedAbsoluteTimeoutMs(
        request.timeoutMs,
        request.providerStream,
        request.absoluteTimeoutMs,
      ),
      startedAt: new Date(started).toISOString(),
      initialSoftDeadlineAt: new Date(
        started + request.timeoutMs,
      ).toISOString(),
      absoluteDeadlineAt: new Date(
        started +
          resolvedAbsoluteTimeoutMs(
            request.timeoutMs,
            request.providerStream,
            request.absoluteTimeoutMs,
          ),
      ).toISOString(),
      progressExtensions: 0,
    },
    ...(result.deadline ? { deadline: result.deadline } : {}),
    ...(transportFailures.length > 0 ? { transportFailures } : {}),
    ...(result.providerDiagnostics
      ? {
          providerDiagnostics: {
            ...result.providerDiagnostics,
            eventLogPath,
          },
        }
      : {}),
  };
  const commandResult: CommandResult = failureClass
    ? { ...base, failureClass }
    : base;
  if (request.providerInvocation) {
    try {
      await sealInvocationUsage({
        logPrefix: request.logPrefix,
        metadata: request.providerInvocation,
        result: commandResult,
        startedAt: new Date(started),
        finishedAt: new Date(),
      });
    } catch {
      // Evidence-only telemetry cannot change an invocation's outcome.
    }
  }
  return commandResult;
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
