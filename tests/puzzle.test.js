import test from 'node:test';
import assert from 'node:assert/strict';
import { makePuzzle, seededRandom, randStart, opValid, applyOp } from '../js/puzzle.js';

test('generated puzzles have a playable solution within the number bounds', () => {
  for (let seed = 0; seed < 100; seed++) {
    const rng = seededRandom(`coverage-${seed}`);
    let current = randStart(rng);
    for (let wave = 1; wave <= 20; wave++) {
      for (const boss of [false, true]) {
        const puzzle = makePuzzle(current, { wave, boss, rng });
        assert.equal(puzzle.buttons.length, 4);
        assert.notEqual(puzzle.target, current);
        assert.ok(puzzle.target >= 1 && puzzle.target <= 999);
        let value = current;
        for (const op of puzzle.solution) {
          assert.ok(puzzle.buttons.some(b => b.sym === op.sym && b.val === op.val));
          assert.ok(opValid(value, op));
          value = applyOp(value, op);
        }
        assert.equal(value, puzzle.target);
        if (boss) assert.equal(puzzle.solution.length, wave >= 8 ? 3 : 2);
        current = puzzle.target;
      }
    }
  }
});

test('a daily seed reproduces an entire puzzle sequence', () => {
  function sequence(seed) {
    const rng = seededRandom(seed);
    let current = randStart(rng);
    return Array.from({ length: 15 }, (_, i) => {
      const puzzle = makePuzzle(current, { wave: Math.floor(i / 5) + 1, rng });
      current = puzzle.target;
      return puzzle;
    });
  }
  assert.deepEqual(sequence('2026-10-24'), sequence('2026-10-24'));
  assert.notDeepEqual(sequence('2026-10-24'), sequence('2026-10-25'));
});

test('invalid operations cannot produce fractions, negatives or out-of-range values', () => {
  for (const [value, op] of [
    [5, { sym: '÷', val: 2 }], [5, { sym: '÷', val: 0 }],
    [8, { sym: '√', val: 0 }], [100, { sym: '²', val: 0 }],
    [5, { sym: '%', val: 0 }], [2, { sym: '−', val: 3 }],
    [9999, { sym: '+', val: 1 }], [4, { sym: '²', val: 0, uses: 0 }],
  ]) assert.equal(opValid(value, op), false);
  assert.equal(opValid(9, { sym: '√', val: 0 }), true);
  assert.equal(opValid(12, { sym: '÷', val: 3 }), true);
});
