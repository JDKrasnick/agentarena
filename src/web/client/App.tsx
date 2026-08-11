import { useEffect, useMemo, useState } from "react";
import openAiLogo from "@lobehub/icons-static-png/dark/openai.png";
import claudeLogo from "@lobehub/icons-static-png/dark/claude-color.png";
import geminiLogo from "@lobehub/icons-static-png/dark/gemini-color.png";
import grokLogo from "@lobehub/icons-static-png/dark/grok.png";
import mistralLogo from "@lobehub/icons-static-png/dark/mistral-color.png";
import deepseekLogo from "@lobehub/icons-static-png/dark/deepseek-color.png";
import cohereLogo from "@lobehub/icons-static-png/dark/cohere-color.png";
import perplexityLogo from "@lobehub/icons-static-png/dark/perplexity-color.png";
import metaLogo from "@lobehub/icons-static-png/dark/meta-color.png";
import copilotLogo from "@lobehub/icons-static-png/dark/copilot-color.png";
import bedrockLogo from "@lobehub/icons-static-png/dark/bedrock-color.png";
import qwenLogo from "@lobehub/icons-static-png/dark/qwen-color.png";
import nvidiaLogo from "@lobehub/icons-static-png/dark/nvidia-color.png";
import azureLogo from "@lobehub/icons-static-png/dark/azure-color.png";
import groqLogo from "@lobehub/icons-static-png/dark/groq.png";
import huggingFaceLogo from "@lobehub/icons-static-png/dark/huggingface-color.png";
import togetherLogo from "@lobehub/icons-static-png/dark/together-color.png";
import fireworksLogo from "@lobehub/icons-static-png/dark/fireworks-color.png";
import openRouterLogo from "@lobehub/icons-static-png/dark/openrouter-color.png";
import cursorLogo from "@lobehub/icons-static-png/dark/cursor.png";
import type {
  DashboardContestant,
  DashboardState,
} from "../../dashboard/state.js";

const fallbackState: DashboardState = {
  task: "Preparing battle…",
  stage: "preflight",
  status: "running",
  assisted: false,
  warnings: [],
  contestants: {
    a: {
      provider: "unknown",
      health: 100,
      status: "pending",
      activity: "Waiting",
      checks: [],
      invocations: [],
      output: [],
      healthChanges: [],
    },
    b: {
      provider: "unknown",
      health: 100,
      status: "pending",
      activity: "Waiting",
      checks: [],
      invocations: [],
      output: [],
      healthChanges: [],
    },
  },
  systemOutput: [],
  attacks: [],
  links: [],
};

const stageNames: Record<string, string> = {
  preflight: "Preflight",
  implement: "Implementation",
  initial_validation: "Validation",
  review_attacks: "Scout weaknesses",
  collect_attacks: "Mount attacks",
  validate_attacks: "Verify attacks",
  repair: "Repair",
  final_validation: "Final validation",
  complete: "Complete",
};

function providerLogo(provider: string) {
  const id = provider.toLowerCase();
  if (id.includes("claude") || id.includes("anthropic")) return claudeLogo;
  if (id.includes("gemini") || id.includes("google")) return geminiLogo;
  if (id.includes("codex") || id.includes("openai")) return openAiLogo;
  if (id.includes("mistral")) return mistralLogo;
  if (id.includes("deepseek")) return deepseekLogo;
  if (id.includes("cohere")) return cohereLogo;
  if (id.includes("perplexity")) return perplexityLogo;
  if (id.includes("meta") || id.includes("llama")) return metaLogo;
  if (id.includes("copilot")) return copilotLogo;
  if (id.includes("bedrock") || id.includes("aws")) return bedrockLogo;
  if (id.includes("qwen")) return qwenLogo;
  if (id.includes("nvidia")) return nvidiaLogo;
  if (id.includes("azure")) return azureLogo;
  if (id.includes("groq")) return groqLogo;
  if (id.includes("grok") || id.includes("xai")) return grokLogo;
  if (id.includes("hugging") || id === "hf") return huggingFaceLogo;
  if (id.includes("together")) return togetherLogo;
  if (id.includes("fireworks")) return fireworksLogo;
  if (id.includes("openrouter")) return openRouterLogo;
  if (id.includes("cursor")) return cursorLogo;
  return undefined;
}

function title(provider: string) {
  if (provider === "unknown") return "Waiting";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function Fighter({
  id,
  fighter,
  onSteer,
}: {
  id: "a" | "b";
  fighter: DashboardContestant;
  onSteer: (id: "a" | "b", note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const damage = fighter.lastHealthChange?.amount ?? 0;
  const checksPassed = fighter.checks.filter(
    (check) => check.status === "passed",
  ).length;
  const output = fighter.output.slice(-4);
  const logo = providerLogo(fighter.provider);
  const provider = title(fighter.provider);

  return (
    <article
      className={`fighter fighter-${id}${damage < 0 ? " is-hit" : ""}`}
      key={`${id}-${String(fighter.lastHealthChange?.sequence ?? 0)}`}
    >
      <header className="fighter-header">
        <div className="provider-mark" aria-hidden="true">
          {logo ? <img src={logo} alt="" /> : <span>?</span>}
        </div>
        <div>
          <p className="fighter-label">Fighter {id.toUpperCase()}</p>
          <h2>{provider}</h2>
          <p className="model">{fighter.model ?? "Default model"}</p>
        </div>
        <span className={`status status-${fighter.status}`}>
          {fighter.status}
        </span>
      </header>

      <div className="health-row">
        <div className="health-copy">
          <span>HP</span>
          <strong>{fighter.health}</strong>
          <span>/ 100</span>
        </div>
        <div
          className="health-track"
          aria-label={`${provider} health ${String(fighter.health)} of 100`}
        >
          <div
            className={`health-fill${damage < 0 ? " is-hit" : ""}`}
            style={{ width: `${String(fighter.health)}%` }}
          />
        </div>
        {damage < 0 ? <span className="damage">{damage} HP</span> : null}
      </div>

      <dl className="fighter-facts">
        <div>
          <dt>Current move</dt>
          <dd>{fighter.activity.replaceAll("_", " ")}</dd>
        </div>
        <div>
          <dt>Checks</dt>
          <dd>
            {checksPassed}/{fighter.checks.length} passed
          </dd>
        </div>
      </dl>

      <div className="agent-output" aria-label={`${provider} output`}>
        {output.length ? (
          output.map((line, index) => (
            <p
              className={line.stream === "stderr" ? "stderr" : ""}
              key={`${line.text}-${String(index)}`}
            >
              <span>›</span> {line.text.trim()}
            </p>
          ))
        ) : (
          <p className="quiet">Waiting for agent output…</p>
        )}
      </div>

      <form
        className="steer"
        onSubmit={(event) => {
          event.preventDefault();
          if (!note.trim()) return;
          void onSteer(id, note).then(() => setNote(""));
        }}
      >
        <input
          aria-label={`Steer ${provider}`}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={`Steer ${provider} once…`}
        />
        <button disabled={!note.trim()} type="submit">
          Send
        </button>
      </form>
    </article>
  );
}

function Result({ state }: { state: DashboardState }) {
  if (state.status !== "complete" || !state.result) return null;
  const winner =
    state.result.recommendedId?.toUpperCase() ??
    state.result.championId?.toUpperCase() ??
    "—";
  const landed = state.attacks.filter((attack) => attack.phase === "landed");
  const repairs = Object.values(state.contestants).flatMap((fighter) =>
    fighter.healthChanges.filter((change) => change.amount > 0),
  );
  return (
    <section className="result" aria-live="polite">
      <div>
        <p className="result-kicker">Battle complete</p>
        <h2>
          {winner === "—"
            ? "No patch was published as the winner."
            : `Patch ${winner} survived the arena.`}
        </h2>
        <p>
          {state.result.recommendationReason ??
            (state.result.coverageConfidence === "provisional"
              ? "Coverage was unresolved, so no champion or recommendation is published."
              : "Review the evidence-backed result before merging.")}
        </p>
      </div>
      <div className="result-proof">
        <strong>{landed.length}</strong>
        <span>defects caught</span>
        <strong>{repairs.length}</strong>
        <span>repairs verified</span>
        <button
          type="button"
          onClick={() => void fetch("/api/close", { method: "POST" })}
        >
          Finish session
        </button>
      </div>
    </section>
  );
}

export function App() {
  const [state, setState] = useState<DashboardState>(fallbackState);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    void fetch("/api/state").then(async (response) =>
      setState((await response.json()) as DashboardState),
    );
    const events = new EventSource("/events");
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.onmessage = (event) =>
      setState(JSON.parse(event.data as string) as DashboardState);
    return () => events.close();
  }, []);

  const counts = useMemo(
    () => ({
      mounting: state.attacks.filter((attack) => attack.phase === "mounting")
        .length,
      landed: state.attacks.filter((attack) => attack.phase === "landed")
        .length,
      revised: state.attacks.filter((attack) => attack.phase === "revised")
        .length,
    }),
    [state.attacks],
  );
  const stage = stageNames[state.stage] ?? state.stage.replaceAll("_", " ");
  const latestAttack = state.attacks.at(-1);
  const roundStep =
    state.stage === "collect_attacks"
      ? 0
      : state.stage === "validate_attacks"
        ? latestAttack?.phase === "landed"
          ? 2
          : 1
        : state.stage === "repair"
          ? 3
          : -1;

  const steer = async (contestantId: "a" | "b", note: string) => {
    const response = await fetch("/api/steer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contestantId, note }),
    });
    if (!response.ok) throw new Error("Unable to queue steering note");
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span>AA</span>
          <strong>Agent Arena</strong>
        </div>
        <div className="task">
          <span>{state.task}</span>
        </div>
        <div className="top-actions">
          <span className={`connection${connected ? " is-live" : ""}`}>
            <i />
            {connected ? "Live" : "Reconnecting"}
          </span>
          {state.links.map((link) => (
            <a href={link.url} target="_blank" rel="noreferrer" key={link.url}>
              {link.label} ↗
            </a>
          ))}
          <button
            className="cancel"
            type="button"
            onClick={() => void fetch("/api/cancel", { method: "POST" })}
          >
            Cancel
          </button>
        </div>
      </header>

      <main>
        <aside className="round-rail">
          <div className="phase-heading">
            <span>
              {state.round ? `Round ${String(state.round)} of 3` : "Opening"}
            </span>
            <strong>{stage}</strong>
          </div>
          {["Mount", "Verify", "Damage", "Repair"].map((step, index) => {
            const active = roundStep === index;
            return (
              <div
                className={`round-step${active ? " active" : ""}`}
                key={step}
              >
                <i />
                {step}
              </div>
            );
          })}
          <div className="move-counts">
            <p>
              <span className="cyan">{counts.mounting}</span> mounting
            </p>
            <p>
              <span className="green">{counts.landed}</span> landed
            </p>
            <p>
              <span className="amber">{counts.revised}</span> revisions
            </p>
          </div>
        </aside>

        <section className="arena">
          <Result state={state} />
          <div className="arena-heading">
            <div>
              <span>Link battle</span>
              <h1>
                {title(state.contestants.a.provider)} <b>vs</b>{" "}
                {title(state.contestants.b.provider)}
              </h1>
            </div>
            <p>{state.assisted ? "Assisted run" : "Competitive run"}</p>
          </div>
          <div className="fighters">
            <Fighter id="a" fighter={state.contestants.a} onSteer={steer} />
            <div className="versus" aria-hidden="true">
              <span>VS</span>
              <i />
            </div>
            <Fighter id="b" fighter={state.contestants.b} onSteer={steer} />
          </div>
          <div className="battle-call">
            <span>
              {latestAttack?.phase === "landed"
                ? "Attack landed"
                : latestAttack?.phase === "revised"
                  ? "Evidence revised"
                  : "Current move"}
            </span>
            <strong>{latestAttack?.detail ?? `${stage} is underway`}</strong>
          </div>
        </section>

        <aside className="activity">
          <header>
            <div>
              <span>Battle log</span>
              <strong>Evidence stream</strong>
            </div>
            <em>{state.attacks.length}</em>
          </header>
          <div className="activity-list">
            {state.attacks.length ? (
              state.attacks
                .slice(-10)
                .reverse()
                .map((attack, index) => (
                  <article
                    key={`${attack.id}-${attack.phase}-${String(index)}`}
                  >
                    <i className={`event event-${attack.phase}`} />
                    <div>
                      <strong>{attack.detail ?? attack.id}</strong>
                      <p>
                        {attack.attacker?.toUpperCase() ?? "House"} →{" "}
                        {attack.target?.toUpperCase() ?? "both"}
                        {attack.damage
                          ? ` · ${String(attack.damage)} damage`
                          : ""}
                      </p>
                    </div>
                    <time>
                      {attack.round ? `R${String(attack.round)}` : "—"}
                    </time>
                  </article>
                ))
            ) : (
              <p className="empty">
                Attacks, evidence revisions, and verified damage will appear
                here.
              </p>
            )}
          </div>
          {state.warnings.length ? (
            <div className="warnings">
              <strong>Needs attention</strong>
              {state.warnings.slice(-3).map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          ) : null}
        </aside>
      </main>
    </div>
  );
}
