'use strict';
// Real Deriv WebSocket client (uses Node 22's built-in WebSocket).
const { EventEmitter } = require('node:events');

class DerivClient extends EventEmitter {
  constructor({ appId = '1089', url } = {}) {
    super();
    this.url = url || `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;
    this.ws = null;
    this.subs = new Set();
    this.reqId = 0;
    this.pending = new Map();
    this.backoff = 1000;
    this.status = 'disconnected';
    this.pingTimer = null;
  }

  connect() {
    this._setStatus('connecting');
    let ws;
    try { ws = new WebSocket(this.url); }
    catch (error) { this.emit('error-msg', error.message); this._setStatus('disconnected'); setTimeout(() => this.connect(), this.backoff); return; }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.backoff = 1000;
      this._setStatus('connected');
      this.pingTimer = setInterval(() => this._send({ ping: 1 }), 30000);
      for (const s of this.subs) this._send({ ticks: s, subscribe: 1 });
    });
    ws.addEventListener('message', (ev) => {
      try { this._onMessage(JSON.parse(ev.data)); }
      catch (error) { this.emit('error-msg', `Invalid market response: ${error.message}`); }
    });
    ws.addEventListener('error', () => this.emit('error-msg', 'WebSocket error'));
    ws.addEventListener('close', () => {
      clearInterval(this.pingTimer);
      this._setStatus('disconnected');
      for (const [id, p] of this.pending) { clearTimeout(p.t); p.reject(new Error('Connection closed')); this.pending.delete(id); }
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    });
  }

  _setStatus(s) { this.status = s; this.emit('status', s); }
  _send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  request(obj) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('Deriv is not connected'));
    return new Promise((resolve, reject) => {
      const req_id = ++this.reqId;
      const t = setTimeout(() => { this.pending.delete(req_id); reject(new Error('timeout')); }, 15000);
      this.pending.set(req_id, { resolve, reject, t });
      this._send({ ...obj, req_id });
    });
  }

  subscribeTicks(symbol) {
    if (this.subs.has(symbol)) return;
    this.subs.add(symbol);
    this._send({ ticks: symbol, subscribe: 1 });
  }

  _onMessage(msg) {
    if (msg.req_id && this.pending.has(msg.req_id)) {
      const p = this.pending.get(msg.req_id);
      clearTimeout(p.t); this.pending.delete(msg.req_id);
      return msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg);
    }
    if (msg.error) return this.emit('error-msg', msg.error.message);
    if (msg.msg_type === 'tick' && msg.tick) {
      const t = msg.tick;
      this.emit('tick', { symbol: t.symbol, quote: t.quote, epoch: t.epoch, pip: t.pip_size });
    }
  }
}

module.exports = { DerivClient };
