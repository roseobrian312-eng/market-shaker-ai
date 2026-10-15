const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/stats');

// Deterministic pseudo-random generator so the test never flakes.
function lcg(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }

test('lastDigit respects pip size', () => {
  assert.strictEqual(S.lastDigit(1234.5, 2), 0);
  assert.strictEqual(S.lastDigit(1234.57, 2), 7);
  assert.strictEqual(S.lastDigit(99.1234, 4), 4);
});

test('chi-square is 0 for perfectly uniform digits', () => {
  assert.strictEqual(S.chiSquareUniform(new Array(10).fill(50)), 0);
});

test('chi-square flags heavily biased digits', () => {
  const counts = new Array(10).fill(20); counts[7] = 200;
  assert.ok(S.chiSquareUniform(counts) > S.CHI2_CRIT_DF9_P05);
});

test('fair random digits do not trip the bias flag (seeded)', () => {
  const rnd = lcg(42);
  const ticks = Array.from({ length: 1000 }, (_, i) => ({ quote: 1000 + i, digit: Math.floor(rnd() * 10) }));
  const s = S.summarize(ticks);
  assert.strictEqual(s.n, 1000);
  assert.strictEqual(s.digitBiasFlag, false);
});

test('biased digit stream trips the bias flag', () => {
  const ticks = Array.from({ length: 500 }, (_, i) => ({ quote: 1000 + i, digit: i % 3 === 0 ? 5 : i % 10 }));
  assert.strictEqual(S.summarize(ticks).digitBiasFlag, true);
});

test('currentStreak counts consecutive moves', () => {
  assert.deepStrictEqual(S.currentStreak([1, 2, 3, 4]), { length: 3, direction: 1 });
  assert.deepStrictEqual(S.currentStreak([5, 4, 3, 4, 3, 2]), { length: 2, direction: -1 });
  assert.deepStrictEqual(S.currentStreak([1, 1]), { length: 0, direction: 0 });
});

test('latestReturnZ detects a spike', () => {
  const rnd = lcg(7);
  const prices = [100];
  for (let i = 0; i < 100; i++) prices.push(prices[i] * (1 + (rnd() - 0.5) * 0.001));
  prices.push(prices[prices.length - 1] * 1.05);
  assert.ok(S.latestReturnZ(prices) > 5);
});
