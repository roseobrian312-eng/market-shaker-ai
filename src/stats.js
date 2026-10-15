'use strict';
// Pure statistics functions: no network, fully unit-tested.

const CHI2_CRIT_DF9_P05 = 16.919; // chi-square critical value, 10 digits, 5% level

function lastDigit(quote, pipSize) {
  const s = Number(quote).toFixed(pipSize);
  return Number(s[s.length - 1]);
}

function digitCounts(digits) {
  const counts = new Array(10).fill(0);
  for (const d of digits) counts[d]++;
  return counts;
}

// Goodness-of-fit against a uniform distribution of last digits.
function chiSquareUniform(counts) {
  const n = counts.reduce((a, b) => a + b, 0);
  if (n === 0) return 0;
  const expected = n / counts.length;
  return counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
}

function logReturns(prices) {
  const r = [];
  for (let i = 1; i < prices.length; i++) r.push(Math.log(prices[i] / prices[i - 1]));
  return r;
}

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

// How unusual is the latest return versus the recent window?
function latestReturnZ(prices, window = 100) {
  const r = logReturns(prices.slice(-(window + 1)));
  if (r.length < 10) return 0;
  const sd = stdev(r.slice(0, -1));
  return sd === 0 ? 0 : (r[r.length - 1] - mean(r.slice(0, -1))) / sd;
}

// Length and direction of the current run of consecutive up/down ticks.
function currentStreak(prices) {
  let len = 0, dir = 0;
  for (let i = prices.length - 1; i > 0; i--) {
    const d = Math.sign(prices[i] - prices[i - 1]);
    if (d === 0) break;
    if (len === 0) dir = d;
    if (d !== dir) break;
    len++;
  }
  return { length: len, direction: dir };
}

function summarize(ticks) {
  const prices = ticks.map(t => t.quote);
  const digits = ticks.map(t => t.digit);
  const counts = digitCounts(digits);
  const chi2 = chiSquareUniform(counts);
  return {
    n: ticks.length,
    digitCounts: counts,
    chi2,
    chi2Critical: CHI2_CRIT_DF9_P05,
    digitBiasFlag: ticks.length >= 200 && chi2 > CHI2_CRIT_DF9_P05,
    returnZ: latestReturnZ(prices),
    streak: currentStreak(prices),
  };
}

module.exports = {
  CHI2_CRIT_DF9_P05, lastDigit, digitCounts, chiSquareUniform,
  logReturns, mean, stdev, latestReturnZ, currentStreak, summarize,
};
