'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DerivClient } = require('./src/deriv');
const { SyntheticFeed } = require('./src/synthetic');
const { lastDigit, summarize } = require('./src/stats');
const { evaluate } = require('./src/decision');
const { DemoTrader } = require('./src/trading');
const { createAccess } = require('./src/access');

// Tiny .env loader for local development only. Render uses environment variables.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const PORT = Number(process.env.PORT || 3000);
const SYNTHETIC = process.env.SYNTHETIC === '1' || process.argv.includes('--synthetic');
const SYMBOLS = [
  ['R_10','Volatility 10 Index'], ['R_25','Volatility 25 Index'], ['R_50','Volatility 50 Index'],
  ['R_75','Volatility 75 Index'], ['R_100','Volatility 100 Index'],
  ['1HZ10V','Volatility 10 (1s) Index'], ['1HZ100V','Volatility 100 (1s) Index'],
];
const feed = SYNTHETIC ? new SyntheticFeed() : new DerivClient({ appId: process.env.DERIV_APP_ID });
const demo = new DemoTrader({ token: SYNTHETIC ? '' : process.env.DERIV_PAT,
  appId: SYNTHETIC ? '' : process.env.DERIV_APP_ID, accountId: process.env.DERIV_DEMO_ACCOUNT_ID || '' });
const access = createAccess(process.env.DASHBOARD_PASSWORD);
const history = new Map();
const clients = new Set();
const MAX_TICKS = 1000;
let lastError = null;

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (event === 'tick' && c.symbol !== data.tick.symbol) continue;
    try { c.res.write(payload); } catch { clients.delete(c); }
  }
}
feed.on('error-msg', msg => { lastError = msg; broadcast('error', { message: msg }); });
feed.on('status', status => broadcast('status', { status, synthetic: SYNTHETIC }));
feed.on('tick', t => {
  const tick = { ...t, digit: lastDigit(t.quote, t.pip) };
  const arr = history.get(t.symbol) || [];
  arr.push(tick); if (arr.length > MAX_TICKS) arr.shift();
  history.set(t.symbol, arr);
  broadcast('tick', { tick, stats: summarize(arr) });
  if (!SYNTHETIC) demo.onTick(tick, arr);
});
demo.on('change', () => {});

function respond(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function fail(res, code, message) { respond(res, code, { error: String(message).slice(0, 400) }); }
function secureOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !req.headers.host) return false;
  try {
    const u = new URL(origin);
    return u.host === req.headers.host && (u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)));
  } catch { return false; }
}
async function readJson(req) {
  let body = '';
  for await (const part of req) {
    body += part.toString();
    if (body.length > 8192) throw new Error('Request too large');
  }
  if (!body) return {};
  const result = JSON.parse(body);
  if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('Expected JSON object');
  return result;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

async function handler(req, res) {
  const url = new URL(req.url, 'http://local.invalid');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return respond(res, 200, { status: feed.status, synthetic: SYNTHETIC, connectedClients: clients.size,
      trackedSymbols: [...history.keys()], lastError, demoAvailable: demo.configured() && access.enabled });
  }
  if (req.method === 'GET' && url.pathname === '/api/symbols')
    return respond(res, 200, SYMBOLS.map(([id, name]) => ({ id, name })));
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    const symbol = url.searchParams.get('symbol') || 'R_100';
    if (!SYMBOLS.some(([id]) => id === symbol)) return fail(res, 400, 'Unsupported symbol');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const client = { res, symbol };
    clients.add(client);
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
    feed.subscribeTicks(symbol);
    const arr = history.get(symbol) || [];
    res.write(`event: snapshot\ndata: ${JSON.stringify({ ticks: arr, stats: summarize(arr), status: feed.status, synthetic: SYNTHETIC, error: lastError })}\n\n`);
    req.on('close', () => { clearInterval(heartbeat); clients.delete(client); });
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    if (req.method === 'GET' && url.pathname === '/api/auth-state')
      return respond(res, 200, { authenticated: access.valid(req), loginEnabled: access.enabled, configured: demo.configured() && access.enabled, synthetic: SYNTHETIC });
    if (req.method === 'POST' && !secureOrigin(req)) return fail(res, 403, 'Security check failed: use this website to submit requests');
    if (req.method === 'POST' && url.pathname === '/api/login') {
      if (!access.enabled) return fail(res, 503, 'Set DASHBOARD_PASSWORD (at least 12 characters) in Render first');
      const body = await readJson(req);
      if (!access.login(req, res, body.password)) return fail(res, 401, 'Wrong passphrase or too many attempts');
      return respond(res, 200, { ok: true });
    }
    if (!access.valid(req)) return fail(res, 401, 'Unlock the trading controls first');
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      demo.stopAuto(); access.logout(req, res); return respond(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/trading/status') return respond(res, 200, demo.state());
    if (req.method !== 'POST') return fail(res, 405, 'Unsupported method');
    if (SYNTHETIC) return fail(res, 403, 'Synthetic testing mode cannot place orders');
    const body = await readJson(req);
    if (url.pathname === '/api/trading/connect') { await demo.connect(); return respond(res, 200, demo.state()); }
    if (url.pathname === '/api/trading/settings') return respond(res, 200, { settings: demo.configure(body) });
    if (url.pathname === '/api/trading/manual') return respond(res, 200, { order: await demo.place({ type: body.type, symbol: body.symbol, stake: demo.settings.stake }) });
    if (url.pathname === '/api/trading/bulk') return respond(res, 200, await demo.bulk({ type: body.type, symbol: body.symbol, count: body.count }));
    if (url.pathname === '/api/trading/auto/start') { demo.startAuto(body.symbol, body.confirm); return respond(res, 200, demo.state()); }
    if (url.pathname === '/api/trading/auto/stop') { demo.stopAuto(); return respond(res, 200, demo.state()); }
    return fail(res, 404, 'Unknown action');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Unsupported method');
  const publicRoot = path.resolve(__dirname, 'public');
  let file;
  try { file = path.resolve(publicRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)); }
  catch { return fail(res, 400, 'Bad URL'); }
  if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(res, 404, 'Not found');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain', 'Cache-Control': 'no-store' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

http.createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch(error => {
    console.error('[Market Shaker]', error.message);
    if (!res.headersSent) fail(res, /invalid|large|json/i.test(error.message) ? 400 : 422, error.message);
    else res.end();
  });
}).listen(PORT, '0.0.0.0', () => console.log(`Market Shaker AI running on port ${PORT}${SYNTHETIC ? '  [SYNTHETIC DEV FEED]' : ''}`));

feed.connect();
