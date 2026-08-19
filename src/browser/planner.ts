import type { FightConfig } from "../core/types.js";
import type { ReconnaissanceSnapshot } from "../task/task-contract.js";
import { BrowserPlanSchema, type BrowserPlan } from "../contracts/browser.js";
export {
  BrowserEvidenceSchema,
  BrowserPlanSchema,
} from "../contracts/browser.js";
export type { BrowserPlan } from "../contracts/browser.js";

const TASK_PATTERN =
  /\b(ui|user[- ]visible|browser|dom|responsive|viewport|mobile|desktop|accessib|keyboard|focus|dialog|modal|drawer|navigation|interaction|click|hover|persistence|localstorage|sessionstorage|visual|layout|render)\b/iu;
const FRONTEND_PATTERN =
  /(?:"(?:react|next|vue|svelte|angular|@playwright\/test|cypress|selenium-webdriver|webdriverio)"|playwright\.config|cypress\.config)/iu;
const PROBE_FAMILIES: BrowserPlan["probeFamilies"] = [
  "interaction",
  "responsive",
  "keyboard_focus",
  "semantics",
  "persistence",
  "runtime_dom_integrity",
  "visual_regression",
];

function isLoopback(value: string): boolean {
  const url = new URL(value);
  return (
    ["http:", "https:"].includes(url.protocol) &&
    ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
  );
}

function packageScripts(
  reconnaissance: ReconnaissanceSnapshot,
): Record<string, string> {
  const manifest = reconnaissance.repositoryEvidence.find(
    (entry) => entry.path === "package.json",
  );
  if (!manifest) return {};
  try {
    const parsed = JSON.parse(manifest.content) as {
      scripts?: Record<string, unknown>;
    };
    return Object.fromEntries(
      Object.entries(parsed.scripts ?? {}).flatMap(([name, command]) =>
        typeof command === "string" ? [[name, command]] : [],
      ),
    );
  } catch {
    return {};
  }
}

function scriptCommand(
  name: string,
  reconnaissance: ReconnaissanceSnapshot,
): string {
  const paths = new Set(
    reconnaissance.repositoryEvidence.map((entry) => entry.path),
  );
  if (paths.has("pnpm-lock.yaml")) return `pnpm run ${name}`;
  if (paths.has("yarn.lock")) return `yarn ${name}`;
  if (paths.has("bun.lock") || paths.has("bun.lockb")) return `bun run ${name}`;
  return `npm run ${name}`;
}

function literalUrl(content: string): string | undefined {
  return /(?:baseURL|baseUrl|url)\s*:\s*["'](https?:\/\/[^"']+)["']/u.exec(
    content,
  )?.[1];
}

function literalProjects(content: string): string[] {
  return [...content.matchAll(/name\s*:\s*["']([^"']+)["']/gu)].flatMap(
    (match) => (match[1] ? [match[1]] : []),
  );
}

function literalCommand(content: string): string | undefined {
  return /command\s*:\s*["']([^"']+)["']/u.exec(content)?.[1];
}

export function planBrowserValidation(
  config: FightConfig,
  reconnaissance: ReconnaissanceSnapshot,
): BrowserPlan | undefined {
  const taskText = [
    config.task,
    ...config.acceptanceCriteria,
    ...reconnaissance.sources.map((source) => source.content),
  ].join("\n");
  const taskRequired = TASK_PATTERN.test(taskText);
  const repositoryMatches = reconnaissance.repositoryEvidence.filter((entry) =>
    FRONTEND_PATTERN.test(`${entry.path}\n${entry.content}`),
  );
  if (!taskRequired && !repositoryMatches.length && !config.browserProfile)
    return undefined;

  const evidence: BrowserPlan["evidence"] = [];
  if (taskRequired)
    evidence.push({
      source: "task",
      location: "frozen task sources",
      detail: "Task names user-visible browser or DOM behavior",
    });
  for (const match of repositoryMatches)
    evidence.push({
      source: "repository",
      location: match.path,
      detail: "Static evidence declares frontend or browser tooling",
    });
  if (config.browserProfile)
    evidence.push({
      source: "configuration",
      location: "agent-arena.yaml#browser",
      detail: "Explicit Arena browser profile",
    });

  const base = {
    version: 1 as const,
    requirement: taskRequired ? ("required" as const) : ("optional" as const),
    evidence,
    capabilityId: "browser_dom_validation" as const,
    role: "harness_only" as const,
    enforcement: "brokered" as const,
    probeFamilies: [
      ...PROBE_FAMILIES,
      ...(/\b(?:html|url|message|rich text|xss|injection)\b/iu.test(taskText)
        ? (["dom_security"] as const)
        : []),
    ],
  };

  if (config.browserProfile) {
    if (
      config.browserProfile.portMode === "dynamic" &&
      ![config.browserProfile.baseUrl, config.browserProfile.healthUrl].every(
        isLoopback,
      )
    )
      return BrowserPlanSchema.parse({
        ...base,
        unavailableReason: "non_local_origin",
      });
    if (config.browserProfile.portMode === "dynamic") {
      const baseUrl = new URL(config.browserProfile.baseUrl);
      const healthUrl = new URL(config.browserProfile.healthUrl);
      if (
        baseUrl.protocol !== healthUrl.protocol ||
        baseUrl.hostname !== healthUrl.hostname
      )
        return BrowserPlanSchema.parse({
          ...base,
          unavailableReason: "dynamic_port_mismatch",
        });
    }
    return BrowserPlanSchema.parse({
      ...base,
      profile: {
        source: "arena_configuration",
        ...config.browserProfile,
        allowedOrigins: config.browserProfile.allowedOrigins.map(
          (origin) => new URL(origin).origin,
        ),
      },
    });
  }

  const ambiguous = reconnaissance.repositoryEvidence.some(
    (entry) =>
      entry.path === "pnpm-workspace.yaml" ||
      (entry.path === "package.json" &&
        /"workspaces"\s*:/u.test(entry.content)),
  );
  if (ambiguous)
    return BrowserPlanSchema.parse({
      ...base,
      unavailableReason: "ambiguous_monorepo",
    });

  const scripts = packageScripts(reconnaissance);
  const startupName = ["dev", "start", "serve"].find((name) => scripts[name]);
  const testName = ["test:e2e", "test:browser", "e2e"].find(
    (name) => scripts[name],
  );
  const playwright = reconnaissance.repositoryEvidence.find((entry) =>
    entry.path.startsWith("playwright.config."),
  );
  const cypress = reconnaissance.repositoryEvidence.find((entry) =>
    entry.path.startsWith("cypress.config."),
  );
  const browserConfig = playwright ?? cypress;
  const configuredStartup =
    browserConfig && literalCommand(browserConfig.content);
  if (!startupName && !configuredStartup)
    return BrowserPlanSchema.parse({
      ...base,
      unavailableReason: "startup_command_missing",
    });
  if (!testName)
    return BrowserPlanSchema.parse({
      ...base,
      unavailableReason: "test_command_missing",
    });
  const baseUrl = browserConfig && literalUrl(browserConfig.content);
  if (!baseUrl)
    return BrowserPlanSchema.parse({
      ...base,
      unavailableReason: "base_url_missing",
    });
  return BrowserPlanSchema.parse({
    ...base,
    profile: {
      source: playwright
        ? "playwright_configuration"
        : cypress
          ? "cypress_configuration"
          : "package_scripts",
      runner: playwright ? "playwright" : cypress ? "cypress" : "custom",
      startupCommand:
        configuredStartup ?? scriptCommand(startupName!, reconnaissance),
      healthUrl: baseUrl,
      baseUrl,
      testCommand: scriptCommand(testName, reconnaissance),
      portMode: "fixed",
      projects: browserConfig ? literalProjects(browserConfig.content) : [],
      allowedOrigins: [new URL(baseUrl).origin],
    },
  });
}

export function browserCapabilityScopes(plan: BrowserPlan): string[] {
  if (!plan.profile) return [];
  return [
    `command:${plan.profile.startupCommand}`,
    `command:${plan.profile.testCommand}`,
    ...(plan.profile.teardownCommand
      ? [`command:${plan.profile.teardownCommand}`]
      : []),
    ...plan.profile.allowedOrigins.filter(isLoopback).map((origin) => {
      const url = new URL(origin);
      return plan.profile?.portMode === "dynamic" &&
        url.origin === new URL(plan.profile.baseUrl).origin
        ? `loopback:${url.protocol}//${url.hostname}:dynamic`
        : `origin:${origin}`;
    }),
  ];
}

export function browserExternalOrigins(plan: BrowserPlan): string[] {
  if (!plan.profile) return [];
  return [
    ...new Set(
      [
        plan.profile.baseUrl,
        plan.profile.healthUrl,
        ...plan.profile.allowedOrigins,
      ]
        .map((value) => new URL(value).origin)
        .filter((origin) => !isLoopback(origin)),
    ),
  ];
}
