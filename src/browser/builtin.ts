import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  access,
  mkdir,
  open,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import {
  minimalEnvironment,
  runShellCommand,
} from "../runner/process-runner.js";
import { ProcessTreeSupervisor } from "../runner/process-supervisor.js";
import type {
  BrowserArtifact,
  BrowserProbeResult,
  BrowserUnavailableReason,
} from "../contracts/browser.js";
import {
  BrowserInfrastructureError,
  type BrowserAdapter,
  type BrowserSession,
} from "./executor.js";

const CHROMIUM_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
] as const;

const DOM_XSS_CANARY_ATTRIBUTE = "data-agent-arena-dom-xss-canary";
const DOM_XSS_CANARY_PAYLOAD = `<span ${DOM_XSS_CANARY_ATTRIBUTE}="present"></span>`;

/** Smallest readiness window; slower services scale with the stage budget. */
const MIN_READINESS_MS = 15_000;
/** Share of the remaining stage budget a service may spend becoming healthy. */
const READINESS_BUDGET_SHARE = 0.5;
/** Share of the remaining stage budget the repository-native suite may spend. */
const NATIVE_SUITE_BUDGET_SHARE = 0.6;
/** A missing application condition must fail a probe before exhausting the stage. */
const PROBE_ACTION_TIMEOUT_MS = 5_000;
/** Grace period teardown always receives, measured from when teardown starts. */
const TEARDOWN_GRACE_MS = 1_500;

function readPlaywrightCoreVersion(): string {
  try {
    const manifestPath = createRequire(import.meta.url).resolve(
      "playwright-core/package.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      version?: unknown;
    };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

let playwrightCoreVersion: string | undefined;

function toolVersion(): string {
  playwrightCoreVersion ??= readPlaywrightCoreVersion();
  return `playwright-core-${playwrightCoreVersion}`;
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new BrowserInfrastructureError(
      "Unable to allocate a dynamic loopback port",
      "launch_failure",
      "harness_configuration",
    );
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function assertLoopbackPortAvailable(value: string): Promise<void> {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
  )
    return;
  const port = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
  } catch {
    throw new BrowserInfrastructureError(
      `Fixed browser origin is already in use: ${url.origin}`,
      "launch_failure",
      "harness_configuration",
    );
  } finally {
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function replacePort(value: string, port: number): string {
  const url = new URL(value);
  url.port = String(port);
  return url.href.replace(/\/$/u, "");
}

async function chromiumExecutable(): Promise<string> {
  const candidates = [
    ...(process.env.CHROME_BIN ? [process.env.CHROME_BIN] : []),
    ...CHROMIUM_PATHS,
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through the fixed executable allowlist.
    }
  }
  throw new BrowserInfrastructureError(
    "No installed Chrome or Chromium executable was found",
    "browser_missing",
  );
}

function viewport(profile: "desktop" | "mobile" | "reflow_320") {
  if (profile === "mobile")
    return {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    };
  if (profile === "reflow_320")
    return {
      viewport: { width: 320, height: 844 },
      hasTouch: false,
      isMobile: false,
    };
  return {
    viewport: { width: 1440, height: 900 },
    hasTouch: false,
    isMobile: false,
  };
}

function safePath(baseUrl: string, value: string): string {
  const resolved = new URL(value, baseUrl);
  if (resolved.origin !== new URL(baseUrl).origin)
    throw new BrowserInfrastructureError(
      `Probe navigation escaped the approved application origin: ${resolved.origin}`,
      "unapproved_origin",
      "harness_configuration",
    );
  return resolved.href;
}

function transportOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  return url.origin;
}

function approvedNetworkOrigin(input: {
  value: string;
  allowedOrigins: string[];
  runtimeBaseUrl: string;
  dynamicPort: boolean;
}): boolean {
  const url = new URL(input.value);
  const exactOrigin = url.origin;
  const approvedTransportOrigin = transportOrigin(input.value);
  return (
    input.allowedOrigins.includes(exactOrigin) ||
    input.allowedOrigins.includes(approvedTransportOrigin) ||
    (input.dynamicPort &&
      transportOrigin(input.runtimeBaseUrl) === approvedTransportOrigin)
  );
}

async function stopProcess(
  child: ChildProcess,
  supervisor: ProcessTreeSupervisor | undefined,
): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) {
    supervisor?.stopTracking();
    return;
  }
  if (supervisor) {
    // Same descendant tracking and identity-checked escalation the rest of the
    // runner uses, so a dev server that spawns workers outside the process
    // group cannot survive teardown and hold the port.
    await supervisor.cleanup((signal) => {
      try {
        child.kill(signal);
      } catch {
        // The direct child may already have exited.
      }
    });
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(1_000).then(() => undefined),
  ]);
  if (child.exitCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process exited between the identity check and escalation.
    }
  }
}

async function executeActions(
  page: Page,
  baseUrl: string,
  actions: Parameters<BrowserSession["runProbe"]>[0]["request"]["actions"],
): Promise<void> {
  for (const action of actions) {
    if (action.kind === "goto") {
      await page.goto(safePath(baseUrl, action.path));
    } else if (action.kind === "click") {
      await page
        .getByRole(action.role as Parameters<Page["getByRole"]>[0], {
          name: action.name,
          exact: true,
        })
        .click();
    } else if (action.kind === "fill") {
      await page.getByLabel(action.label, { exact: true }).fill(action.value);
    } else if (action.kind === "fill_dom_xss_canary") {
      await page
        .getByLabel(action.label, { exact: true })
        .fill(DOM_XSS_CANARY_PAYLOAD);
    } else if (action.kind === "press") {
      await page.keyboard.press(action.key);
    } else if (action.kind === "reload") {
      await page.reload();
    } else if (action.kind === "assert_text") {
      await page.getByText(action.text, { exact: true }).waitFor({
        state: "visible",
      });
    } else if (action.kind === "assert_visible") {
      await page
        .getByRole(action.role as Parameters<Page["getByRole"]>[0], {
          name: action.name,
          exact: true,
        })
        .waitFor({ state: "visible" });
    } else if (action.kind === "assert_url") {
      if (page.url() !== safePath(baseUrl, action.value))
        throw new Error(
          `Expected URL ${safePath(baseUrl, action.value)}, received ${page.url()}`,
        );
    }
  }
}

async function familyInvariant(
  page: Page,
  family: Parameters<BrowserSession["runProbe"]>[0]["request"]["family"],
): Promise<string | undefined> {
  if (family === "responsive") {
    const overflow = await page.evaluate(
      "document.documentElement.scrollWidth > document.documentElement.clientWidth",
    );
    return overflow ? "Document has horizontal overflow" : undefined;
  }
  if (family === "keyboard_focus") {
    const focus = await page.evaluate(
      "({tag: document.activeElement?.tagName ?? '', visible: document.activeElement?.matches(':focus-visible') ?? false})",
    );
    const value = focus as { tag: string; visible: boolean };
    return !value.tag || value.tag === "BODY" || !value.visible
      ? "Keyboard focus is missing or not visibly indicated"
      : undefined;
  }
  if (family === "semantics") {
    const controls = page.locator(
      'button,input,select,textarea,a[href],[role="button"],[role="link"]',
    );
    const controlCount = await controls.count();
    // Playwright owns accessible-name computation; issue the snapshots
    // concurrently instead of one sequential round trip per control.
    const snapshots = await Promise.all(
      Array.from({ length: controlCount }, (_value, index) =>
        controls.nth(index).ariaSnapshot(),
      ),
    );
    const missingCount = snapshots.filter((snapshot) => {
      if (!snapshot) return false;
      const root = snapshot.split("\n", 1)[0]?.trim() ?? "";
      return !/^-\s+\S+\s+"/u.test(root);
    }).length;
    return missingCount > 0
      ? `${String(missingCount)} actionable element(s) lack an accessible name`
      : undefined;
  }
  if (family === "runtime_dom_integrity") {
    const duplicates = await page.evaluate(`(() => {
      const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
      return ids.filter((id, index) => ids.indexOf(id) !== index);
    })()`);
    return Array.isArray(duplicates) && duplicates.length
      ? `Duplicate critical IDs: ${duplicates.join(", ")}`
      : undefined;
  }
  if (family === "dom_security") {
    const interpretedAsMarkup = await page.evaluate(
      `Boolean(document.querySelector('[${DOM_XSS_CANARY_ATTRIBUTE}="present"]'))`,
    );
    return interpretedAsMarkup
      ? "The inert DOM-XSS canary was interpreted as markup"
      : undefined;
  }
  return undefined;
}

function nativeSuiteEnvironment(
  profile: NonNullable<
    Parameters<BrowserAdapter["launch"]>[0]["plan"]["profile"]
  >,
): Record<string, string> {
  // Both service modes receive the resolved runtime address. `self_managed`
  // owns the service lifecycle rather than the port choice: Arena still
  // reserves the port and the suite binds it before Arena starts its own
  // service, which is what keeps the two from colliding.
  const port = new URL(profile.baseUrl).port;
  return {
    ...(port ? { PORT: port } : {}),
    BASE_URL: profile.baseUrl,
    PLAYWRIGHT_BASE_URL: profile.baseUrl,
    CYPRESS_BASE_URL: profile.baseUrl,
  };
}

async function runNativeSuiteCommand(
  input: Parameters<BrowserAdapter["launch"]>[0],
): Promise<Omit<BrowserProbeResult, "contextId" | "requiredCapabilityIds">> {
  // Leave room in the stage budget for the probe phase; a slow repository
  // suite should not starve the probes it exists alongside.
  const remainingMs = Math.max(1, input.deadlineAt - Date.now());
  const result = await runShellCommand(input.plan.profile.testCommand, {
    cwd: input.worktree,
    timeoutMs: Math.max(1, Math.floor(remainingMs * NATIVE_SUITE_BUDGET_SHARE)),
    logPrefix: path.join(input.artifactDirectory, "native-suite"),
    env: nativeSuiteEnvironment(input.plan.profile),
    signal: input.signal,
  });
  const artifacts: BrowserArtifact[] = [
    { kind: "runner_result", path: result.stdoutPath, failureOnly: false },
    { kind: "runner_result", path: result.stderrPath, failureOnly: false },
  ];
  return {
    family: "visual_regression",
    profile: "repository_native",
    status:
      result.failureClass === "arena_infrastructure"
        ? "unverified"
        : result.exitCode === 0
          ? "verified"
          : "failed",
    ...(result.failureClass === "arena_infrastructure"
      ? { reason: "launch_failure" as const }
      : result.exitCode === 0
        ? {}
        : { reason: "application_failure" as const }),
    detail: `Repository-native browser command exited with ${String(result.exitCode)}`,
    blockedOrigins: [],
    artifacts,
  };
}

class BuiltInBrowserSession implements BrowserSession {
  readonly artifacts: BrowserArtifact[];
  readonly toolVersion = toolVersion();
  browserVersion = "unlaunched";
  private browser?: Browser;

  constructor(
    private readonly input: Parameters<BrowserAdapter["launch"]>[0],
    private readonly child: ChildProcess,
    private readonly supervisor: ProcessTreeSupervisor | undefined,
    private readonly stdout: FileHandle,
    private readonly stderr: FileHandle,
    artifacts: BrowserArtifact[],
  ) {
    this.artifacts = artifacts;
  }

  async waitUntilReady(): Promise<void> {
    // Scale readiness with the stage budget so a slower contestant service is
    // not misread as an application failure, while still reserving time for
    // the probe phase.
    const readinessMs = Math.max(
      MIN_READINESS_MS,
      Math.floor((this.input.deadlineAt - Date.now()) * READINESS_BUDGET_SHARE),
    );
    const deadline = Math.min(Date.now() + readinessMs, this.input.deadlineAt);
    while (Date.now() < deadline) {
      if (this.input.signal.aborted)
        throw new BrowserInfrastructureError(
          "Browser run interrupted",
          "interrupted",
        );
      if (this.child.exitCode !== null)
        throw new BrowserInfrastructureError(
          `Startup command exited with ${String(this.child.exitCode)}`,
          "server_command_failure",
          "harness_configuration",
        );
      try {
        const response = await fetch(this.input.plan.profile.healthUrl, {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) break;
      } catch {
        // Poll until the bounded deadline.
      }
      await delay(150);
    }
    if (Date.now() >= deadline)
      throw new BrowserInfrastructureError(
        "Browser service health check timed out",
        "health_failure",
        "harness_configuration",
      );
    const executablePath = await chromiumExecutable();
    this.browser = await chromium.launch({ executablePath, headless: true });
    this.browserVersion = this.browser.version();
  }

  async runNativeSuite(): Promise<
    Omit<BrowserProbeResult, "contextId" | "requiredCapabilityIds">
  > {
    return runNativeSuiteCommand(this.input);
  }

  async runProbe({
    request,
    contextId,
    allowedOrigins,
    harnessOwned,
  }: Parameters<BrowserSession["runProbe"]>[0]): Promise<
    Omit<BrowserProbeResult, "contextId" | "requiredCapabilityIds">
  > {
    if (!this.browser)
      throw new BrowserInfrastructureError(
        "Browser session was not provisioned",
        "launch_failure",
      );
    const blockedOrigins: string[] = [];
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let phase: "provision" | "application" = "provision";
    try {
      context = await this.browser.newContext({
        ...viewport(request.profile),
        serviceWorkers: "block",
      });
      context.setDefaultTimeout(
        Math.max(
          1,
          Math.min(PROBE_ACTION_TIMEOUT_MS, this.input.deadlineAt - Date.now()),
        ),
      );
      context.setDefaultNavigationTimeout(
        Math.max(1, this.input.deadlineAt - Date.now()),
      );
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (
          ["about:", "data:", "blob:"].includes(url.protocol) ||
          approvedNetworkOrigin({
            value: url.href,
            allowedOrigins,
            runtimeBaseUrl: this.input.plan.profile.baseUrl,
            dynamicPort: this.input.plan.profile.portMode === "dynamic",
          })
        )
          await route.continue();
        else {
          blockedOrigins.push(url.origin);
          await route.abort("blockedbyclient");
        }
      });
      await context.routeWebSocket("**/*", async (webSocket) => {
        const url = new URL(webSocket.url());
        if (
          approvedNetworkOrigin({
            value: url.href,
            allowedOrigins,
            runtimeBaseUrl: this.input.plan.profile.baseUrl,
            dynamicPort: this.input.plan.profile.portMode === "dynamic",
          })
        ) {
          webSocket.connectToServer();
          return;
        }
        blockedOrigins.push(url.origin);
        await webSocket.close({
          code: 1008,
          reason: "WebSocket origin was not approved",
        });
      });
      page = await context.newPage();
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => pageErrors.push(error.message));
      phase = "application";
      await executeActions(
        page,
        this.input.plan.profile.baseUrl,
        request.actions,
      );
      const invariant = await familyInvariant(page, request.family);
      // Harness-owned smoke probes assert only what the repository opted into
      // by having a browser lane at all: no uncaught runtime errors and the
      // family invariant. Console noise and blocked third-party origins are
      // recorded as diagnostics, because an approved profile allows exactly
      // one origin and ordinary applications legitimately reference CDNs.
      // A contestant-selected probe declares its own expected behavior, so it
      // keeps the stricter reading.
      const failures = [
        ...pageErrors,
        ...(invariant ? [invariant] : []),
        ...(harnessOwned ? [] : consoleErrors),
        ...(harnessOwned || !blockedOrigins.length
          ? []
          : [
              `Blocked unapproved origin(s): ${[...new Set(blockedOrigins)].join(", ")}`,
            ]),
      ];
      const diagnostics = [
        ...failures,
        ...(harnessOwned ? consoleErrors : []),
        ...(harnessOwned && blockedOrigins.length
          ? [
              `Recorded blocked origin(s): ${[...new Set(blockedOrigins)].join(", ")}`,
            ]
          : []),
      ];
      const status = failures.length ? "failed" : "verified";
      const artifacts: BrowserArtifact[] = [];
      if (status === "failed") {
        const screenshotPath = path.join(
          this.input.artifactDirectory,
          `${contextId}.png`,
        );
        await page.screenshot({ path: screenshotPath, fullPage: true });
        artifacts.push({
          kind: "screenshot",
          path: screenshotPath,
          failureOnly: true,
        });
      }
      if (blockedOrigins.length) {
        const blockedPath = path.join(
          this.input.artifactDirectory,
          `${contextId}-blocked-origins.json`,
        );
        await writeFile(
          blockedPath,
          `${JSON.stringify([...new Set(blockedOrigins)], null, 2)}\n`,
        );
        artifacts.push({
          kind: "blocked_origin",
          path: blockedPath,
          // Blocked origins are evidence whether or not the probe failed.
          failureOnly: false,
        });
      }
      return {
        family: request.family,
        profile: request.profile,
        status,
        ...(status === "failed"
          ? { reason: "application_failure" as const }
          : {}),
        detail: diagnostics.join("; ") || request.expectedBehavior,
        blockedOrigins: [...new Set(blockedOrigins)],
        artifacts,
      };
    } catch (error) {
      if (error instanceof BrowserInfrastructureError) throw error;
      if (
        phase === "provision" ||
        (error instanceof Error &&
          /(?:browser|context|page|target).*(?:closed|crashed)|connection closed|target crashed/iu.test(
            error.message,
          ))
      )
        throw new BrowserInfrastructureError(
          error instanceof Error ? error.message : String(error),
          "launch_failure",
        );
      const screenshotPath = path.join(
        this.input.artifactDirectory,
        `${contextId}.png`,
      );
      if (page)
        await page
          .screenshot({ path: screenshotPath, fullPage: true })
          .catch(() => undefined);
      return {
        family: request.family,
        profile: request.profile,
        status: "failed",
        reason: "application_failure",
        detail: error instanceof Error ? error.message : String(error),
        blockedOrigins: [...new Set(blockedOrigins)],
        artifacts: page
          ? [{ kind: "screenshot", path: screenshotPath, failureOnly: true }]
          : [],
      };
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    await stopProcess(this.child, this.supervisor);
    await Promise.all([
      this.stdout.close().catch(() => undefined),
      this.stderr.close().catch(() => undefined),
    ]);
    if (this.input.plan.profile.teardownCommand)
      await runShellCommand(this.input.plan.profile.teardownCommand, {
        cwd: this.input.worktree,
        // Teardown is measured from when teardown starts, not from the stage
        // deadline: it matters most on the path where that deadline already
        // expired.
        timeoutMs: TEARDOWN_GRACE_MS,
        logPrefix: path.join(this.input.artifactDirectory, "teardown"),
        signal: new AbortController().signal,
      });
  }
}

class BuiltInBrowserAdapter implements BrowserAdapter {
  constructor(readonly runner: BrowserAdapter["runner"]) {}

  async resolveRuntime(
    input: Parameters<NonNullable<BrowserAdapter["resolveRuntime"]>>[0],
  ): Promise<
    Awaited<ReturnType<NonNullable<BrowserAdapter["resolveRuntime"]>>>
  > {
    if (input.plan.profile.portMode !== "dynamic")
      return {
        plan: input.plan,
        approvedOrigins: input.approvedOrigins,
      };
    const port = await unusedLoopbackPort();
    const originalBaseOrigin = new URL(input.plan.profile.baseUrl).origin;
    const baseUrl = replacePort(input.plan.profile.baseUrl, port);
    const runtimeBaseOrigin = new URL(baseUrl).origin;
    return {
      plan: {
        ...input.plan,
        profile: {
          ...input.plan.profile,
          baseUrl,
          healthUrl: replacePort(input.plan.profile.healthUrl, port),
          allowedOrigins: input.plan.profile.allowedOrigins.map((origin) =>
            new URL(origin).origin === originalBaseOrigin
              ? runtimeBaseOrigin
              : origin,
          ),
        },
      },
      approvedOrigins: input.approvedOrigins.map((origin) =>
        new URL(origin).origin === originalBaseOrigin
          ? runtimeBaseOrigin
          : origin,
      ),
    };
  }

  runNativeSuiteStandalone(
    input: Parameters<BrowserAdapter["launch"]>[0],
  ): ReturnType<NonNullable<BrowserAdapter["runNativeSuiteStandalone"]>> {
    return runNativeSuiteCommand(input);
  }

  async launch(
    input: Parameters<BrowserAdapter["launch"]>[0],
  ): Promise<BrowserSession> {
    if (input.plan.profile.portMode !== "dynamic") {
      const origins = [
        ...new Set(
          [input.plan.profile.baseUrl, input.plan.profile.healthUrl].map(
            (value) => new URL(value).origin,
          ),
        ),
      ];
      for (const origin of origins) await assertLoopbackPortAvailable(origin);
    }
    const runtimeInput = input;
    await mkdir(runtimeInput.artifactDirectory, { recursive: true });
    const stdoutPath = path.join(
      runtimeInput.artifactDirectory,
      "startup.stdout.log",
    );
    const stderrPath = path.join(
      runtimeInput.artifactDirectory,
      "startup.stderr.log",
    );
    const [stdout, stderr] = await Promise.all([
      open(stdoutPath, "w"),
      open(stderrPath, "w"),
    ]);
    const port = new URL(runtimeInput.plan.profile.baseUrl).port;
    const owner = randomUUID();
    const child = spawn(runtimeInput.plan.profile.startupCommand, {
      cwd: runtimeInput.worktree,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", stdout.fd, stderr.fd],
      env: minimalEnvironment({
        ...(port ? { PORT: port } : {}),
        AGENT_ARENA_PROCESS_OWNER: owner,
      }),
    });
    child.once("error", () => undefined);
    const supervisor =
      child.pid === undefined
        ? undefined
        : new ProcessTreeSupervisor(child.pid, owner);
    supervisor?.startTracking();
    return new BuiltInBrowserSession(
      runtimeInput,
      child,
      supervisor,
      stdout,
      stderr,
      [
        { kind: "startup_log", path: stdoutPath, failureOnly: false },
        { kind: "startup_log", path: stderrPath, failureOnly: false },
      ],
    );
  }
}

export function createBuiltInBrowserAdapters(): Partial<
  Record<"playwright" | "cypress" | "custom", BrowserAdapter>
> {
  return {
    playwright: new BuiltInBrowserAdapter("playwright"),
    cypress: new BuiltInBrowserAdapter("cypress"),
    custom: new BuiltInBrowserAdapter("custom"),
  };
}

export function browserFailureReason(
  result: Awaited<ReturnType<BrowserSession["runProbe"]>>,
): BrowserUnavailableReason | undefined {
  return result.reason;
}
