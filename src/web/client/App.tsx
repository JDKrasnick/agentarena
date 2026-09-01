import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  DashboardBrowserSession,
  DashboardContestant,
  DashboardState,
} from "../../dashboard/state.js";
import { providerActivityLabel } from "../../dashboard/provider-activity.js";
import {
  ARENA_THEMES,
  DEFAULT_ARENA_THEME,
  type ArenaTheme,
} from "../../dashboard/arena-theme.js";
import {
  attackDisplayLabel,
  createArenaPresentation,
  isRoundAvailable,
  projectAttackLifecycles,
  recordedRoundMoveCount,
  roundLabel,
  roundPlanDescription,
  roundPlanStatus,
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
    arenaDesktop?: {
      reportPaint(revision: number): void;
    };
  }
}

const themeNames: Record<ArenaTheme, string> = {
  "classic-shell": "Classic Shell",
  "developer-dashboard": "Developer Dashboard",
  "night-transit": "Night Transit",
  "test-lab": "Test Lab",
  "live-arena-broadcast": "Live Broadcast",
  "retro-tactics": "16-Bit Tactics",
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
      summaries: [],
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
      summaries: [],
      output: [],
      healthChanges: [],
    },
  },
  systemOutput: [],
  attacks: [],
  browserSessions: [],
  failures: [],
  links: [],
};

const SNAPSHOT_STALE_AFTER_MS = 8_000;
type ConnectionState = "reconnecting" | "live" | "stale";
interface SnapshotEnvelope {
  revision: number;
  generatedAt: string;
  snapshot: DashboardState;
}

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

function checkCounts(fighter: DashboardContestant) {
  return (
    fighter.authoritativeCheckCounts ?? {
      passed: fighter.checks.filter((check) => check.status === "passed")
        .length,
      total: fighter.checks.length,
    }
  );
}

function participantName(
  participant: string | undefined,
  contestants: { a: DashboardContestant; b: DashboardContestant },
  fallback: string,
) {
  if (participant === "a" || participant === "b") {
    return title(contestants[participant].provider);
  }
  return participant ? title(participant) : fallback;
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
  browserSessions,
  onSteer,
  onOpen,
  isHistorical,
  canSteer,
  steeringUnavailable,
}: {
  id: ContestantId;
  fighter: DashboardContestant;
  browserSessions: DashboardBrowserSession[];
  onSteer: (id: ContestantId, note: string) => Promise<void>;
  onOpen: (id: ContestantId) => void;
  isHistorical: boolean;
  canSteer: boolean;
  steeringUnavailable: string;
}) {
  const [note, setNote] = useState("");
  const damage = fighter.lastHealthChange?.amount ?? 0;
  const checks = checkCounts(fighter);
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
          <BrowserSessionAction sessions={browserSessions} actor={provider} />
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
          <dd>{providerActivityLabel(fighter)}</dd>
        </div>
        <div>
          <dt>Checks</dt>
          <dd>
            {checks.passed}/{checks.total} passed
          </dd>
        </div>
      </dl>

      <CompactAgentOutput fighter={fighter} provider={provider} />

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

export function CompactAgentOutput({
  fighter,
  provider,
}: {
  fighter: DashboardContestant;
  provider: string;
}) {
  const summaries = fighter.summaries.slice(-10);
  return (
    <div className="agent-output" aria-label={`${provider} work summary`}>
      {summaries.length ? (
        summaries.map((summary) => (
          <p key={summary.invocationId}>
            <span>›</span> {summary.text}
          </p>
        ))
      ) : (
        <p className="quiet">Waiting for a work summary…</p>
      )}
    </div>
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
          const planDescription = roundPlanDescription(state, round);
          const isExtension =
            roundPlanStatus(state, round) === "conditional_extension";
          return (
            <button
              className={`${selected === round ? "is-selected" : ""}${roundPlanStatus(state, round) === "conditional_extension" ? " is-extension" : ""}`}
              type="button"
              aria-label={`${roundLabel(round)}${planDescription ? ` — ${planDescription}` : ""}`}
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
                    ? isExtension
                      ? "Extension in progress"
                      : "In progress"
                    : isComplete
                      ? `${isExtension ? "Extension · " : ""}${String(recordedMoves)} recorded moves`
                      : (planDescription ?? "Upcoming")}
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
  browserSessions,
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
  browserSessions: DashboardBrowserSession[];
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
  const checks = checkCounts(fighter);

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
          <BrowserSessionAction sessions={browserSessions} actor={provider} />
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
            <span>{providerActivityLabel(fighter)}</span>
          </header>
          <FullAgentOutput fighter={fighter} provider={provider} />
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
                    {invocation.progress?.length ? (
                      <ol className="provider-progress">
                        {invocation.progress
                          .slice(-20)
                          .map((activity, index) => (
                            <li key={`${activity.timestamp}-${String(index)}`}>
                              <time>{activity.timestamp.slice(11, 19)}</time>{" "}
                              {activity.label}
                            </li>
                          ))}
                      </ol>
                    ) : null}
                    {invocation.diagnosticArtifactRefs?.length ? (
                      <details>
                        <summary>Diagnostic artifacts</summary>
                        <ul>
                          {invocation.diagnosticArtifactRefs.map((artifact) => (
                            <li key={artifact}>{artifact}</li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
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
              {checks.passed} of {checks.total} passed
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

export function FullAgentOutput({
  fighter,
  provider,
}: {
  fighter: DashboardContestant;
  provider: string;
}) {
  return (
    <pre className="detail-output" aria-label={`${provider} full output`}>
      {fighter.output.length ? (
        fighter.output.map((chunk, index) => (
          <span
            className={`output-chunk output-${chunk.stream}`}
            data-invocation={chunk.invocationId}
            key={`${chunk.timestamp}-${String(index)}`}
          >
            {chunk.text}
          </span>
        ))
      ) : (
        <span className="detail-empty">
          No output was recorded for this view yet.
        </span>
      )}
    </pre>
  );
}

export function ResultScreen({
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
  const nonDiscriminating = state.result.outcomeKind === "non_discriminating";
  const landed = state.attacks.filter(
    (attack) => attack.phase === "landed" && attack.evidenceClass !== "shared",
  );
  const shared = state.attacks.filter(
    (attack) => attack.phase === "landed" && attack.evidenceClass === "shared",
  );
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
  const resultHeading = nonDiscriminating
    ? "Non-discriminating battle."
    : championId
      ? `Fighter ${championId.toUpperCase()} won the arena.`
      : recommendedId
        ? `${title(state.contestants[recommendedId].provider)} (Fighter ${recommendedId.toUpperCase()}) is recommended for review.`
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
          <dt>Arena result</dt>
          <dd>
            {nonDiscriminating
              ? "No champion"
              : championId
                ? `Fighter ${championId.toUpperCase()}`
                : "Withheld"}
          </dd>
        </div>
        <div>
          <dt>Recommendation</dt>
          <dd>
            {recommendedId
              ? `${title(state.contestants[recommendedId].provider)} · Fighter ${recommendedId.toUpperCase()}`
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
          <dt>Evidence signal</dt>
          <dd>
            {state.result.competitiveLandingCount ?? 0} competitive ·{" "}
            {state.result.sharedDefectCount ?? 0} shared ·{" "}
            {state.result.explicitEmptyLaneCount ?? 0} empty lanes
          </dd>
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

      {(
        state.result.implementationEligibility ??
        state.result.terminalOutcome?.contestants
      )?.length ? (
        <section className="result-validation" aria-label="Validation evidence">
          <header>
            <h2>Eligibility and validation evidence</h2>
            <span>Required checks</span>
          </header>
          <div>
            {(
              state.result.implementationEligibility ??
              state.result.terminalOutcome?.contestants ??
              []
            ).map((entry) => (
              <article key={entry.contestantId}>
                <h3>
                  Fighter {entry.contestantId.toUpperCase()} ·{" "}
                  {entry.eligible ? "eligible" : "ineligible"}
                </h3>
                <p>{entry.reasonCode ?? "eligible_patch"}</p>
                {entry.validation ? (
                  <>
                    <strong>
                      {entry.validation.outcome.replaceAll("_", " ")}
                    </strong>
                    <ol>
                      {entry.validation.attempts.map((attempt, index) => (
                        <li key={attempt.stdoutPath}>
                          <span>
                            Attempt {String(index + 1)} ·{" "}
                            {attempt.termination?.cause ??
                              (attempt.timedOut ? "timeout" : "exit")}
                          </span>
                          <small>
                            exit {attempt.exitCode ?? "none"} · signal{" "}
                            {attempt.signal ?? "none"} · {attempt.durationMs}ms
                            · last output{" "}
                            {attempt.termination?.lastOutputAt ?? "none"}
                          </small>
                          {attempt.failureExcerpt ? (
                            <details>
                              <summary>Failure excerpt</summary>
                              <pre>{attempt.failureExcerpt}</pre>
                            </details>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  </>
                ) : (
                  <small>No required-validation command evidence.</small>
                )}
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <div className="result-evidence">
        <section>
          <header>
            <h2>Competitive landings</h2>
            <span>{state.result.competitiveLandingCount ?? landed.length}</span>
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
            <p>
              No contestant-authored differential attack produced a verified
              defect.
            </p>
          )}
        </section>
        <section>
          <header>
            <h2>Shared QA defects</h2>
            <span>{state.result.sharedDefectCount ?? shared.length}</span>
          </header>
          {shared.length ? (
            <ol>
              {shared.map((attack, index) => (
                <li key={`${attack.id}-shared-${String(index)}`}>
                  <strong>{attackDisplayLabel(attack)}</strong>
                  <span>
                    Neutral evidence · {attack.severity ?? "verified"}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p>No shared neutral defect was recorded.</p>
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
                    {title(state.contestants[id].provider)} · +{change.amount}{" "}
                    HP
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
            : nonDiscriminating
              ? recommendedId
                ? "The arena produced no champion; the recommended patch comes only from a separate identity-blind quality comparison."
                : "The arena produced no champion or automatic recommendation. Inspect either eligible patch and record an explicit choice."
              : "The recommendation is evidence-backed; inspect the selected patch before merging."}
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

export function BrowserSessionAction({
  sessions,
  actor,
}: {
  sessions: DashboardBrowserSession[];
  actor: string;
}) {
  const session = sessions.at(-1);
  if (!session) return null;
  const multiple = sessions.length > 1;
  const description = multiple
    ? `${String(sessions.length)} browser sessions are active. ${actor} is using the most recent session: ${session.label}.`
    : `${actor} is using the browser for ${session.label}.`;
  return (
    <a
      className={`browser-session-action${session.contestantId ? ` is-${session.contestantId}` : " is-arena"}`}
      href={session.url}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open browser. ${description} This is a separate view from Arena's isolated probe.`}
      title={`${description} The Arena probe remains isolated.`}
    >
      <svg viewBox="0 0 18 18" aria-hidden="true">
        <rect x="1.5" y="2.5" width="15" height="13" rx="2" />
        <path d="M2 6.5h14" />
        <circle cx="4.25" cy="4.5" r=".65" />
        <circle cx="6.5" cy="4.5" r=".65" />
      </svg>
      <span className="browser-session-copy">
        <small>{actor} is using the browser</small>
        <strong>Open browser</strong>
      </span>
      {multiple ? <b aria-hidden="true">{sessions.length}</b> : null}
    </a>
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
          const planDescription = roundPlanDescription(state, round);
          return (
            <button
              type="button"
              className={`${selected === round ? "is-selected" : ""}${roundPlanStatus(state, round) === "conditional_extension" ? " is-extension" : ""}`}
              aria-label={`${roundLabel(round)}${planDescription ? ` — ${planDescription}` : ""}`}
              title={planDescription}
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

interface DeveloperDashboardProps extends AlternateArenaProps {
  onSteer: (id: ContestantId, note: string) => Promise<void>;
  canSteer: boolean;
  steeringUnavailable: string;
}

function DeveloperAgentPanel({
  id,
  fighter,
  browserSessions,
  isHistorical,
  canSteer,
  steeringUnavailable,
  onFighter,
  onSteer,
}: {
  id: ContestantId;
  fighter: DashboardContestant;
  browserSessions: DashboardBrowserSession[];
  isHistorical: boolean;
  canSteer: boolean;
  steeringUnavailable: string;
  onFighter: (id: ContestantId) => void;
  onSteer: (id: ContestantId, note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const provider = title(fighter.provider);
  const checks = checkCounts(fighter);
  const summaries = fighter.summaries.slice(-4).reverse();

  return (
    <article className={`developer-agent developer-agent-${id}`}>
      <header>
        <ProviderDisc fighter={fighter} id={id} />
        <div>
          <strong>{provider}</strong>
          <span>{fighter.model ?? "Default model"}</span>
          <BrowserSessionAction sessions={browserSessions} actor={provider} />
        </div>
        <div className="developer-health">
          <b>{fighter.health}</b>
          <span>HP</span>
        </div>
      </header>
      <div
        className="developer-health-track"
        aria-label={`${provider} health ${String(fighter.health)} of 100`}
      >
        <span style={{ width: `${String(fighter.health)}%` }} />
      </div>
      <dl className="developer-metrics">
        <div>
          <dt>Checks</dt>
          <dd>
            {checks.passed}/{checks.total}
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{fighter.status.replaceAll("_", " ")}</dd>
        </div>
        <div>
          <dt>Runs</dt>
          <dd>{fighter.invocations.length}</dd>
        </div>
      </dl>
      <section className="developer-checks">
        <header>
          <strong>Check results</strong>
          <span>{checks.passed} passing</span>
        </header>
        {fighter.checks.length ? (
          <table>
            <thead>
              <tr>
                <th>Check</th>
                <th>Round</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {fighter.checks.slice(-5).map((check) => (
                <tr key={`${check.id}-${check.status}`}>
                  <td>{check.id}</td>
                  <td>{check.round ? `R${check.round}` : "—"}</td>
                  <td>
                    <span className={`developer-check is-${check.status}`}>
                      <i /> {check.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No checks recorded yet.</p>
        )}
      </section>
      <section className="developer-log">
        <header>
          <strong>Agent log</strong>
          <button type="button" onClick={() => onFighter(id)}>
            View full log
          </button>
        </header>
        <div>
          {summaries.length ? (
            summaries.map((summary) => (
              <p key={summary.invocationId}>
                <time>{summary.timestamp.slice(11, 19)}</time>
                <span>{summary.text}</span>
              </p>
            ))
          ) : (
            <p className="is-empty">Waiting for a work summary…</p>
          )}
        </div>
      </section>
      <footer>
        {isHistorical ? (
          <span>Read-only recorded state</span>
        ) : canSteer ? (
          <form
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
              placeholder={`Queue one note for ${provider}…`}
            />
            <button type="submit" disabled={!note.trim()}>
              Queue
            </button>
          </form>
        ) : (
          <span>{steeringUnavailable}</span>
        )}
        <button type="button" onClick={() => onFighter(id)}>
          Inspect {provider} <OpenIcon />
        </button>
      </footer>
    </article>
  );
}

export function DeveloperDashboardArena({
  state,
  rounds,
  selectedRound,
  contestants,
  attacks,
  stage,
  onRound,
  onFighter,
  onSteer,
  canSteer,
  steeringUnavailable,
}: DeveloperDashboardProps) {
  const latest = attacks.at(-1);
  const activeRound = state.round ?? rounds.at(-1) ?? 1;
  const isHistorical = selectedRound !== "live";

  return (
    <main className="developer-console">
      <aside className="developer-timeline" aria-label="Round timeline">
        <header>
          <strong>Round timeline</strong>
          <span>{isHistorical ? "Replay" : "Live run"}</span>
        </header>
        <nav>
          <button
            type="button"
            className={selectedRound === "live" ? "is-selected" : ""}
            aria-current={selectedRound === "live" ? "page" : undefined}
            onClick={() => onRound("live")}
          >
            <i />
            <span>
              <strong>Live arena</strong>
              <small>{stage}</small>
            </span>
          </button>
          {rounds.map((round) => {
            const available = isRoundAvailable(state, round);
            const current = state.round === round && state.status === "running";
            const planDescription = roundPlanDescription(state, round);
            const isExtension =
              roundPlanStatus(state, round) === "conditional_extension";
            return (
              <button
                type="button"
                className={`${selectedRound === round ? "is-selected" : ""}${roundPlanStatus(state, round) === "conditional_extension" ? " is-extension" : ""}`}
                aria-label={`${roundLabel(round)}${planDescription ? ` — ${planDescription}` : ""}`}
                aria-current={selectedRound === round ? "page" : undefined}
                disabled={!available}
                key={round}
                onClick={() => onRound(round)}
              >
                <i>{round}</i>
                <span>
                  <strong>{roundLabel(round)}</strong>
                  <small>
                    {current
                      ? isExtension
                        ? "Extension in progress"
                        : "In progress"
                      : available
                        ? `${isExtension ? "Extension · " : ""}${String(recordedRoundMoveCount(state, round))} recorded moves`
                        : (planDescription ?? "Upcoming")}
                  </small>
                </span>
              </button>
            );
          })}
        </nav>
        <section>
          <strong>Objective</strong>
          <p>{stage}</p>
          <span>
            {isHistorical
              ? "Recorded state. Live execution is unchanged."
              : state.task}
          </span>
        </section>
      </aside>

      <section className="developer-workspace">
        <header className="developer-workspace-header">
          <div>
            <h1>
              {roundLabel(selectedRound)}: {stage}
            </h1>
            <p>
              {isHistorical
                ? "Review the recorded checks, summaries, and evidence for this round."
                : "Both agents are running concurrently. Inspect evidence before selecting a patch."}
            </p>
          </div>
          <span className={state.assisted ? "is-assisted" : ""}>
            {state.assisted ? "Assisted run" : "Competitive run"}
          </span>
        </header>
        <div className="developer-agents">
          {(["a", "b"] as const).map((id) => (
            <DeveloperAgentPanel
              id={id}
              fighter={contestants[id]}
              browserSessions={state.browserSessions.filter(
                (session) => session.contestantId === id,
              )}
              isHistorical={isHistorical}
              canSteer={canSteer}
              steeringUnavailable={steeringUnavailable}
              onFighter={onFighter}
              onSteer={onSteer}
              key={id}
            />
          ))}
        </div>
        <footer className="developer-current-event">
          <span>{latest?.phase.replaceAll("_", " ") ?? "Current move"}</span>
          <strong>
            {attackDisplayLabel(latest) ?? `${stage} is underway`}
          </strong>
        </footer>
      </section>

      <aside className="developer-events">
        <header>
          <strong>Activity</strong>
          <span>{attacks.length} events</span>
        </header>
        <div>
          {attacks.length ? (
            attacks
              .slice(-10)
              .reverse()
              .map((attack, index) => (
                <article key={`${attack.id}-${attack.phase}-${String(index)}`}>
                  <i className={`is-${attack.phase}`} />
                  <div>
                    <strong>{attackDisplayLabel(attack)}</strong>
                    <span>
                      {attack.attacker?.toUpperCase() ?? "House"} →{" "}
                      {attack.target?.toUpperCase() ?? "both"}
                    </span>
                  </div>
                  <small>{attack.round ? `R${attack.round}` : "—"}</small>
                </article>
              ))
          ) : (
            <p>No attack evidence has been recorded yet.</p>
          )}
        </div>
      </aside>

      <footer className="developer-statusbar">
        <span>Run {state.runId ?? "preflight"}</span>
        <span>Round {activeRound}</span>
        <span>{state.status.replaceAll("_", " ")}</span>
        <span>{attacks.length} evidence events</span>
      </footer>
    </main>
  );
}

function OperatorNote({
  id,
  fighter,
  canSteer,
  isHistorical,
  unavailable,
  onSteer,
}: {
  id: ContestantId;
  fighter: DashboardContestant;
  canSteer: boolean;
  isHistorical: boolean;
  unavailable: string;
  onSteer: (id: ContestantId, note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  if (isHistorical) return <span>Read-only recorded state</span>;
  if (!canSteer) return <span>{unavailable}</span>;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!note.trim()) return;
        void onSteer(id, note).then(() => setNote(""));
      }}
    >
      <input
        aria-label={`Steer ${title(fighter.provider)}`}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder={`One-time note for ${title(fighter.provider)}…`}
      />
      <button type="submit" disabled={!note.trim()}>
        Queue
      </button>
    </form>
  );
}

function HealthHistory({
  fighter,
  label,
}: {
  fighter: DashboardContestant;
  label: string;
}) {
  const values = [100, ...fighter.healthChanges.map((change) => change.health)];
  const visibleValues = values.slice(-10);
  const points = visibleValues
    .map((value, index, entries) => {
      const x = entries.length === 1 ? 0 : (index / (entries.length - 1)) * 100;
      const normalizedHealth = Math.max(0, Math.min(100, value));
      const y = 4 + ((100 - normalizedHealth) / 100) * 28;
      return `${String(x)},${String(y)}`;
    })
    .join(" ");
  const current = visibleValues.at(-1) ?? 100;
  const minimum = Math.min(...visibleValues);
  const accessibleLabel = `${label}: 100 to ${current} HP; low ${minimum} HP across ${visibleValues.length} observations.`;
  return (
    <svg
      className="lab-health-chart"
      viewBox="0 0 100 36"
      role="img"
      aria-label={accessibleLabel}
    >
      <title>{accessibleLabel}</title>
      <path d="M0 12H100M0 24H100" />
      <polyline points={points || "0,0"} />
    </svg>
  );
}

function NightTransitStatus({
  id,
  fighter,
  browserSessions,
  onFighter,
}: {
  id: ContestantId;
  fighter: DashboardContestant;
  browserSessions: DashboardBrowserSession[];
  onFighter: (id: ContestantId) => void;
}) {
  const checks = checkCounts(fighter);
  return (
    <article className={`transit-contestant transit-contestant-${id}`}>
      <ProviderDisc fighter={fighter} id={id} />
      <div>
        <strong>{title(fighter.provider)} line</strong>
        <span>{fighter.model ?? "Default model"}</span>
        <BrowserSessionAction
          sessions={browserSessions}
          actor={title(fighter.provider)}
        />
      </div>
      <dl>
        <div>
          <dt>Health</dt>
          <dd>{fighter.health} HP</dd>
        </div>
        <div>
          <dt>Checks</dt>
          <dd>
            {checks.passed}/{checks.total}
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{fighter.status.replaceAll("_", " ")}</dd>
        </div>
      </dl>
      <button type="button" onClick={() => onFighter(id)}>
        Inspect {title(fighter.provider)}
      </button>
    </article>
  );
}

function TransitPath({
  active,
  className,
  d,
}: {
  active: boolean;
  className: "a" | "b" | "verify";
  d: string;
}) {
  return (
    <>
      <path className={`transit-track track-${className}`} d={d} />
      {active ? (
        <>
          <path className={`transit-route route-${className}`} d={d} />
          <path
            className={`transit-route-highlight route-${className}`}
            d={d}
          />
        </>
      ) : null}
    </>
  );
}

function TransitTrainIcon() {
  return (
    <svg className="transit-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.5 4.5h11v11h-11z" />
      <path d="M8.5 7.5h7M8 18.5l2-3M16 18.5l-2-3" />
      <circle cx="9" cy="12.5" r="1" />
      <circle cx="15" cy="12.5" r="1" />
    </svg>
  );
}

function TransitRoundelIcon() {
  return (
    <svg className="transit-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M3 10h18v4H3z" />
    </svg>
  );
}

function TransitEvidenceIcon() {
  return (
    <svg className="transit-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 3.5h9l3 3v14H6z" />
      <path d="M15 3.5v4h4M9 11h6M9 15h6" />
    </svg>
  );
}

export function NightTransitArena({
  state,
  rounds,
  selectedRound,
  contestants,
  attacks,
  stage,
  onRound,
  onFighter,
  onSteer,
  canSteer,
  steeringUnavailable,
}: DeveloperDashboardProps) {
  const lifecycles = projectAttackLifecycles(state, attacks);
  const isHistorical = selectedRound !== "live";
  const hasRoute = (id: ContestantId) =>
    lifecycles.some(
      (attack) => attack.attacker === id || attack.repairedBy === id,
    );
  const hasVerification = lifecycles.some((attack) =>
    ["landed", "revised", "resolved"].includes(attack.phase),
  );
  const verifiedRoutes = lifecycles.filter((attack) =>
    ["landed", "resolved"].includes(attack.phase),
  ).length;
  const repairedRoutes = lifecycles.filter(
    (attack) => attack.repairedBy !== undefined,
  ).length;
  const arrivals = lifecycles.slice(-5).reverse();
  return (
    <main className="night-transit">
      <aside className="transit-rounds">
        <header>
          <strong>
            <TransitRoundelIcon />
            {roundLabel(selectedRound)}
          </strong>
          <span>{isHistorical ? "Read-only" : "Live service"}</span>
        </header>
        <CompactRoundNav
          state={state}
          rounds={rounds}
          selected={selectedRound}
          onSelect={onRound}
        />
        <ol>
          {rounds.map((round) => (
            <li
              key={round}
              className={state.round === round ? "is-current" : ""}
            >
              <i />
              <span>
                <strong>{roundLabel(round)}</strong>
                <small>
                  {isRoundAvailable(state, round)
                    ? `${roundPlanStatus(state, round) === "conditional_extension" ? "Extension · " : ""}${recordedRoundMoveCount(state, round)} recorded moves`
                    : (roundPlanDescription(state, round) ?? "Upcoming")}
                </small>
              </span>
            </li>
          ))}
        </ol>
        <p>
          {isHistorical
            ? "Recorded view. Live execution is unchanged."
            : state.task}
        </p>
      </aside>
      <section className="transit-workspace">
        <header>
          <div>
            <h1>
              <TransitTrainIcon />
              Verification interchange
            </h1>
            <p>{stage}</p>
          </div>
          <span>
            {isHistorical
              ? "Recorded service"
              : state.assisted
                ? "Assisted service"
                : "Competitive service"}
          </span>
        </header>
        <div className="transit-network">
          <div className="transit-contestants">
            {(["a", "b"] as const).map((id) => (
              <NightTransitStatus
                id={id}
                fighter={contestants[id]}
                browserSessions={state.browserSessions.filter(
                  (session) => session.contestantId === id,
                )}
                onFighter={onFighter}
                key={id}
              />
            ))}
          </div>
          <section
            className="transit-map"
            aria-label="Attack and verification route map"
          >
            <svg
              viewBox="0 0 900 360"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <TransitPath
                active={hasRoute("a")}
                className="a"
                d="M35 82H310L380 145H520L590 82H865"
              />
              <TransitPath
                active={hasRoute("b")}
                className="b"
                d="M35 278H310L380 215H520L590 278H865"
              />
              <TransitPath
                active={hasVerification}
                className="verify"
                d="M450 145V215"
              />
            </svg>
            <div className="transit-line-label line-a">
              <b>A</b>
              <span>Line A · contestant service</span>
            </div>
            <div className="transit-line-label line-b">
              <b>B</b>
              <span>Line B · contestant service</span>
            </div>
            {(["a", "b"] as const).flatMap((id) =>
              rounds.slice(0, 3).map((round, index) => (
                <span
                  className={`transit-station transit-station-${id} station-${String(index + 1)} ${state.round === round ? "is-current" : ""}`}
                  key={`${id}-${String(round)}`}
                >
                  <i />
                  <strong>R{round}</strong>
                  <small>
                    {state.round === round
                      ? isRoundAvailable(state, round)
                        ? `Current · ${recordedRoundMoveCount(state, round)} moves`
                        : "Current · upcoming"
                      : isRoundAvailable(state, round)
                        ? `${recordedRoundMoveCount(state, round)} moves`
                        : "Upcoming"}
                  </small>
                </span>
              )),
            )}
            <div className="transit-interchange">
              <i>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m6.5 12.5 3.5 3.5 7.5-8" />
                </svg>
                <strong>Verify</strong>
              </i>
              <span>
                {hasVerification ? "Evidence accepted" : "Awaiting evidence"}
              </span>
            </div>
            <div className="transit-map-status">
              <span>
                {lifecycles.length ? "Network status" : "No recorded services"}
              </span>
              <strong>
                {lifecycles.length
                  ? "Services recorded"
                  : "The network is ready"}
              </strong>
            </div>
          </section>
        </div>
        <dl
          className="transit-route-summary"
          aria-label="Recorded route totals"
        >
          <div>
            <dt>Attack routes</dt>
            <dd>{lifecycles.length}</dd>
          </div>
          <div>
            <dt>Verified</dt>
            <dd>{verifiedRoutes}</dd>
          </div>
          <div>
            <dt>Repaired</dt>
            <dd>{repairedRoutes}</dd>
          </div>
        </dl>
        <section className="transit-arrivals">
          <header>
            <h2>
              <TransitTrainIcon />
              Arrivals
            </h2>
            <span>{arrivals.length} attack lifecycles</span>
          </header>
          {arrivals.length ? (
            <table>
              <thead>
                <tr>
                  <th>Service</th>
                  <th>From → target</th>
                  <th>Status</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {arrivals.map((attack) => (
                  <tr key={attack.id}>
                    <td>{attack.id}</td>
                    <td>
                      {participantName(attack.attacker, contestants, "House")} →{" "}
                      {participantName(attack.target, contestants, "Both")}
                    </td>
                    <td>
                      {attack.repairedBy
                        ? `repaired by ${participantName(attack.repairedBy, contestants, "Unknown")}`
                        : attack.status.replaceAll("_", " ")}
                    </td>
                    <td>
                      {attack.originalClaim ??
                        attack.latestDetail ??
                        "No claim text recorded"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>
              No authoritative arrivals yet. Routes appear only after recorded
              battle activity.
            </p>
          )}
        </section>
        <footer className="transit-steering">
          {(["a", "b"] as const).map((id) => (
            <div key={id}>
              <strong>{title(contestants[id].provider)} operator note</strong>
              <OperatorNote
                id={id}
                fighter={contestants[id]}
                canSteer={canSteer}
                isHistorical={isHistorical}
                unavailable={steeringUnavailable}
                onSteer={onSteer}
              />
            </div>
          ))}
        </footer>
      </section>
      <aside className="transit-activity">
        <header>
          <strong>
            <TransitEvidenceIcon />
            Activity / evidence
          </strong>
          <span>{attacks.length}</span>
        </header>
        {attacks.length ? (
          attacks
            .slice(-9)
            .reverse()
            .map((attack, index) => (
              <article key={`${attack.id}-${attack.phase}-${index}`}>
                <i className={`is-${attack.attacker ?? "verify"}`} />
                <div>
                  <strong>{attackDisplayLabel(attack)}</strong>
                  <span>
                    {participantName(attack.attacker, contestants, "House")} →{" "}
                    {participantName(attack.target, contestants, "Both")} ·{" "}
                    {attack.phase} · {attack.round ? `R${attack.round}` : "—"}
                  </span>
                </div>
                {attack.damage ? <b>−{attack.damage}</b> : null}
              </article>
            ))
        ) : (
          <p>No attack evidence recorded yet.</p>
        )}
        {isHistorical ? (
          <footer>Historical events are read-only.</footer>
        ) : null}
      </aside>
    </main>
  );
}

function LabBench({
  id,
  fighter,
  browserSessions,
  onFighter,
  onSteer,
  canSteer,
  isHistorical,
  steeringUnavailable,
}: {
  id: ContestantId;
  fighter: DashboardContestant;
  browserSessions: DashboardBrowserSession[];
  onFighter: (id: ContestantId) => void;
  onSteer: (id: ContestantId, note: string) => Promise<void>;
  canSteer: boolean;
  isHistorical: boolean;
  steeringUnavailable: string;
}) {
  const recent = fighter.invocations.at(-1);
  const checks = checkCounts(fighter);
  return (
    <article className={`lab-bench lab-bench-${id}`}>
      <header>
        <ProviderDisc fighter={fighter} id={id} />
        <div>
          <strong>{title(fighter.provider)}</strong>
          <span>{fighter.model ?? "Default model"}</span>
          <BrowserSessionAction
            sessions={browserSessions}
            actor={title(fighter.provider)}
          />
        </div>
        <b>Bench {id.toUpperCase()}</b>
      </header>
      <dl>
        <div>
          <dt>Health</dt>
          <dd>{fighter.health} HP</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{fighter.status.replaceAll("_", " ")}</dd>
        </div>
        <div>
          <dt>Current work</dt>
          <dd>{providerActivityLabel(fighter)}</dd>
        </div>
        <div>
          <dt>Checks</dt>
          <dd>
            {checks.passed}/{checks.total} passed
          </dd>
        </div>
      </dl>
      <section>
        <h3>Health history</h3>
        <HealthHistory
          fighter={fighter}
          label={`${title(fighter.provider)} recorded health history`}
        />
      </section>
      <section>
        <h3>Check grid</h3>
        <div className="lab-check-grid">
          {fighter.checks.length ? (
            fighter.checks.slice(-12).map((check, index) => (
              <span
                className={`is-${check.status}`}
                title={`${check.id}: ${check.status}`}
                aria-label={`${check.id}: ${check.status}`}
                key={`${check.id}-${index}`}
              >
                {check.status.charAt(0).toUpperCase() || "—"}
              </span>
            ))
          ) : (
            <p>No checks recorded.</p>
          )}
        </div>
        {fighter.checks.length ? (
          <p className="lab-check-legend">
            P passed · F failed · first letter otherwise
          </p>
        ) : null}
      </section>
      <section className="lab-output">
        <h3>Recent invocation</h3>
        {recent ? (
          <>
            <strong>{recent.stage.replaceAll("_", " ")}</strong>
            <span>
              {recent.startedAt.slice(11, 19)} ·{" "}
              {recent.durationMs === undefined
                ? recent.status
                : `${(recent.durationMs / 1000).toFixed(1)}s · ${recent.status}`}
            </span>
            <p>{fighter.summaries.at(-1)?.text ?? "No summary recorded."}</p>
          </>
        ) : (
          <p>No invocation recorded.</p>
        )}
      </section>
      <footer>
        <OperatorNote
          id={id}
          fighter={fighter}
          canSteer={canSteer}
          isHistorical={isHistorical}
          unavailable={steeringUnavailable}
          onSteer={onSteer}
        />
        <button type="button" onClick={() => onFighter(id)}>
          Inspect {title(fighter.provider)}
        </button>
      </footer>
    </article>
  );
}

export function TestLabArena({
  state,
  rounds,
  selectedRound,
  contestants,
  attacks,
  stage,
  onRound,
  onFighter,
  onSteer,
  canSteer,
  steeringUnavailable,
}: DeveloperDashboardProps) {
  const isHistorical = selectedRound !== "live";
  const lifecycles = projectAttackLifecycles(state, attacks);
  const sample = lifecycles.at(-1);
  const invocations = (["a", "b"] as const)
    .flatMap((id) =>
      contestants[id].invocations.map((invocation) => ({ id, invocation })),
    )
    .toSorted((left, right) =>
      left.invocation.startedAt.localeCompare(right.invocation.startedAt),
    );
  const recordedChecks = (["a", "b"] as const)
    .flatMap((id) => contestants[id].checks.map((check) => ({ id, check })))
    .slice(-10)
    .reverse();
  return (
    <main className="test-lab">
      <aside className="lab-timeline">
        <header>
          <strong>Invocation timeline</strong>
          <span>{isHistorical ? "Read-only" : "Live record"}</span>
        </header>
        <CompactRoundNav
          state={state}
          rounds={rounds}
          selected={selectedRound}
          onSelect={onRound}
        />
        {invocations.length ? (
          <ol>
            {invocations.slice(-10).map(({ id, invocation }) => (
              <li className={`lab-invocation-${id}`} key={invocation.id}>
                <i className={`is-${invocation.status}`} />
                <time>{invocation.startedAt.slice(11, 19)}</time>
                <strong>
                  {title(contestants[id].provider)} ·{" "}
                  {invocation.stage.replaceAll("_", " ")}
                </strong>
                <span>
                  {invocation.durationMs === undefined
                    ? invocation.status
                    : `${(invocation.durationMs / 1000).toFixed(1)}s · ${invocation.status}`}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p>No invocations recorded yet.</p>
        )}
      </aside>
      <section className="lab-workspace">
        <LabBench
          id="a"
          fighter={contestants.a}
          browserSessions={state.browserSessions.filter(
            (session) => session.contestantId === "a",
          )}
          onFighter={onFighter}
          onSteer={onSteer}
          canSteer={canSteer}
          isHistorical={isHistorical}
          steeringUnavailable={steeringUnavailable}
        />
        <article className="experiment-sheet">
          <header>
            <span>{roundLabel(selectedRound)}</span>
            <h1>Experiment sheet</h1>
            <p>{stage}</p>
          </header>
          <dl className="experiment-facts">
            <div className="lab-fact-claim">
              <dt>Original attack claim</dt>
              <dd>{sample?.originalClaim ?? "No attack claim recorded."}</dd>
            </div>
            <div className="lab-fact-source">
              <dt>Source</dt>
              <dd>{participantName(sample?.attacker, contestants, "—")}</dd>
            </div>
            <div className="lab-fact-target">
              <dt>Target</dt>
              <dd>{participantName(sample?.target, contestants, "—")}</dd>
            </div>
            <div className="lab-fact-severity">
              <dt>Severity</dt>
              <dd>{sample?.severity ?? "Not recorded"}</dd>
            </div>
            <div className="lab-fact-lifecycle">
              <dt>Lifecycle status</dt>
              <dd>
                {sample ? sample.phase.replaceAll("_", " ") : "Awaiting sample"}
              </dd>
            </div>
            <div className="lab-fact-adjudication">
              <dt>Adjudication outcome</dt>
              <dd>{sample?.status.replaceAll("_", " ") ?? "Not available"}</dd>
            </div>
            <div className="lab-fact-damage">
              <dt>Damage</dt>
              <dd>
                {sample?.damage === undefined ? "—" : `${sample.damage} HP`}
              </dd>
            </div>
            <div className="lab-fact-repair">
              <dt>Repair</dt>
              <dd>
                {sample?.repairedBy
                  ? `${participantName(sample.repairedBy, contestants, "Unknown")} +${sample.repairAmount ?? 0} HP`
                  : "None recorded"}
              </dd>
            </div>
          </dl>
          <section className="experiment-checks">
            <h2>Evidence / checks</h2>
            {recordedChecks.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Bench</th>
                    <th>Check</th>
                    <th>Round</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recordedChecks.map(({ id, check }, index) => (
                    <tr
                      className={`lab-check-${id}`}
                      key={`${id}-${check.id}-${index}`}
                    >
                      <td>{id.toUpperCase()}</td>
                      <td>{check.id}</td>
                      <td>{check.round ? `R${check.round}` : "—"}</td>
                      <td>{check.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p>No checks recorded for this experiment.</p>
            )}
          </section>
          <footer>
            {isHistorical
              ? "Recorded experiment — read-only"
              : state.assisted
                ? "Assisted experiment"
                : "Competitive experiment"}
          </footer>
        </article>
        <LabBench
          id="b"
          fighter={contestants.b}
          browserSessions={state.browserSessions.filter(
            (session) => session.contestantId === "b",
          )}
          onFighter={onFighter}
          onSteer={onSteer}
          canSteer={canSteer}
          isHistorical={isHistorical}
          steeringUnavailable={steeringUnavailable}
        />
      </section>
      <aside className="lab-samples">
        <header>
          <strong>Check samples</strong>
          <span>{recordedChecks.length}</span>
        </header>
        {recordedChecks.length ? (
          recordedChecks.map(({ id, check }, index) => (
            <article
              className={`lab-sample-${id}`}
              key={`${id}-${check.id}-${index}`}
            >
              <strong>{check.id}</strong>
              <span>
                Bench {id.toUpperCase()} ·{" "}
                {check.round ? `R${check.round}` : "unassigned"}
              </span>
              <b className={`is-${check.status}`}>{check.status}</b>
            </article>
          ))
        ) : (
          <p>No test samples recorded yet.</p>
        )}
      </aside>
    </main>
  );
}

export function BroadcastArena({
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
  const checks = (id: ContestantId) => checkCounts(contestants[id]);
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
          <article className="broadcast-fighter broadcast-fighter-a">
            <button
              className="broadcast-fighter-hitbox"
              type="button"
              aria-label={`Inspect ${title(contestants.a.provider)}`}
              onClick={() => onFighter("a")}
            />
            <ProviderDisc fighter={contestants.a} id="a" />
            <strong>{title(contestants.a.provider)}</strong>
            <small>{providerActivityLabel(contestants.a)}</small>
            <BrowserSessionAction
              sessions={state.browserSessions.filter(
                (session) => session.contestantId === "a",
              )}
              actor={title(contestants.a.provider)}
            />
          </article>
          <span className="broadcast-vs">VS</span>
          <article className="broadcast-fighter broadcast-fighter-b">
            <button
              className="broadcast-fighter-hitbox"
              type="button"
              aria-label={`Inspect ${title(contestants.b.provider)}`}
              onClick={() => onFighter("b")}
            />
            <ProviderDisc fighter={contestants.b} id="b" />
            <strong>{title(contestants.b.provider)}</strong>
            <small>{providerActivityLabel(contestants.b)}</small>
            <BrowserSessionAction
              sessions={state.browserSessions.filter(
                (session) => session.contestantId === "b",
              )}
              actor={title(contestants.b.provider)}
            />
          </article>
          <div className="scorebug">
            <div>
              <b>
                {title(contestants.a.provider)} · {contestants.a.health}
              </b>
              <span>{checks("a").passed} checks passing</span>
            </div>
            <strong>{latest?.damage ? `−${latest.damage} HP` : stage}</strong>
            <div>
              <b>
                {title(contestants.b.provider)} · {contestants.b.health}
              </b>
              <span>{checks("b").passed} checks passing</span>
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

export function RetroTacticsArena({
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
  const checks = (id: ContestantId) => checkCounts(contestants[id]);
  const activeRound = state.round ?? rounds.at(-1) ?? 1;
  const repairs = (["a", "b"] as const).flatMap((id) =>
    contestants[id].healthChanges
      .filter((change) => change.amount > 0)
      .map((change) => ({ id, change })),
  );
  const latestRepair = repairs
    .toSorted((left, right) => left.change.sequence - right.change.sequence)
    .at(-1);
  const hasAttack = (id: ContestantId) =>
    attacks.some((attack) => attack.attacker === id);
  const hasVerification =
    attacks.some((attack) =>
      ["landed", "revised", "resolved"].includes(attack.phase),
    ) || checks("a").passed + checks("b").passed > 0;
  const workNodes = (id: ContestantId) => {
    const recent = contestants[id].invocations.slice(-2);
    const entries = recent.length
      ? recent
      : [
          {
            id: `${id}-current`,
            stage: contestants[id].activity,
            status: contestants[id].status,
          },
        ];
    return entries.map((invocation, index) => ({
      id: `${id}-work-${String(index)}`,
      owner: id,
      label: invocation.stage.replaceAll("_", " "),
      meta:
        "durationMs" in invocation && invocation.durationMs !== undefined
          ? `${(invocation.durationMs / 1000).toFixed(1)}s · ${invocation.status}`
          : invocation.status,
      kind: "work" as const,
    }));
  };
  const mapNodes = [
    {
      id: "a-base",
      owner: "a" as const,
      label: `${title(contestants.a.provider)} base`,
      meta: `${contestants.a.health} HP`,
      kind: "base" as const,
    },
    ...workNodes("a"),
    {
      id: "verify",
      owner: "neutral" as const,
      label: stage,
      meta: roundLabel(selectedRound),
      kind: "verify" as const,
    },
    ...workNodes("b"),
    {
      id: "b-base",
      owner: "b" as const,
      label: `${title(contestants.b.provider)} base`,
      meta: `${contestants.b.health} HP`,
      kind: "base" as const,
    },
  ];
  const participantLabel = (id: string | undefined, fallback: string) => {
    if (id === "a" || id === "b") return title(contestants[id].provider);
    return id ? title(id) : fallback;
  };
  const latestHasContestantRoute =
    latest?.attacker === "a" || latest?.attacker === "b";

  return (
    <main className="retro-tactics">
      <header className="tactics-matchup">
        {(["a", "b"] as const).map((id) => (
          <article className={`tactics-status tactics-status-${id}`} key={id}>
            <button
              className="tactics-status-hitbox"
              type="button"
              aria-label={`Inspect ${title(contestants[id].provider)}`}
              onClick={() => onFighter(id)}
            />
            <ProviderDisc fighter={contestants[id]} id={id} />
            <span className="tactics-identity">
              <strong>{title(contestants[id].provider)}</strong>
              <small>{contestants[id].model ?? "Default model"}</small>
              <BrowserSessionAction
                sessions={state.browserSessions.filter(
                  (session) => session.contestantId === id,
                )}
                actor={title(contestants[id].provider)}
              />
            </span>
            <span className="tactics-hp">
              <b>{contestants[id].health}</b>
              <small>HP</small>
              <i aria-hidden="true">
                <span
                  style={{
                    transform: `scaleX(${String(contestants[id].health / 100)})`,
                  }}
                />
              </i>
            </span>
            <span className="tactics-checks">
              <b>
                {checks(id).passed}/{checks(id).total}
              </b>
              <small>checks</small>
            </span>
          </article>
        ))}
        <span className="tactics-versus" aria-hidden="true">
          VS
        </span>
      </header>

      <nav className="tactics-mobile-inspect" aria-label="Inspect contestants">
        {(["a", "b"] as const).map((id) => (
          <button type="button" key={id} onClick={() => onFighter(id)}>
            <ProviderDisc fighter={contestants[id]} id={id} />
            <span>Inspect {title(contestants[id].provider)}</span>
          </button>
        ))}
      </nav>

      <section className="tactics-console">
        <aside className="tactics-rounds">
          <strong>ROUND</strong>
          <CompactRoundNav
            state={state}
            rounds={rounds}
            selected={selectedRound}
            onSelect={onRound}
          />
          <dl>
            <div>
              <dt>Phase</dt>
              <dd>{stage}</dd>
            </div>
            <div>
              <dt>Round</dt>
              <dd>{activeRound}</dd>
            </div>
          </dl>
        </aside>

        <section className="tactics-map" aria-label="Tactical battle map">
          <header>
            <div>
              <strong>{roundLabel(selectedRound)}</strong>
              <span>{stage}</span>
            </div>
            <em>{selectedRound === "live" ? "LIVE MAP" : "RECORDED MAP"}</em>
          </header>
          <div className="tactics-legend" aria-label="Route legend">
            <span>
              <i className="is-a" />
              {title(contestants.a.provider)}
            </span>
            <span>
              <i className="is-b" />
              {title(contestants.b.provider)}
            </span>
            <span>
              <i className="is-repair" />
              Repair
            </span>
            <span>
              <i className="is-verify" />
              Verify
            </span>
          </div>
          <svg
            className="tactics-paths"
            viewBox="0 0 1000 520"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <marker
                id="tactics-arrow-a"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="4"
                markerHeight="4"
                orient="auto-start-reverse"
              >
                <path d="M0 0 10 5 0 10z" />
              </marker>
              <marker
                id="tactics-arrow-b"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="4"
                markerHeight="4"
                orient="auto-start-reverse"
              >
                <path d="M0 0 10 5 0 10z" />
              </marker>
              <marker
                id="tactics-arrow-neutral"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="4"
                markerHeight="4"
                orient="auto-start-reverse"
              >
                <path d="M0 0 10 5 0 10z" />
              </marker>
            </defs>
            {hasAttack("a") ? (
              <>
                <path
                  className="route route-attack route-a"
                  d="M135 285 C220 285 242 175 310 170 S430 225 500 260"
                />
                <path
                  className="route route-attack route-secondary route-a"
                  d="M135 285 C220 310 255 365 340 360 S430 300 500 260"
                />
              </>
            ) : null}
            {hasAttack("b") ? (
              <>
                <path
                  className="route route-attack route-b"
                  d="M865 285 C780 285 758 175 690 170 S570 225 500 260"
                />
                <path
                  className="route route-attack route-secondary route-b"
                  d="M865 285 C780 310 745 365 660 360 S570 300 500 260"
                />
              </>
            ) : null}
            {hasVerification ? (
              <path
                className="route route-neutral"
                d="M500 260 C505 205 495 145 500 88"
              />
            ) : null}
            {latestRepair ? (
              <path
                className={`route route-repair route-${latestRepair.id}`}
                d={
                  latestRepair.id === "b"
                    ? "M500 260 C570 225 620 170 690 170 S780 285 865 285"
                    : "M500 260 C430 225 380 170 310 170 S220 285 135 285"
                }
              />
            ) : null}
            {latest && latestHasContestantRoute ? (
              <path
                className={`route route-attack route-latest route-${latest.attacker}`}
                d={
                  latest.attacker === "b"
                    ? "M865 285 C780 285 758 175 690 170 S570 225 500 260 S380 170 310 170"
                    : "M135 285 C220 285 242 175 310 170 S430 225 500 260 S620 170 690 170"
                }
              />
            ) : null}
          </svg>
          <div className="tactics-terrain" aria-hidden="true">
            {Array.from({ length: 96 }, (_, index) => (
              <i key={index} />
            ))}
          </div>
          <div className="tactics-nodes">
            {mapNodes.map((node) => (
              <button
                className={`tactics-node tactics-node-${node.id} tactics-node-kind-${node.kind} is-${node.owner}`}
                type="button"
                key={node.id}
                disabled={node.owner === "neutral"}
                onClick={() => {
                  if (node.owner !== "neutral") onFighter(node.owner);
                }}
              >
                <span aria-hidden="true" />
                <strong>{node.label}</strong>
                <small>{node.meta}</small>
              </button>
            ))}
          </div>
          <footer aria-live="polite" aria-label="Latest battle evidence">
            <div className="tactics-evidence-summary">
              <small>Latest evidence</small>
              <strong>
                {latest ? attackDisplayLabel(latest) : "Awaiting verified move"}
              </strong>
              <span>
                {latest?.detail ??
                  "Recorded attacks and repairs will illuminate this route."}
              </span>
            </div>
            {latest ? (
              <dl className="tactics-evidence-facts">
                <div>
                  <dt>Source</dt>
                  <dd>{participantLabel(latest.attacker, "House")}</dd>
                </div>
                <div>
                  <dt>Target</dt>
                  <dd>{participantLabel(latest.target, "Both")}</dd>
                </div>
                <div>
                  <dt>Outcome</dt>
                  <dd>{latest.phase.replaceAll("_", " ")}</dd>
                </div>
                <div className="is-damage">
                  <dt>Damage</dt>
                  <dd>{latest.damage ? `${String(latest.damage)} HP` : "—"}</dd>
                </div>
              </dl>
            ) : null}
          </footer>
        </section>

        <aside className="tactics-activity">
          <header>
            <strong>ACTIVITY / EVIDENCE</strong>
            <span>{attacks.length}</span>
          </header>
          {attacks.length ? (
            attacks
              .slice(-7)
              .reverse()
              .map((attack, index) => (
                <article key={`${attack.id}-${attack.phase}-${String(index)}`}>
                  <i className={`is-${attack.attacker ?? "neutral"}`} />
                  <div>
                    <strong>{attackDisplayLabel(attack)}</strong>
                    <p>
                      {attack.phase} ·{" "}
                      {attack.attacker?.toUpperCase() ?? "House"} →{" "}
                      {attack.target?.toUpperCase() ?? "both"}
                    </p>
                  </div>
                  <b>{attack.damage ? `−${String(attack.damage)}` : "··"}</b>
                </article>
              ))
          ) : (
            <p className="tactics-empty">No verified attack activity yet.</p>
          )}
        </aside>
      </section>

      <footer className="tactics-commands">
        <div>
          <strong>{state.task}</strong>
          <span>
            {selectedRound === "live"
              ? "Live execution"
              : "Read-only recorded state"}
          </span>
        </div>
        <nav aria-label="Inspect contestants">
          {(["a", "b"] as const).map((id) => (
            <button type="button" key={id} onClick={() => onFighter(id)}>
              <ProviderDisc fighter={contestants[id]} id={id} />
              <span>
                <strong>Inspect {title(contestants[id].provider)}</strong>
                <small>Full output and evidence</small>
              </span>
            </button>
          ))}
        </nav>
      </footer>
    </main>
  );
}

const DESIGN_CONTRACTS: Record<
  ArenaTheme,
  {
    thesis: string;
    ownWorld: string;
    story: string;
    firstViewport: string;
    form: string;
    seed: string;
  }
> = {
  "classic-shell": {
    thesis:
      "Keep live engineering evidence immediately legible in a restrained battle shell.",
    ownWorld: "Warm shell surfaces, clear fighter cards, and direct controls.",
    story: "Track, inspect, replay, and review.",
    firstViewport:
      "Round rail, opposing fighters, narration, and evidence activity.",
    form: "Classic Shell.",
    seed: "classic",
  },
  "developer-dashboard": {
    thesis: "Operate the arena as a conventional observability workspace.",
    ownWorld:
      "Dark developer console with dense tables, logs, and status rules.",
    story: "Scan checks and activity, inspect agents, then review results.",
    firstViewport:
      "Round timeline, paired workspaces, activity rail, and run status.",
    form: "Developer Dashboard.",
    seed: "developer",
  },
  "night-transit": {
    thesis:
      "Turn attack lifecycles into an authoritative late-night transit control map.",
    ownWorld:
      "Ink enamel signage, cyan and coral contestant lines, amber verification, and arrivals typography.",
    story:
      "Follow real routes into verification, inspect either line, and read authoritative arrivals.",
    firstViewport:
      "Round stations, central verification interchange, arrivals board, contestant panels, and activity rail.",
    form: "Approved Night Transit composition.",
    seed: "night-transit",
  },
  "test-lab": {
    thesis:
      "Make each attack lifecycle readable as a reproducible software experiment.",
    ownWorld:
      "Warm lab paper, graphite instruments, ruled evidence sheets, teal and safety-orange benches.",
    story:
      "Trace invocations, compare benches, inspect the experiment sheet, and review recent tests.",
    firstViewport:
      "Invocation timeline, opposing benches, central experiment sheet, and recent-test tray.",
    form: "Approved Test Lab composition.",
    seed: "test-lab",
  },
  "live-arena-broadcast": {
    thesis:
      "Present recorded engineering evidence with the immediacy of a live broadcast.",
    ownWorld:
      "Broadcast field, scorebug, battle desk, and factual play-by-play.",
    story:
      "Watch the live matchup, follow evidence, inspect contestants, then review results.",
    firstViewport: "Live feed beside an authoritative battle desk.",
    form: "Live Arena Broadcast.",
    seed: "broadcast",
  },
  "retro-tactics": {
    thesis:
      "Turn recorded engineering evidence into a live 16-bit tactics console without changing a product fact.",
    ownWorld:
      "Midnight violet chassis, purple and orange territories, aqua verification, pixel tile terrain, angular panels, and bitmap-scale rules.",
    story:
      "Track the fight, inspect either contestant, review recorded rounds, understand attacks and repairs, then finish the authoritative result.",
    firstViewport:
      "A top matchup bar leads a round rail, central tactical node map, right evidence channel, and bottom inspection commands.",
    form: "User-approved 16-bit Tactics Board, operator-console composition B.",
    seed: "71186a7d",
  },
};

export function App() {
  const [theme, setThemeState] = useState<ArenaTheme>(
    () => window.arenaTheme?.getTheme() ?? DEFAULT_ARENA_THEME,
  );
  const [themeWarning, setThemeWarning] = useState<string>();
  const [state, setState] = useState<DashboardState>(fallbackState);
  const [connection, setConnection] = useState<ConnectionState>("reconnecting");
  const [paintTicket, setPaintTicket] = useState({ revision: -1, nonce: 0 });
  const latestRevision = useRef(-1);
  const latestTicket = useRef(0);
  const lastSnapshotAt = useRef(0);
  const lastPaintAt = useRef(0);
  const streamOpen = useRef(false);
  const [selectedRound, setSelectedRound] = useState<RoundSelection>("live");
  const [selectedFighter, setSelectedFighter] = useState<ContestantId | null>(
    null,
  );
  const [reviewingResults, setReviewingResults] = useState(false);
  const [, setClock] = useState(0);
  const designContract = DESIGN_CONTRACTS[theme];
  const connected = connection === "live";

  useEffect(() => {
    let disposed = false;
    const acceptSnapshot = (envelope: SnapshotEnvelope) => {
      if (
        disposed ||
        !Number.isInteger(envelope.revision) ||
        envelope.revision < latestRevision.current
      )
        return;
      latestRevision.current = envelope.revision;
      lastSnapshotAt.current = Date.now();
      latestTicket.current += 1;
      setConnection("reconnecting");
      setState(envelope.snapshot);
      setPaintTicket({
        revision: envelope.revision,
        nonce: latestTicket.current,
      });
    };
    void fetch("/api/state", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load dashboard state");
        const revision = Number(
          response.headers.get("X-Agent-Arena-Snapshot-Revision") ?? "0",
        );
        acceptSnapshot({
          revision: Number.isInteger(revision) ? revision : 0,
          generatedAt:
            response.headers.get("X-Agent-Arena-Snapshot-Generated-At") ??
            new Date().toISOString(),
          snapshot: (await response.json()) as DashboardState,
        });
      })
      .catch(() => setConnection("reconnecting"));
    const events = new EventSource("/events");
    events.onopen = () => {
      streamOpen.current = true;
      setConnection(
        Date.now() - lastPaintAt.current < SNAPSHOT_STALE_AFTER_MS
          ? "live"
          : "reconnecting",
      );
    };
    events.onerror = () => {
      streamOpen.current = false;
      setConnection("reconnecting");
    };
    events.onmessage = (event) => {
      try {
        acceptSnapshot(JSON.parse(event.data as string) as SnapshotEnvelope);
      } catch {
        setConnection("reconnecting");
      }
    };
    const watchdog = window.setInterval(() => {
      const snapshotAge = Date.now() - lastSnapshotAt.current;
      const paintAge = Date.now() - lastPaintAt.current;
      if (!streamOpen.current) setConnection("reconnecting");
      else if (
        snapshotAge >= SNAPSHOT_STALE_AFTER_MS ||
        paintAge >= SNAPSHOT_STALE_AFTER_MS
      )
        setConnection("stale");
    }, 1_000);
    return () => {
      disposed = true;
      streamOpen.current = false;
      window.clearInterval(watchdog);
      events.close();
    };
  }, []);
  useLayoutEffect(() => {
    if (paintTicket.revision < 0) return;
    let firstFrame = 0;
    let paintedFrame = 0;
    firstFrame = window.requestAnimationFrame(() => {
      paintedFrame = window.requestAnimationFrame(() => {
        if (paintTicket.nonce !== latestTicket.current) return;
        lastPaintAt.current = Date.now();
        window.arenaDesktop?.reportPaint(paintTicket.revision);
        if (streamOpen.current) setConnection("live");
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(paintedFrame);
    };
  }, [paintTicket]);
  useEffect(() => {
    if (state.status !== "running") return;
    const timer = window.setInterval(
      () => setClock((value) => value + 1),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [state.status]);

  const hasResult = Boolean(state.result);
  const showResults =
    hasResult &&
    !reviewingResults &&
    selectedRound === "live" &&
    !selectedFighter;
  useEffect(() => {
    document.title = hasResult
      ? "Agent Arena · Results"
      : "Agent Arena · Live battle";
    if (!hasResult) setReviewingResults(false);
  }, [hasResult]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [selectedFighter, selectedRound, showResults, theme]);

  useEffect(() => {
    if (!showResults) return;

    let frame = 0;
    const keepResultsAtTop = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      });
    };

    keepResultsAtTop();
    window.addEventListener("resize", keepResultsAtTop);
    window.visualViewport?.addEventListener("resize", keepResultsAtTop);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", keepResultsAtTop);
      window.visualViewport?.removeEventListener("resize", keepResultsAtTop);
    };
  }, [showResults]);

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
      data-design-thesis={designContract.thesis}
      data-design-own-world={designContract.ownWorld}
      data-design-story={designContract.story}
      data-design-first-viewport={designContract.firstViewport}
      data-design-form={designContract.form}
      data-design-seed={designContract.seed}
      data-connection-state={connection}
      data-snapshot-revision={String(paintTicket.revision)}
      data-live-stage={state.stage}
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
            {!showResults ? (
              <>
                {" "}
                · <strong>{stageLabel(state.stage)}</strong>
              </>
            ) : null}
          </span>
        </div>
        <div className="top-actions">
          <ThemePicker theme={theme} onChange={selectTheme} />
          <span
            className={`connection${hasResult ? " is-complete" : connected ? " is-live" : connection === "stale" ? " is-stale" : ""}`}
            role="status"
            aria-live="polite"
          >
            <i />
            {hasResult
              ? "Complete"
              : connected
                ? "Live"
                : connection === "stale"
                  ? "Stale"
                  : "Reconnecting"}
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

      <div className="arena-browser-event">
        <BrowserSessionAction
          sessions={state.browserSessions.filter(
            (session) => session.contestantId === undefined,
          )}
          actor="Arena"
        />
      </div>

      {themeWarning ? (
        <div className="theme-warning" role="status">
          {themeWarning}
        </div>
      ) : null}

      {!showResults && !selectedFighter && theme === "developer-dashboard" ? (
        <DeveloperDashboardArena
          state={state}
          rounds={rounds}
          selectedRound={selectedRound}
          contestants={viewContestants}
          attacks={viewAttacks}
          stage={stage}
          onRound={selectRound}
          onFighter={setSelectedFighter}
          onSteer={steer}
          canSteer={canSteer}
          steeringUnavailable={steeringUnavailable}
        />
      ) : !showResults && !selectedFighter && theme === "night-transit" ? (
        <NightTransitArena
          state={state}
          rounds={rounds}
          selectedRound={selectedRound}
          contestants={viewContestants}
          attacks={viewAttacks}
          stage={stage}
          onRound={selectRound}
          onFighter={setSelectedFighter}
          onSteer={steer}
          canSteer={canSteer}
          steeringUnavailable={steeringUnavailable}
        />
      ) : !showResults && !selectedFighter && theme === "test-lab" ? (
        <TestLabArena
          state={state}
          rounds={rounds}
          selectedRound={selectedRound}
          contestants={viewContestants}
          attacks={viewAttacks}
          stage={stage}
          onRound={selectRound}
          onFighter={setSelectedFighter}
          onSteer={steer}
          canSteer={canSteer}
          steeringUnavailable={steeringUnavailable}
        />
      ) : !showResults &&
        !selectedFighter &&
        theme === "live-arena-broadcast" ? (
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
      ) : !showResults && !selectedFighter && theme === "retro-tactics" ? (
        <RetroTacticsArena
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
                browserSessions={state.browserSessions.filter(
                  (session) => session.contestantId === selectedFighter,
                )}
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
                    browserSessions={state.browserSessions.filter(
                      (session) => session.contestantId === "a",
                    )}
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
                    browserSessions={state.browserSessions.filter(
                      (session) => session.contestantId === "b",
                    )}
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
                          {participantName(
                            attack.attacker,
                            viewContestants,
                            "House",
                          )}{" "}
                          →{" "}
                          {participantName(
                            attack.target,
                            viewContestants,
                            "Both",
                          )}
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
                {state.warnings.slice(-3).map((warning, index) => (
                  <p key={`${String(index)}-${warning}`}>{warning}</p>
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
