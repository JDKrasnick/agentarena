---
name: Agent Arena Desktop Observatory
description: Five physical competition views presenting one authoritative engineering record.
colors:
  pocket-ink: "#173039"
  classic-paper: "#ecf6d7"
  classic-coral: "#ef5d58"
  classic-yellow: "#ffe86a"
  classic-mint: "#70d8c2"
  sticker-paper: "#fffaf0"
  sticker-yellow: "#f7d96f"
  sticker-mint: "#72d5c3"
  night-field: "#191838"
  night-hardware: "#372764"
  night-violet: "#8f6de8"
  night-mint: "#75efd0"
  night-cream: "#f1eddd"
  broadcast-ink: "#161a1c"
  broadcast-paper: "#f3f0e7"
  broadcast-field: "#285c69"
  broadcast-field-deep: "#173945"
  broadcast-live: "#f04d45"
  broadcast-score: "#ffdd52"
  deck-felt: "#245c49"
  deck-wood: "#684331"
  deck-cream: "#f4ead1"
  deck-attack: "#ef7568"
  deck-repair: "#65b4bb"
  deck-gold: "#e8bd4d"
typography:
  pocket-display:
    fontFamily: "Arena Fredoka, ui-rounded, sans-serif"
    fontWeight: 700
  operational-body:
    fontFamily: "Arena Space, sans-serif"
    fontWeight: 400
  broadcast-headline:
    fontFamily: "Arena Barlow, sans-serif"
    fontWeight: 900
---

# Design System: Agent Arena Desktop Observatory

## Overview

**Creative North Star: "Five physical views, one recorded truth"**

Agent Arena is an Operate-mode Electron observatory. It turns recorded
engineering evidence into five materially distinct competition views without
changing a product fact. The active renderer's central metaphor dominates the
first viewport while status, round navigation, theme selection, and cancellation
remain reachable.

The five worlds are chunky pocket hardware, a physical sticker sheet, a
portable night console, a hard-edged sports broadcast, and a felt evidence
table. Their shared story is: track the fight, inspect either contestant, review
immutable recorded rounds, understand attacks and repairs, then review and
finish the authoritative result. The approved direction seed is `a785963b`.

**Key Characteristics:**

- Five materially different renderer compositions over one normalized
  `DashboardState`.
- Physical, high-contrast framing with provider identity and engineering facts
  kept primary.
- Persistent access to live status, rounds, theme selection, and cancellation.
- Playful competition language constrained by authoritative evidence.

**The Recorded Truth Rule.** A theme may change composition and language, but it
must never invent a fighter, check, attack, repair, failure, terminal outcome,
coverage result, or recommendation.

## Colors

Each family has its own material palette; semantic red, green, and focus colors
remain legible within that world rather than being forced into a universal skin.

### Primary

- **Pocket Ink:** the shared outline, text, and hardware-detail color for the
  three Pocket themes.
- **Broadcast Field:** the live-feed plane, split with its deeper companion to
  separate the two contestants.
- **Deck Felt:** the tabletop field beneath all evidence cards.

### Secondary

- **Classic Coral, Yellow, and Mint:** hardware shell, tactile controls, and
  contestant emphasis.
- **Pocket Operational Teal and Danger Red:** high-contrast stream annotations,
  errors, and damage labels on light card stock.
- **Sticker Yellow and Mint:** the sticker rail, selected controls, and playful
  layered accents.
- **Night Violet and Mint:** translucent hardware and luminous selection/focus
  cues against the dark field.
- **Broadcast Live and Score:** urgent evidence signals and the central versus
  marker; neither is decorative filler.
- **Deck Attack, Repair, and Gold:** attack card, repair card, and ledger/versus
  emphasis respectively.

### Neutral

- **Classic and Sticker Paper:** light arena and card stocks for the Pocket
  hierarchy.
- **Night Field, Hardware, and Cream:** the dark console body and readable battle
  cards.
- **Broadcast Ink and Paper:** the network chrome and editorial Battle Desk.
- **Deck Wood and Cream:** the outer rail and face-up card stock.

**The Family Integrity Rule.** Do not recolor one renderer into another theme.
Pocket, Broadcast, and Evidence Deck use different compositions as well as
different palettes.

**The Result Contrast Rule.** Terminal views use the per-family semantic
`--result-*` tokens for surface, foreground, muted text, link, card, winner
card, border, stat, and focus colors. Every normal-text token pair must remain
at or above 4.5:1 on both standard and winner card surfaces. Winner emphasis
comes from the surface and border; it must not make authoritative values harder
to read. Family-specific tonal ramps may vary, but result components must not
introduce literal foreground colors outside these tokens.

### Token architecture

`styles.css` has three deliberate color layers:

- Shared operational tokens (`--app-*`, `--fighter-*`, `--replay-*`, and
  `--result-*`) own chrome, text hierarchy, controls, warnings, evidence states,
  focus, and terminal semantics.
- Family palette tokens (`--pocket-*`, `--sticker-*`, `--night-*`,
  `--broadcast-*`, and `--deck-*`) own the physical materials and tonal ramps
  unique to each renderer.
- The small compatibility aliases (`--surface`, `--line`, `--muted`, `--cyan`,
  `--green`, `--amber`, and `--red`) let the shared behavioral components
  inherit the active family's semantics without branching their markup.

Component rules consume tokens rather than literal colors. A new literal is
appropriate only when introducing a documented primitive to one of these
layers; repeated component-level literals are design-system drift. Shadows use
the shared `--shadow-*` ramp, while Pocket hardware retains its family-specific
inset band and Sticker retains its warm paper shadow.

## Typography

**Display Font:** Arena Fredoka (with `ui-rounded, sans-serif` fallback)
**Body Font:** Arena Space (with `sans-serif` fallback)
**Broadcast Headline Font:** Arena Barlow (with `sans-serif` fallback)

Fredoka supplies the friendly, tactile voice for Pocket hardware and tabletop
cards. Space Grotesk carries operational copy in Broadcast and Evidence Deck.
Barlow Condensed Black is reserved for broadcast headlines, provider names,
score data, and other network-scale moments; it is not general body copy.

The font files are bundled locally and use `font-display: swap`. Their SIL Open
Font License remains at `src/web/client/fonts/OFL.txt`.

**The Broadcast Compression Rule.** Use the condensed face only where the
broadcast renderer needs headline force or dense score data.

## Layout

The top bar is shared across every theme and keeps the brand, task, theme
picker, connection state, links, results return, and cancel action in one stable
place. Theme changes do not replace or reconnect this shell.

- **Pocket:** the desktop grid is a round rail (`176px`), a flexible arena
  (`minmax(600px, 1fr)`), and a `310px` evidence rail. The arena places equal
  fighter cards around a compact versus divider.
- **Broadcast:** the feed dominates a flexible left column while a `340px`
  Battle Desk carries counts and play-by-play.
- **Evidence Deck:** the table uses `220px` and `250px` player stacks around a
  flexible center playmat containing the attack and repair cards.
- **Results and detail:** all renderer families return to the same semantic
  result and fighter-detail structures, inheriting the active theme's material,
  type, focus, and colors.

At `1180px`, the Pocket evidence rail moves below the arena. At `980px`, the
physical outer frames flatten, Broadcast stacks the Battle Desk below the feed,
and Evidence Deck becomes a single-column sequence with its objective and
playmat before either fighter stack. At `760px`, Pocket uses a horizontal round
strip and stacked fighters. At `700px`, compact controls wrap, Broadcast retains
two opposing fighters in a reduced stage, and the Evidence Deck playmat becomes
a vertical card sequence. The document minimum is `320px`.

**The Metaphor-First Rule.** The renderer's fight, feed, or played cards must
remain the first-viewport anchor; operational controls stay visible without
becoming the visual subject.

## Elevation & Depth

Depth is structural and physical. Pocket cards use dark ink borders plus short,
soft shadows; Classic and Night add inset shell bands to read as hardware.
Sticker League adds restrained rotations to the rail, fighters, and battle call.
Broadcast is mostly flat and editorial, using the provider-disc shadow to lift
the contestants from the feed. Evidence Deck uses deeper card and rail shadows
to separate stock, felt, and wood.

Damage uses a brief `220ms` pop/hit response. All animation and transition
durations collapse to `0.01ms` under `prefers-reduced-motion: reduce`; the
numeric HP change remains the durable cue.

**The Material Depth Rule.** Shadows and rotations explain physical layering;
they must not decorate arbitrary operational text or evidence.

## Shapes

Pocket uses chunky rounded shells, thick ink outlines, circular provider wells,
pill health tracks, and a circular versus control. Classic's outer shell is
strongly rounded (`44px`); internal production cards use approximately
`20–28px` corners. Sticker League keeps those forms but offsets them like placed
paper decals. Night Edition repeats the hardware silhouette in violet with cream
cards.

Broadcast uses squared editorial panels, a diagonal field split, circular
provider portraits, and a hard rectangular scorebug. Evidence Deck combines a
rounded wood rail, lightly rotated player cards, dashed playmat boundary,
rounded stock, and a circular gold versus marker.

**The Silhouette Rule.** Preserve the family's geometry with its palette:
Pocket is rounded hardware, Broadcast is hard editorial framing, and Evidence
Deck is tactile tabletop stock.

## Components

### Theme picker

The five swatches live in a labeled fieldset and use `aria-pressed` for the
selected state. Each swatch previews its family's material rather than showing
an abstract color. The picker remains reachable in arena, replay, fighter
detail, and results views. A change preserves the selected fighter, selected
round, replay/results mode, event stream, and all projected battle state.

`ArenaTheme` is display-only Electron state. The sandboxed preload exposes only
`getTheme()` and `setTheme(theme)`. Electron reads the preference before React
mounts and atomically replaces `arena-theme.json` under
`app.getPath("userData")`; the file is private (`0600`). Missing, corrupt, or
unknown values resolve to `classic-shell`. A failed save keeps the in-memory
selection active and raises a non-blocking status warning. The preference never
enters battle events, runtime schemas, run artifacts, project configuration, or
recovery digests; terminal and plain displays do not consume it.

### Fighters and detail

Both fighter surfaces are always actionable and open the same workstream detail
view. Provider imagery comes from the provider registry; provider names remain
primary. Cards show health, status, current move, checks, up to ten concise
invocation summaries, and a textual damage cue. Detail uses a separate data path
that preserves and renders the full redacted stream in terminal order without
trimming whitespace or adding presentation timestamps. Returning to the arena
preserves the selected recorded round.

Operational text in the detail view uses theme-local semantic colors. Transcript,
empty, error, steering, and ledger text must retain at least WCAG AA 4.5:1
contrast against their actual surface in every renderer family; the full stream
uses a minimum 13px monospace treatment so terminal output remains legible.

### Round navigation and replay

Live is the current event-stream projection. Available rounds use actual
buttons, disabled upcoming rounds stay unavailable, and the selected item uses
`aria-current="page"` in both full and compact navigators. A shared availability
predicate enables a round as soon as authoritative attacks or invocations have
been recorded for it, even while a later round is live. Recorded rounds are
read-only; selecting one never pauses, rewinds, reruns, or mutates execution.
Replay copy must say this plainly.

### Steering, status, and cancellation

Steering is available only while connected, live, and running. Empty notes are
disabled. Connection state is always written as Live, Reconnecting, or Complete
beside its indicator. Cancellation remains reachable while running or
cancelling and changes its label to “Cancelling…” while disabled.

### Results

A terminal result opens results automatically. The view includes champion,
recommendation, coverage confidence, run integrity, completed rounds, both
fighter outcomes, defects, verified repairs, terminal outcome, artifact links,
round review, fighter inspection, and Finish Session. Provisional coverage must
withhold champion and recommendation language.

### Approved reference mapping

| Approved reference                     | Production mapping                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `08-pocket-rivals-classic.html`        | Shared top bar, `RoundNavigator`, Pocket fighter cards, battle call, evidence stream, themed results and detail. |
| `09-pocket-rivals-sticker-league.html` | Pocket renderer plus sticker rail, rotated navigation/fighters, and yellow stage material.                       |
| `12-pocket-rivals-night-edition.html`  | Pocket renderer plus violet console shell, cream cards, and mint focus/control treatment.                        |
| `13-live-arena-broadcast.html`         | `BroadcastArena`: network header, live field, provider discs, scorebug, Battle Desk, and play-by-play.           |
| `15-evidence-deck.html`                | `EvidenceDeckArena`: wood/felt table, player stacks, attack/repair playmat, and health ledger.                   |

### Accessibility contract

Keyboard focus uses a visible `2px` theme focus outline with `2px` offset.
Buttons, links, and inputs retain native keyboard operation. Icon-only theme
controls and fighter hit areas have accessible names; decorative provider discs
and icons are hidden from assistive technology. Results and persistence warnings
announce through polite status regions. Reduced motion preserves all numeric and
textual state cues.

## Do's and Don'ts

### Do

- **Do** derive every label and quantity from normalized dashboard state.
- **Do** keep theme selection and cancellation available in the first viewport.
- **Do** preserve view selection and the live connection when themes change.
- **Do** expose status, HP, evidence phase, and replay state in text as well as
  color.
- **Do** let each renderer collapse according to its own responsive composition.

### Don't

- **Don't** turn Broadcast or Evidence Deck into palette variants of Pocket.
- **Don't** imply that replay controls execution or that recorded rounds can be
  rewound, paused, or rerun.
- **Don't** allow display preferences to affect scoring, artifacts, recovery, or
  any other battle authority.
- **Don't** hide provider identity, engineering checks, failures, warnings, or
  coverage confidence behind game language.
- **Don't** animate away the only evidence of damage, repair, selection, or
  connection state.
