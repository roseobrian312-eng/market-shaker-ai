'use strict';
// Deriv market discovery and rotating live monitor. Trading decisions are research heuristics.
// Every active symbol is exposed to the UI; only symbols delivering tick data can be ranked.
const { EventEmitter } = require('node:events');
const { evaluate } = require('./decision');

const FALLBACK = [
  ['R_10','Volatility 10 Index'],['R_25','Volatility 25 Index'],
  ['R_50','Volatility 50 Index'],['R_75','Volatility 75 Index'],
  ['R_100','Volatility 100 Index'],['1HZ10V','Volatility 10 (1s) Index'],
  ['1HZ100V','Volatility 100 (1s) Index'],
];
const DEFAULT_MAX_LIVE = 24; // memory, network and CPU budget for Render Free
const MAX_HISTORY = 600;
const MIN_SAMPLE = 30;
const MAX_AGE_MS = 90000;

function parseActiveSymbols(response) {
  const arr = response?.active_symbols;
  if (!Array.isArray(arr)) throw new Error('Deriv did not return active_symbols');
  const found = new Map();
  for (const item of arr) {
    const id = String(item.symbol || item.underlying_symbol || '').trim();
    if (!/^[A-Za-z0-9_]{2,48}$/.test(id)) continue;
    if (item.is_trading_suspended === 1 || item.is_trading_suspended === true) continue;
    found.set(id, {id, name: String(item.display_name || item.name || id),
      market: String(item.market || item.market_display_name || 'Other'),
      submarket: String(item.submarket || ''),
      active: item.exchange_is_open !== 0 && item.exchange_is_open !== false });
  }
  const priority = x => /synthetic|derived/i.test(x.market) || /volatility|step|jump|boom|crash|range break/i.test(x.name) ? 0 : 1;
  return [...found.values()].sort((a,b) => priority(a)-priority(b) || a.name.localeCompare(b.name));
}
function safeTradeScore(sample, rule) {
  // Shrink small samples toward the fair digit baseline; no prediction is implied.
  const w = 60;
  const adjusted = (sample.observedPct / 100 * sample.n + rule * w) / (sample.n + w);
  const z = (sample.observedPct / 100 - rule) / Math.sqrt(rule * (1-rule) / Math.max(sample.n,1));
  return { adjusted, z, score: adjusted - rule };
}

class MarketScanner extends EventEmitter {
  constructor({ feed, maxLive = DEFAULT_MAX_LIVE, rotateMs = 100000 } = {}) {
    super();
    this.feed = feed;
    this.symbols = FALLBACK.map(([id,name]) => ({id,name,market:'Synthetic',active:true}));
    this.byId = new Map(this.symbols.map(s => [s.id, s]));
    this.history = new Map();
    this.latest = new Map();
    this.active = false;
    this.loading = false;
    this.message = 'Press Scan all markets to start live market comparisons.';
    this.maxLive = maxLive;
    this.rotateMs = rotateMs;
    this.round = 0;
    this.nextBatch = 0;
    this.current = new Set();
    this.chart = 'R_100';
    this.timer = null;
    this.fetching = null;
    this.lastRefreshed = 0;
    this.lastScan = 0;
    this.blocked = new Map(); // rejected contract types, not markets for general viewing
  }
  async discover(force = false) {
    if (this.fetching) return this.fetching;
    if (!force && this.lastRefreshed && Date.now() - this.lastRefreshed < 15 * 60 * 1000) return this.symbols;
    this.fetching = (async () => {
      const response = await this.feed.request({ active_symbols: 'brief' });
      const items = parseActiveSymbols(response);
      if (!items.length) throw new Error('Deriv returned an empty market list');
      this.symbols = items;
      this.byId = new Map(items.map(s => [s.id,s]));
      this.lastRefreshed = Date.now();
      this.emit('change');
      return items;
    })().finally(() => { this.fetching = null; });
    return this.fetching;
  }
  getSymbols() { return this.symbols; }
  hasSymbol(id) { return this.byId.has(id); }
  setChart(id) {
    if (!this.hasSymbol(id)) return false;
    this.chart = id;
    this.feed.subscribeTicks(id);
    return true;
  }
  async start() {
    if (this.active) return this.state();
    this.loading = true;
    this.message = 'Discovering active Deriv markets…';
    this.emit('change');
    try {
      await this.discover(true);
      this.active = true;
      this.round = 0;
      this.nextBatch = 0;
      this._rotate();
      this.timer = setInterval(() => this._rotate(), this.rotateMs);
      return this.state();
    } catch (err) {
      this.message = `Market discovery unavailable: ${err.message}`;
      this.emit('change');
      throw err;
    } finally {
      this.loading = false;
      this.emit('change');
    }
  }
  stop() {
    this.active = false;
    clearInterval(this.timer); this.timer = null;
    for (const id of this.current) if (id !== this.chart) this.feed.unsubscribeTicks?.(id);
    this.current.clear();
    this.message = 'Scanner stopped. The selected chart may continue updating.';
    this.emit('change');
  }
  _rotate() {
    if (!this.active) return;
    const all = this.symbols.filter(s => s.active).map(s => s.id);
    if (!all.length) { this.message = 'No open symbols reported by Deriv'; return; }
    const next = new Set();
    let inspected = 0;
    while (next.size < Math.min(this.maxLive, all.length) && inspected < all.length) {
      const id = all[(this.nextBatch + inspected) % all.length];
      inspected++;
      next.add(id);
    }
    this.nextBatch = (this.nextBatch + inspected) % all.length;
    for (const old of this.current) if (!next.has(old) && old !== this.chart) this.feed.unsubscribeTicks?.(old);
    for (const id of next) if (!this.current.has(id)) this.feed.subscribeTicks(id);
    this.current = next;
    this.round++;
    this.lastScan = Date.now();
    this.message = all.length > this.maxLive
      ? `Rotating scan: ${next.size} live feeds per round across ${all.length} active markets. Round ${this.round}.`
      : `Scanning ${next.size} active Deriv markets. Digit-compatible contracts checked before ordering.`;
    this.emit('change');
  }
  onTick(tick) {
    if (!this.hasSymbol(tick.symbol)) return;
    const arr = this.history.get(tick.symbol) || [];
    if (Number.isInteger(tick.digit) && tick.digit >= 0 && tick.digit <= 9) {
      arr.push(tick.digit);
      if (arr.length > MAX_HISTORY) arr.shift();
      this.history.set(tick.symbol, arr);
      this.latest.set(tick.symbol, Date.now());
    }
  }
  blockContract(id, type, reason = '') {
    this.blocked.set(`${id}|${type}`, { at: Date.now(), reason });
  }
  // A blocked contract is rechecked when the list changes / after 30 minutes.
  allowsContract(id, type) {
    const rec = this.blocked.get(`${id}|${type}`);
    return !rec || Date.now() - rec.at > 30 * 60 * 1000;
  }
  rankings(limit = 12) {
    const found = [];
    for (const [id, digits] of this.history) {
      if (digits.length < MIN_SAMPLE || !this.hasSymbol(id)) continue;
      if (Date.now() - (this.latest.get(id) || 0) > MAX_AGE_MS) continue;
      const recent = digits.slice(-100);
      const estimates = evaluate(recent);
      const name = this.byId.get(id)?.name || id;
      for (const estimate of estimates) {
        if (!this.allowsContract(id, estimate.type)) continue;
        const baseline = estimate.theoreticalPct / 100;
        const score = safeTradeScore(estimate, baseline);
        found.push({ symbol: id, name, type: estimate.type, label: estimate.label,
          barrier: estimate.barrier, sample: estimate.n, observedPct: estimate.observedPct,
          baselinePct: estimate.theoreticalPct, adjustedPct: +(score.adjusted*100).toFixed(1),
          deviationPct: +(score.score*100).toFixed(2), z: +score.z.toFixed(2),
          ageSeconds: Math.round((Date.now()-(this.latest.get(id)||0))/1000) });
      }
    }
    // Deviations are diagnostics only, not evidence of a profitable market.
    found.sort((a,b) => b.deviationPct-a.deviationPct || b.sample-a.sample);
    return found.slice(0, limit);
  }
  state() {
    return {
      active: this.active, loading: this.loading, message: this.message,
      discovered: this.symbols.length, watching: this.current.size, round: this.round,
      warmed: [...this.history.entries()].filter(([id,x]) => x.length >= MIN_SAMPLE && Date.now()-(this.latest.get(id)||0)<MAX_AGE_MS).length,
      nextRotationSeconds: this.active ? Math.max(0, Math.round((this.lastScan + this.rotateMs - Date.now())/1000)) : null,
      rankings: this.rankings(), minimumTicks: MIN_SAMPLE,
      disclosure: 'Research ranking uses past ticks, not validated predictive AI. All open Deriv markets are discovered; active feeds rotate to respect resource limits. Unsupported digit contracts cannot be traded.'
    };
  }
}
module.exports = { MarketScanner, parseActiveSymbols, safeTradeScore, MIN_SAMPLE };
