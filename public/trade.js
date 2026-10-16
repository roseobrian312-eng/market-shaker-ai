'use strict';
// All privileged actions travel to SAME ORIGIN; Deriv PAT never appears in browser code.
(() => {
  const $ = id => document.getElementById(id);
  let unlocked = false;
  let busy = false;
  let config = null;
  let scannerActive = false;
  let scannerStatus = null;
  let aiStatus = null;

  async function api(route, data) {
    const response = await fetch('/api/' + route, {
      method: data === undefined ? 'GET' : 'POST',
      headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...(data === undefined ? {} : { body: JSON.stringify(data) })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed: HTTP ${response.status}`);
    return payload;
  }
  function message(text, bad = false) {
    $('trading-message').textContent = text;
    $('trading-message').className = 'status-line ' + (bad ? 'error' : 'ok');
  }
  function money(amount) {
    return Number.isFinite(Number(amount)) ? '$' + Number(amount).toFixed(2) : '—';
  }
  function showUnlocked(isUnlocked) {
    unlocked = isUnlocked;
    $('unlock-panel').hidden = isUnlocked;
    $('trade-panel').hidden = !isUnlocked;
    $('demo-status').textContent = isUnlocked ? 'Unlocked · Demo only' : 'Locked';
    $('demo-status').className = 'badge ' + (isUnlocked ? 'on' : 'off');
  }
  function fillSettings(settings) {
    const pairs = { stake: 'stake', maxStake: 'max-stake', lossLimit: 'loss-limit', maxOpen: 'max-open', cooldown: 'cooldown', maxTrades: 'max-trades' };
    for (const [key, el] of Object.entries(pairs)) $(el).value = settings[key];
  }
  function state(s) {
    config = s;
    $('account-id').textContent = s.accountId ? `${s.accountId} (DEMO)` : 'Not connected';
    $('account-balance').textContent = money(s.balance);
    $('session-pnl').textContent = money(s.sessionPnl);
    $('session-pnl').className = s.sessionPnl < 0 ? 'pnl-down' : 'pnl-up';
    $('open-count').textContent = String(s.openCount);
    $('session-trades').textContent = String(s.tradesToday);
    $('demo-status').textContent = s.auto ? 'Demo auto ON' : 'Demo · ' + s.status;
    $('connect-demo').disabled = busy || s.status === 'connected' || s.status === 'connecting' || !s.configured;
    $('buy').disabled = busy || s.status !== 'connected' || s.uncertain;
    $('bulk').disabled = busy || s.status !== 'connected' || s.uncertain;
    $('start-auto').disabled = busy || s.auto || !scannerActive || s.status !== 'connected' || s.uncertain;
    $('stop-auto').disabled = busy || !s.auto;
    $('auto-progress').textContent = `${s.autoPlaced || 0} / ${s.autoTarget || 0}`;
    $('auto-state').textContent = `${s.auto ? 'AI AUTO RUNNING' : 'AI AUTO OFF'} (${s.autoMode || 'quality'}) · ${s.autoPlaced || 0}/${s.autoTarget || 0} demo orders. ${s.autoReason || ''}` +
      (s.autoChoice ? ` Last ML selection: ${s.autoChoice.name} / ${s.autoChoice.strategy}; estimated P=${s.autoChoice.predictedPct}%; quoted payout $${s.autoChoice.payout}.` : '');
    if (!s.configured) message('Trading credentials not configured. Set DERIV_APP_ID and DERIV_PAT privately in Render.', true);
    else if (s.uncertain) message('SAFETY LOCK: Order status uncertain. Check your Deriv demo account and restart only after reconciling positions.', true);
    else if (s.error) message(s.error, true);
    $('trades').replaceChildren();
    if (!s.history.length) {
      const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 5; td.className = 'muted'; td.textContent = 'No demo trades recorded this server session.'; tr.append(td); $('trades').append(tr);
    }
    for (const t of s.history) {
      const tr = document.createElement('tr');
      const fields = [new Date(t.startedAt).toLocaleTimeString(), t.symbol, t.label, money(t.stake), t.profit === null ? 'Open' : `${money(t.profit)} · ${t.status}`];
      for (const value of fields) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
      tr.lastElementChild.className = t.profit === null ? '' : t.profit >= 0 ? 'pnl-up' : 'pnl-down';
      $('trades').append(tr);
    }
  }
  async function refresh() {
    if (!unlocked) return;
    try {
      const s = await api('trading/status');
      state(s);
    } catch (err) {
      if (/unlock|401/i.test(err.message)) showUnlocked(false);
      else message(err.message, true);
    }
  }
  async function run(fn) {
    if (busy) return;
    busy = true;
    if (config) state(config);
    try { await fn(); }
    catch (err) { message(err.message, true); }
    finally { busy = false; await refresh(); }
  }
  $('unlock').onclick = () => run(async () => {
    const pw = $('password').value;
    await api('login', { password: pw });
    $('password').value = '';
    showUnlocked(true);
    message('Demo controls unlocked. Connect your Deriv demo account to trade.');
    await refresh();
    await refreshAI();
  });
  $('password').addEventListener('keydown', e => { if (e.key === 'Enter') $('unlock').click(); });
  $('connect-demo').onclick = () => run(async () => {
    message('Connecting authenticated Deriv demo account…');
    await api('trading/connect', {});
    message('Deriv DEMO account connected. Ready for manual test.');
  });
  $('save-risk').onclick = () => run(async () => {
    const s = await api('trading/settings', {
      stake: +$('stake').value, maxStake: +$('max-stake').value, lossLimit: +$('loss-limit').value,
      maxOpen: +$('max-open').value, cooldown: +$('cooldown').value, maxTrades: +$('max-trades').value
    });
    fillSettings(s.settings);
    $('auto-stake').value = s.settings.stake;
    message('Session risk settings saved. These reset when Render restarts.');
  });
  $('buy').onclick = () => run(async () => {
    if (!confirm(`Place a $${config.settings.stake} DEMO ${$('trade-type').selectedOptions[0].text} contract on ${$('symbol').value}?`)) return;
    message('Requesting Deriv quote and placing demo contract…');
    const result = await api('trading/manual', { type: $('trade-type').value, symbol: $('symbol').value });
    message(`Deriv demo order confirmed: ${result.order.id}.`);
  });
  $('bulk').onclick = () => run(async () => {
    const count = +$('bulk-count').value;
    if (!confirm(`Queue up to ${count} demo trades? Risk limits and cooldowns apply.`)) return;
    message('Submitting demo orders sequentially…');
    const result = await api('trading/bulk', { type: $('trade-type').value, symbol: $('symbol').value, count });
    message(`${result.submitted.length} demo orders confirmed. ${result.stopped || 'Queue completed.'}`, Boolean(result.stopped));
  });
  $('scan-all').onclick = () => run(async () => {
    $('scanner-message').textContent = 'Discovering all active Deriv markets and starting a rotating live scan…';
    await api('scanner/start', {});
    message('Market discovery started. Choose your demo trade quantity and stake.');
    await refreshScanner();
  });
  $('start-auto').onclick = () => run(async () => {
    const count = +$('auto-count').value;
    const stake = +$('auto-stake').value;
    const mode = $('ai-mode').value;
    if (!config) throw new Error('Connect your DEMO account first.');
    if (stake !== config.settings.stake) {
      const old = config.settings;
      const updated = await api('trading/settings', {
        stake, maxStake: old.maxStake, lossLimit: old.lossLimit,
        maxOpen: old.maxOpen, cooldown: old.cooldown, maxTrades: old.maxTrades
      });
      fillSettings(updated.settings);
    }
    const warning = mode === 'research' ? 'EXPLORATORY: these DEMO trades may have NEGATIVE expected value. ML predictions are unverified.' : mode === 'assistant' ? 'ChatGPT will periodically review CURRENT live quotes (up to 20 billed API decisions per server session), select one or WAIT. No profit is guaranteed. It does not analyze every tick via API.' : 'EVIDENCE-GATED: the AI may make zero trades if no forward-evaluated opportunity passes the checks.';
    const ok = confirm(`Start up to ${count} DEMO trades at $${stake.toFixed(2)} each? Market Shaker will compare models, markets and quotes; ChatGPT selects among validated candidates in AI-assisted mode. ${warning} Continue?`);
    if (!ok) return;
    await api('trading/auto/start', {count, mode, confirm:'DEMO ONLY'});
    message(`Market Shaker DEMO auto started in ${mode} mode, target ${count} orders. Results are experimental.`);
  });
  $('stop-auto').onclick = () => run(async () => {
    await api('trading/auto/stop', {});
    message('Experimental auto trading stopped. Previously placed contracts still settle normally.');
  });
  $('refresh').onclick = () => run(refresh);
  $('logout').onclick = () => run(async () => {
    await api('logout', {});
    showUnlocked(false);
  });
  function appendRow(parent, fields) {
    const tr = document.createElement('tr');
    for (const v of fields) {
      const td = document.createElement('td');
      td.textContent = String(v);
      tr.append(td);
    }
    parent.append(tr);
  }
  async function refreshScanner() {
    try {
      const s = await api('scanner/status');
      scannerStatus = s;
      scannerActive = s.active;
      $('scan-badge').textContent = s.active ? 'Scanning' : 'Scanner OFF';
      $('scan-badge').className = 'badge ' + (s.active ? 'on' : 'warn');
      $('markets-total').textContent = String(s.discovered);
      $('markets-watching').textContent = String(s.watching);
      $('markets-ready').textContent = String(s.warmed);
      $('scanner-message').textContent = s.message;
      $('scan-all').disabled = busy || s.active || s.loading;
      if (config) $('start-auto').disabled = busy || config.auto || !s.active || config.status !== 'connected' || config.uncertain;
      const tbody = $('scan-leaders'); tbody.replaceChildren();
      if (!s.rankings.length) appendRow(tbody, ['Waiting for live samples (' + s.minimumTicks + ' ticks per market)…', '', '', '', '', '']);
      for (const r of s.rankings) {
        appendRow(tbody, [r.name, r.label, r.sample, r.observedPct + '%', r.baselinePct + '%',
          (r.deviationPct >= 0 ? '+' : '') + r.deviationPct + ' pp']);
      }
    } catch (e) { $('scanner-message').textContent = 'Scanner status unavailable: ' + e.message; }
  }
  async function refreshAI() {
    if (!unlocked) return;
    try {
      const s = await api('ai/status');
      aiStatus = s;
      $('ai-ticks').textContent = Number(s.totalTicks).toLocaleString();
      $('ai-ready').textContent = String(s.readyMarkets);
      $('ai-settled').textContent = String(s.totalSettlements);
      $('ai-badge').textContent = s.readyMarkets > 0 ? 'ML active' : 'Learning';
      $('ai-badge').className = 'badge ' + (s.readyMarkets > 0 ? 'on' : 'warn');
      $('ai-note').textContent = s.readyMarkets > 0 ?
        `Online training running. ${s.readyMarkets} markets have warmed up; predictions are checked on later ticks. Higher forward score (positive) means better recent log-loss than a 10% uniform forecast, NOT proven profit.` :
        `Learning tick patterns across ${s.trainedMarkets} markets. About ${s.samplesNeeded} ticks per symbol are needed for initial AI rankings. Different markets warm at different speeds.`;
      const body=$('ai-leaders');body.replaceChildren();
      if (!s.leaders.length) appendRow(body, ['Collecting labelled tick outcomes…','','','','','']);
      for (const r of s.leaders) appendRow(body, [r.name, r.strategy,
        `${r.predictedPct}%`, `${r.baselinePct}%`,
        `${r.modelSkill === null ? '—' : (r.modelSkill >= 0 ? '+' : '') + r.modelSkill.toFixed(4)} (${r.forecasts} checks)`,
        r.tradeCount ? `${r.tradeCount} trades · ${r.realizedDemoROI}% ROI` : 'Not tested']);
    } catch(e) { $('ai-note').textContent = 'AI status unavailable: ' + e.message; }
  }
  $('ai-backup').onclick = () => run(async () => {
    const snapshot = await api('ai/backup');
    const blob = new Blob([JSON.stringify(snapshot)], {type:'application/json'});
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;anchor.download='market-shaker-ai-model-backup.json';
    document.body.append(anchor);anchor.click();anchor.remove();
    setTimeout(()=>URL.revokeObjectURL(href),1000);
    message('AI model backup downloaded. Store the JSON file safely before Render restarts.');
  });
  $('ai-restore').onclick = () => { $('ai-file').value = ''; $('ai-file').click(); };
  $('ai-file').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    await run(async () => {
      if (file.size > 2000000) throw new Error('AI backup is too large (max 2 MB).');
      if (!confirm('Restore trained AI model from this backup? Current in-memory training will be replaced. Stop any active demo orders first.')) return;
      const backup = JSON.parse(await file.text());
      await api('ai/restore', backup);
      await refreshAI();
      message('AI model weights restored. Waiting for fresh ticks before making new market predictions.');
    });
  });
  setInterval(refreshScanner, 4000);
  setInterval(refreshAI, 5000);
  setInterval(refresh, 4000);
  refreshScanner();
  api('auth-state').then(result => {
    showUnlocked(result.authenticated);
    if (!result.loginEnabled) $('setup-hint').textContent = 'Trading is not configured yet. Set DASHBOARD_PASSWORD (12+ characters) in Render Environment.';
    else if (!result.configured) $('setup-hint').textContent = 'Passphrase configured; demo API credentials still need DERIV_PAT and DERIV_APP_ID on Render.';
    else $('setup-hint').textContent = 'Trading credentials detected on server. Unlock to connect the demo account.';
    if (result.authenticated) { refresh(); refreshAI(); }
  }).catch(() => { $('setup-hint').textContent = 'Trading status unavailable; scanner can still run.'; });
})();
