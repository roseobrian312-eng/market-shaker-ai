'use strict';
// DEVELOPMENT ONLY. Random-walk ticks used to test the pipeline when Deriv is unreachable.
// Off by default; the UI shows a loud SYNTHETIC badge when enabled. Never use for trading decisions.
const { EventEmitter } = require('node:events');

class SyntheticFeed extends EventEmitter {
  constructor() { super(); this.status = 'synthetic'; this.subs = new Map(); }
  connect() { this.emit('status', 'synthetic'); }
  subscribeTicks(symbol) {
    if (this.subs.has(symbol)) return;
    let price = 1000 + Math.random() * 100;
    this.subs.set(symbol, setInterval(() => {
      price *= 1 + (Math.random() - 0.5) * 0.002;
      this.emit('tick', { symbol, quote: Number(price.toFixed(2)), epoch: Math.floor(Date.now() / 1000), pip: 2 });
    }, 1000));
  }
  async request() { return { active_symbols: [] }; }
}
module.exports = { SyntheticFeed };
