import { useEffect, useState } from "react";
import { Box, Text, render, useInput } from "ink";
import Link from "ink-link";
import type { ArenaBattleControl } from "../observability/control.js";
import type { ContestantId, Stage } from "../core/types.js";
import type { DashboardObserver, DashboardState } from "./state.js";

type View = "overview" | "a" | "b" | "rounds" | "system" | "result";
type InkColor = "cyan" | "green" | "yellow" | "red";

const STAGE_DETAILS: Record<
  Stage,
  { label: string; chapter: string; objective: string }
> = {
  preflight: {
    label: "Preflight",
    chapter: "Setup",
    objective: "Checking the repository, agents, and battle contract",
  },
  resolve_permissions: {
    label: "Permissions",
    chapter: "Setup",
    objective: "Confirming the capability plan before agents run",
  },
  implement: {
    label: "Opening build",
    chapter: "Opening",
    objective: "Both fighters are building their initial patches",
  },
  initial_validate: {
    label: "Opening checks",
    chapter: "Opening",
    objective: "Testing both initial patches against the same checks",
  },
  review_attacks: {
    label: "Scout weaknesses",
    chapter: "Attack",
    objective: "Fighters are reviewing the opponent patches for attack vectors",
  },
  collect_attacks: {
    label: "Mount attacks",
    chapter: "Attack",
    objective: "Fighters are preparing ranked attacks against each other",
  },
  validate_attacks: {
    label: "Verify attacks",
    chapter: "Attack",
    objective: "Running mounted attacks against the frozen opponent patches",
  },
  review_infrastructure: {
    label: "Review infrastructure",
    chapter: "Attack",
    objective: "Separating product defects from arena infrastructure failures",
  },
  revise_evidence: {
    label: "Revise evidence",
    chapter: "Attack",
    objective: "Applying the single bounded evidence revision",
  },
  assign_severity: {
    label: "Judge severity",
    chapter: "Attack",
    objective: "Scoring verified defects by impact and confidence",
  },
  resolve_damage: {
    label: "Resolve damage",
    chapter: "Damage",
    objective: "Applying landed damage and recoil simultaneously",
  },
  repair: {
    label: "Repair",
    chapter: "Repair",
    objective: "Fighters are repairing defects exposed this round",
  },
  validate_repairs: {
    label: "Verify repairs",
    chapter: "Repair",
    objective: "Replaying visible and held-out evidence after repairs",
  },
  recovery_round: {
    label: "Recovery round",
    chapter: "Recovery",
    objective: "Spending replacement credits lost to infrastructure failures",
  },
  reconciliation_round: {
    label: "Reconciliation round",
    chapter: "Recovery",
    objective: "Re-adjudicating attacks that were rejected on a technicality",
  },
  final_validate: {
    label: "Final checks",
    chapter: "Final",
    objective: "Running the final symmetric validation matrix",
  },
  report: {
    label: "Decision",
    chapter: "Final",
    objective: "Selecting the recommended patch and writing battle artifacts",
  },
  complete: {
    label: "Complete",
    chapter: "Result",
    objective: "Battle complete — inspect the recommendation and artifacts",
  },
  inconclusive: {
    label: "Inconclusive",
    chapter: "Result",
    objective: "Evidence was insufficient for a competitive result",
  },
  failed: {
    label: "Failed",
    chapter: "Result",
    objective: "The battle stopped before a valid result was produced",
  },
  cancelled: {
    label: "Cancelled",
    chapter: "Result",
    objective: "Cancellation is being persisted to the battle artifacts",
  },
};

const ROUND_FLOW = ["scout", "mount", "verify", "damage", "repair"] as const;

function roundStep(stage: Stage): (typeof ROUND_FLOW)[number] | undefined {
  if (stage === "review_attacks") return "scout";
  if (stage === "collect_attacks") return "mount";
  if (
    [
      "validate_attacks",
      "review_infrastructure",
      "revise_evidence",
      "assign_severity",
    ].includes(stage)
  )
    return "verify";
  if (stage === "resolve_damage") return "damage";
  if (["repair", "validate_repairs"].includes(stage)) return "repair";
  return undefined;
}

function BattleStatus({ state }: { state: DashboardState }) {
  const detail = STAGE_DETAILS[state.stage];
  const activeStep = roundStep(state.stage);
  const roundLabel = activeStep
    ? state.round === "recovery"
      ? "RECOVERY"
      : state.round
        ? `ROUND ${String(state.round)}/3`
        : "ATTACK ROUND"
    : detail.chapter.toUpperCase();
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color="cyan">
          {roundLabel}
        </Text>
        <Text dimColor> │ </Text>
        <Text bold>{detail.label}</Text>
        <Text dimColor> │ {elapsed(state)}</Text>
      </Text>
      <Text>
        <Text dimColor>Objective: </Text>
        {detail.objective}
      </Text>
      {activeStep ? (
        <Text>
          <Text dimColor>Round flow: </Text>
          {ROUND_FLOW.map((step, index) => (
            <Text key={step}>
              {index ? <Text dimColor> → </Text> : null}
              <Text
                bold={step === activeStep}
                dimColor={step !== activeStep}
                {...colorProps(step === activeStep ? "cyan" : undefined)}
              >
                {step === activeStep ? `[${step}]` : step}
              </Text>
            </Text>
          ))}
        </Text>
      ) : (
        <Text dimColor>Battle phase: {detail.chapter}</Text>
      )}
    </Box>
  );
}

function statusColor(status: string): InkColor | undefined {
  if (
    ["succeeded", "passed", "complete", "survived", "landed"].includes(status)
  )
    return "green";
  if (["failed", "timed_out", "cancelled", "eliminated"].includes(status))
    return "red";
  if (
    ["warning", "blocked", "inconclusive", "assisted", "revised"].includes(
      status,
    )
  )
    return "yellow";
  if (["working", "running", "cancelling", "mounting"].includes(status))
    return "cyan";
  return undefined;
}

function healthColor(health: number): Exclude<InkColor, undefined> {
  return health >= 75 ? "green" : health >= 40 ? "yellow" : "red";
}

function HealthBar({ health }: { health: number }) {
  const segments = 14;
  const filled = Math.max(
    0,
    Math.min(segments, Math.round((health / 100) * segments)),
  );
  return (
    <Text color={healthColor(health)}>
      [{"█".repeat(filled)}
      <Text dimColor>{"░".repeat(segments - filled)}</Text>]
    </Text>
  );
}

function colorProps(
  color: InkColor | undefined,
): Record<string, never> | { color: InkColor } {
  return color ? { color } : {};
}

function elapsed(state: DashboardState): string {
  if (!state.startedAt) return "0s";
  return `${Math.max(0, Math.floor((Date.now() - Date.parse(state.startedAt)) / 1000))}s`;
}

function ProviderSigil({
  provider,
  id,
}: {
  provider: string;
  id: ContestantId;
}) {
  const normalized = provider.toLowerCase();
  const isClaude =
    normalized.includes("claude") || normalized.includes("anthropic");
  const glyph = isClaude
    ? "✦"
    : normalized.includes("gemini") || normalized.includes("google")
      ? "✧"
      : normalized.includes("codex") || normalized.includes("openai")
        ? "◆"
        : "●";
  return (
    <Text bold color={isClaude ? "#d97757" : id === "a" ? "cyan" : "yellow"}>
      {glyph}
    </Text>
  );
}

function Contestant({
  id,
  state,
}: {
  id: ContestantId;
  state: DashboardState;
}) {
  const contestant = state.contestants[id];
  const [hitFrame, setHitFrame] = useState<number>();
  const healthChange = contestant.lastHealthChange;
  useEffect(() => {
    if (!healthChange || healthChange.amount >= 0) return;
    const reducedMotion =
      process.env["AGENT_ARENA_REDUCED_MOTION"] === "1" ||
      process.env["TERM"] === "dumb";
    setHitFrame(reducedMotion ? 2 : 0);
    const timers = reducedMotion
      ? [setTimeout(() => setHitFrame(undefined), 500)]
      : [
          setTimeout(() => setHitFrame(1), 80),
          setTimeout(() => setHitFrame(2), 160),
          setTimeout(() => setHitFrame(undefined), 480),
        ];
    return () => timers.forEach((timer) => clearTimeout(timer));
  }, [healthChange?.sequence]);
  const latestOutput = contestant.output.at(-1);
  const preview = latestOutput?.text.replaceAll(/\s+/gu, " ").trim();
  const hitActive =
    hitFrame !== undefined && healthChange?.amount !== undefined;
  const hitGlyph = ["╳", "◆", "✦"][hitFrame ?? 0];
  const checksPassed = contestant.checks.filter(
    (check) => check.status === "passed",
  ).length;
  return (
    <Box flexDirection="column" paddingLeft={1} marginY={1}>
      <Text bold>
        <ProviderSigil provider={contestant.provider} id={id} />{" "}
        {contestant.provider.toUpperCase()}
        <Text dimColor> · FIGHTER {id.toUpperCase()}</Text>
        {hitActive ? (
          <Text bold color="red">
            {" "}
            {hitGlyph} {String(healthChange.amount)} HP
          </Text>
        ) : null}
      </Text>
      <Text>
        <Text dimColor> HP </Text>
        <HealthBar health={contestant.health} />{" "}
        <Text bold color={healthColor(contestant.health)}>
          {contestant.health}/100
        </Text>
        <Text dimColor> · checks </Text>
        <Text color="green">{String(checksPassed)}</Text>/
        {String(contestant.checks.length)}
        <Text dimColor> · </Text>
        <Text {...colorProps(statusColor(contestant.status))}>
          {contestant.status}
        </Text>
      </Text>
      <Text wrap="truncate-end">
        <Text dimColor> {contestant.model ?? "default model"} · </Text>
        {contestant.activity.replaceAll("_", " ")}
      </Text>
      {preview ? (
        <Text
          {...colorProps(latestOutput?.stream === "stderr" ? "red" : undefined)}
        >
          <Text color={id === "a" ? "cyan" : "yellow"}> ↳ </Text>
          {preview.slice(0, 72)}
        </Text>
      ) : null}
    </Box>
  );
}

function BattleDialogue({
  call,
  attackCounts,
  objective,
}: {
  call: string | undefined;
  attackCounts: { mounting: number; landed: number; revised: number };
  objective: string;
}) {
  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={1}>
      <Text bold wrap="wrap">
        <Text color="cyan">● </Text>
        {call ?? objective}
      </Text>
      <Text>
        <Text dimColor> moves </Text>
        <Text color="cyan">mounting {String(attackCounts.mounting)}</Text>
        {" · "}
        <Text color="green">landed {String(attackCounts.landed)}</Text>
        {" · "}
        <Text color="yellow">revisions {String(attackCounts.revised)}</Text>
      </Text>
    </Box>
  );
}

function Output({
  state,
  id,
  system,
  offset,
  follow,
  filter,
}: {
  state: DashboardState;
  id?: ContestantId;
  system?: boolean;
  offset: number;
  follow: boolean;
  filter: "all" | "stdout" | "stderr";
}) {
  const allEntries = system
    ? state.systemOutput.map((entry) => ({
        stream: entry.stream,
        text: `[${entry.source}] ${entry.text}`,
      }))
    : id
      ? state.contestants[id].output
      : [];
  const entries = allEntries.filter(
    (entry) => filter === "all" || entry.stream === filter,
  );
  const end = follow ? entries.length : Math.max(0, entries.length - offset);
  const visible = entries.slice(Math.max(0, end - 30), end);
  if (!visible.length) return <Text dimColor>No output yet.</Text>;
  return (
    <Box flexDirection="column">
      {visible.map((entry, index) => (
        <Text
          key={`${String(index)}-${entry.text}`}
          {...colorProps(entry.stream === "stderr" ? "red" : undefined)}
          wrap="truncate-end"
        >
          <Text color={entry.stream === "stderr" ? "red" : "cyan"}>
            {entry.stream === "stderr" ? "err" : "out"} │{" "}
          </Text>
          {entry.text.replace(/\r?\n$/u, "")}
        </Text>
      ))}
    </Box>
  );
}

function SuccessScreen({ state }: { state: DashboardState }) {
  const landed = Array.from(
    new Map(
      state.attacks
        .filter((attack) => attack.phase === "landed")
        .map((attack) => [attack.id, attack]),
    ).values(),
  );
  const improvements = (["a", "b"] as const).flatMap((id) =>
    state.contestants[id].healthChanges
      .filter((change) => change.amount > 0)
      .map((change) => ({ ...change, contestantId: id })),
  );
  const finalStates =
    state.result?.contestants ??
    (["a", "b"] as const).map((id) => ({
      id,
      health: state.contestants[id].health,
      status: state.contestants[id].status,
      checksPassed: state.contestants[id].checks.filter(
        (check) => check.status === "passed",
      ).length,
      checksTotal: state.contestants[id].checks.length,
    }));
  const rounds = state.result?.roundsCompleted ?? 0;
  const recommended = state.result?.recommendedId?.toUpperCase();
  const champion = state.result?.championId?.toUpperCase();
  return (
    <Box flexDirection="column">
      <Box
        borderStyle="double"
        borderColor="green"
        flexDirection="column"
        paddingX={1}
      >
        <Text bold color="green">
          ★ BATTLE COMPLETE · PATCH HARDENED
        </Text>
        <Text>
          <Text bold>{String(landed.length)}</Text> verified defect
          {landed.length === 1 ? "" : "s"} caught ·{" "}
          <Text bold>{String(improvements.length)}</Text> improvement
          {improvements.length === 1 ? "" : "s"} verified ·{" "}
          <Text bold>{String(rounds)}</Text>/3 rounds
        </Text>
        <Text>
          Recommended:{" "}
          <Text bold color="green">
            Fighter {recommended ?? "—"}
          </Text>
          {champion ? ` · Arena champion: Fighter ${champion}` : ""}
        </Text>
        {state.result?.recommendationReason ? (
          <Text wrap="wrap">
            <Text dimColor>Why: </Text>
            {state.result.recommendationReason}
          </Text>
        ) : state.result?.coverageConfidence === "provisional" ? (
          <Text wrap="wrap">
            <Text dimColor>Why: </Text>
            Coverage was unresolved, so no champion or recommendation is
            published.
          </Text>
        ) : null}
      </Box>

      <Text bold color="cyan">
        FINAL STATE
      </Text>
      {finalStates.map((fighter) => (
        <Text key={fighter.id}>
          <Text bold>Fighter {fighter.id.toUpperCase()}</Text> ·{" "}
          {state.contestants[fighter.id].provider.toUpperCase()} · HP{" "}
          <HealthBar health={fighter.health} /> {String(fighter.health)}/100 ·{" "}
          <Text {...colorProps(statusColor(fighter.status))}>
            {fighter.status}
          </Text>
          {" · "}
          <Text color="green">{String(fighter.checksPassed)}</Text>/
          {String(fighter.checksTotal)} checks passed
        </Text>
      ))}

      <Text bold color="red">
        DEFECTS CAUGHT BEFORE SHIP
      </Text>
      {landed.length ? (
        landed.map((attack) => {
          const mounted = state.attacks.find(
            (candidate) =>
              candidate.id === attack.id && candidate.phase === "mounting",
          );
          return (
            <Box key={attack.id} flexDirection="column">
              <Text>
                <Text color="red">◆</Text>{" "}
                {attack.round ? `R${String(attack.round)} · ` : ""}
                <Text bold>{attack.id}</Text> ·{" "}
                {(attack.attacker ?? "house").toUpperCase()} →{" "}
                {(attack.target ?? "—").toUpperCase()}
                {attack.severity ? ` · ${attack.severity}` : ""}
                {attack.damage === undefined
                  ? ""
                  : ` · ${String(attack.damage)} HP`}
              </Text>
              {mounted?.detail ? <Text dimColor> {mounted.detail}</Text> : null}
            </Box>
          );
        })
      ) : (
        <Text dimColor>No attack produced verified defect damage.</Text>
      )}

      <Text bold color="green">
        IMPROVEMENTS VERIFIED
      </Text>
      {improvements.length ? (
        improvements.map((improvement) => (
          <Text
            key={`${improvement.contestantId}-${String(improvement.sequence)}`}
          >
            <Text color="green">↑</Text> Fighter{" "}
            {improvement.contestantId.toUpperCase()} recovered{" "}
            <Text bold color="green">
              +{String(improvement.amount)} HP
            </Text>
            {improvement.round ? ` in R${String(improvement.round)}` : ""} ·{" "}
            {improvement.reason}
          </Text>
        ))
      ) : (
        <Text dimColor>
          No health-restoring repair was recorded; inspect the battle log for
          unresolved findings.
        </Text>
      )}

      <Text bold color="yellow">
        WHY THIS IS SAFER TO SHIP
      </Text>
      <Text wrap="wrap">
        The arena found {String(landed.length)} defect
        {landed.length === 1 ? "" : "s"} through adversarial testing before
        human review. The final candidates were attacked and replayed—not only
        checked against the happy path.
      </Text>
      {state.runId ? (
        <Text>
          <Text dimColor>Next: </Text>
          agent-arena review {state.runId}
        </Text>
      ) : null}
    </Box>
  );
}

export function Dashboard({
  observer,
  control,
}: {
  observer: DashboardObserver;
  control: ArenaBattleControl;
}) {
  const [state, setState] = useState(observer.snapshot());
  const [view, setView] = useState<View>("overview");
  const [selected, setSelected] = useState<ContestantId>("a");
  const [note, setNote] = useState<string | undefined>();
  const [offset, setOffset] = useState(0);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState<"all" | "stdout" | "stderr">("all");

  useEffect(
    () => observer.subscribe(() => setState(observer.snapshot())),
    [observer],
  );
  useEffect(() => {
    if (state.status === "complete") setView("result");
  }, [state.status]);
  useInput((input, key) => {
    if (note !== undefined) {
      if (key.escape) setNote(undefined);
      else if (key.return) {
        if (note.trim()) control.queueSteering(selected, note);
        setNote(undefined);
      } else if (key.backspace || key.delete) setNote(note.slice(0, -1));
      else if (!key.ctrl && !key.meta) setNote(note + input);
      return;
    }
    if (input === "o") setView("overview");
    else if (input === "v" && state.status === "complete") setView("result");
    else if (input === "1") {
      setSelected("a");
      setView("a");
    } else if (input === "2") {
      setSelected("b");
      setView("b");
    } else if (input === "r") setView("rounds");
    else if (input === "s") setView("system");
    else if (input === "n") setNote("");
    else if (input === "f") setFollow((value) => !value);
    else if (input === "t")
      setFilter((value) =>
        value === "all" ? "stdout" : value === "stdout" ? "stderr" : "all",
      );
    else if (key.upArrow || input === "k") {
      setFollow(false);
      setOffset((value) => value + 1);
    } else if (key.downArrow || input === "j") {
      setOffset((value) => Math.max(0, value - 1));
    }
  });

  const activeRoundStep = roundStep(state.stage);
  const attackCounts = {
    mounting: state.attacks.filter((attack) => attack.phase === "mounting")
      .length,
    landed: state.attacks.filter((attack) => attack.phase === "landed").length,
    revised: state.attacks.filter((attack) => attack.phase === "revised")
      .length,
  };
  const latestAttack = state.attacks.at(-1);
  const attacker = latestAttack?.attacker?.toUpperCase() ?? "HOUSE";
  const target = latestAttack?.target?.toUpperCase() ?? "—";
  const battleCall = latestAttack
    ? latestAttack.phase === "mounting"
      ? `${attacker} is mounting ${latestAttack.id} against ${target}…`
      : latestAttack.phase === "revised"
        ? `${attacker} revised ${latestAttack.id}${latestAttack.detail ? ` — ${latestAttack.detail}` : ""}`
        : latestAttack.phase === "landed"
          ? `${attacker} used ${latestAttack.id}! ${target} took ${String(latestAttack.damage ?? 0)} HP.`
          : `${latestAttack.id} resolved as ${latestAttack.status}.`
    : undefined;
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        ⚔ AGENT ARENA ·{" "}
        <Text {...colorProps(statusColor(state.status))}>
          {state.status.toUpperCase()}
        </Text>
      </Text>
      <Text>{state.task}</Text>
      <BattleStatus state={state} />
      {state.links.length ? (
        <Text>
          <Text dimColor>Links: </Text>
          {state.links.map((link, index) => (
            <Text key={link.url}>
              {index > 0 ? " · " : ""}
              <Link url={link.url}>
                <Text color="cyan" underline>
                  {link.label}
                </Text>
              </Link>
            </Text>
          ))}
        </Text>
      ) : null}
      {state.assisted ? (
        <Text bold color="yellow">
          Assisted — not competitively comparable
        </Text>
      ) : null}
      {view !== "overview" && view !== "result" && state.attacks.length ? (
        <Text>
          <Text bold>MOVES </Text>
          <Text color="cyan">mounting {String(attackCounts.mounting)}</Text>
          {" · "}
          <Text color="green">landed {String(attackCounts.landed)}</Text>
          {" · "}
          <Text color="yellow">revisions {String(attackCounts.revised)}</Text>
        </Text>
      ) : null}
      {view !== "overview" && view !== "result" && battleCall ? (
        <Text bold {...colorProps(statusColor(latestAttack?.phase ?? ""))}>
          ❯ {battleCall}
        </Text>
      ) : null}
      {view === "result" ? (
        <SuccessScreen state={state} />
      ) : view === "overview" ? (
        <Box flexDirection="column">
          <Text>
            <Text bold color="#d97757">
              ✦
            </Text>{" "}
            <Text bold>{state.contestants.b.provider.toUpperCase()}</Text>
            <Text dimColor> versus </Text>
            <Text bold>{state.contestants.a.provider.toUpperCase()}</Text>{" "}
            <Text bold color="cyan">
              ◆
            </Text>
          </Text>
          <Contestant id="b" state={state} />
          <Text dimColor> ──────────────── VS ────────────────</Text>
          <Contestant id="a" state={state} />
          <BattleDialogue
            call={battleCall}
            attackCounts={attackCounts}
            objective={STAGE_DETAILS[state.stage].objective}
          />
        </Box>
      ) : view === "a" || view === "b" ? (
        <Box borderStyle="round" flexDirection="column" paddingX={1}>
          <Text bold color="cyan">
            Contestant {view.toUpperCase()} output
          </Text>
          <Text>
            Invocations:{" "}
            {state.contestants[view].invocations
              .slice(-4)
              .map((invocation) => `${invocation.stage}:${invocation.status}`)
              .join(" · ") || "none"}
          </Text>
          <Text dimColor>
            {filter} · {follow ? "following" : `scroll -${String(offset)}`}
          </Text>
          <Output
            state={state}
            id={view}
            offset={offset}
            follow={follow}
            filter={filter}
          />
        </Box>
      ) : view === "system" ? (
        <Box borderStyle="round" flexDirection="column" paddingX={1}>
          <Text bold color="cyan">
            System output
          </Text>
          <Text dimColor>
            {filter} · {follow ? "following" : `scroll -${String(offset)}`}
          </Text>
          <Output
            state={state}
            system
            offset={offset}
            follow={follow}
            filter={filter}
          />
        </Box>
      ) : (
        <Box borderStyle="round" flexDirection="column" paddingX={1}>
          <Text bold color="cyan">
            BATTLE LOG ·{" "}
            {activeRoundStep && state.round
              ? state.round === "recovery"
                ? "RECOVERY"
                : `ROUND ${String(state.round)}`
              : "ALL ROUNDS"}
            {" · "}
            {STAGE_DETAILS[state.stage].label}
          </Text>
          {state.attacks.length ? (
            state.attacks.slice(-12).map((attack, index) => (
              <Text key={`${attack.id}-${attack.status}-${String(index)}`}>
                <Text {...colorProps(statusColor(attack.phase))}>
                  {attack.phase === "mounting"
                    ? "↗ mounting"
                    : attack.phase === "landed"
                      ? "✓ landed"
                      : attack.phase === "revised"
                        ? "↻ revised"
                        : "· resolved"}
                </Text>{" "}
                · {attack.round ? `R${String(attack.round)} · ` : ""}
                {attack.id} · {attack.attacker ?? "house"} →{" "}
                {attack.target ?? "—"}
                {attack.phase === "resolved" ? (
                  <Text {...colorProps(statusColor(attack.status))}>
                    {" "}
                    · {attack.status}
                  </Text>
                ) : null}
                {attack.severity ? ` · ${attack.severity}` : ""}
                {attack.damage === undefined ? null : (
                  <Text color="red"> · {String(attack.damage)} damage</Text>
                )}
                {attack.detail ? ` · ${attack.detail}` : ""}
              </Text>
            ))
          ) : (
            <Text>No attack activity yet.</Text>
          )}
        </Box>
      )}
      {state.warnings.slice(-3).map((warning) => (
        <Text key={warning} color="yellow">
          Warning: {warning}
        </Text>
      ))}
      {note !== undefined ? (
        <Text color="cyan">
          Steer {selected.toUpperCase()}: {note}█
        </Text>
      ) : (
        <Box marginTop={1}>
          <Text>
            <Text dimColor>
              o arena · 1/2 fighters · r battle log · s system · n steer
              {state.status === "complete" ? " · v result" : ""} · ctrl+c cancel
            </Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function startDashboard(
  observer: DashboardObserver,
  control: ArenaBattleControl,
) {
  return render(<Dashboard observer={observer} control={control} />, {
    exitOnCtrlC: false,
  });
}
