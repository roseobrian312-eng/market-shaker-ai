'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DerivClient } = require('./src/deriv');
const { SyntheticFeed } = require('./src/synthetic');
const { lastDigit, summarize } = require('./src/stats');

// Tiny .env loader (no dependencies)
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const PORT = Number(process.env.PORT || 3000);
const SYNTHETIC = process.env.SYNTHETIC === '1' || process.argv.includes('--synthetic');
const feed = SYNTHETIC ? new SyntheticFeed() : new DerivClient({ appId: process.env.DERIV_APP_ID || '1089' });

const MAX_TICKS = 1000;
const history = new Map();   // symbol -> tick[]
const clients = new Set();   // SSE responses
let lastError = null;

feed.on('error-msg', (m) => { lastError = m; broadcast('error', { message: m }); });
feed.on('status', (s) => broadcast('status', { status: s, synthetic: SYNTHETIC }));
feed.on('tick', (t) => {
  const tick = { ...t, digit: lastDigit(t.quote, t.pip) };
  const arr = history.get(t.symbol) || [];
  arr.push(tick);
  if (arr.length > MAX_TICKS) arr.shift();
  history.set(t.symbol, arr);
  broadcast('tick', { tick, stats: summarize(arr) });
});

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) if (!c.symbol || event !== 'tick' || data.tick.symbol === c.symbol) c.res.write(payload);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const SYMBOLS = [
  ['R_10', 'Volatility 10 Index'], ['R_25', 'Volatility 25 Index'], ['R_50', 'Volatility 50 Index'],
  ['R_75', 'Volatility 75 Index'], ['R_100', 'Volatility 100 Index'],
  ['1HZ10V', 'Volatility 10 (1s) Index'], ['1HZ100V', 'Volatility 100 (1s) Index'],
];

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ status: feed.status, synthetic: SYNTHETIC, connectedClients: clients.size, trackedSymbols: [...history.keys()], lastError }));
  }
  if (url.pathname === '/api/symbols') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(SYMBOLS.map(([id, name]) => ({ id, name }))));
  }
  if (url.pathname === '/api/stream') {
    const symbol = url.searchParams.get('symbol') || 'R_100';
    if (!SYMBOLS.some(([id]) => id === symbol)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unsupported symbol' }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const c = { res, symbol };
    clients.add(c);
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
    feed.subscribeTicks(symbol);
    const arr = history.get(symbol) || [];
    res.write(`event: snapshot\ndata: ${JSON.stringify({ ticks: arr, stats: summarize(arr), status: feed.status, synthetic: SYNTHETIC, error: lastError })}\n\n`);
    req.on('close', () => { clearInterval(heartbeat); clients.delete(c); });
    return;
  }
  const publicRoot = path.resolve(__dirname, 'public');
  let file;
  try { file = path.resolve(publicRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)); }
  catch { res.writeHead(400); return res.end('Bad URL'); }
  if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '0.0.0.0', () => console.log(`Market Shaker AI running on port ${PORT}${SYNTHETIC ? '  [SYNTHETIC DEV FEED]' : ''}`));

feed.connect();
