---
name: Agent Arena Desktop Observatory
description: Five physical operator views presenting one authoritative engineering record.
colors:
  classic-ink: "#173039"
  classic-paper: "#ecf6d7"
  classic-coral: "#ef5d58"
  classic-yellow: "#ffe86a"
  classic-mint: "#70d8c2"
  developer-canvas: "#0d1117"
  developer-panel: "#161b22"
  developer-panel-raised: "#1c232d"
  developer-line: "#30363d"
  developer-text: "#f0f3f6"
  developer-muted: "#9da7b3"
  developer-blue: "#4493f8"
  developer-green: "#3fb950"
  developer-red: "#f85149"
  night-field: "#191838"
  night-violet: "#8f6de8"
  night-mint: "#75efd0"
  night-cream: "#f1eddd"
  broadcast-ink: "#161a1c"
  broadcast-paper: "#f3f0e7"
  broadcast-field: "#285c69"
  broadcast-live: "#f04d45"
  broadcast-score: "#ffdd52"
  tactics-ground: "#080815"
  tactics-chassis: "#171329"
  tactics-purple: "#7949ba"
  tactics-orange: "#f08a22"
  tactics-aqua: "#43d5d1"
  tactics-grass: "#396f38"
  tactics-water: "#176287"
  tactics-text: "#f2ebdf"
typography:
  display:
    fontFamily: "Arena Barlow, sans-serif"
    fontSize: "clamp(38px, 5vw, 72px)"
    fontWeight: 900
    lineHeight: 0.85
  headline:
    fontFamily: "Arena Fredoka, ui-rounded, sans-serif"
    fontSize: "clamp(28px, 3vw, 42px)"
    fontWeight: 700
  body:
    fontFamily: "Arena Space, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Arena Silkscreen, ui-monospace, monospace"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 1.35
  terminal:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  pixel: "1px"
  dashboard-card: "6px"
  control: "8px"
  classic-card: "20px"
  hardware-shell: "44px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "24px"
  xxl: "28px"
components:
  theme-option:
    backgroundColor: "{colors.developer-panel}"
    rounded: "{rounded.control}"
    size: "28px"
  developer-card:
    backgroundColor: "{colors.developer-panel}"
    textColor: "{colors.developer-text}"
    rounded: "{rounded.dashboard-card}"
    padding: "18px"
  classic-card:
    backgroundColor: "#ffffff"
    textColor: "{colors.classic-ink}"
    rounded: "{rounded.classic-card}"
    padding: "18px"
  tactics-command:
    backgroundColor: "{colors.tactics-ground}"
    textColor: "{colors.tactics-text}"
    typography: "{typography.label}"
    rounded: "{rounded.pixel}"
    padding: "8px 11px"
---

# Design System: Agent Arena Desktop Observatory

## Overview

**Creative North Star: "Five physical views, one recorded truth"**

Agent Arena is an Operate-mode desktop observatory for an adversarial coding
run. Five shipped renderers—Classic Shell, Developer Dashboard, Night Edition,
Live Arena Broadcast, and 16-Bit Tactics—present the same normalized dashboard
state through materially different operator worlds. Theme choice changes
composition and atmosphere, never the underlying engineering record.

The current signature direction is the original 16-Bit Tactics operator
console: a midnight-violet cartridge chassis surrounding a tactical terrain
field where authoritative attacks, repairs, and verification are visible as
routes and nodes. Its approved direction seed is `71186a7d`. This is still an
engineering tool: playful competition language may frame the evidence, but
provider identity, HP, checks, coverage, failures, warnings, and result
authority stay explicit.

**Key Characteristics:**

- Five distinct physical compositions over one `DashboardState` projection.
- Persistent live status, round navigation, theme choice, and cancellation.
- Overview screens summarize; contestant detail preserves full terminal-order
  output and the complete evidence ledger.
- Responsive layouts retain actionable inspection and textual state cues.
- Locally bundled type and original generated bitmaps keep the application
  self-contained.

**The Recorded Truth Rule.** A renderer may change composition and language,
but it must never invent a contestant, round, check, attack, repair, failure,
coverage result, terminal outcome, or recommendation.

**The Summary-to-Source Rule.** Arena overviews use normalized summaries and
recent evidence. The Inspect action is the path to the untruncated, redacted
output stream in recorded terminal order; do not turn an overview into a second
terminal or trim the detail source.

## Colors

Each renderer owns a coherent material palette while shared semantic aliases
keep focus, success, warning, danger, replay, detail, and result states legible.
The normative core colors are in frontmatter; additional tonal and semantic
roles remain in `styles.css`.

### Primary

- **Classic Pocket Family:** dark blue-green ink on pale paper, with coral as
  the hardware shell and mint/yellow for tactile controls and contestant wells.
- **Developer Dashboard Family:** near-black canvas and charcoal panels with
  blue interaction, green success, and red failure signals.
- **Night Console Family:** midnight field and violet hardware surrounding warm
  cream cards; mint carries selection and focus.
- **Broadcast Family:** dark editorial ink and warm paper around a split teal
  live field; live red and score yellow carry urgency and comparison.
- **Tactics Family:** black-violet ground and chassis, purple/orange contestant
  territories, aqua verification, and grass/water terrain.

### Secondary

- Shared operational aliases map each theme to readable focus, success,
  warning, danger, replay, detail, and terminal-result roles.
- 16-Bit Tactics uses green only for repair routes, aqua for neutral verification,
  and purple/orange for contestant ownership. Those meanings must survive even
  when motion is reduced.
- Broadcast reserves live red for the live badge and scorebug emphasis; score
  yellow is a comparison accent rather than ambient decoration.

### Neutral

- Classic and Night use warm paper/cream stocks inside their hardware shells.
- Developer Dashboard uses tonal layering from canvas to panel to raised panel.
- Broadcast uses ink rules against warm editorial stock.
- Tactics uses the ground/chassis/panel sequence for readable cartridge depth,
  with warm off-white operational text.

**The Family Integrity Rule.** Do not recolor one renderer into another. Classic
and Night are rounded hardware, Developer Dashboard is a conventional dense
tool, Broadcast is an editorial live feed, and Tactics is an angular cartridge
console with a map-first topology.

**The Semantic Route Rule.** In 16-Bit Tactics, attack, repair, and verify are
not decorative line colors. The legend, route class, latest-state treatment,
and textual footer must agree with recorded state.

**The Result Contrast Rule.** Results and fighter detail consume each family's
semantic `--result-*` and `--detail-*` tokens. Winner emphasis comes from
surface and border changes without reducing the readability of authoritative
values.

## Typography

**Display Font:** Arena Barlow (with `sans-serif` fallback)

**Friendly Headline Font:** Arena Fredoka (with `ui-rounded, sans-serif` fallback)

**Operational Body Font:** Arena Space (with `sans-serif` fallback)

**Bitmap Label Font:** Arena Silkscreen (with `ui-monospace, monospace` fallback)

**Terminal Font:** system monospace stack

**Character:** The typography changes with the material world while preserving
a clear split between spectacle, operational reading, and raw evidence. All
four named faces are bundled locally with `font-display: swap`; their license
is shipped alongside the font files.

### Hierarchy

- **Display:** Barlow Condensed Black is reserved for Broadcast provider names,
  score data, the Battle Desk, and terminal verdict moments.
- **Headline:** Fredoka supplies the friendly, tactile scale of Classic and
  Night hardware.
- **Body:** Space Grotesk carries conventional dashboard and editorial
  operational copy.
- **Label:** Silkscreen is the bitmap-scale voice of 16-Bit Tactics status,
  navigation, map nodes, commands, detail, and result chrome.
- **Terminal:** the full output surface uses a minimum `13px/1.6` system
  monospace treatment with preserved whitespace and wrapping for long content.

**The Role Separation Rule.** Do not use the broadcast face for body copy or
Silkscreen for long terminal output. Display faces provide identity; operational
and terminal faces carry evidence.

## Layout

The shared shell keeps brand, task, theme picker, connection state, links,
results return, and cancellation in a stable top bar. Theme changes preserve
the selected fighter, round, replay/results mode, live stream, and projected
battle state.

- **Classic Shell and Night Edition:** shared three-column topology: `176px`
  round rail, flexible arena (`minmax(600px, 1fr)`), and `310px` evidence rail.
  Equal fighter cards flank a narrow versus divider.
- **Developer Dashboard:** a dashboard-native three-column workspace: `260px`
  dedicated vertical round timeline, flexible paired contestant workspaces,
  and `310px` chronological activity rail, with a compact run-status bar
  spanning the bottom. Check tables and summary logs make engineering facts
  the primary visual material.
- **Live Arena Broadcast:** a flexible live feed plus a `340px` Battle Desk.
  The feed contains a split field, opposing provider discs, versus marker, and
  scorebug; the desk holds round totals and play-by-play.
- **16-Bit Tactics:** the map-first operator-console topology is a top matchup
  bar, a `126px` round rail, a flexible tactical map, a `300px` activity/evidence
  rail, and bottom inspection commands. The terrain fills most of the central
  pane while all operational state remains semantic HTML/SVG above it.
- **Results and contestant detail:** all five families reuse the same semantic
  structures. The overview remains compact; detail exposes full output,
  invocations, checks, health changes, and attack involvement.

At `1200px`, Developer Dashboard moves its activity rail below the timeline and
contestant workspace. At `1180px`, shared detail collapses to one column and the
shared evidence rail moves below the arena. At `980px`, hardware frames flatten,
Broadcast stacks its Battle Desk, and the Tactics evidence rail becomes a
two-column band below the map. At `760px`, shared arenas switch to a horizontal
round strip and stacked fighters. At `700px`, Developer Dashboard becomes a
horizontal round selector with stacked contestant workspaces; Tactics compresses
matchup bars, turns the round rail into a horizontal strip, and installs a fixed
two-command inspect dock at the bottom edge. Those compact Inspect controls
remain visible while the map scrolls and open the same full-detail view as the
desktop command strip.

**The Metaphor-First Rule.** The renderer's cards, feed, or tactical map remain
the first-viewport anchor; operator controls stay immediately reachable without
becoming the visual subject.

**The Compact Inspect Rule.** On narrow Tactics screens, never hide inspection
behind map nodes or a menu. Keep the two explicit provider-labeled Inspect
commands in the fixed dock.

## Elevation & Depth

Depth is structural. Classic uses thick ink borders and soft card lift inside
an inset hardware shell. Night repeats the hardware silhouette with cream cards
and a short hard drop. Developer Dashboard is flat by default and separates
canvas, panel, and raised-panel tones with one-pixel rules. Broadcast is mostly
flat editorial stock; the large provider discs carry the strongest lift.
Tactics uses doubled chassis rules, inset pixel bevels, short map-node shadows,
and cartridge ornaments. It never uses glass or blur.

The latest Tactics route animates in `900ms` stepped increments; HP/damage state
changes use `220ms` responses. Under `prefers-reduced-motion: reduce`, all
durations collapse to `0.01ms`; numbers, labels, selection, and route classes
remain the durable evidence.

**The Structural Depth Rule.** A shadow or bevel must explain a card, chassis,
provider disc, node, or operator control. Do not apply depth to arbitrary prose.

## Shapes

Classic and Night use chunky rounded hardware (`44px` outer shell), thick
outlines, circular provider wells, pill health tracks, and `20–24px` production
cards. Developer Dashboard uses compact `4–8px` corners and one-pixel rules.
Broadcast uses squared editorial panels, a diagonal field split, circles for
provider portraits, and a hard rectangular scorebug.

16-Bit Tactics uses `0–2px` corners, `3–6px` single or doubled rules,
clip-path-cut panel corners, square-ended dashed paths, and inset pixel bevels.
Generated bezel sprites add rivets, seams, and corner ornaments around the
semantic cartridge structure without replacing its borders or focus states.

**The Silhouette Rule.** Preserve geometry with palette: rounded Pocket
hardware, compact Developer panels, hard Broadcast editorial framing, and
angular pixel-cartridge Tactics.

## Components

### Theme picker

The five `28px` swatches live in a labeled fieldset, use `aria-pressed`, and
preview their renderer's material. The selected swatch has a visible two-pixel
outline. At compact width the targets expand to `44px`.

`ArenaTheme` is display-only Electron state. The sandboxed bridge exposes only
`getTheme()` and `setTheme(theme)`. Preferences are stored privately and
atomically; missing or invalid values resolve to Classic Shell. Theme state
never enters scoring, run artifacts, recovery digests, or dashboard authority.

### Fighters and detail

Fighter cards, status bars, provider discs, and Tactics-owned map nodes open the
same contestant detail view. Overview cards render the ten most recent work
summaries; the detail `<pre>` renders every provided redacted output chunk in
order without presentation timestamps or truncation. It also keeps the full
invocation, check, health, and attack ledgers adjacent to the workstream.

### Round navigation and replay

Live and recorded rounds are native buttons. Selected items expose
`aria-current="page"`; unavailable future rounds are disabled. Recorded views
are explicitly read-only and never pause, rewind, rerun, or mutate execution.

### Developer Dashboard

Developer Dashboard owns the conventional operations-console topology shown in
the approved canon concept: a true round timeline, paired contestant workspaces
with health, metrics, check tables and normalized agent logs, an independent
chronological activity rail, and a bottom run-status bar. Steering and Inspect
remain present in each contestant workspace; Inspect opens the same complete
terminal-order detail used by every theme. Its visual grammar is flat near-black
canvas, charcoal sidebars and modules, `4–6px` corners, compact provider wells,
blue focus, green success, red failure, and no ornamental game framing. It is
the quiet, high-density option for developers who want the evidence model with
minimal metaphor.

### Live Arena Broadcast

Broadcast owns a network header, split live field, large circular provider
portraits, an authoritative scorebug, and a Battle Desk with recent play-by-play.
On smaller screens the desk stacks below the feed; two opposing contestants
remain visible in the stage.

### 16-Bit Tactics arena

The matchup header exposes provider, model, HP bar, and check totals for both
contestants. The left rail exposes actual round availability and phase. The map
contains five semantic nodes—two bases, two current-work nodes, and a neutral
verification node—with SVG attack, repair, and verify routes. The right rail
shows recent authoritative activity; the footer restates the current route in
text. The bottom command strip contains exactly two provider-labeled Inspect
actions and the current task/read-only state.

The map's generated bitmap assets are presentation layers only:

- `terrain-background.png` supplies original cover-sized grass, water, stone,
  vegetation, and path terrain beneath semantic state.
- `tactical-sprites.png` supplies original bases, objectives, ruins,
  vegetation, and markers clipped from a sprite sheet.
- `cartridge-bezel-atlas.png` supplies original corner, edge, rivet, and seam
  ornaments for cartridge framing.

Each bitmap ships with an adjacent `.png.json` provenance sidecar recording the
OpenAI image generator, approved-comp reference role, original prompt,
post-processing, dimensions, and intended use. The bitmaps may never bake in
labels, routes, selection, HP, or other operational truth; those remain in
accessible HTML/SVG/CSS.

### Steering, status, cancellation, and results

Steering is available only while connected, live, and running; empty notes are
disabled. Connection state is always written as Live, Reconnecting, or Complete.
Cancellation remains reachable while running/cancelling. Results automatically
open on terminal state and must distinguish a coverage-qualified champion from
a provisional leader whose recommendation remains withheld.

### Accessibility contract

Buttons, links, and inputs retain native keyboard operation. Focus uses a
visible two-pixel theme-colored outline with offset. Icon-only controls and
fighter hit areas have accessible names; decorative bitmap/SVG layers are
hidden from assistive technology. State is written in text as well as color,
and reduced motion never removes the only durable cue.

## Do's and Don'ts

### Do

- **Do** derive every label, quantity, route, node state, and result from
  normalized dashboard state.
- **Do** keep theme selection, connection, round context, and cancellation
  reachable in the first viewport.
- **Do** use the 16-Bit Tactics legend and textual route footer alongside color
  and stepped motion.
- **Do** preserve overview summaries and route Inspect to full terminal-order
  output and complete ledgers.
- **Do** keep generated asset provenance sidecars adjacent to every shipping
  tactics bitmap.
- **Do** let each renderer collapse according to its own composition, including
  the fixed compact Tactics inspect dock.

### Don't

- **Don't** reduce Developer Dashboard, Broadcast, or Tactics to palette swaps
  of Classic Shell.
- **Don't** copy third-party game characters, sprites, logos, maps, or UI, and
  don't use the approved comp itself as shipping production UI.
- **Don't** bake operational state into terrain, sprite, or bezel bitmaps.
- **Don't** imply that replay controls execution or that recorded rounds can be
  rewound, paused, or rerun.
- **Don't** let display preferences affect scoring, artifacts, recovery, or any
  other source of battle authority.
- **Don't** hide provider identity, checks, failures, warnings, or coverage
  confidence behind competition language.
- **Don't** animate away the only evidence of damage, repair, verification,
  selection, or connection state.
