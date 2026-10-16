'use strict';
// An experimental rules-based indicator, NOT an ML model or demonstrated predictive edge.
const TYPES = Object.freeze({
  DIGITOVER: { label: 'Over 1', barrier: '1', accept: d => d > 1, theoretical: 0.8 },
  DIGITUNDER: { label: 'Under 8', barrier: '8', accept: d => d < 8, theoretical: 0.8 },
  DIGITDIFF: { label: 'Differs 5', barrier: '5', accept: d => d !== 5, theoretical: 0.9 },
  DIGITMATCH: { label: 'Matches 5', barrier: '5', accept: d => d === 5, theoretical: 0.1 },
});
function evaluate(digits) {
  const window = digits.slice(-200).filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
  return Object.entries(TYPES).map(([type, rule]) => {
    const wins = window.filter(rule.accept).length;
    const rate = window.length ? wins / window.length : 0;
    return { type, label: rule.label, barrier: rule.barrier, n: window.length,
      observedPct: +(100 * rate).toFixed(1), theoreticalPct: +(100 * rule.theoretical).toFixed(1),
      deviation: +(rate - rule.theoretical).toFixed(3) };
  }).sort((a, b) => b.deviation - a.deviation);
}
// Deliberately conservative: historical concentration does NOT imply forward prediction.
function demoCandidate(digits, minimumSample = 200, minimumDeviation = 0.07) {
  const rankings = evaluate(digits);
  const best = rankings.find(x => ['DIGITOVER', 'DIGITUNDER', 'DIGITDIFF'].includes(x.type) && x.n >= minimumSample && x.deviation >= minimumDeviation);
  return best || null;
}
module.exports = { TYPES, evaluate, demoCandidate };
