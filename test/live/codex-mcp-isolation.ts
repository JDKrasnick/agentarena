import { execa } from "execa";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { providerCommand } from "../../src/agents/adapter.js";

if (process.env.AGENT_ARENA_LIVE !== "1") {
  process.stdout.write(
    "SKIP: set AGENT_ARENA_LIVE=1 only for an explicitly authorized paid Codex MCP check.\n",
  );
  process.exit(0);
}

const serverPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/mcp-ping-server.mjs",
);
const policy = {
  version: 1 as const,
  mode: "configure_selection" as const,
  inventory: [
    {
      provider: "codex" as const,
      state: "known" as const,
      servers: [
        {
          name: "selected",
          enabled: true,
          authentication: "not_required" as const,
          readiness: "ready" as const,
        },
        {
          name: "incompatible_ambient",
          enabled: true,
          authentication: "unknown" as const,
          readiness: "unknown" as const,
        },
      ],
      diagnosticArtifactRefs: [],
    },
  ],
  servers: [
    {
      provider: "codex" as const,
      name: "selected",
      enabledInSnapshot: true,
      authentication: "not_required" as const,
      readiness: "ready" as const,
      role: "agent" as const,
      requirement: "required" as const,
      decision: "included" as const,
      reason: "Selected for the paid live check",
    },
    {
      provider: "codex" as const,
      name: "incompatible_ambient",
      enabledInSnapshot: true,
      authentication: "unknown" as const,
      readiness: "unknown" as const,
      role: "agent" as const,
      requirement: "optional" as const,
      decision: "excluded" as const,
      reason: "Not selected for this run",
    },
  ],
  coverageGaps: [],
  frozenAt: "2026-09-04T00:00:00.000Z",
  policyHash: "0".repeat(64),
};
const definition = {
  provider: "codex" as const,
  name: "selected",
  transport: {
    type: "stdio" as const,
    command: process.execPath,
    args: [serverPath],
    env_vars: [],
    cwd: null,
  },
  enabled_tools: null,
  disabled_tools: null,
  startup_timeout_sec: null,
  tool_timeout_sec: null,
};
const command = providerCommand(
  "codex",
  process.env.AGENT_ARENA_LIVE_CODEX_MODEL,
  policy,
  [definition],
);
const result = await execa(command.executable, command.args, {
  cwd: process.cwd(),
  input:
    "Call selected.arena_ping. Respond with exactly AGENT_ARENA_SELECTED_MCP_OK only when its result is AGENT_ARENA_MCP_TOOL_RESULT.",
  reject: false,
});

if (result.exitCode !== 0)
  throw new Error(`Codex exited ${String(result.exitCode)}: ${result.stderr}`);
const events = result.stdout
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Record<string, unknown>);
const serialized = JSON.stringify(events);
if (
  !serialized.includes('"server":"selected"') ||
  !serialized.includes('"tool":"arena_ping"') ||
  !serialized.includes('"status":"completed"') ||
  !serialized.includes("AGENT_ARENA_MCP_TOOL_RESULT") ||
  !serialized.includes("AGENT_ARENA_SELECTED_MCP_OK") ||
  serialized.includes("incompatible_ambient")
)
  throw new Error(`Selected-only Codex MCP check failed: ${serialized}`);

process.stdout.write(
  "PASS: selected-only Codex MCP tool execution completed.\n",
);
