# 3D Math Wall

**Transform the number before the wall arrives.**

A fast-paced 3D arithmetic action-puzzle game inspired by the "hole in the wall"
TV show — except your character is a number, and the hole is the shape of the
answer. Apply arithmetic operations to transform your number into the target
before the wall hits you. Correct answers fly through their own silhouette;
wrong answers bounce off and shatter the wall.

## Play

- **1–4 keys** or tap the operation buttons
- **Esc / P** — pause
- Hole glows **green** when your number matches — you're safe
- Match in the final moments for a **PERFECT** bonus

**Modes:** Classic (3 hearts, endless waves) · Time Attack (60s, crashes cost
time) · Daily Challenge (same seeded 15-wall gauntlet for everyone, every day)

New operators unlock as waves progress (×, ÷, then single-use x², √, mod), and
every 5th wall is a reinforced boss requiring multi-step solutions.

## Run locally

Any static file server works — no build step:

```
npx http-server -p 5173 -c-1 .
```

Then open http://localhost:5173. Everything is vendored (`lib/`), no internet needed.

## Deploy

It's a fully static site: host the repo root on GitHub Pages, itch.io
(upload as HTML game), Netlify, or any static host.

## Code layout

See [GAMEPLAY.md](GAMEPLAY.md) for the gameplay system design and module layout.
