# Design references

Source-of-truth design material for the Warehouse client and protocol. Open the `.html` mocks directly in a browser. They are self-contained static files; Tailwind loads from a CDN.

| Doc | What it is |
|---|---|
| [mock-v4.html](mock-v4.html) | **The UI target.** Interactive single-file mock: isometric floor, floating collapsible HUDs, and the sim core the server is ported from. |
| [ui-parity-plan.md](ui-parity-plan.md) | Approved plan (2026-10-16) to bring the live client up to mock v4. |
| [contracts.md](contracts.md) | Interface contracts between server/protocol, renderer and client UI, including the as-built field shapes. |
| [gap-analysis.md](gap-analysis.md) | Line-by-line comparison of mock v4 and the pre-rewrite client (baseline commit `0087fd2`). |
| [img/](img/) | Screenshots: the mock, and the live client before the rewrite. |

### Decisions recorded
- Isometric 2.5D Canvas2D renderer ported from the mock; pixi.js removed.
- The mock's slate palette and frosted-glass HUDs, used exactly. (The sepia preference does not apply to this repo.)
- Full-bleed canvas with collapsible floating panels and a slide-out right drawer. Panel state persists per browser.
- No speed buttons and no "Reset world", because the floor is shared and server-authoritative. Difficulty stays a vote.
- Strict no-fake-data rule: show "—" or real errors until real data arrives.

### history/
Earlier design rounds, kept for context:
- [implementation-plan-rev3.md](history/implementation-plan-rev3.md): the original build plan.
- [design-review-and-revised-premise.md](history/design-review-and-revised-premise.md)
- [architecture-and-ui-design.md](history/architecture-and-ui-design.md)
- [style-guide-and-sprite-spec.md](history/style-guide-and-sprite-spec.md)
- [design-addendum-persistence-multiplayer.md](history/design-addendum-persistence-multiplayer.md)
- [mock-v1-25d.html](history/mock-v1-25d.html): the first 2.5D mock.
