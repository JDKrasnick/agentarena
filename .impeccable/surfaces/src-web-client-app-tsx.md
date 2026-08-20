---
version: 1
slug: "src-web-client-app-tsx"
primary_target: "src/web/client/App.tsx"
related_targets: ["src/web/client/styles.css", "src/web/client/index.html"]
---

# Monster Battle renderer brief

- Scope: replaces Evidence Deck across live arena, replay, fighter detail, and results.
- Mode: Operate. Developers must read health, checks, current work, evidence, and navigation at a glance.
- Direction: original handheld creature-battle arena; Pokémon-inspired grammar without proprietary characters, logos, sprites, or exact UI.
- Approved composition: `.impeccable/mocks/monster-battle-b-approved.png`.
- Memorable moment: provider marks materialize as blue/coral elemental summons over a cel-shaded field while authoritative turn dialogue narrates recorded engineering state.
- Constraints: provider identity and engineering facts remain primary; overview stays summarized; fighter detail stays full-output; all controls are real; reduced motion retains state cues.

## Implementation inventory

| Ingredient       | Commitment                                                                | Medium                                          |
| ---------------- | ------------------------------------------------------------------------- | ----------------------------------------------- |
| Stadium field    | Sky, clouds, two mountain layers, grass, sand battle ring                 | Semantic CSS plus crisp decorative SVG geometry |
| Provider summons | Large asymmetric blue/coral diamond forms with dashed elemental aura      | CSS geometry plus existing provider PNGs        |
| Status plates    | 4px navy contour, cream stock, rounded notched silhouette, HP and checks  | Semantic HTML/CSS                               |
| Turn dialogue    | Cream panel, strong message, evidence detail, single motion cue           | Semantic HTML/CSS                               |
| Inspect commands | Two real contestant-detail actions, provider mark and full-output promise | Native buttons                                  |
| Round navigation | Compact authoritative live/recorded controls                              | Existing React component, themed CSS            |
| Evidence ticker  | Up to four recorded attack entries                                        | Semantic aside and text                         |
| Results/detail   | Same product structures in battle cream/sky/navy tokens                   | Shared React components, themed CSS             |

Type: Arena Fredoka for battle display labels, Arena Space for operations, monospace only for model/output data. Palette: navy `#071a3c`, cobalt `#2369d8`, sky `#65c9f3`, cream `#fff9e9`, coral `#ee7359`, yellow `#f3c83b`, health green `#4aaf55`.
