'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

async function waitFor(base) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not start');
}

test('synthetic server loads pages, validates markets, streams actual SSE tick events', async () => {
  const port = 33887;
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js', '--synthetic'], {
    cwd: require('node:path').join(__dirname, '..'),
    env: { ...process.env, PORT: String(port) }, stdio: 'ignore',
  });
  const controller = new AbortController();
  try {
    await waitFor(base);
    const health = await (await fetch(base + '/api/health')).json();
    assert.equal(health.synthetic, true);
    const page = await (await fetch(base + '/')).text();
    assert.match(page, /Market Shaker AI/);
    const symResponse = await fetch(base + '/api/symbols');
    assert.equal(symResponse.status, 200);
    assert.ok((await symResponse.json()).some(x => x.id === 'R_100'));
    assert.equal((await fetch(base + '/api/stream?symbol=INVALID')).status, 400);
    assert.equal((await fetch(base + '/server.js')).status, 404);
    const stream = await fetch(base + '/api/stream?symbol=R_100', { signal: controller.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (let i = 0; i < 15 && !buffer.includes('event: tick'); i++) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      buffer += decoder.decode(value);
    }
    assert.match(buffer, /event: snapshot/);
    assert.match(buffer, /event: tick/);
    assert.match(buffer, /"symbol":"R_100"/);
  } finally {
    controller.abort();
    child.kill();
  }
});
