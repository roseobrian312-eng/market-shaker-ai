
'use strict';

// Market Shaker AI - Deriv Market Data Connection
// Node.js 22+ required.

const { EventEmitter } = require('node:events');

class DerivClient extends EventEmitter {
  constructor({ appId = '1089', url } = {}) {
    super();

    this.url = url ||
      'wss://api.derivws.com/trading/v1/options/ws/public';

    this.ws = null;
    this.subs = new Set();
    this.reqId = 0;
    this.pending = new Map();
    this.backoff = 1000;
    this.status = 'disconnected';
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.connectTimer = null;
  }

  _setStatus(status) {
    this.status = status;
    this.emit('status', status);
  }

  _report(message) {
    console.error('[Deriv]', message);
    this.emit('error-msg', message);
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;

    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30000);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  connect() {
    if (
      this.ws &&
      (this.ws.readyState === 0 || this.ws.readyState === 1)
    ) return;

    this._setStatus('connecting');

    let ws;

    try {
      ws = new WebSocket(this.url);
    } catch (error) {
      this._report(`Cannot open WebSocket: ${error.message}`);
      this._setStatus('disconnected');
      this._scheduleReconnect();
      return;
    }

    this.ws = ws;

    this.connectTimer = setTimeout(() => {
      if (this.ws === ws && ws.readyState === 0) {
        this._report('Deriv connection timed out after 15 seconds');
        try {
          ws.close();
        } catch (error) {
          this.ws = null;
          this._setStatus('disconnected');
          this._scheduleReconnect();
        }
      }
    }, 15000);

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;

      clearTimeout(this.connectTimer);
      this.backoff = 1000;
      this._setStatus('connected');

      console.log('[Deriv] Market data connected');

      this.pingTimer = setInterval(() => {
        this._send({ ping: 1 });
      }, 30000);

      for (const symbol of this.subs) {
        this._send({ ticks: symbol, subscribe: 1 });
      }
    });

    ws.addEventListener('message', (event) => {
      if (this.ws !== ws) return;

      try {
        this._onMessage(JSON.parse(event.data));
      } catch (error) {
        this._report(`Invalid response: ${error.message}`);
      }
    });

    ws.addEventListener('error', (event) => {
      if (this.ws !== ws) return;

      const error = event.error;
      const reason =
        error?.cause?.message ||
        error?.message ||
        event.message ||
        'WebSocket handshake or network error';

      this._report(`WebSocket error: ${reason}`);
    });

    ws.addEventListener('close', (event) => {
      if (this.ws !== ws) return;

      clearTimeout(this.connectTimer);
      clearInterval(this.pingTimer);

      this.ws = null;
      this._setStatus('disconnected');

      const details = event.reason
        ? `: ${event.reason}`
        : '';

      this._report(
        `Deriv connection closed (code ${event.code})${details}`
      );

      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Connection closed'));
        this.pending.delete(id);
      }

      this._scheduleReconnect();
    });
  }

  _send(payload) {
    if (!this.ws || this.ws.readyState !== 1) {
      return false;
    }

    this.ws.send(JSON.stringify(payload));
    return true;
  }

  request(payload) {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(
        new Error('Deriv is not connected')
      );
    }

    return new Promise((resolve, reject) => {
      const req_id = ++this.reqId;

      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error('Deriv request timed out'));
      }, 15000);

      this.pending.set(req_id, {
        resolve,
        reject,
        timer
      });

      this._send({ ...payload, req_id });
    });
  }

  subscribeTicks(symbol) {
    if (!symbol || this.subs.has(symbol)) return;

    this.subs.add(symbol);

    this._send({
      ticks: symbol,
      subscribe: 1
    });
  }

  _onMessage(message) {
    if (
      message.req_id &&
      this.pending.has(message.req_id)
    ) {
      const pending = this.pending.get(message.req_id);

      clearTimeout(pending.timer);
      this.pending.delete(message.req_id);

      if (message.error) {
        pending.reject(
          new Error(message.error.message || 'API error')
        );
      } else {
        pending.resolve(message);
      }
    }

    if (message.error) {
      this._report(
        `Deriv API error: ${
          message.error.message ||
          JSON.stringify(message.error)
        }`
      );
      return;
    }

    if (message.msg_type === 'tick' && message.tick) {
      const tick = message.tick;

      this.emit('tick', {
        symbol: tick.symbol,
        quote: tick.quote,
        epoch: tick.epoch,
        pip: tick.pip_size
      });
    }
  }
}

module.exports = { DerivClient };
