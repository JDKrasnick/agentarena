import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PROCESS_CLEANUP_GRACE_MS = 2_000;
const PROCESS_SNAPSHOT_INTERVAL_MS = 100;
const PROCESS_SNAPSHOT_TTL_MS = PROCESS_SNAPSHOT_INTERVAL_MS;
const OWNER_ENV_NAME = "AGENT_ARENA_PROCESS_OWNER";
const TERM_SIGNAL_GRACE_MS = 500;
const FINAL_REAP_WAIT_MS = 500;

interface ProcessRecord {
  pid: number;
  ppid: number;
  identity: string;
  owner?: string;
}

export interface OwnedProcessIdentity {
  pid: number;
  identity: string;
}

export interface ProcessSignalEvent extends OwnedProcessIdentity {
  signal: "SIGTERM" | "SIGKILL";
  outcome: "sent" | "already_exited" | "identity_changed" | "error";
}

export interface ProcessCleanupResult {
  durationMs: number;
  graceMs: number;
  cleanupComplete: boolean;
  signalEscalation: ProcessSignalEvent[];
  remainingDescendants: OwnedProcessIdentity[];
}

async function readLinuxProcesses(): Promise<Map<number, ProcessRecord>> {
  const records = new Map<number, ProcessRecord>();
  const entries = await readdir("/proc", { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        const pid = Number(entry.name);
        try {
          const [stat, environment] = await Promise.all([
            readFile(`/proc/${entry.name}/stat`, "utf8"),
            readFile(`/proc/${entry.name}/environ`, "utf8").catch(() => ""),
          ]);
          const closingParen = stat.lastIndexOf(")");
          if (closingParen < 0) return;
          const fields = stat
            .slice(closingParen + 2)
            .trim()
            .split(/\s+/);
          const ppid = Number(fields[1]);
          const startTicks = fields[19];
          if (!Number.isInteger(ppid) || startTicks === undefined) return;
          const ownerEntry = environment
            .split("\0")
            .find((value) => value.startsWith(`${OWNER_ENV_NAME}=`));
          const owner = ownerEntry?.slice(OWNER_ENV_NAME.length + 1);
          records.set(pid, {
            pid,
            ppid,
            identity: `linux:${startTicks}`,
            ...(owner ? { owner } : {}),
          });
        } catch {
          // Processes routinely exit while /proc is being enumerated.
        }
      }),
  );
  return records;
}

async function readPsProcesses(): Promise<Map<number, ProcessRecord>> {
  const records = new Map<number, ProcessRecord>();
  const { stdout } = await execFileAsync(
    "ps",
    ["eww", "-axo", "pid=,ppid=,lstart=,command="],
    { timeout: 250, maxBuffer: 16 * 1024 * 1024 },
  );
  for (const line of stdout.split("\n")) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/,
    );
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const commandAndEnvironment = match[4] ?? "";
    const owner = commandAndEnvironment.match(
      new RegExp(`(?:^|\\s)${OWNER_ENV_NAME}=([^\\s]+)`),
    )?.[1];
    records.set(pid, {
      pid,
      ppid,
      identity: `ps:${createHash("sha256")
        .update(`${match[3]}:${owner ?? commandAndEnvironment}`)
        .digest("hex")}`,
      ...(owner ? { owner } : {}),
    });
  }
  return records;
}

let cachedProcesses: Map<number, ProcessRecord> | undefined;
let cachedAt = 0;
let processRead: Promise<Map<number, ProcessRecord>> | undefined;

async function readProcesses(
  fresh = false,
): Promise<Map<number, ProcessRecord>> {
  if (
    !fresh &&
    cachedProcesses !== undefined &&
    Date.now() - cachedAt < PROCESS_SNAPSHOT_TTL_MS
  ) {
    return cachedProcesses;
  }
  if (!fresh && processRead !== undefined) return processRead;
  const nextRead = (
    process.platform === "linux" ? readLinuxProcesses() : readPsProcesses()
  ).then((processes) => {
    cachedProcesses = processes;
    cachedAt = Date.now();
    return processes;
  });
  if (fresh) return nextRead;
  processRead = nextRead.finally(() => {
    processRead = undefined;
  });
  return processRead;
}

async function readProcessesBefore(
  deadlineAt: number,
): Promise<Map<number, ProcessRecord> | undefined> {
  const timeoutMs = deadlineAt - Date.now();
  if (timeoutMs <= 0) return undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      readProcesses(true),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type ProcessObserver = (processes: Map<number, ProcessRecord>) => void;

const processObservers = new Set<ProcessObserver>();
let processObserverLoop: Promise<void> | undefined;

async function observeProcessTable(): Promise<void> {
  while (processObservers.size > 0) {
    try {
      const processes = await readProcesses();
      for (const observer of processObservers) observer(processes);
    } catch {
      // Deadline cleanup performs bounded fresh reads and records failures.
    }
    if (processObservers.size === 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, PROCESS_SNAPSHOT_INTERVAL_MS);
      timer.unref();
    });
  }
}

function startProcessObserverLoop(): void {
  if (processObserverLoop === undefined) {
    processObserverLoop = observeProcessTable().finally(() => {
      processObserverLoop = undefined;
      if (processObservers.size > 0) startProcessObserverLoop();
    });
  }
}

function addProcessObserver(observer: ProcessObserver): () => void {
  processObservers.add(observer);
  startProcessObserverLoop();
  return () => processObservers.delete(observer);
}

export class ProcessTreeSupervisor {
  private readonly owned = new Map<number, string>();
  private stopObserving: (() => void) | undefined;

  constructor(
    private readonly rootPid: number,
    private readonly owner: string,
  ) {}

  startTracking(): void {
    if (this.stopObserving !== undefined) return;
    this.stopObserving = addProcessObserver((processes) => {
      this.remember(processes);
    });
  }

  stopTracking(): void {
    this.stopObserving?.();
    this.stopObserving = undefined;
  }

  private remember(processes: Map<number, ProcessRecord>): void {
    const ancestry = new Set(this.owned.keys());
    for (const record of processes.values()) {
      if (record.owner === this.owner) {
        ancestry.add(record.pid);
        this.owned.set(record.pid, record.identity);
      }
    }
    let found = true;
    while (found) {
      found = false;
      for (const record of processes.values()) {
        if (ancestry.has(record.pid)) continue;
        if (ancestry.has(record.ppid)) {
          ancestry.add(record.pid);
          this.owned.set(record.pid, record.identity);
          found = true;
        }
      }
    }
  }

  private async signalOwned(
    signal: "SIGTERM" | "SIGKILL",
    deadlineAt: number,
  ): Promise<ProcessSignalEvent[]> {
    const processes = await readProcessesBefore(deadlineAt);
    if (processes !== undefined) this.remember(processes);
    const events: ProcessSignalEvent[] = [];
    for (const [pid, identity] of [...this.owned.entries()].reverse()) {
      const current = processes?.get(pid);
      let outcome: ProcessSignalEvent["outcome"];
      if (processes === undefined) {
        outcome = "error";
      } else if (!current) {
        outcome = "already_exited";
      } else if (current.identity !== identity) {
        outcome = "identity_changed";
      } else {
        try {
          process.kill(pid, signal);
          outcome = "sent";
        } catch (error) {
          outcome =
            (error as NodeJS.ErrnoException).code === "ESRCH"
              ? "already_exited"
              : "error";
        }
      }
      events.push({ pid, identity, signal, outcome });
    }
    return events;
  }

  async cleanup(
    killRoot: (signal: NodeJS.Signals) => void,
  ): Promise<ProcessCleanupResult> {
    const started = Date.now();
    const deadlineAt = started + PROCESS_CLEANUP_GRACE_MS;
    killRoot("SIGTERM");
    const signalEscalation = await this.signalOwned("SIGTERM", deadlineAt);
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, Math.min(TERM_SIGNAL_GRACE_MS, deadlineAt - Date.now())),
      ),
    );
    killRoot("SIGKILL");
    signalEscalation.push(...(await this.signalOwned("SIGKILL", deadlineAt)));
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, Math.min(FINAL_REAP_WAIT_MS, deadlineAt - Date.now())),
      ),
    );

    const processes = await readProcessesBefore(deadlineAt);
    const remainingDescendants = [...this.owned.entries()]
      .filter(
        ([pid, identity]) =>
          pid !== this.rootPid &&
          (processes === undefined ||
            processes.get(pid)?.identity === identity),
      )
      .map(([pid, identity]) => ({ pid, identity }));
    const durationMs = Date.now() - started;
    this.stopTracking();
    return {
      durationMs,
      graceMs: PROCESS_CLEANUP_GRACE_MS,
      cleanupComplete:
        processes !== undefined &&
        remainingDescendants.length === 0 &&
        durationMs <= PROCESS_CLEANUP_GRACE_MS,
      signalEscalation,
      remainingDescendants,
    };
  }
}
