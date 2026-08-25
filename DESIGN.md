---
name: Agent Arena Desktop Observatory
description: Six physical operator views presenting one authoritative engineering record.
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
  transit-ground: "#e8e6dc"
  transit-panel: "#fffdf7"
  transit-rule: "#768184"
  transit-foreground: "#17232b"
  transit-muted: "#5d696d"
  transit-line-a: "#0072bc"
  transit-line-b: "#e86a10"
  transit-verification: "#00843d"
  transit-current: "#ffd200"
  lab-paper: "#f3efe4"
  lab-panel: "#fffdf7"
  lab-ink: "#172328"
  lab-muted: "#526267"
  lab-rule: "#aab8b3"
  lab-teal: "#14736f"
  lab-orange: "#c04322"
  lab-blue: "#285e9c"
  lab-header-yellow: "#fff0b8"
  lab-claim-yellow: "#fff8d9"
  lab-violet: "#73549b"
  lab-red: "#a8321b"
  lab-green: "#256b40"
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
  transit-arrivals:
    backgroundColor: "{colors.transit-panel}"
    textColor: "{colors.transit-foreground}"
    rounded: "{rounded.pixel}"
    padding: "12px"
  lab-experiment-sheet:
    backgroundColor: "{colors.lab-panel}"
    textColor: "{colors.lab-ink}"
    rounded: "{rounded.pixel}"
    padding: "18px 24px"
  tactics-command:
    backgroundColor: "{colors.tactics-ground}"
    textColor: "{colors.tactics-text}"
    typography: "{typography.label}"
    rounded: "{rounded.pixel}"
    padding: "8px 11px"
---

# Design System: Agent Arena Desktop Observatory

## Overview

**Creative North Star: "Six physical views, one recorded truth"**

Agent Arena is an Operate-mode desktop observatory for an adversarial coding
run. Six shipped renderers—Classic Shell, Developer Dashboard, Night Transit,
Test Lab, Live Arena Broadcast, and 16-Bit Tactics—present the same normalized dashboard
state through materially different operator worlds. Theme choice changes
composition and atmosphere, never the underlying engineering record.

Night Transit replaces Night Edition with a real-wayfinding metropolitan board:
a warm mounted-map field is framed by black enamel signage, white service
panels, transit-blue Line A, orange Line B, green verification, yellow
current-service markers, standardized train/roundel/evidence pictograms,
repeated round stations, and authoritative arrivals. Its shipped visual record
is `.impeccable/review/subway-paper-desktop.png`,
`.impeccable/review/subway-paper-compact.png`, and
`.impeccable/review/subway-paper-results.png`. The visual-world inspiration is
a `.context` attachment only; it is not a shipping asset or runtime dependency.

Test Lab uses warm paper, opposing instrument benches, a central experiment
sheet, recorded invocation timing, check grids, and health-history plots. Its
approved composition reference remains `.impeccable/mocks/decision/test-lab.png`
and its shipped reproduction remains
`.impeccable/review/test-lab-hero-repro.png`. Approved references establish
composition and density, not fabricated operational content or production art.

The current signature direction is the user-selected modern pixel observatory
refinement of the original 16-Bit Tactics operator console: a midnight-violet
cartridge chassis surrounding a lush tactical terrain field where authoritative
attacks, repairs, and verification are visible as routes and nodes, with the
latest evidence structured directly inside the map. Its approved direction seed
is `71186a7d`, and the selected refinement reference is
`.impeccable/mocks/decision/retro-tactics-modern-pixel-observatory.png`. This is still an
engineering tool: playful competition language may frame the evidence, but
provider identity, HP, checks, coverage, failures, warnings, and result
authority stay explicit.

**Key Characteristics:**

- Six distinct physical compositions over one `DashboardState` projection.
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

**The Provider Activity Rule.** Every renderer projects the same normalized
provider events without raw tool arguments or private reasoning. Activity in
the last 30 seconds reads “Active” with its safe action label; an outstanding
tool reads “Waiting on `<tool>`” with elapsed time; otherwise a running call
reads “No recent provider activity” with heartbeat age. Quiet state is
informational and never implies a timeout. Contestant detail exposes the
normalized timeline and diagnostic artifact references, while plain output
prints activity only when the projected state changes.

**The Lifecycle Projection Rule.** Consolidate append-only attack telemetry by
attack ID. Preserve the first recorded mounting claim, show the latest recorded
phase, status, detail, severity, and damage, and derive repair ownership and HP
restoration only from positive health-ledger entries carrying that attack ID.
Unavailable measurements stay unavailable; visual metaphors never fill gaps.

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
- **Night Transit Family:** warm map paper and white timetable panels framed by
  black enamel signage; transit blue owns Line A, orange owns Line B, green owns
  verification, and service yellow marks the current round and wayfinding alerts.
- **Test Lab Family:** warm paper and neutral table rows with darker teal
  structure, blue Bench A ownership, orange Bench B ownership, yellow reserved
  for the original claim and notebook header, violet integrity/closure, red
  damage, and green repair.
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

- Classic uses warm paper inside its hardware shell; Night Transit uses ink
  enamel signage, while Test Lab uses warm experiment paper and metal rules.
- Developer Dashboard uses tonal layering from canvas to panel to raised panel.
- Broadcast uses ink rules against warm editorial stock.
- Tactics uses the ground/chassis/panel sequence for readable cartridge depth,
  with warm off-white operational text.

**The Family Integrity Rule.** Do not recolor one renderer into another. Classic
is rounded Pocket hardware, Developer Dashboard is a conventional dense tool,
Night Transit is a route-and-arrivals control room, Test Lab is an experiment
sheet between opposing benches, Broadcast is an editorial live feed, and
Tactics is an angular cartridge console with a map-first topology.

**The Semantic Route Rule.** In 16-Bit Tactics, attack, repair, and verify are
not decorative line colors. The legend, route class, latest-state treatment,
and textual footer must agree with recorded state.

**The Result Contrast Rule.** Results and fighter detail consume each family's
semantic `--result-*` and `--detail-*` tokens. Winner emphasis comes from
surface and border changes without reducing the readability of authoritative
values.

**The Track Bed Truth Rule.** Night Transit's lightly route-colored track bed
communicates available network topology and perceived readiness only. Saturated
blue, orange, or green service overlays appear only when the projected dashboard
lifecycle records the corresponding route or verification evidence. Blue and
orange always name contestant ownership, green names verified or repaired
outcomes, and service yellow is reserved for the current station and wayfinding
notices. Every color state retains a nearby text label.

**The Notebook Semantics Rule.** Test Lab color is restrained and intentional.
Paper and table rows stay neutral by default; yellow is reserved for the
original claim and header, blue/orange identifies contestant ownership only at
headers, labels, and markers, red/green identifies damage and repair, teal
structures evidence, and violet marks the footer and run-integrity state.

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

The `136,676`-byte Space Grotesk file (approximately `137 KB`) is preloaded from
the document head. Switching into Night Transit therefore does not wait for its
operational face to begin loading; the preload is a perceived-readiness and
theme-switch performance contract.

### Hierarchy

- **Display:** Barlow Condensed Black is reserved for Broadcast provider names,
  score data, the Battle Desk, and terminal verdict moments.
- **Headline:** Fredoka supplies the friendly, tactile scale of Classic
  hardware.
- **Body:** Space Grotesk carries Developer Dashboard, Night Transit, Test Lab,
  and Broadcast operational copy.
- **Label:** Silkscreen is the bitmap-scale voice of 16-Bit Tactics status,
  navigation, map nodes, commands, detail, and result chrome.
- **Terminal:** the full output surface uses a minimum `13px/1.6` system
  monospace treatment with preserved whitespace and wrapping for long content.

**The Theme-Switch Readiness Rule.** Preload Space Grotesk before React mounts;
Night Transit must not look typographically unfinished while its `137 KB` body
face begins loading after a theme change.

**The Role Separation Rule.** Do not use the broadcast face for body copy or
Silkscreen for long terminal output. Display faces provide identity; operational
and terminal faces carry evidence.

**The Operational Legibility Rule.** Night Transit and Test Lab operational
copy never drops below `10px`; compact data values use `11px` where the current
tables, contestant facts, experiment facts, and sample identifiers require
stronger scanning weight.

## Layout

The shared shell keeps brand, task, theme picker, connection state, links,
results return, and cancellation in a stable top bar. Theme changes preserve
the selected fighter, round, replay/results mode, live stream, and projected
battle state.

- **Classic Shell:** three-column topology with round rail, flexible arena, and
  evidence rail. Equal fighter cards flank a narrow versus divider.
- **Night Transit:** `190px` round rail, a flexible central workspace, and a
  `260px` activity rail. The central `360px` network physically aligns a `230px`
  two-row contestant status board with the route map before arrivals, totals,
  and steering continue below.
- **Test Lab:** `250px` invocation timeline, a flexible three-column workspace
  of opposing benches and central experiment sheet, and `225px` Check samples
  tray. The tray moves below at narrow widths and the experiment sheet leads the
  compact reading order.
- **Developer Dashboard:** a dashboard-native three-column workspace: `260px`
  dedicated vertical round timeline, flexible paired contestant workspaces,
  and `310px` chronological activity rail, with a compact run-status bar
  spanning the bottom. Check tables and summary logs make engineering facts
  the primary visual material.
- **Live Arena Broadcast:** a flexible live feed plus a `340px` Battle Desk.
  The feed contains a split field, opposing provider discs, versus marker, and
  scorebug; the desk holds round totals and play-by-play.
- **16-Bit Tactics:** the map-first operator-console topology is a top matchup
  bar, a `142px` round rail, a flexible tactical map, a `280px` activity/evidence
  rail, and bottom inspection commands. On desktop, the complete chassis is
  locked to the available viewport: matchup, rails, terrain, and command strip
  remain visible while the two rails scroll internally when their evidence is
  taller than the frame. The brighter terrain fills most of the central pane
  while all operational state remains semantic HTML/SVG above it.
- **Results and contestant detail:** all six families reuse the same semantic
  structures. The overview remains compact; detail exposes full output,
  invocations, checks, health changes, and attack involvement.

At `1200px`, Developer Dashboard moves its activity rail below the contestant
workspace; Night Transit moves activity into a two-column lower band; Test Lab
moves Check samples into a three-column band below its
workspace. At `1180px`, shared detail collapses to one column and the shared
evidence rail moves below the arena. At `980px`, Night Transit's outer rails
stack while its network keeps a `210px` contestant board beside the map. Test
Lab returns to natural flow and puts the experiment sheet before the stacked
benches. Hardware frames flatten,
Broadcast stacks its Battle Desk, and Tactics releases its desktop viewport
lock, returns to natural page scrolling, and moves the evidence rail into a
two-column band below the map. At `760px`, shared arenas switch to a horizontal
round strip and stacked fighters. At `700px`, Transit places the two contestant
panels in columns above a `330px` map, retains both lines' R1/R2/R3 stations but
hides their secondary move counts, and lets the arrivals table scroll. Lab
reduces to a single Check samples list and lets its evidence table scroll.
Developer Dashboard becomes a
horizontal round selector with stacked contestant workspaces; Tactics compresses
matchup bars, turns the round rail into a horizontal strip, hides nonessential
bezel ornaments that could cover status values, and installs a fixed two-command
inspect dock at the bottom edge. Those compact Inspect controls remain visible
while the map scrolls and open the same full-detail view as the desktop command
strip.

**The Metaphor-First Rule.** The renderer's cards, feed, or tactical map remain
the first-viewport anchor; operator controls stay immediately reachable without
becoming the visual subject.

**The Compact Inspect Rule.** On narrow Tactics screens, never hide inspection
behind map nodes or a menu. Keep the two explicit provider-labeled Inspect
commands in the fixed dock.

**The Full Chassis Rule.** At desktop widths, fit the complete Tactics console
inside the application viewport. Do not make the terrain a separately cropped
or page-scrolling poster; overflow belongs inside the round and activity rails.

## Elevation & Depth

Depth is structural. Classic uses thick ink borders and soft card lift inside
an inset hardware shell. Night Transit stays flat and map-like, separating field,
panel, and route layers with fine rules and tonal steps. Test Lab keeps benches
flat but lifts the central ruled experiment sheet with a restrained paper shadow
(`0 5px 18px rgb(34 47 43 / 18%)`). Developer Dashboard is flat by default and
separates canvas, panel, and raised-panel tones with one-pixel rules. Broadcast is mostly
flat editorial stock; the large provider discs carry the strongest lift.
Tactics uses doubled chassis rules, inset pixel bevels, short map-node shadows,
and cartridge-bezel ornaments at the matchup, rails, map, and command strip.
Terrain is kept bright enough for paths, node silhouettes, and map detail to
remain readable beneath overlays. It never uses glass or blur.

The latest Tactics route animates in a `1100ms` linear cycle; HP/damage state
changes use `220ms` responses. Under `prefers-reduced-motion: reduce`, all
durations collapse to `0.01ms`; numbers, labels, selection, and route classes
remain the durable evidence.

**The Structural Depth Rule.** A shadow or bevel must explain a card, chassis,
provider disc, node, or operator control. Do not apply depth to arbitrary prose.

## Shapes

Classic uses chunky rounded hardware (`44px` outer shell), thick outlines,
circular provider wells, pill health tracks, and `20–24px` production cards.
Night Transit uses squared enamel-sign panels, cool gray rules, circular line
badges and stations, `45deg` route geometry, round-ended service strokes,
and a large circular double-ring transfer. Test Lab uses ruled paper, compact metal-panel
benches, square check cells, and functional health polylines. Developer
Dashboard uses compact `4–8px` corners and one-pixel rules. Broadcast uses
squared editorial panels, a diagonal field split, circles for provider
portraits, and a hard rectangular scorebug.

16-Bit Tactics uses `0–2px` corners, `3–6px` single or doubled rules,
clip-path-cut panel corners, square-ended dashed paths, and inset pixel bevels.
Generated bezel sprites add rivets, seams, and corner ornaments around the
semantic cartridge structure without replacing its borders or focus states.

**The Silhouette Rule.** Preserve geometry with palette: rounded Pocket
hardware, compact Developer panels, squared Transit signage and stations, ruled
Lab paper and instrument benches, hard Broadcast editorial framing, and angular
pixel-cartridge Tactics.

## Components

### Theme picker

The six `28px` swatches live in a labeled fieldset, use `aria-pressed`, and
preview their renderer's material. The selected swatch has a visible two-pixel
outline. At compact width the targets expand to `44px`.

`ArenaTheme` is display-only Electron state. The sandboxed bridge exposes only
`getTheme()` and `setTheme(theme)`. Preferences are stored privately and
atomically; missing or invalid values resolve to Classic Shell. Theme state
never enters scoring, run artifacts, recovery digests, or dashboard authority.

Stored `night-edition` preferences normalize to `night-transit` before React
mounts. The migration is one-way display compatibility: Night Edition is not a
seventh renderer and its former Pocket-shell palette is not a source for new
Night Transit work.

### Per-theme direction contracts

- **Classic Shell:** keep live engineering evidence immediately legible in warm
  shell surfaces and clear opposing fighter cards. The first viewport contains
  the round rail, fighters, narration, and evidence activity.
- **Developer Dashboard:** operate the arena as a conventional dark observability
  workspace. The first viewport contains the round timeline, paired workspaces,
  chronological activity, and run-status bar.
- **Night Transit:** turn attack lifecycles into an authoritative subway
  wayfinding board using a near-black sign shell, a warm printed map, blue/orange
  contestant services, green verification, yellow current state, transit
  pictograms, and arrivals typography.
  The first viewport contains the round rail, aligned contestant/network board,
  repeated round stations, Verify transfer, network-status sign, route totals,
  arrivals, and activity rail.
- **Test Lab:** make each lifecycle readable as a reproducible software
  experiment using warm paper, graphite instruments, teal and safety-orange
  benches, and ruled evidence. The first viewport contains the invocation
  timeline, opposing benches, central experiment sheet, and Check samples tray;
  follow the approved Test Lab composition.
- **Live Arena Broadcast:** present recorded evidence with live-broadcast
  immediacy through the split field, scorebug, Battle Desk, and factual
  play-by-play. The first viewport is the live feed beside the desk.
- **16-Bit Tactics:** present recorded evidence in the approved map-first,
  midnight-violet operator console. The first viewport is the matchup bar,
  round rail, tactical node map, evidence channel, and inspection commands.

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

### Night Transit

Night Transit fills the live arena viewport with a `190px` round rail, flexible
central workspace, and `260px` activity rail. The workspace begins with a
`360px` network: a `230px` two-row contestant status board is physically aligned
to the route map, so each contestant service reads as the origin of its line.
Provider, model, HP, checks, status, Inspect, and steering remain adjacent to the
network rather than floating below it.

The route map uses `45deg` metropolitan geometry over a warm printed field with
faint street-grid and water/arterial context. Persistent `18px` pale blue and
orange track beds paint the complete two-line topology on first paint; Line A
and Line B repeat R1, R2, and R3 stations, with the current round switching to
service yellow. Circular A/B bullets establish ownership. At center, a large
double-ring Verify transfer carries a green check and status; the network-status
sign states whether the board is merely ready or contains recorded services.
When real lifecycle data exists, saturated blue or orange service strokes overlay
the bed; verification uses the saturated green branch. The bed is
perceived-readiness infrastructure, never fabricated evidence: only saturated
lifecycle overlays claim recorded service. Authored train, roundel, and evidence
SVG pictograms share one square-stroked wayfinding language; emoji and generic
decorative glyphs are not substitutes.

The arrivals board consolidates the five latest lifecycles without discarding
the original claim. A three-part totals strip—Attack routes, Verified, and
Repaired—and the compact no-recorded-services state make authoritative zeroes
look complete rather than loading.

At `1200px`, activity becomes a two-column lower band. At `980px`, the outer
rails stack while the network remains a `210px` contestant board beside the
map. At `700px`, contestant panels become two columns above a `330px` map;
R1/R2/R3 stations remain on both lines, secondary move counts hide, and arrivals
scroll horizontally without compressing evidence.

### Test Lab

Test Lab fills the live arena viewport with a `250px` invocation timeline,
opposing benches around a flexible central ruled experiment sheet, and a
`225px` Check samples tray. The timeline reads recorded start times, durations,
stages, and statuses; each bench derives HP, work state, health history, check
cells, latest invocation, summary, steering, and Inspect from its contestant.
The restrained notebook palette communicates ownership, evidence, and outcomes.
Paper and tables remain neutral; yellow is reserved for the original claim and
header, blue/orange appears only on
contestant headers, labels, and markers, red/green marks damage and repair, teal
structures evidence, and violet marks the footer and integrity state.
The sheet uses the latest projected attack lifecycle for original claim, source,
target, severity, phase, adjudication status, damage, and ledger-backed repair,
and uses explicit unavailable copy rather than synthetic lab measurements. The
Check samples tray lists recorded checks only.

At `1200px`, Check samples become a three-column band below the workspace. At
`980px`, the experiment sheet leads the reading order before stacked Bench A and
Bench B, while the timeline becomes a compact band above. At `700px`, samples
become a single list, the ruled sheet narrows without losing its hierarchy, and
wide evidence tables scroll horizontally.

### Live Arena Broadcast

Broadcast owns a network header, split live field, large circular provider
portraits, an authoritative scorebug, and a Battle Desk with recent play-by-play.
On smaller screens the desk stacks below the feed; two opposing contestants
remain visible in the stage.

### 16-Bit Tactics arena

The matchup header exposes provider, model, HP bar, and check totals for both
contestants. The left rail exposes actual round availability and phase. The map
contains two bases, a neutral verification node, and up to two compact work
nodes per contestant derived from that contestant's most recent recorded
invocations. Work-node labels and metadata wrap instead of truncating. SVG
attack routes render only for contestants with recorded attacks, verification
renders only when checks or adjudication evidence exist, and repair/latest
routes come from the corresponding recorded events. The right rail shows recent
authoritative activity; the in-map evidence readout names the latest event,
source, target, outcome, and damage without inventing missing values. The bottom
command strip contains exactly two provider-labeled Inspect actions and the
current task/read-only state.

On desktop the full cartridge chassis fits the available application viewport,
with internal rail scrolling and a bounded map. Below the alternate-renderer
breakpoint it returns to natural document flow; at narrow widths, decorative
corner and rail ornaments are removed before they can obscure HP or check data.

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

**The Results Entry and Overflow Rule.** Every transition into Results resets
document scroll to the top and keeps it there through Electron's automatic
results-window resize, so the full topbar, verdict, and actions start visible.
Result summary and evidence-grid children are shrink-safe
(`min-width: 0`); long labels wrap, and metadata/counts remain fixed-size so no
text is clipped. Content continuing below the viewport fold is normal document
scrolling; horizontal overflow, clipped text, or hidden leading chrome is not.

The current cross-theme proof set is
`.impeccable/review/result-user-viewport.png` (`1024x434`),
`.impeccable/review/result-wide-proof.png` (`2048x867`), and
`.impeccable/review/result-compact-proof.png` (`760x600`). These captures prove
entry position and shrink safety at representative widths; they do not require
all result evidence to fit above the fold.

Night Transit and Test Lab map the shared shell aliases and the complete
`--detail-*` / `--result-*` contract to their own surfaces, rules, text,
hover, focus, success, danger, winner, and action colors. Fighter detail and
results therefore inherit the active renderer instead of falling back to
Classic or generic chrome.

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
- **Do** project attack lifecycles by stable attack ID, retaining the original
  mounting claim while later events update only the facts they actually carry.
- **Do** use the final desktop, compact, and Results Night Transit captures and the approved Test Lab
  comp/reproduction as their respective composition and density evidence.
- **Do** keep the Night Transit contestant board physically aligned to its
  network, paint the lightly route-colored track bed immediately, and reserve
  saturated service overlays for recorded lifecycles.
- **Do** pair sparse Transit rounds with the network-status sign and
  attack/verified/repaired totals.
- **Do** keep Test Lab paper and rows neutral, reserving its accents for the
  documented claim, ownership, structure, integrity, damage, and repair roles.
- **Do** keep theme selection, connection, round context, and cancellation
  reachable in the first viewport.
- **Do** invert Night Transit Inspect buttons into their blue/orange ownership
  color on hover and keyboard focus while retaining a visible focus outline.
- **Do** use the 16-Bit Tactics legend and textual route footer alongside color
  and route motion.
- **Do** derive compact Tactics work nodes from recorded invocations and render
  routes only when their corresponding battle events exist.
- **Do** keep the complete Tactics chassis visible at desktop widths and switch
  to natural page scrolling for compact layouts.
- **Do** preserve overview summaries and route Inspect to full terminal-order
  output and complete ledgers.
- **Do** keep generated asset provenance sidecars adjacent to every shipping
  tactics bitmap.
- **Do** let each renderer collapse according to its own composition, including
  the fixed compact Tactics inspect dock.

### Don't

- **Don't** reduce Developer Dashboard, Night Transit, Test Lab, Broadcast, or Tactics to palette swaps
  of Classic Shell.
- **Don't** render a transit route, experiment metric, verdict, or duration
  without corresponding recorded dashboard state.
- **Don't** restore Night Edition as a selectable family or reuse its rounded
  Pocket-shell grammar for Night Transit.
- **Don't** collapse a sparse Transit network into vague loading space or remove
  its status sign or zero-value totals.
- **Don't** treat the always-visible Transit track bed as evidence that a route
  has been recorded; only lifecycle overlays carry that meaning.
- **Don't** swap Test Lab ownership and outcome colors for arbitrary variety.
- **Don't** tint every Test Lab fact or table row.
- **Don't** copy third-party game characters, sprites, logos, maps, or UI, and
  don't use the approved comp itself as shipping production UI.
- **Don't** bake operational state into terrain, sprite, or bezel bitmaps.
- **Don't** darken Tactics terrain until paths, node silhouettes, or map detail
  become difficult to read, or let decorative bezel pieces overlap status data.
- **Don't** imply that replay controls execution or that recorded rounds can be
  rewound, paused, or rerun.
- **Don't** let display preferences affect scoring, artifacts, recovery, or any
  other source of battle authority.
- **Don't** hide provider identity, checks, failures, warnings, or coverage
  confidence behind competition language.
- **Don't** animate away the only evidence of damage, repair, verification,
  selection, or connection state.
