'use strict';
// Public Deriv market-data WebSocket. No trading credentials are used here.
const { EventEmitter } = require('node:events');
const DEFAULT_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
class DerivClient extends EventEmitter {
  constructor({ appId = '', url = DEFAULT_URL, WebSocketImpl = WebSocket } = {}) {
    super();
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.ws = null;
    this.subs = new Set();
    this.ids = new Map();
    this.reqId = 0;
    this.pending = new Map();
    this.backoff = 1000;
    this.status = 'disconnected';
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.outboxTimer = null;
    this.connectTimer = null;
    this.outbox = [];
  }
  _setStatus(status) { this.status = status; this.emit('status', status); }
  _error(message) { console.error('[Deriv public]', message); this.emit('error-msg', message); }
  _queueSubscription(symbol) {
    if (!this.subs.has(symbol)) return;
    if (!this.outbox.includes(symbol) && !this.ids.has(symbol)) this.outbox.push(symbol);
    this._flushSoon();
  }
  _flushSoon() {
    if (this.outboxTimer || !this.ws || this.ws.readyState !== 1) return;
    this.outboxTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) { clearInterval(this.outboxTimer); this.outboxTimer = null; return; }
      const symbol = this.outbox.shift();
      if (symbol && this.subs.has(symbol) && !this.ids.has(symbol)) this._send({ticks: symbol, subscribe: 1});
      if (!this.outbox.length) { clearInterval(this.outboxTimer); this.outboxTimer = null; }
    }, 150);
    this.outboxTimer.unref?.();
  }
  connect() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this._setStatus('connecting');
    let ws;
    try { ws = new this.WebSocketImpl(this.url); }
    catch (error) { this._error(error.message); this._setStatus('disconnected'); this._reconnect(); return; }
    this.ws = ws;
    this.connectTimer = setTimeout(() => { if (this.ws === ws && ws.readyState === 0) ws.close(); }, 16000);
    ws.addEventListener('open', () => {
      if (ws !== this.ws) return;
      clearTimeout(this.connectTimer);
      this.backoff = 1000;
      this.ids.clear(); this.outbox = [];
      this._setStatus('connected');
      this.pingTimer = setInterval(() => this._send({ping: 1}), 30000);
      this.pingTimer.unref?.();
      for (const symbol of this.subs) this._queueSubscription(symbol);
    });
    ws.addEventListener('message', event => {
      if (this.ws !== ws) return;
      try { this._onMessage(JSON.parse(event.data)); }
      catch (error) { this._error(`Invalid market response: ${error.message}`); }
    });
    ws.addEventListener('error', event => {
      if (this.ws !== ws) return;
      this._error(`WebSocket error: ${event.error?.cause?.message || event.error?.message || event.message || 'network/handshake error'}`);
    });
    ws.addEventListener('close', event => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearTimeout(this.connectTimer); clearInterval(this.pingTimer); clearInterval(this.outboxTimer);
      this.outboxTimer = null;
      this.ids.clear(); this.outbox = [];
      for (const [id,p] of this.pending) {
        clearTimeout(p.t); p.reject(new Error('Public market connection closed'));
        this.pending.delete(id);
      }
      this._setStatus('disconnected');
      this._error(`Market WebSocket closed ${event.code || ''} ${event.reason || ''}`.trim());
      this._reconnect();
    });
  }
  _reconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, this.backoff);
    this.reconnectTimer.unref?.();
    this.backoff = Math.min(this.backoff * 2, 30000);
  }
  _send(payload) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(payload)); }
  request(payload) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('Public Deriv feed is not connected'));
    return new Promise((resolve,reject) => {
      const req_id = ++this.reqId;
      const t = setTimeout(() => { this.pending.delete(req_id); reject(new Error('Deriv public request timed out')); }, 12000);
      this.pending.set(req_id, {resolve,reject,t});
      try { this._send({...payload,req_id}); }
      catch(error) { clearTimeout(t); this.pending.delete(req_id); reject(error); }
    });
  }
  subscribeTicks(symbol) {
    if (!symbol || this.subs.has(symbol)) return;
    this.subs.add(symbol);
    this._queueSubscription(symbol);
  }
  unsubscribeTicks(symbol) {
    if (!this.subs.has(symbol)) return;
    this.subs.delete(symbol);
    this.outbox = this.outbox.filter(x => x !== symbol);
    const id = this.ids.get(symbol);
    this.ids.delete(symbol);
    if (id) this._send({forget:id});
  }
  _onMessage(msg) {
    // Some server streaming updates carry req_id. Resolve the original request once only.
    const p = msg.req_id && this.pending.get(msg.req_id);
    if (p) {
      clearTimeout(p.t); this.pending.delete(msg.req_id);
      if (msg.error) p.reject(new Error(msg.error.message || 'API error'));
      else p.resolve(msg);
      if (msg.msg_type !== 'tick') return;
    }
    if (msg.error) { this._error(msg.error.message || 'Market data API error'); return; }
    if (msg.msg_type === 'tick' && msg.tick) {
      const t = msg.tick;
      if (msg.subscription?.id && this.subs.has(t.symbol)) this.ids.set(t.symbol, msg.subscription.id);
      this.emit('tick',{symbol:t.symbol,quote:t.quote,epoch:t.epoch,pip:t.pip_size});
    }
  }
}
module.exports = {DerivClient};
