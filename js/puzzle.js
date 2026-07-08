// Puzzle generation: operators, wave-gated pools, seeded RNG.
// Pure logic — no three.js, no DOM — so it stays testable and deterministic.

export const NUM_MIN = 1;
export const NUM_MAX = 999;
const HARD_MAX = 9999; // intermediate values may briefly exceed NUM_MAX

export const OP_DEFS = {
  '+': { apply: (n, v) => n + v, label: v => `+${v}`, exotic: false },
  '−': { apply: (n, v) => n - v, label: v => `−${v}`, exotic: false },
  '×': { apply: (n, v) => n * v, label: v => `×${v}`, exotic: false },
  '÷': { apply: (n, v) => n / v, label: v => `÷${v}`, exotic: false },
  '²': { apply: n => n * n, label: () => 'x²', exotic: true },
  '√': { apply: n => Math.sqrt(n), label: () => '√', exotic: true },
  '%': { apply: (n, v) => n % v, label: v => `mod ${v}`, exotic: true },
};

export function applyOp(n, op) { return OP_DEFS[op.sym].apply(n, op.val); }
export function opLabel(op) { return OP_DEFS[op.sym].label(op.val); }
export function isExotic(op) { return OP_DEFS[op.sym].exotic; }

export function opValid(n, op) {
  if (op.uses !== undefined && op.uses <= 0) return false;
  if (op.sym === '÷' && (op.val === 0 || n % op.val !== 0)) return false;
  if (op.sym === '√' && (n < 4 || !Number.isInteger(Math.sqrt(n)))) return false;
  if (op.sym === '²' && (n < 2 || n * n > HARD_MAX)) return false;
  if (op.sym === '%' && op.val === 0) return false;
  const r = applyOp(n, op);
  return Number.isInteger(r) && r >= 0 && r <= HARD_MAX;
}

// deterministic RNG for Daily Challenge (mulberry32)
export function seededRandom(seedString) {
  let h = 1779033703 ^ seedString.length;
  for (let i = 0; i < seedString.length; i++) {
    h = Math.imul(h ^ seedString.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, a, b) { return a + Math.floor(rng() * (b - a + 1)); }
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

// operators available at a given wave (1-based)
export function poolForWave(wave) {
  const pool = ['+', '−'];
  if (wave >= 2) pool.push('×');
  if (wave >= 3) pool.push('÷');
  return pool;
}

// exotic ops that MAY appear as buttons at this wave
function exoticsForWave(wave) {
  const ex = [];
  if (wave >= 5) ex.push('²');
  if (wave >= 7) ex.push('√');
  if (wave >= 9) ex.push('%');
  return ex;
}

// Random op from the wave pool that keeps the running value sane.
function randomStepOp(rng, n, wave) {
  const difficulty = (wave - 1) * 2;
  const maxAdd = 5 + Math.min(difficulty, 15);
  const pool = poolForWave(wave);
  const candidates = [];
  if (pool.includes('+')) candidates.push({ sym: '+', val: randInt(rng, 2, maxAdd) });
  if (pool.includes('−') && n > 3) candidates.push({ sym: '−', val: randInt(rng, 1, Math.min(n - 1, maxAdd)) });
  if (pool.includes('×') && n * 2 <= NUM_MAX) {
    const maxMul = wave < 3 ? 3 : wave < 5 ? 5 : 9;
    candidates.push({ sym: '×', val: randInt(rng, 2, Math.max(2, Math.min(maxMul, Math.floor(NUM_MAX / Math.max(n, 1))))) });
  }
  if (pool.includes('÷')) {
    const divisors = [];
    for (let d = 2; d <= 9; d++) if (n % d === 0 && n / d >= NUM_MIN) divisors.push(d);
    if (divisors.length) candidates.push({ sym: '÷', val: pick(rng, divisors) });
  }
  const valid = candidates.filter(op => opValid(n, op) && applyOp(n, op) !== n && applyOp(n, op) <= NUM_MAX);
  return valid.length ? pick(rng, valid) : { sym: '+', val: 1 };
}

// A distractor button: usually a pool op, occasionally an exotic (single-use).
function distractorOp(rng, n, wave) {
  const exotics = exoticsForWave(wave);
  if (exotics.length && rng() < 0.22) {
    const sym = pick(rng, exotics);
    const op = { sym, val: sym === '%' ? randInt(rng, 2, 9) : 0, uses: 1 };
    if (opValid(n, op)) return op;
  }
  return randomStepOp(rng, n, wave);
}

/**
 * Build a puzzle for the current value.
 * opts: { wave, boss, rng }
 * Returns { target, buttons, steps } — buttons always contain a solution chain.
 */
export function makePuzzle(current, { wave = 1, boss = false, rng = Math.random } = {}) {
  const steps = boss
    ? (wave >= 8 ? 3 : 2)
    : (wave >= 4 && rng() < 0.25 ? 2 : 1);

  let chain = [{ sym: '+', val: 1 }];
  let target = current + 1;
  for (let attempt = 0; attempt < 40; attempt++) {
    const c = [];
    let n = current;
    for (let s = 0; s < steps; s++) {
      const op = randomStepOp(rng, n, wave);
      c.push(op);
      n = applyOp(n, op);
    }
    if (n >= NUM_MIN && n <= NUM_MAX && n !== current) { chain = c; target = n; break; }
  }

  const buttons = [...chain];
  let guard = 0;
  while (buttons.length < 4 && guard++ < 60) {
    const d = distractorOp(rng, current, wave);
    const dup = buttons.some(b => b.sym === d.sym && b.val === d.val);
    const solvesInstantly = steps === 1 && opValid(current, d) && applyOp(current, d) === target;
    if (!dup && !solvesInstantly) buttons.push(d);
  }
  while (buttons.length < 4) buttons.push({ sym: '+', val: buttons.length + 10 });

  for (let i = buttons.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [buttons[i], buttons[j]] = [buttons[j], buttons[i]];
  }
  return { target, buttons, steps };
}

export function randStart(rng) { return randInt(rng, 2, 12); }
