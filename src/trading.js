'use strict';
// DEMO ONLY: independent authenticated channel. Tokens never travel to browser.
const { EventEmitter } = require('node:events');
const { TYPES, evaluate, demoCandidate } = require('./decision');
const REST = 'https://api.derivws.com';
const WS_DEMO = 'wss://api.derivws.com/trading/v1/options/ws/demo';
const ACCOUNT_PATH = '/trading/v1/options/accounts';

function demoAccount(a) {
  const id = String(a.account_id || a.accountId || a.loginid || a.id || '');
  const t = String(a.account_type || a.accountType || a.type || a.environment || '').toLowerCase();
  if (t === 'real' || t === 'live' || a.is_virtual === 0 || a.is_virtual === false) return false;
  if (t === 'demo' || t === 'virtual' || a.is_virtual === 1 || a.is_virtual === true) return true;
  return /^DOT\d+/i.test(id);
}
function flattenAccounts(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    if (Array.isArray(data.accounts)) return data.accounts;
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.data)) return data.data;
    if (data.account_id || data.id) return [data];
  }
  return [];
}
const number = (v, fallback = NaN) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
const today = () => new Date().toISOString().slice(0, 10);

class DemoTrader extends EventEmitter {
  constructor({ token, appId, accountId = '', fetchImpl = fetch, WebSocketImpl = WebSocket } = {}) {
    super();
    this.token = token || '';
    this.appId = appId || '';
    this.accountPreference = accountId;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.ws = null;
    this.status = 'not-configured';
    this.error = null;
    this.accountId = null;
    this.currency = 'USD';
    this.balance = null;
    this.pending = new Map();
    this.reqId = 0;
    this.open = new Map();
    this.history = [];
    this.inFlight = false;
    this.uncertain = false;
    this.tradesToday = 0;
    this.pnlToday = 0;
    this.sessionDay = today();
    this.lastTradeAt = 0;
    this.auto = false;
    this.autoBusy = false;
    this.autoSymbol = 'R_100';
    this.settings = { stake: 1, maxStake: 5, lossLimit: 10, maxOpen: 1, cooldown: 15, maxTrades: 20, duration: 1 };
    this.lastAutoCheck = 0;
    this.connectedOnce = false;
    this.connecting = null;
    this.balanceTimer = null;
  }
  configured() { return Boolean(this.token && this.appId); }
  _status(status, error = null) {
    this.status = status;
    this.error = error;
    if (status !== 'connected') this.auto = false;
    this.emit('change');
  }
  _resetDay() {
    if (today() !== this.sessionDay) {
      this.sessionDay = today(); this.tradesToday = 0; this.pnlToday = 0;
      this.emit('change');
    }
  }
  _fail(reason) {
    const error = reason instanceof Error ? reason.message : String(reason);
    this._status('error', error);
    return new Error(error);
  }
  async _rest(path, options = {}) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 12000);
    try {
      const response = await this.fetchImpl(REST + path, {
        method: options.method || 'GET',
        signal: abort.signal,
        headers: { Authorization: `Bearer ${this.token}`, 'Deriv-App-ID': this.appId },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(`Deriv HTTP ${response.status}: ${data.errors?.[0]?.message || 'request failed'}`);
      return data.data;
    } finally { clearTimeout(timer); }
  }
  async connect() {
    if (this.status === 'connected') return;
    if (this.connecting) return this.connecting;
    this.connecting = this._connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async _connect() {
    if (!this.configured()) return this._status('not-configured', 'Configure DERIV_PAT and DERIV_APP_ID in Render');
    this._status('connecting');
    try {
      const accounts = flattenAccounts(await this._rest(ACCOUNT_PATH));
      const valid = accounts.filter(demoAccount);
      const a = this.accountPreference
        ? valid.find(x => String(x.account_id || x.accountId || x.loginid || x.id) === this.accountPreference)
        : valid[0];
      if (!a) throw new Error('No verified demo Options account found. Check PAT and DERIV_DEMO_ACCOUNT_ID. Real accounts are forbidden.');
      this.accountId = String(a.account_id || a.accountId || a.loginid || a.id);
      this.currency = String(a.currency || 'USD');
      const reply = await this._rest(`${ACCOUNT_PATH}/${encodeURIComponent(this.accountId)}/otp`, { method: 'POST' });
      const wsUrl = reply?.url;
      if (typeof wsUrl !== 'string' || !wsUrl.startsWith(WS_DEMO + '?') || !new URL(wsUrl).searchParams.has('otp')) {
        throw new Error('Deriv did not return a verified demo websocket URL; refusing connection');
      }
      await this._openSocket(wsUrl);
      this._status('connected');
      try {
        await this.request({ balance: 1 });
      } catch (e) { this.error = `Balance: ${e.message}`; }
      this.connectedOnce = true;
      clearInterval(this.balanceTimer);
      this.balanceTimer = setInterval(() => {
        if (this.status === 'connected') this.request({ balance: 1 }).catch(() => {});
      }, 30000);
      this.emit('change');
    } catch (err) {
      this._fail(err);
      throw err;
    }
  }
  _openSocket(url) {
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(url);
      this.ws = ws;
      let finished = false;
      const timer = setTimeout(() => { if (!finished) { finished = true; reject(new Error('Demo trading socket timed out')); ws.close(); } }, 14000);
      ws.addEventListener('open', () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.pingTimer = setInterval(() => this._send({ ping: 1 }), 30000);
        resolve();
      });
      ws.addEventListener('message', event => {
        try { this._onMessage(JSON.parse(event.data)); }
        catch (e) { this.error = 'Trading response parsing failed'; this.emit('change'); }
      });
      ws.addEventListener('error', event => {
        const message = event.error?.cause?.message || event.error?.message || 'WebSocket transport error';
        if (!finished) { finished = true; clearTimeout(timer); reject(new Error(message)); }
        else { this.error = 'Trading websocket transport error'; this.emit('change'); }
      });
      ws.addEventListener('close', () => {
        clearTimeout(timer);
        clearInterval(this.pingTimer);
        clearInterval(this.balanceTimer);
        if (!finished) { finished = true; reject(new Error('Trading socket closed before connecting')); }
        if (this.inFlight || this.open.size) this.uncertain = true;
        for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Trading socket closed; order status might be unknown')); this.pending.delete(id); }
        this._status('disconnected', 'Trading socket closed. Auto mode stopped. Reconcile open contracts on Deriv before reconnecting.');
      });
    });
  }
  _send(payload) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error('Demo trading connection is offline');
    this.ws.send(JSON.stringify(payload));
  }
  request(payload, timeout = 14000) {
    if (this.status !== 'connected') return Promise.reject(new Error('Demo account not connected'));
    return new Promise((resolve, reject) => {
      const id = ++this.reqId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Deriv request timed out; check Deriv before retrying a buy')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this._send({ ...payload, req_id: id }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  _onMessage(msg) {
    if (msg.req_id && this.pending.has(msg.req_id)) {
      const p = this.pending.get(msg.req_id);
      this.pending.delete(msg.req_id);
      clearTimeout(p.timer);
      msg.error ? p.reject(new Error(msg.error.message || 'Deriv API error')) : p.resolve(msg);
    }
    if (msg.error) { this.error = msg.error.message || 'Deriv request failed'; this.emit('change'); return; }
    if (msg.msg_type === 'balance' && msg.balance) {
      this.balance = number(msg.balance.balance, this.balance);
      this.emit('change');
    }
    if (msg.msg_type === 'proposal_open_contract' && msg.proposal_open_contract) {
      this._applyContract(msg.proposal_open_contract);
    }
  }
  _applyContract(contract) {
    const id = String(contract.contract_id || '');
    const rec = this.open.get(id);
    if (!rec) return;
    const status = String(contract.status || '').toLowerCase();
    const sold = contract.is_sold === 1 || contract.is_sold === true || ['won','lost','sold'].includes(status);
    if (sold) {
      rec.status = status || 'settled';
      rec.profit = number(contract.profit, number(contract.sell_price, 0) - rec.buyPrice);
      rec.closedAt = Date.now();
      this.pnlToday += rec.profit;
      this.open.delete(id);
      this._resetDay();
      if (this.pnlToday <= -this.settings.lossLimit) this.auto = false;
    }
    this.emit('change');
  }
  exposure() { return [...this.open.values()].reduce((sum, x) => sum + x.buyPrice, 0) + (this.inFlight ? this.settings.stake : 0); }
  _validate(type, symbol, stake) {
    this._resetDay();
    if (this.status !== 'connected') throw new Error('Demo account not connected');
    if (this.uncertain) throw new Error('Uncertain trade status after network interruption. Check Deriv before continuing.');
    if (!TYPES[type]) throw new Error('Unsupported strategy');
    if (!['R_10','R_25','R_50','R_75','R_100','1HZ10V','1HZ100V'].includes(symbol)) throw new Error('Unsupported symbol');
    if (!Number.isFinite(stake) || stake < 0.35 || stake > this.settings.maxStake) throw new Error(`Stake must be between $0.35 and $${this.settings.maxStake}`);
    if (this.inFlight) throw new Error('Wait for the current order');
    if (this.open.size >= this.settings.maxOpen) throw new Error('Maximum open trades reached');
    if (this.tradesToday >= this.settings.maxTrades) throw new Error('Session trade cap reached');
    if (Date.now() - this.lastTradeAt < this.settings.cooldown * 1000) throw new Error('Trade cooldown active');
    if (this.pnlToday - this.exposure() - stake < -this.settings.lossLimit) throw new Error('Session loss cap would be exceeded');
  }
  async place({ type, symbol, stake, source = 'manual' }) {
    const amount = Number(stake);
    this._validate(type, symbol, amount);
    this.inFlight = true;
    this.emit('change');
    let buyAttempted = false;
    let buyConfirmed = false;
    try {
      const choice = TYPES[type];
      const offer = await this.request({ proposal: 1, amount, basis: 'stake', contract_type: type, currency: this.currency,
        duration: this.settings.duration, duration_unit: 't', underlying_symbol: symbol, barrier: choice.barrier });
      const proposal = offer.proposal;
      const ask = number(proposal?.ask_price);
      if (!proposal?.id || !Number.isFinite(ask) || ask <= 0 || ask > amount) {
        throw new Error('Deriv quote was invalid or exceeded selected stake. No trade placed.');
      }
      // If no buy response is received, do not assume failure or retry.
      buyAttempted = true;
      const bought = await this.request({ buy: proposal.id, price: amount });
      buyConfirmed = true;
      if (!bought.buy?.contract_id) { this.uncertain = true; this.auto = false; throw new Error('Deriv buy acknowledgement lacked a contract ID. Verify trades on Deriv.'); }
      const id = String(bought.buy.contract_id);
      const buyPrice = number(bought.buy.buy_price, ask);
      const rec = { id, type, label: choice.label, symbol, stake: amount, buyPrice,
        status: 'open', profit: null, source, startedAt: Date.now() };
      this.open.set(id, rec);
      this.history.unshift(rec);
      if (this.history.length > 100) this.history.length = 100;
      this.tradesToday++;
      this.lastTradeAt = Date.now();
      this.emit('change');
      try { await this.request({ proposal_open_contract: 1, contract_id: Number(id), subscribe: 1 }); }
      catch (e) { this.uncertain = true; this.auto = false; this.error = `Order ${id} placed but settlement tracking failed. Verify on Deriv: ${e.message}`; this.emit('change'); }
      return { id, buyPrice, type, symbol };
    } catch (e) {
      if (buyAttempted && !buyConfirmed && /timeout|timed out|closed|offline|network|socket/i.test(e.message)) {
        // An order may exist even if an acknowledgement never arrived. NEVER retry automatically.
        this.uncertain = true;
        this.auto = false;
        this.error = 'Buy result uncertain. Check open contracts on Deriv before proceeding.';
      }
      this.emit('change');
      throw e;
    } finally { this.inFlight = false; this.emit('change'); }
  }
  configure(input) {
    if (this.auto || this.open.size || this.inFlight) throw new Error('Stop auto mode and wait for contracts to settle before changing settings');
    const next = {
      stake: Number(input.stake), maxStake: Number(input.maxStake), lossLimit: Number(input.lossLimit),
      maxOpen: Number(input.maxOpen), cooldown: Number(input.cooldown), maxTrades: Number(input.maxTrades), duration: 1,
    };
    if (!Number.isFinite(next.stake) || next.stake < 0.35 || next.stake > 5) throw new Error('Stake must be $0.35–$5');
    if (!Number.isFinite(next.maxStake) || next.maxStake < next.stake || next.maxStake > 5) throw new Error('Max stake must be between stake and $5');
    if (!Number.isFinite(next.lossLimit) || next.lossLimit < next.maxStake || next.lossLimit > 100) throw new Error('Loss limit must be between max stake and $100');
    if (!Number.isInteger(next.maxOpen) || next.maxOpen < 1 || next.maxOpen > 3) throw new Error('Max open must be 1–3');
    if (!Number.isInteger(next.cooldown) || next.cooldown < 5 || next.cooldown > 3600) throw new Error('Cooldown must be 5–3600 seconds');
    if (!Number.isInteger(next.maxTrades) || next.maxTrades < 1 || next.maxTrades > 100) throw new Error('Max trades must be 1–100');
    this.settings = next;
    this.emit('change');
    return this.settings;
  }
  startAuto(symbol, confirm) {
    if (confirm !== 'DEMO ONLY') throw new Error('Confirmation must read DEMO ONLY');
    if (!this.connectedOnce || this.status !== 'connected') throw new Error('Connect the Deriv demo account first');
    if (this.uncertain) throw new Error('Reconcile uncertain orders first');
    this.autoSymbol = symbol;
    this.auto = true;
    this.lastAutoCheck = 0;
    this.emit('change');
  }
  stopAuto() { this.auto = false; this.emit('change'); }
  onTick(tick, ticks) {
    if (!this.auto || this.autoBusy || this.status !== 'connected' || tick.symbol !== this.autoSymbol) return;
    if (Date.now() - this.lastAutoCheck < 2500) return;
    this.lastAutoCheck = Date.now();
    if (this.inFlight || this.open.size >= this.settings.maxOpen || Date.now() - this.lastTradeAt < this.settings.cooldown * 1000) return;
    const candidate = demoCandidate(ticks.map(x => x.digit));
    if (!candidate) return;
    this.autoBusy = true;
    this.place({ type: candidate.type, symbol: tick.symbol, stake: this.settings.stake, source: 'rules-demo' })
      .catch(e => { this.error = `Auto stopped: ${e.message}`; this.auto = false; this.emit('change'); })
      .finally(() => { this.autoBusy = false; });
  }
  async bulk({ type, symbol, count }) {
    if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error('Bulk count must be 1–3');
    // Sequential, not simultaneous. Further orders must each pass limits.
    const submitted = [];
    for (let i = 0; i < count; i++) {
      try { submitted.push(await this.place({ type, symbol, stake: this.settings.stake, source: 'bulk-demo' })); }
      catch (e) { return { submitted, stopped: e.message }; }
      if (i < count - 1) await new Promise(resolve => setTimeout(resolve, this.settings.cooldown * 1000));
    }
    return { submitted, stopped: null };
  }
  state() {
    this._resetDay();
    return { configured: this.configured(), status: this.status, error: this.error, accountId: this.accountId,
      currency: this.currency, balance: this.balance, uncertain: this.uncertain, auto: this.auto,
      autoSymbol: this.autoSymbol, settings: this.settings, tradesToday: this.tradesToday,
      sessionPnl: +this.pnlToday.toFixed(2), exposure: +this.exposure().toFixed(2), openCount: this.open.size,
      history: this.history.slice(0, 25),
      warning: 'DEMO ONLY. Rules-based experimentation, not proven AI. Loss cap is per server session, not durable across Render restarts.' };
  }
}
module.exports = { DemoTrader, demoAccount, flattenAccounts };
