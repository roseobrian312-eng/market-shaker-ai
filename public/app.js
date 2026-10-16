const $ = (id) => document.getElementById(id);
let ticks = [], es = null;
let currentSymbol = 'R_100';

let symbolsSignature = '';
async function syncSymbols() {
  const response = await fetch('/api/symbols', {cache:'no-store'});
  if (!response.ok) throw new Error(`Server error ${response.status}`);
  const syms = await response.json();
  const signature = syms.map(s=>s.id).join('|');
  if (!syms.length || signature === symbolsSignature) return;
  const select = $('symbol');
  const selected = select.value || currentSymbol;
  select.replaceChildren();
  for (const item of syms) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name;
    select.append(option);
  }
  symbolsSignature = signature;
  select.value = syms.some(s=>s.id===selected) ? selected : syms.some(s=>s.id==='R_100') ? 'R_100' : syms[0].id;
  if (select.value !== currentSymbol) connect(select.value);
}
async function init() {
  try {
    await syncSymbols();
    $('symbol').onchange = () => connect($('symbol').value);
    connect($('symbol').value);
  } catch (error) {
    $('feed-message').textContent = `Cannot load market symbols: ${error.message}`;
    setStatus('unavailable', false);
  }
}
setInterval(() => syncSymbols().catch(() => {}), 15000);

function connect(symbol) {
  if (es) es.close();
  ticks = [];
  currentSymbol = symbol;
  $('price').textContent = '—';
  $('digit').textContent = '';
  $('feed-message').textContent = 'Connecting to market feed…';
  $('last-seen').textContent = 'Waiting for first tick';
  es = new EventSource('/api/stream?symbol=' + encodeURIComponent(symbol));
  es.addEventListener('snapshot', (e) => {
    const d = JSON.parse(e.data); ticks = d.ticks;
    setStatus(d.status, d.synthetic); render(d.stats);
    if (d.error) $('feed-message').textContent = `Feed warning: ${d.error}`;
  });
  es.addEventListener('tick', (e) => {
    const d = JSON.parse(e.data); ticks.push(d.tick);
    if (ticks.length > 600) ticks.shift();
    render(d.stats);
    $('last-seen').textContent = 'Last tick: ' + new Date(d.tick.epoch * 1000).toLocaleTimeString();
    $('feed-message').textContent = d.tick.symbol === currentSymbol ? 'Receiving market ticks' : 'Waiting for selected market';
  });
  es.addEventListener('status', (e) => { const d = JSON.parse(e.data); setStatus(d.status, d.synthetic); });
  es.addEventListener('error', (e) => {
    if (e.data) { try { $('feed-message').textContent = 'Feed warning: ' + JSON.parse(e.data).message; } catch {} }
    else { $('feed-message').textContent = 'Stream interrupted. Reconnecting automatically…'; setStatus('reconnecting', false); }
  });
}

function setStatus(status, synthetic) {
  const el = $('conn');
  el.textContent = status === 'connected' ? 'Deriv connected' : status === 'synthetic' ? 'synthetic feed' : status;
  el.className = 'badge ' + (status === 'connected' ? 'on' : status === 'synthetic' ? 'warn' : 'off');
  $('synthetic').hidden = !synthetic;
}

function render(stats) {
  if (!ticks.length) return;
  const last = ticks[ticks.length - 1];
  $('price').textContent = Number(last.quote).toFixed(Number.isInteger(last.pip) && last.pip >= 0 && last.pip <= 10 ? last.pip : 2);
  $('last-seen').textContent = 'Last tick: ' + new Date(last.epoch * 1000).toLocaleTimeString();
  $('digit').textContent = 'last digit ' + last.digit;
  drawChart(); drawDigits(stats); drawSignals(stats);
}

function drawChart() {
  const c = $('chart'), dpr = devicePixelRatio || 1;
  c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
  const g = c.getContext('2d'); g.scale(dpr, dpr);
  const w = c.clientWidth, h = c.clientHeight, p = ticks.map(t => t.quote);
  const min = Math.min(...p), max = Math.max(...p), rng = max - min || 1;
  g.strokeStyle = '#1f2a44'; g.fillStyle = '#8793ad'; g.font = '11px system-ui';
  for (let i = 0; i <= 4; i++) {
    const y = 10 + (h - 20) * i / 4; g.beginPath(); g.moveTo(0, y); g.lineTo(w - 60, y); g.stroke();
    g.fillText((max - rng * i / 4).toFixed(2), w - 56, y + 4);
  }
  g.strokeStyle = '#4f8cff'; g.lineWidth = 1.8; g.beginPath();
  p.forEach((v, i) => {
    const x = (w - 60) * i / Math.max(p.length - 1, 1), y = 10 + (h - 20) * (1 - (v - min) / rng);
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.stroke();
}

function drawDigits(s) {
  const max = Math.max(...s.digitCounts, 1);
  const exp = s.n / 10;
  $('digits').innerHTML = s.digitCounts.map((c, d) =>
    `<div class="dbar ${c > exp * 1.3 && s.n >= 200 ? 'hot' : ''}"><i style="height:${(c / max) * 100}%"></i>${d}</div>`).join('');
  $('chi').textContent = `n=${s.n} · χ²=${s.chi2.toFixed(1)} (critical ${s.chi2Critical}) · ` +
    (s.n < 200 ? 'need ≥200 ticks for a meaningful test' : s.digitBiasFlag ? 'non-uniform at 5% level' : 'consistent with uniform');
}

function drawSignals(s) {
  const items = [];
  if (s.digitBiasFlag) items.push('Last-digit distribution departs from uniform (χ² test, 5% level).');
  if (Math.abs(s.returnZ) >= 3) items.push(`Latest tick move is ${s.returnZ.toFixed(1)}σ from recent average.`);
  if (s.streak.length >= 6) items.push(`${s.streak.length} consecutive ${s.streak.direction > 0 ? 'up' : 'down'} ticks.`);
  $('signals').innerHTML = items.length ? items.map(t => `<li>${t}</li>`).join('') : '<li class="muted">No unusual statistics right now.</li>';
}

addEventListener('resize', () => ticks.length && drawChart());
init();
