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
import {
  ARENA_THEMES,
  DEFAULT_ARENA_THEME,
  type ArenaTheme,
} from "../../dashboard/arena-theme.js";
import {
  attackDisplayLabel,
  createArenaPresentation,
  invocationStatusSentence,
  isRoundAvailable,
  recordedRoundMoveCount,
  roundLabel,
  stageLabel,
  steeringUnavailableMessage,
  type ContestantId,
  type RoundSelection,
} from "./presentation.js";

declare global {
  interface Window {
    arenaTheme?: {
      getTheme(): ArenaTheme;
      setTheme(theme: ArenaTheme): Promise<void>;
    };
  }
}

const themeNames: Record<ArenaTheme, string> = {
  "classic-shell": "Classic Shell",
  "sticker-league": "Sticker League",
  "night-edition": "Night Edition",
  "live-arena-broadcast": "Live Broadcast",
  "evidence-deck": "Evidence Deck",
};

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
  failures: [],
  links: [],
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

function BackIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M16 10H4m0 0 5-5m-5 5 5 5" />
    </svg>
  );
}

function OpenIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="m7 4 6 6-6 6" />
    </svg>
  );
}

function Fighter({
  id,
  fighter,
  onSteer,
  onOpen,
  isHistorical,
  canSteer,
  steeringUnavailable,
}: {
  id: ContestantId;
  fighter: DashboardContestant;
  onSteer: (id: ContestantId, note: string) => Promise<void>;
  onOpen: (id: ContestantId) => void;
  isHistorical: boolean;
  canSteer: boolean;
  steeringUnavailable: string;
}) {
  const [note, setNote] = useState("");
  const damage = fighter.lastHealthChange?.amount ?? 0;
  const checksPassed = fighter.checks.filter(
    (check) => check.status === "passed",
  ).length;
  const output = fighter.output.slice(-10);
  const logo = providerLogo(fighter.provider);
  const provider = title(fighter.provider);

  return (
    <article
      className={`fighter fighter-${id}${damage < 0 ? " is-hit" : ""}`}
      key={`${id}-${String(fighter.lastHealthChange?.sequence ?? 0)}`}
    >
      <button
        className="fighter-hitbox"
        type="button"
        aria-label={`Open ${provider} fighter details`}
        onClick={() => onOpen(id)}
      />
      <header className="fighter-header">
        <div className="provider-mark" aria-hidden="true">
          {logo ? <img src={logo} alt="" /> : <span>?</span>}
        </div>
        <div>
          <p className="fighter-label">Fighter {id.toUpperCase()}</p>
          <h2>{provider}</h2>
          <p className="model">{fighter.model ?? "Default model"}</p>
        </div>
        <div className="fighter-actions">
          <span className={`status status-${fighter.status}`}>
            {fighter.status}
          </span>
          <span className="open-fighter" aria-hidden="true">
            Details <OpenIcon />
          </span>
        </div>
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

      {isHistorical ? (
        <div className="replay-card-note">Read-only round replay</div>
      ) : canSteer ? (
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
      ) : (
        <div className="replay-card-note">{steeringUnavailable}</div>
      )}
    </article>
  );
}

function RoundNavigator({
  state,
  rounds,
  selected,
  onSelect,
}: {
  state: DashboardState;
  rounds: Array<NonNullable<DashboardState["round"]>>;
  selected: RoundSelection;
  onSelect: (round: RoundSelection) => void;
}) {
  return (
    <aside className="round-rail" aria-label="Battle rounds">
      <div className="phase-heading">
        <span>Battle timeline</span>
        <strong>Round replay</strong>
      </div>
      <nav className="round-nav">
        <button
          className={selected === "live" ? "is-selected" : ""}
          type="button"
          aria-current={selected === "live" ? "page" : undefined}
          onClick={() => onSelect("live")}
        >
          <i className="round-live-dot" />
          <span>
            <strong>Live arena</strong>
            <small>{stageLabel(state.stage)}</small>
          </span>
        </button>
        {rounds.map((round) => {
          const recordedMoves = recordedRoundMoveCount(state, round);
          const isCurrent = state.round === round && state.status === "running";
          const isAvailable = isRoundAvailable(state, round);
          const isComplete = isAvailable && !isCurrent;
          return (
            <button
              className={selected === round ? "is-selected" : ""}
              type="button"
              aria-current={selected === round ? "page" : undefined}
              disabled={!isAvailable}
              key={round}
              onClick={() => onSelect(round)}
            >
              <i />
              <span>
                <strong>{roundLabel(round)}</strong>
                <small>
                  {isCurrent
                    ? "In progress"
                    : isComplete
                      ? `${String(recordedMoves)} recorded moves`
                      : "Upcoming"}
                </small>
              </span>
            </button>
          );
        })}
      </nav>
      <p className="replay-explainer">
        Past rounds are read-only. Agent Arena can resume a sealed run, but it
        does not rewind live execution.
      </p>
    </aside>
  );
}

function FighterDetail({
  id,
  fighter,
  round,
  attacks,
  onBack,
  onSteer,
  canSteer,
  steeringUnavailable,
  backLabel,
}: {
  id: ContestantId;
  fighter: DashboardContestant;
  round: RoundSelection;
  attacks: DashboardState["attacks"];
  onBack: () => void;
  onSteer: (id: ContestantId, note: string) => Promise<void>;
  canSteer: boolean;
  steeringUnavailable: string;
  backLabel: string;
}) {
  const [note, setNote] = useState("");
  const provider = title(fighter.provider);
  const logo = providerLogo(fighter.provider);
  const relevantAttacks = attacks.filter(
    (attack) => attack.attacker === id || attack.target === id,
  );
  const checksPassed = fighter.checks.filter(
    (check) => check.status === "passed",
  ).length;

  return (
    <section className="fighter-detail" aria-labelledby="fighter-detail-title">
      <button className="back-to-arena" type="button" onClick={onBack}>
        <BackIcon /> {backLabel}
      </button>

      <header className={`detail-identity fighter-${id}`}>
        <div className="provider-mark" aria-hidden="true">
          {logo ? <img src={logo} alt="" /> : <span>?</span>}
        </div>
        <div>
          <p>Fighter {id.toUpperCase()}</p>
          <h1 id="fighter-detail-title">{provider}</h1>
          <span>{fighter.model ?? "Default model"}</span>
        </div>
        <div className="detail-health">
          <span>{roundLabel(round)}</span>
          <strong>{fighter.health} HP</strong>
          <em className={`status status-${fighter.status}`}>
            {fighter.status}
          </em>
        </div>
      </header>

      {round !== "live" ? (
        <div className="replay-notice">
          <strong>Viewing recorded state</strong>
          <span>
            This replay does not pause, rerun, or change the active battle.
          </span>
        </div>
      ) : null}

      <div className="detail-grid">
        <section className="workstream">
          <header>
            <h2>Agent workstream</h2>
            <span>{fighter.activity.replaceAll("_", " ")}</span>
          </header>
          <div className="detail-output" aria-label={`${provider} full output`}>
            {fighter.output.length ? (
              fighter.output.map((line, index) => (
                <p
                  className={line.stream === "stderr" ? "stderr" : ""}
                  key={`${line.timestamp}-${String(index)}`}
                >
                  <time>
                    {new Date(line.timestamp).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                      hour12: false,
                    })}
                  </time>
                  <span>{line.text.trim()}</span>
                </p>
              ))
            ) : (
              <p className="detail-empty">
                No output was recorded for this view yet.
              </p>
            )}
          </div>
          {round === "live" && canSteer ? (
            <form
              className="detail-steer"
              onSubmit={(event) => {
                event.preventDefault();
                if (!note.trim()) return;
                void onSteer(id, note).then(() => setNote(""));
              }}
            >
              <label htmlFor={`detail-steer-${id}`}>Steer next action</label>
              <div>
                <input
                  id={`detail-steer-${id}`}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={`Give ${provider} one instruction…`}
                />
                <button disabled={!note.trim()} type="submit">
                  Queue note
                </button>
              </div>
            </form>
          ) : round === "live" ? (
            <p className="detail-steer-unavailable">{steeringUnavailable}</p>
          ) : null}
        </section>

        <aside className="fighter-ledger">
          <section>
            <h2>Invocations</h2>
            {fighter.invocations.length ? (
              <ol>
                {fighter.invocations.map((invocation) => (
                  <li key={invocation.id}>
                    <div>
                      <strong>{invocation.stage.replaceAll("_", " ")}</strong>
                      <span>{invocation.status}</span>
                    </div>
                    <time>
                      {invocation.durationMs === undefined
                        ? "Running"
                        : `${(invocation.durationMs / 1000).toFixed(1)}s`}
                    </time>
                  </li>
                ))}
              </ol>
            ) : (
              <p>No invocations recorded for this view.</p>
            )}
          </section>
          <section>
            <h2>Checks</h2>
            <p className="ledger-summary">
              {checksPassed} of {fighter.checks.length} passed
            </p>
            {fighter.checks.length ? (
              <ul>
                {fighter.checks.map((check) => (
                  <li key={`${check.id}-${check.status}`}>
                    <strong>{check.id}</strong>
                    <span className={`check-${check.status}`}>
                      {check.status}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No checks recorded for this view.</p>
            )}
          </section>
          <section>
            <h2>Health ledger</h2>
            {fighter.healthChanges.length ? (
              <ul>
                {fighter.healthChanges.map((change) => (
                  <li key={change.sequence}>
                    <strong>{change.reason}</strong>
                    <span className={change.amount < 0 ? "loss" : "gain"}>
                      {change.amount > 0 ? "+" : ""}
                      {change.amount} HP
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No health changes recorded for this view.</p>
            )}
          </section>
          <section>
            <h2>Attack involvement</h2>
            {relevantAttacks.length ? (
              <ul>
                {relevantAttacks.map((attack, index) => (
                  <li key={`${attack.id}-${attack.phase}-${String(index)}`}>
                    <strong>{attackDisplayLabel(attack)}</strong>
                    <span>{attack.phase}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No attacks involved this fighter in this view.</p>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}

function ResultScreen({
  state,
  onReview,
  onOpenFighter,
}: {
  state: DashboardState;
  onReview: () => void;
  onOpenFighter: (id: ContestantId) => void;
}) {
  if (!state.result) return null;
  const championId = state.result.championId;
  const recommendedId = state.result.recommendedId;
  const landed = state.attacks.filter((attack) => attack.phase === "landed");
  const repairs = (
    Object.entries(state.contestants) as Array<
      [ContestantId, DashboardContestant]
    >
  ).flatMap(([id, fighter]) =>
    fighter.healthChanges
      .filter((change) => change.amount > 0)
      .map((change) => ({ id, change })),
  );
  const fighterResults = (["a", "b"] as const).map((id) => ({
    id,
    fighter: state.contestants[id],
    result: state.result?.contestants?.find((entry) => entry.id === id),
  }));
  const verdict =
    state.result.recommendationReason ??
    state.result.terminalOutcome?.reason ??
    (state.result.coverageConfidence === "provisional"
      ? "Coverage was unresolved, so no champion or recommendation is published."
      : "Review the evidence-backed result before merging.");
  const resultHeading = championId
    ? `Fighter ${championId.toUpperCase()} won the arena.`
    : recommendedId
      ? `Patch ${recommendedId.toUpperCase()} is recommended for review.`
      : "No competitive winner was published.";

  return (
    <section className="results-screen" aria-live="polite">
      <header className="result-verdict">
        <div>
          <h1>{resultHeading}</h1>
          <p>{verdict}</p>
        </div>
        <div className="result-actions">
          <button className="review-battle" type="button" onClick={onReview}>
            Review rounds
          </button>
          <button
            className="finish-session"
            type="button"
            onClick={() => void fetch("/api/close", { method: "POST" })}
          >
            Finish session
          </button>
        </div>
      </header>

      <dl className="result-summary">
        <div>
          <dt>Arena champion</dt>
          <dd>
            {championId ? `Fighter ${championId.toUpperCase()}` : "Withheld"}
          </dd>
        </div>
        <div>
          <dt>Recommendation</dt>
          <dd>
            {recommendedId
              ? `Patch ${recommendedId.toUpperCase()}`
              : "Withheld"}
          </dd>
        </div>
        <div>
          <dt>Coverage</dt>
          <dd>{state.result.coverageConfidence ?? "Legacy / unknown"}</dd>
        </div>
        <div>
          <dt>Rounds completed</dt>
          <dd>{state.result.roundsCompleted ?? "—"}</dd>
        </div>
        <div>
          <dt>Run integrity</dt>
          <dd>
            {state.assisted
              ? "Assisted — not competitively comparable"
              : "Competitive"}
          </dd>
        </div>
      </dl>

      <div className="result-fighters">
        {fighterResults.map(({ id, fighter, result }) => {
          const logo = providerLogo(fighter.provider);
          return (
            <button
              className={`result-fighter fighter-${id}${championId === id ? " is-winner" : ""}`}
              type="button"
              key={id}
              onClick={() => onOpenFighter(id)}
            >
              <span className="provider-mark" aria-hidden="true">
                {logo ? <img src={logo} alt="" /> : <span>?</span>}
              </span>
              <span className="result-fighter-name">
                <strong>{title(fighter.provider)}</strong>
                <small>{fighter.model ?? "Default model"}</small>
              </span>
              <span className="result-fighter-stat">
                <strong>{result?.health ?? fighter.health} HP</strong>
                <small>{result?.status ?? fighter.status}</small>
              </span>
              <span className="result-fighter-stat">
                <strong>
                  {result?.checksPassed ??
                    fighter.checks.filter((check) => check.status === "passed")
                      .length}
                  /{result?.checksTotal ?? fighter.checks.length}
                </strong>
                <small>checks passed</small>
              </span>
              <span className="result-fighter-open">
                Inspect fighter <OpenIcon />
              </span>
            </button>
          );
        })}
      </div>

      <div className="result-evidence">
        <section>
          <header>
            <h2>Defects caught</h2>
            <span>{landed.length}</span>
          </header>
          {landed.length ? (
            <ol>
              {landed.map((attack, index) => (
                <li key={`${attack.id}-${String(index)}`}>
                  <strong>{attackDisplayLabel(attack)}</strong>
                  <span>
                    {attack.severity ?? "verified"}
                    {attack.damage ? ` · ${String(attack.damage)} HP` : ""}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p>No attacks produced a verified defect.</p>
          )}
        </section>
        <section>
          <header>
            <h2>Repairs verified</h2>
            <span>{repairs.length}</span>
          </header>
          {repairs.length ? (
            <ol>
              {repairs.map(({ id, change }) => (
                <li key={`${id}-${String(change.sequence)}`}>
                  <strong>{change.reason}</strong>
                  <span>
                    Fighter {id.toUpperCase()} · +{change.amount} HP
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p>No health-restoring repairs were verified.</p>
          )}
        </section>
      </div>

      <footer className="result-footer">
        <p>
          {state.result.terminalOutcome
            ? `${state.result.terminalOutcome.reasonCode}: ${state.result.terminalOutcome.reason}`
            : "The recommendation is evidence-backed; inspect the winning patch before merging."}
        </p>
        <div>
          {state.links.map((link) => (
            <a href={link.url} target="_blank" rel="noreferrer" key={link.url}>
              {link.label} ↗
            </a>
          ))}
        </div>
      </footer>
    </section>
  );
}

function ThemePicker({
  theme,
  onChange,
}: {
  theme: ArenaTheme;
  onChange: (theme: ArenaTheme) => void;
}) {
  return (
    <fieldset className="theme-picker">
      <legend className="sr-only">Arena theme</legend>
      {ARENA_THEMES.map((option) => (
        <button
          type="button"
          className={`theme-option theme-option-${option}`}
          aria-label={themeNames[option]}
          aria-pressed={theme === option}
          title={themeNames[option]}
          key={option}
          onClick={() => onChange(option)}
        >
          <span aria-hidden="true" />
        </button>
      ))}
    </fieldset>
  );
}

function ProviderDisc({
  fighter,
  id,
}: {
  fighter: DashboardContestant;
  id: ContestantId;
}) {
  const logo = providerLogo(fighter.provider);
  return (
    <span className={`provider-disc provider-disc-${id}`} aria-hidden="true">
      {logo ? <img src={logo} alt="" /> : <span>?</span>}
    </span>
  );
}

export function CompactRoundNav({
  state,
  rounds,
  selected,
  onSelect,
}: {
  state: DashboardState;
  rounds: Array<NonNullable<DashboardState["round"]>>;
  selected: RoundSelection;
  onSelect: (round: RoundSelection) => void;
}) {
  return (
    <nav className="compact-rounds" aria-label="Recorded rounds">
      <button
        type="button"
        className={selected === "live" ? "is-selected" : ""}
        aria-current={selected === "live" ? "page" : undefined}
        onClick={() => onSelect("live")}
      >
        Live
      </button>
      {rounds
        .filter((round) => typeof round === "number")
        .map((round) => {
          const available = isRoundAvailable(state, round);
          return (
            <button
              type="button"
              className={selected === round ? "is-selected" : ""}
              aria-current={selected === round ? "page" : undefined}
              disabled={!available}
              key={round}
              onClick={() => onSelect(round)}
            >
              R{round}
            </button>
          );
        })}
    </nav>
  );
}

interface AlternateArenaProps {
  state: DashboardState;
  rounds: Array<NonNullable<DashboardState["round"]>>;
  selectedRound: RoundSelection;
  contestants: { a: DashboardContestant; b: DashboardContestant };
  attacks: DashboardState["attacks"];
  stage: string;
  onRound: (round: RoundSelection) => void;
  onFighter: (id: ContestantId) => void;
}

function BroadcastArena({
  state,
  rounds,
  selectedRound,
  contestants,
  attacks,
  stage,
  onRound,
  onFighter,
}: AlternateArenaProps) {
  const latest = attacks.at(-1);
  const landed = attacks.filter((attack) => attack.phase === "landed");
  const checks = (id: ContestantId) =>
    contestants[id].checks.filter((check) => check.status === "passed").length;
  return (
    <main className="broadcast-layout">
      <section className="broadcast-feed">
        <header className="feed-header">
          <strong>ARENA SPORTS NETWORK</strong>
          <span>{selectedRound === "live" ? "LIVE" : "REPLAY"}</span>
          <CompactRoundNav
            state={state}
            rounds={rounds}
            selected={selectedRound}
            onSelect={onRound}
          />
        </header>
        <div className="broadcast-field">
          <span className="feed-label">
            {roundLabel(selectedRound)} · {stage}
          </span>
          <button
            className="broadcast-fighter broadcast-fighter-a"
            type="button"
            onClick={() => onFighter("a")}
          >
            <ProviderDisc fighter={contestants.a} id="a" />
            <strong>{title(contestants.a.provider)}</strong>
            <small>{contestants.a.activity.replaceAll("_", " ")}</small>
          </button>
          <span className="broadcast-vs">VS</span>
          <button
            className="broadcast-fighter broadcast-fighter-b"
            type="button"
            onClick={() => onFighter("b")}
          >
            <ProviderDisc fighter={contestants.b} id="b" />
            <strong>{title(contestants.b.provider)}</strong>
            <small>{contestants.b.activity.replaceAll("_", " ")}</small>
          </button>
          <div className="scorebug">
            <div>
              <b>
                {title(contestants.a.provider)} · {contestants.a.health}
              </b>
              <span>{checks("a")} checks passing</span>
            </div>
            <strong>{latest?.damage ? `−${latest.damage} HP` : stage}</strong>
            <div>
              <b>
                {title(contestants.b.provider)} · {contestants.b.health}
              </b>
              <span>{checks("b")} checks passing</span>
            </div>
          </div>
        </div>
      </section>
      <aside className="battle-desk">
        <h1>Battle desk</h1>
        <dl>
          <div>
            <dt>Attacks landed</dt>
            <dd>{landed.length}</dd>
          </div>
          <div>
            <dt>Current round</dt>
            <dd>{state.round ? roundLabel(state.round) : "Opening"}</dd>
          </div>
        </dl>
        <section>
          <h2>Play by play</h2>
          {attacks.length ? (
            attacks
              .slice(-8)
              .reverse()
              .map((attack, index) => (
                <article key={`${attack.id}-${attack.phase}-${index}`}>
                  <strong>{attackDisplayLabel(attack)}</strong>
                  <p>
                    {attack.phase} · {attack.attacker?.toUpperCase() ?? "House"}{" "}
                    → {attack.target?.toUpperCase() ?? "both"}
                  </p>
                </article>
              ))
          ) : (
            <p>No verified attack activity yet.</p>
          )}
        </section>
        {selectedRound !== "live" ? (
          <p className="broadcast-replay">
            Read-only replay. Live execution is unchanged.
          </p>
        ) : null}
      </aside>
    </main>
  );
}

function EvidenceDeckArena({
  state,
  rounds,
  selectedRound,
  contestants,
  attacks,
  stage,
  onRound,
  onFighter,
}: AlternateArenaProps) {
  const latest = attacks.at(-1);
  const repairOwner: ContestantId =
    latest?.target === "a" || latest?.target === "b" ? latest.target : "b";
  const repair = contestants[repairOwner].invocations
    .filter((item) => item.stage === "repair")
    .at(-1);
  const deckItems = (id: ContestantId) => {
    const items = attacks
      .filter((attack) => attack.attacker === id || attack.target === id)
      .slice(-3)
      .map((attack) => attackDisplayLabel(attack) ?? attack.id);
    return items.length ? items : ["No evidence played yet"];
  };
  return (
    <main className="evidence-table">
      <header className="deck-header">
        <strong>AGENT ARENA · EVIDENCE DECK</strong>
        <span>{state.task}</span>
        <CompactRoundNav
          state={state}
          rounds={rounds}
          selected={selectedRound}
          onSelect={onRound}
        />
      </header>
      <div className="deck-surface">
        {(["a", "b"] as const).map((id) => (
          <aside className={`deck-player deck-player-${id}`} key={id}>
            <button
              className="deck-identity"
              type="button"
              onClick={() => onFighter(id)}
            >
              <ProviderDisc fighter={contestants[id]} id={id} />
              <strong>{title(contestants[id].provider)}</strong>
              <span>{contestants[id].activity.replaceAll("_", " ")}</span>
              <b>{contestants[id].health} HP</b>
              <i>
                <span style={{ width: `${contestants[id].health}%` }} />
              </i>
            </button>
            <div
              className={`deck-stack${deckItems(id)[0] === "No evidence played yet" ? " is-empty" : ""}`}
            >
              {deckItems(id).map((item, index) => (
                <span key={`${item}-${index}`}>{item}</span>
              ))}
            </div>
          </aside>
        ))}
        <section className="deck-center">
          <div className="deck-objective">
            <strong>
              {roundLabel(selectedRound)} · {stage}
            </strong>
            <span>
              {selectedRound === "live"
                ? "Authoritative live table"
                : "Read-only recorded table · live run unchanged"}
            </span>
          </div>
          <div className="playmat">
            <article className="evidence-card attack-card">
              <span>
                ATTACK ·{" "}
                {latest?.severity?.toUpperCase() ??
                  latest?.phase.toUpperCase() ??
                  "WAITING"}
              </span>
              <h2>
                {attackDisplayLabel(latest) ?? "Evidence has not been played"}
              </h2>
              <p>
                {latest
                  ? `${latest.attacker?.toUpperCase() ?? "House"} targets ${latest.target?.toUpperCase() ?? "both"}.`
                  : "The next authoritative attack will appear here."}
              </p>
              <footer>
                <b>
                  {latest?.damage ? `${latest.damage} DAMAGE` : "NO DAMAGE"}
                </b>
                <b>{latest?.phase ?? "PENDING"}</b>
              </footer>
            </article>
            <span className="deck-vs">VS</span>
            <article className="evidence-card repair-card">
              <span>REPAIR · {repair?.status.toUpperCase() ?? "WAITING"}</span>
              <h2>{repair?.stage.replaceAll("_", " ") ?? "Repair response"}</h2>
              <p>
                {repair
                  ? invocationStatusSentence(repair.id, repair.status)
                  : "No repair invocation is recorded for this view."}
              </p>
              <footer>
                <b>
                  {repair?.durationMs === undefined
                    ? "—"
                    : `${(repair.durationMs / 1000).toFixed(1)}s`}
                </b>
                <b>{stage}</b>
              </footer>
            </article>
          </div>
          <div className="deck-ledger">
            <strong>Health ledger</strong>
            <span>
              {title(contestants.a.provider)} {contestants.a.health} HP ·{" "}
              {title(contestants.b.provider)} {contestants.b.health} HP
            </span>
          </div>
        </section>
      </div>
    </main>
  );
}

const DESIGN_CONTRACT = {
  thesis:
    "Turn recorded engineering evidence into five materially distinct competition views without changing a product fact.",
  ownWorld:
    "Pocket hardware, sticker sheet, portable night console, sports broadcast, and felt evidence table.",
  story:
    "Track the fight, inspect either contestant, review recorded rounds, understand attacks and repairs, then finish the authoritative result.",
  firstViewport:
    "The active renderer's central metaphor dominates while live status, rounds, theme selection, and cancellation remain reachable.",
  form: "Operate-mode Electron observatory derived from approved outside concepts.",
  seed: "a785963b",
} as const;

export function App() {
  const [theme, setThemeState] = useState<ArenaTheme>(
    () => window.arenaTheme?.getTheme() ?? DEFAULT_ARENA_THEME,
  );
  const [themeWarning, setThemeWarning] = useState<string>();
  const [state, setState] = useState<DashboardState>(fallbackState);
  const [connected, setConnected] = useState(false);
  const [selectedRound, setSelectedRound] = useState<RoundSelection>("live");
  const [selectedFighter, setSelectedFighter] = useState<ContestantId | null>(
    null,
  );
  const [reviewingResults, setReviewingResults] = useState(false);

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

  const hasResult = Boolean(state.result);
  useEffect(() => {
    document.title = hasResult
      ? "Agent Arena · Results"
      : "Agent Arena · Live battle";
    if (!hasResult) setReviewingResults(false);
  }, [hasResult]);

  const presentation = useMemo(
    () => createArenaPresentation(state, selectedRound, connected),
    [connected, selectedRound, state],
  );
  const {
    counts,
    rounds,
    attacks: viewAttacks,
    contestants: viewContestants,
    stage,
    canSteer,
  } = presentation;
  const showResults =
    hasResult &&
    !reviewingResults &&
    selectedRound === "live" &&
    !selectedFighter;
  const latestAttack = viewAttacks.at(-1);
  const steeringUnavailable = steeringUnavailableMessage(
    connected,
    state.status,
  );
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

  const selectRound = (round: RoundSelection) => {
    setSelectedRound(round);
    setSelectedFighter(null);
    setReviewingResults(true);
  };

  const selectTheme = (nextTheme: ArenaTheme) => {
    setThemeState(nextTheme);
    setThemeWarning(undefined);
    if (!window.arenaTheme) return;
    void window.arenaTheme.setTheme(nextTheme).catch(() => {
      setThemeWarning(
        "Theme preference could not be saved. This window will keep your selection.",
      );
    });
  };

  return (
    <div
      className={`app-shell theme-${theme}`}
      data-theme={theme}
      data-design-thesis={DESIGN_CONTRACT.thesis}
      data-design-own-world={DESIGN_CONTRACT.ownWorld}
      data-design-story={DESIGN_CONTRACT.story}
      data-design-first-viewport={DESIGN_CONTRACT.firstViewport}
      data-design-form={DESIGN_CONTRACT.form}
      data-design-seed={DESIGN_CONTRACT.seed}
    >
      <header className="topbar">
        <button
          className="brand"
          type="button"
          onClick={() => {
            setSelectedFighter(null);
            setSelectedRound("live");
            setReviewingResults(false);
          }}
        >
          <span>AA</span>
          <strong>Agent Arena</strong>
        </button>
        <div className="task">
          <span>
            {state.task} · {showResults ? "Results" : roundLabel(selectedRound)}
          </span>
        </div>
        <div className="top-actions">
          <ThemePicker theme={theme} onChange={selectTheme} />
          <span
            className={`connection${hasResult ? " is-complete" : connected ? " is-live" : ""}`}
          >
            <i />
            {hasResult ? "Complete" : connected ? "Live" : "Reconnecting"}
          </span>
          {state.links.map((link) => (
            <a href={link.url} target="_blank" rel="noreferrer" key={link.url}>
              {link.label} ↗
            </a>
          ))}
          {hasResult && reviewingResults ? (
            <button
              className="show-results"
              type="button"
              onClick={() => {
                setSelectedFighter(null);
                setSelectedRound("live");
                setReviewingResults(false);
              }}
            >
              Results
            </button>
          ) : null}
          {state.status === "running" || state.status === "cancelling" ? (
            <button
              className="cancel"
              type="button"
              disabled={state.status === "cancelling"}
              onClick={() => void fetch("/api/cancel", { method: "POST" })}
            >
              {state.status === "cancelling" ? "Cancelling…" : "Cancel"}
            </button>
          ) : null}
        </div>
      </header>

      {themeWarning ? (
        <div className="theme-warning" role="status">
          {themeWarning}
        </div>
      ) : null}

      {!showResults && !selectedFighter && theme === "live-arena-broadcast" ? (
        <BroadcastArena
          state={state}
          rounds={rounds}
          selectedRound={selectedRound}
          contestants={viewContestants}
          attacks={viewAttacks}
          stage={stage}
          onRound={selectRound}
          onFighter={setSelectedFighter}
        />
      ) : !showResults && !selectedFighter && theme === "evidence-deck" ? (
        <EvidenceDeckArena
          state={state}
          rounds={rounds}
          selectedRound={selectedRound}
          contestants={viewContestants}
          attacks={viewAttacks}
          stage={stage}
          onRound={selectRound}
          onFighter={setSelectedFighter}
        />
      ) : (
        <main className={showResults ? "is-results" : undefined}>
          <RoundNavigator
            state={state}
            rounds={rounds}
            selected={selectedRound}
            onSelect={selectRound}
          />

          <section className="arena">
            {showResults ? (
              <ResultScreen
                state={state}
                onReview={() => {
                  setReviewingResults(true);
                  setSelectedRound(state.round ?? "live");
                }}
                onOpenFighter={(id) => {
                  setSelectedFighter(id);
                }}
              />
            ) : selectedFighter ? (
              <FighterDetail
                id={selectedFighter}
                fighter={viewContestants[selectedFighter]}
                round={selectedRound}
                attacks={viewAttacks}
                backLabel={
                  hasResult && !reviewingResults
                    ? "Back to results"
                    : "Back to main arena"
                }
                onBack={() => {
                  setSelectedFighter(null);
                }}
                onSteer={steer}
                canSteer={canSteer}
                steeringUnavailable={steeringUnavailable}
              />
            ) : (
              <>
                <div className="arena-heading">
                  <div>
                    <span>{roundLabel(selectedRound)}</span>
                    <h1>
                      {title(viewContestants.a.provider)} <b>vs</b>{" "}
                      {title(viewContestants.b.provider)}
                    </h1>
                  </div>
                  <p>
                    {selectedRound === "live"
                      ? state.assisted
                        ? "Assisted run"
                        : "Competitive run"
                      : "Recorded round state"}
                  </p>
                </div>
                <div className="fighters">
                  <Fighter
                    id="a"
                    fighter={viewContestants.a}
                    onSteer={steer}
                    onOpen={setSelectedFighter}
                    isHistorical={selectedRound !== "live"}
                    canSteer={canSteer}
                    steeringUnavailable={steeringUnavailable}
                  />
                  <div className="versus" aria-hidden="true">
                    <span>VS</span>
                    <i />
                  </div>
                  <Fighter
                    id="b"
                    fighter={viewContestants.b}
                    onSteer={steer}
                    onOpen={setSelectedFighter}
                    isHistorical={selectedRound !== "live"}
                    canSteer={canSteer}
                    steeringUnavailable={steeringUnavailable}
                  />
                </div>
                <div className="battle-call">
                  <span>
                    {selectedRound !== "live"
                      ? "Replay summary"
                      : latestAttack?.phase === "landed"
                        ? "Attack landed"
                        : latestAttack?.phase === "revised"
                          ? "Evidence revised"
                          : "Current move"}
                  </span>
                  <strong>
                    {attackDisplayLabel(latestAttack) ??
                      (selectedRound === "live"
                        ? `${stage} is underway`
                        : `No attack activity was recorded for ${roundLabel(selectedRound).toLowerCase()}.`)}
                  </strong>
                </div>
                {selectedRound === "live" ? (
                  <div className="move-counts move-counts-inline">
                    <p>
                      <span className="cyan">{counts.mounting}</span> mounting
                    </p>
                    <p>
                      <span className="green">{counts.landed}</span> landed
                    </p>
                    <p>
                      <span className="amber">{counts.revised}</span> revisions
                    </p>
                    <p>
                      Stage step {roundStep < 0 ? "—" : String(roundStep + 1)}{" "}
                      of 4
                    </p>
                  </div>
                ) : null}
              </>
            )}
          </section>

          <aside className="activity">
            <header>
              <div>
                <span>{roundLabel(selectedRound)}</span>
                <strong>Evidence stream</strong>
              </div>
              <em>{viewAttacks.length}</em>
            </header>
            <div className="activity-list">
              {viewAttacks.length ? (
                viewAttacks
                  .slice(-10)
                  .reverse()
                  .map((attack, index) => (
                    <article
                      key={`${attack.id}-${attack.phase}-${String(index)}`}
                    >
                      <i className={`event event-${attack.phase}`} />
                      <div>
                        <strong>{attackDisplayLabel(attack)}</strong>
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
            {state.failures.length ? (
              <div className="warnings">
                <strong>Recovery activity</strong>
                {state.failures.slice(-3).map((failure) => (
                  <p key={failure.id}>
                    {failure.state}: {failure.subject} · attempt{" "}
                    {failure.attempt}
                    {failure.terminalDisposition
                      ? ` · ${failure.terminalDisposition}`
                      : ""}
                  </p>
                ))}
              </div>
            ) : null}
          </aside>
        </main>
      )}
    </div>
  );
}
