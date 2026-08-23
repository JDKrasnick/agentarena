---
target: Developer Dashboard and 16-Bit Tactics themes
total_score: 27
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 2
timestamp: 2026-08-20T14-40-34Z
slug: src-web-client-app-tsx
---

## Design Health Score

| #         | Heuristic                       |     Score | Key issue                                                                     |
| --------- | ------------------------------- | --------: | ----------------------------------------------------------------------------- |
| 1         | Visibility of system status     |         3 | Compact layouts hide Live/Reconnecting/Complete                               |
| 2         | Match system / real world       |         3 | Tactics is convincing 16-bit-inspired design, not literal 8-bit               |
| 3         | User control and freedom        |         3 | Inspect/replay/steer paths exist; compact controls duplicate                  |
| 4         | Consistency and standards       |         3 | Developer timeline omits the shared programmatic selected state               |
| 5         | Error prevention                |         2 | Tactics can visually attribute neutral or stale repair routes incorrectly     |
| 6         | Recognition rather than recall  |         3 | Strong labels overall; Tactics splits attention across map, HUD, and evidence |
| 7         | Flexibility and efficiency      |         3 | Strong detail/replay paths, but redundant compact tab stops                   |
| 8         | Aesthetic and minimalist design |         3 | Both are coherent; Tactics’ scenery sometimes outranks evidence               |
| 9         | Error recovery                  |         2 | Failures are visible, but recovery guidance is mostly deferred to detail      |
| 10        | Help and documentation          |         2 | The UI does not explain HP/evidence mechanics in context                      |
| **Total** |                                 | **27/40** | **Acceptable — targeted release fixes needed**                                |

## Design Specificity Verdict

Both themes are authored for Agent Arena, not palette swaps. Developer Dashboard is the stronger operator surface: fast to scan, fair in its paired comparison, and appropriately conventional. 16-Bit Tactics is the memorable signature theme, translating bases, work nodes, verification, attacks, and repairs into a coherent tactical map.

The automated detector returned zero findings, but manual source review found data-authority and compact-layout issues the detector does not model.

The retro theme is accurately named **16-Bit Tactics**. Its lush terrain, large sprite vocabulary, layered HUD, and color depth read as a modern homage to late-SNES/GBA-era tactics games. It is not period-authentic 8-bit/NES design, and renaming it “8-Bit” would make it less accurate. The current aesthetic fits the product well; its main weakness is operational hierarchy, not lack of theme.

## Overall Impression

Developer Dashboard is the stronger Operate-mode baseline. Tactics is the more emotionally engaging and memorable theme, but its map can outrank the evidence users need to judge a patch.

## What's Working

- Developer Dashboard’s equal contestant panels, checks, summaries, activity rail, steering, and bottom status bar make comparison unusually clear.
- Tactics has a real visual thesis: purple/orange territories, aqua verification, green repair, bitmap labels, node routes, and cartridge framing form a distinctive system.
- Theme switching preserves fighter, round, replay/results, SSE state, and battle data. Persistence, migrations, save-failure behavior, shared detail/results, contrast tokens, and full-output retention are covered by passing tests.

## Priority Issues

1. **[P1] Tactics can show invented or wrong route ownership.** The legend hard-codes Codex/Claude despite arbitrary providers and mirror matches; neutral activity defaults to contestant A’s route; and “latest repair” is selected by contestant grouping rather than global event sequence. This violates the Recorded Truth Rule. Fix all map labels and routes from normalized IDs and event sequence. Suggested command: `$impeccable harden`.
2. **[P1] Compact layouts remove connection state.** Below 700px, Live/Reconnecting/Complete disappears from both visual and accessibility trees, conflicting with the first-viewport contract. Keep a compact text/icon status visible. Suggested command: `$impeccable adapt`.
3. **[P2] Compact Tactics duplicates Inspect controls.** The fixed dock appears while the inline command pair remains present, creating four equivalent controls, redundant keyboard stops, and visible content obstruction. Keep one pair and reserve layout space for it. Suggested command: `$impeccable adapt`.
4. **[P2] Developer Dashboard’s selected round is visual-only.** Its custom timeline uses `.is-selected` without `aria-current`, unlike the shared navigator. Add the same programmatic state and regression coverage. Suggested command: `$impeccable harden`.
5. **[P2] Tactics is asset-heavy.** The three theme PNGs total about 4.95 MiB and decode to roughly 18.5 MB. Loopback delivery reduces network concern, but first activation and memory still warrant atlas cropping/compression or smaller source assets. Suggested command: `$impeccable optimize`.

## Persona Red Flags

- **Alex, power operator:** Developer Dashboard is strong; Tactics’ map-to-evidence scanning and duplicate compact controls slow expert inspection.
- **Sam, accessibility-dependent:** Missing compact connection status and selected-round semantics are concrete failures; 7–10px bitmap labels may also become tiring at zoom.
- **Riley, stress tester:** Non-Codex/Claude contestants, neutral attacks, interleaved repairs, narrow layouts, and long evidence lists expose the current truth/overflow gaps.

## Minor Observations

- Equal agent cards are excellent for fairness, but the active or failing contestant could receive slightly stronger non-color emphasis.
- Purple/orange ownership is memorable; labels and text must remain authoritative when color perception is limited.
- The theme picker already has accessible labels, native buttons, tooltips, and selected outlines; its small desktop swatches are a mild discoverability tradeoff, not a release defect.
- Shared results/detail structures preserve parity, but terminal results should retain each theme’s emotional language without changing evidence order.
- HP is delightful framing, but contextual help should explain what changes it and how checks/evidence relate.

## Questions to Consider

- Should Tactics remain a modern pixel-art observatory, become more historically authentic 16-bit, or move toward a quieter command-console balance?
- Should this pass fix every objective issue, or only release-blocking truth and compact-status defects first?
