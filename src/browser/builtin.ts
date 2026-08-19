import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  mkdir,
  open,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import { runShellCommand } from "../runner/process-runner.js";
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

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(1_000).then(() => undefined),
  ]);
  if (child.exitCode === null) {
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
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
    const missing = await page.evaluate(`(() => {
      const controls = [...document.querySelectorAll('button,input,select,textarea,a[href],[role="button"],[role="link"]')];
      return controls.filter((element) => {
        const text = (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').trim();
        const id = element.getAttribute('id');
        const label = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
        return !text && !label;
      }).length;
    })()`);
    return Number(missing) > 0
      ? `${String(missing)} actionable element(s) lack an accessible name`
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
  return undefined;
}

class BuiltInBrowserSession implements BrowserSession {
  readonly artifacts: BrowserArtifact[];
  readonly toolVersion = "playwright-core-1.62.1";
  browserVersion = "unlaunched";
  private browser?: Browser;

  constructor(
    private readonly input: Parameters<BrowserAdapter["launch"]>[0],
    private readonly child: ChildProcess,
    private readonly stdout: FileHandle,
    private readonly stderr: FileHandle,
    artifacts: BrowserArtifact[],
  ) {
    this.artifacts = artifacts;
  }

  async waitUntilReady(): Promise<void> {
    const deadline = Math.min(Date.now() + 15_000, this.input.deadlineAt);
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
    const result = await runShellCommand(this.input.plan.profile.testCommand, {
      cwd: this.input.worktree,
      timeoutMs: Math.max(1, this.input.deadlineAt - Date.now()),
      logPrefix: path.join(this.input.artifactDirectory, "native-suite"),
      signal: this.input.signal,
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

  async runProbe({
    request,
    contextId,
    allowedOrigins,
  }: Parameters<BrowserSession["runProbe"]>[0]): Promise<
    Omit<BrowserProbeResult, "contextId" | "requiredCapabilityIds">
  > {
    if (!this.browser)
      throw new BrowserInfrastructureError(
        "Browser session was not provisioned",
        "launch_failure",
      );
    const blockedOrigins: string[] = [];
    const errors: string[] = [];
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    try {
      context = await this.browser.newContext({
        ...viewport(request.profile),
        serviceWorkers: "block",
      });
      context.setDefaultTimeout(
        Math.max(1, this.input.deadlineAt - Date.now()),
      );
      context.setDefaultNavigationTimeout(
        Math.max(1, this.input.deadlineAt - Date.now()),
      );
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        const runtimeBaseOrigin = new URL(this.input.plan.profile.baseUrl)
          .origin;
        if (
          ["about:", "data:", "blob:"].includes(url.protocol) ||
          allowedOrigins.includes(url.origin) ||
          (this.input.plan.profile.portMode === "dynamic" &&
            url.origin === runtimeBaseOrigin)
        )
          await route.continue();
        else {
          blockedOrigins.push(url.origin);
          await route.abort("blockedbyclient");
        }
      });
      page = await context.newPage();
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await executeActions(
        page,
        this.input.plan.profile.baseUrl,
        request.actions,
      );
      const invariant = await familyInvariant(page, request.family);
      if (invariant) errors.push(invariant);
      const status =
        errors.length || blockedOrigins.length ? "failed" : "verified";
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
          failureOnly: true,
        });
      }
      return {
        family: request.family,
        profile: request.profile,
        status,
        ...(status === "failed"
          ? { reason: "application_failure" as const }
          : {}),
        detail: errors.join("; ") || request.expectedBehavior,
        blockedOrigins: [...new Set(blockedOrigins)],
        artifacts,
      };
    } catch (error) {
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
    await stopProcess(this.child);
    await Promise.all([
      this.stdout.close().catch(() => undefined),
      this.stderr.close().catch(() => undefined),
    ]);
    if (this.input.plan.profile.teardownCommand)
      await runShellCommand(this.input.plan.profile.teardownCommand, {
        cwd: this.input.worktree,
        timeoutMs: Math.max(
          1,
          Math.min(1_500, this.input.deadlineAt + 1_500 - Date.now()),
        ),
        logPrefix: path.join(this.input.artifactDirectory, "teardown"),
        signal: new AbortController().signal,
      });
  }
}

class BuiltInBrowserAdapter implements BrowserAdapter {
  constructor(readonly runner: BrowserAdapter["runner"]) {}

  async launch(
    input: Parameters<BrowserAdapter["launch"]>[0],
  ): Promise<BrowserSession> {
    const runtimeInput =
      input.plan.profile.portMode === "dynamic"
        ? await (async () => {
            const port = await unusedLoopbackPort();
            const originalBaseOrigin = new URL(input.plan.profile.baseUrl)
              .origin;
            const baseUrl = replacePort(input.plan.profile.baseUrl, port);
            return {
              ...input,
              plan: {
                ...input.plan,
                profile: {
                  ...input.plan.profile,
                  baseUrl,
                  healthUrl: replacePort(input.plan.profile.healthUrl, port),
                  allowedOrigins: input.plan.profile.allowedOrigins.map(
                    (origin) =>
                      new URL(origin).origin === originalBaseOrigin
                        ? new URL(baseUrl).origin
                        : origin,
                  ),
                },
              },
            };
          })()
        : input;
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
    const child = spawn(runtimeInput.plan.profile.startupCommand, {
      cwd: runtimeInput.worktree,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", stdout.fd, stderr.fd],
      env: { ...process.env, ...(port ? { PORT: port } : {}) },
    });
    child.once("error", () => undefined);
    return new BuiltInBrowserSession(runtimeInput, child, stdout, stderr, [
      { kind: "startup_log", path: stdoutPath, failureOnly: false },
      { kind: "startup_log", path: stderrPath, failureOnly: false },
    ]);
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
