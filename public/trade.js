'use strict';
// All privileged actions travel to SAME ORIGIN; Deriv PAT never appears in browser code.
(() => {
  const $ = id => document.getElementById(id);
  let unlocked = false;
  let busy = false;
  let config = null;
  let lastRanked = 0;
  let previousSymbol = '';

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
    $('start-auto').disabled = busy || s.auto || s.status !== 'connected' || s.uncertain;
    $('stop-auto').disabled = busy || !s.auto;
    $('auto-state').textContent = s.auto ? 'Demo auto is ACTIVE on ' + s.autoSymbol + '. Stop before changing markets.' : 'Demo auto is OFF. Auto does not resume after restarts or reconnections.';
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
  $('start-auto').onclick = () => run(async () => {
    const ok = confirm('DEMO ONLY: This is NOT a trained AI strategy or a validated profitable system. It uses past digit frequencies, which do not predict future ticks. Activate experimental auto orders on this demo account?');
    if (!ok) return;
    await api('trading/auto/start', { symbol: $('symbol').value, confirm: 'DEMO ONLY' });
    message('Experimental DEMO automation enabled. You can stop it any time.');
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
  function updateRankings() {
    if (Date.now() - lastRanked < 2000 || typeof ticks === 'undefined' || !ticks.length) return;
    lastRanked = Date.now();
    if (previousSymbol !== $('symbol').value) { previousSymbol = $('symbol').value; }
    const recent = ticks.slice(-200).map(x => x.digit);
    if (recent.length < 200) { $('rankings').textContent = `Collecting ${200 - recent.length} more ticks for a 200-tick sample…`; return; }
    const definitions = [
      ['Over 1', d => d > 1, .8],['Under 8', d => d < 8, .8],
      ['Differs 5', d => d !== 5, .9],['Matches 5', d => d === 5, .1]
    ];
    const scored = definitions.map(([label, test, baseline]) => ({ label,
      observed: 100 * recent.filter(test).length / recent.length, baseline: baseline * 100,
      deviation: recent.filter(test).length / recent.length - baseline
    })).sort((a,b) => b.deviation - a.deviation);
    const parent = $('rankings'); parent.replaceChildren();
    for (const s of scored) {
      const row = document.createElement('div'); row.className = 'ranking-item';
      const name = document.createElement('span'); name.textContent = s.label;
      const meta = document.createElement('em'); meta.textContent = `${s.observed.toFixed(1)}% observed · ${s.baseline}% baseline`;
      row.append(name, meta); parent.append(row);
    }
  }
  setInterval(updateRankings, 1500);
  setInterval(refresh, 4000);
  api('auth-state').then(result => {
    showUnlocked(result.authenticated);
    if (!result.loginEnabled) $('setup-hint').textContent = 'Trading is not configured yet. Set DASHBOARD_PASSWORD (12+ characters) in Render Environment.';
    else if (!result.configured) $('setup-hint').textContent = 'Passphrase configured; demo API credentials still need DERIV_PAT and DERIV_APP_ID on Render.';
    else $('setup-hint').textContent = 'Trading credentials detected on server. Unlock to connect the demo account.';
    if (result.authenticated) refresh();
  }).catch(() => { $('setup-hint').textContent = 'Trading status unavailable; scanner can still run.'; });
})();
