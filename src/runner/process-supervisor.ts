import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PROCESS_CLEANUP_GRACE_MS = 1_500;
const PROCESS_SNAPSHOT_TTL_MS = 1_000;
const OWNER_ENV_NAME = "AGENT_ARENA_PROCESS_OWNER";
const TERM_SIGNAL_GRACE_MS = 500;
const FINAL_REAP_WAIT_MS = 100;

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
    ["-axo", "pid=,ppid=,lstart=,command="],
    { timeout: 250 },
  );
  for (const line of stdout.split("\n")) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/,
    );
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    records.set(pid, {
      pid,
      ppid,
      identity: `ps:${createHash("sha256")
        .update(`${match[3]}:${match[4]}`)
        .digest("hex")}`,
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
  if (processRead !== undefined) return processRead;
  processRead = (
    process.platform === "linux" ? readLinuxProcesses() : readPsProcesses()
  )
    .then((processes) => {
      cachedProcesses = processes;
      cachedAt = Date.now();
      return processes;
    })
    .finally(() => {
      processRead = undefined;
    });
  return processRead;
}

export class ProcessTreeSupervisor {
  private readonly owned = new Map<number, string>();

  constructor(
    private readonly rootPid: number,
    private readonly owner: string,
  ) {}

  private async refresh(fresh = false): Promise<void> {
    let processes: Map<number, ProcessRecord>;
    try {
      processes = await readProcesses(fresh);
    } catch {
      return;
    }

    const root = processes.get(this.rootPid);
    if (root && !this.owned.has(this.rootPid)) {
      this.owned.set(this.rootPid, root.identity);
    }
    const ancestry = new Set([this.rootPid, ...this.owned.keys()]);
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
        if (record.pid === this.rootPid || ancestry.has(record.pid)) continue;
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
  ): Promise<ProcessSignalEvent[]> {
    await this.refresh(true);
    let processes: Map<number, ProcessRecord>;
    try {
      processes = await readProcesses(true);
    } catch {
      processes = new Map();
    }
    const events: ProcessSignalEvent[] = [];
    for (const [pid, identity] of [...this.owned.entries()].reverse()) {
      const current = processes.get(pid);
      let outcome: ProcessSignalEvent["outcome"];
      if (!current) {
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
    const signalEscalation = await this.signalOwned("SIGTERM");
    killRoot("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, TERM_SIGNAL_GRACE_MS));
    signalEscalation.push(...(await this.signalOwned("SIGKILL")));
    killRoot("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, FINAL_REAP_WAIT_MS));

    let processes: Map<number, ProcessRecord>;
    try {
      processes = await readProcesses(true);
    } catch {
      processes = new Map();
    }
    const remainingDescendants = [...this.owned.entries()]
      .filter(
        ([pid, identity]) =>
          pid !== this.rootPid && processes.get(pid)?.identity === identity,
      )
      .map(([pid, identity]) => ({ pid, identity }));
    return {
      durationMs: Date.now() - started,
      graceMs: PROCESS_CLEANUP_GRACE_MS,
      signalEscalation,
      remainingDescendants,
    };
  }
}
