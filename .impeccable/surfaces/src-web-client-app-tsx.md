---
version: 1
slug: "src-web-client-app-tsx"
primary_target: "src/web/client/App.tsx"
related_targets: ["src/web/client/styles.css", "src/web/client/index.html"]
---

# Retro Tactics renderer brief

- Scope: replace Monster Battle across live arena, replay, fighter detail, and results; replace Sticker League with a conventional developer-dashboard theme using the shared semantic layout.
- Mode: Operate. Developers must read health, checks, current work, rounds, evidence, and actions at a glance.
- Direction: an original late-16-bit tactical strategy console for coding agents. No copied game characters, sprites, logos, or proprietary UI.
- Approved composition: `.impeccable/mocks/retro-tactics-b-operator-console.png`.
- Memorable moment: verified attacks and repairs illuminate opposing paths across a real battle-state node map while the evidence rail advances.
- Constraints: overview stays summarized; fighter detail preserves full terminal-order output; controls are real; selected/history state is textual; reduced motion retains every durable cue.

## Implementation inventory

| Ingredient          | Commitment                                                                                 | Medium                                                           |
| ------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Match header        | Two angular contestant status bars, provider, model, HP, checks, VS                        | Semantic HTML/CSS plus existing provider PNGs                    |
| Round rail          | Persistent compact numbered live/recorded navigation in the left bezel                     | Existing round state and native buttons                          |
| Tactical map        | Dense rectangular tile field covering most of the central pane                             | Responsive CSS tile field with authored SVG geometry             |
| Agent territories   | Purple left and orange right base nodes with actual activity labels                        | Semantic buttons with CSS pixel geometry                         |
| Battle paths        | Attack, repair, and neutral routes derived from recorded events                            | SVG paths and state classes; motion only on authoritative change |
| Activity rail       | Recent attacks/evidence, phase and directional ownership                                   | Semantic aside and real recorded text                            |
| Command strip       | Inspect Codex and Inspect Claude as prominent angular controls                             | Native buttons opening full-output detail                        |
| Developer dashboard | Conventional dark three-column shared renderer replacing the redundant second Pocket theme | Existing semantic React components with neutral theme tokens     |
| Results/detail      | Shared structures in tactical violet/orange/aqua materials; full output remains unbounded  | Existing React structures plus theme CSS                         |

## Component grammar

- Corners: clipped/angular `0–4px`, never rounded cards or pills.
- Lines: `2px` deep-violet chassis rules; `1px` aqua/purple/orange data rules.
- Elevation: inset pixel bevels and short soft chassis shadows; no glass or blur.
- Type: Arena Space for operational copy; bundled monospace for measurements and map labels; display labels use a blocky uppercase treatment without rasterizing text.
- Palette: ground `#080815`, chassis `#171329`, purple `#7949ba`, orange `#f08a22`, aqua `#43d5d1`, grass `#396f38`, water `#176287`, parchment `#ead8a6`, text `#f2ebdf`.
- Density: the map occupies roughly two-thirds of the first viewport; status and evidence rails remain compact and factual.

The approved comp is a topology and density contract, not permission to invent ten rounds, spectators, countdowns, map objects, or game mechanics. Only recorded dashboard facts ship.
