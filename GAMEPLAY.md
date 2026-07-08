# 3D Math Wall — Gameplay System Design

The core fantasy stays untouched: **transform the number before the wall arrives.**
Everything below adds structure, tension, and variety around that single idea.

## Run structure: Waves

- A run is divided into **waves of 5 walls**.
- Wave start shows a banner ("WAVE 3") with a short breather (~2.5s).
- Difficulty scales per **wave**, not per wall: wall speed rises and solve time
  shrinks each wave (8s at wave 1 → floor of 4.5s), so each wave has a stable
  rhythm and the jump between waves is felt.
- **Wall 5 of every wave is a Boss Wall:**
  - Reinforced look (darker slab, gold target glow).
  - Requires a 2-step solution (3-step from wave 8).
  - Extra solve time, but **does not shatter** on failure — it knocks the
    number back hard and rolls on. Failing still costs a heart.
  - Worth 2.5× base points.

## Scoring

| Event | Points |
|---|---|
| Wall passed | 10 × combo multiplier |
| Boss wall passed | 25 × combo multiplier |
| Perfect timing | +15 bonus (see below) |

- **Combo:** +1 per consecutive pass, multiplier = 1 + (combo−1) × 0.5. Reset on crash.
- **Perfect timing:** if the press that completes the match happens in the
  **last 30% of the wall's approach**, it's a PERFECT — bonus points and a
  distinct popup/sound. This makes waiting deliberately a risk/reward choice.

## Operation variety

Operators unlock by wave, so the math vocabulary grows during a run:

| Wave | Pool |
|---|---|
| 1 | + − |
| 2 | + − × |
| 3 | + − × ÷ |
| 5+ | x² may appear |
| 7+ | √ may appear (only when the value is a perfect square) |
| 9+ | mod may appear |

- **Exotic operators (x², √, mod) are single-use per wall** — they glow gold
  and grey out after one press. They act as powerful limited-use shortcuts.
- Two-step (non-boss) puzzles start appearing at wave 4 (~25% chance).
- All puzzles remain integer-only and within 0–9999; division buttons disable
  when the value isn't divisible.

## Modes

- **Classic** — 3 hearts, endless waves, difficulty ramps forever. The default.
- **Time Attack** — 60 seconds, no hearts. A crash costs 6 seconds instead.
  Highest score when the clock hits zero wins.
- **Daily Challenge** — a 15-wall gauntlet seeded from today's date: everyone
  gets the same starting number and puzzle sequence. 3 hearts. Best score per
  day is stored locally (leaderboards later).

Best scores per mode persist in localStorage.

## Code layout

| File | Owns |
|---|---|
| `main.js` | scene, player character, game state machine, UI wiring, loop |
| `js/puzzle.js` | operator defs, wave pools, puzzle generator, seeded RNG |
| `js/wall.js` | wall building (glyph cutout), match glow, disposal |
| `js/fx.js` | particle bursts, wall-shatter debris |
| `js/audio.js` | WebAudio synth sound effects |
| `js/text3d.js` | font loading, shared glyph sizing, 3D number geometry |

## Deferred (deliberately)

- Global/online leaderboards — needs a backend; tune the game first.
- Operation cards as collectible inventory — the single-use exotic ops cover
  the "limited resource" feel with far less UI; revisit if runs feel samey.
- Boss stages with unique mechanics beyond reinforced walls.
