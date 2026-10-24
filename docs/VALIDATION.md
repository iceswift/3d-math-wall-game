# Release validation

Validated on 2026-10-24 for the portfolio release.

- `npm run check`: syntax checks pass for the application modules.
- `npm test`: all three tests pass, including 4,000 generated puzzles across 100 seeds and 20 waves, repeatable seeded sequences and invalid operations.
- Desktop Chromium smoke check: menu, Classic start, crash/result screen, retry, pause, resume and quit to menu work. A correct operation matched the target, awarded 10 points and advanced to the next wall.
- No console errors in the final local browser check after reloading. An initial transient module request failure disappeared on reload.
- README menu and gameplay images were captured from the running game.
- Original development history is retained. The previous remote is retained locally as `previous-origin`.

Not yet covered: physical mobile devices, broad browser compatibility, accessibility conformance and performance benchmarks. These are roadmap items, not release guarantees.

## Environment gallery

On 2026-10-24, five 1440×900 screenshots were captured from the published game in Chromium: Morning, Day, Sunset, Twilight and Night. The existing `__setPhase` debug control selected each time period while gameplay was frozen at the same moment, making lighting and scenery comparable. The screenshots are unretouched renders; the game source was not changed for the capture. Each screenshot was visually checked before publication in the README.
