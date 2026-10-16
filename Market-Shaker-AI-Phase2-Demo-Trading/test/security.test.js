'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

async function ready(url) {
  for(let i=0;i<50;i++) {
    try { const r=await fetch(url+'/api/health'); if(r.ok) return; } catch {}
    await new Promise(done=>setTimeout(done,100));
  }
  throw new Error('server did not respond');
}
test('public scanner stays public but trading routes need passphrase and same-origin POST',async()=>{
  const port=33763; const base=`http://127.0.0.1:${port}`;
  const server=spawn(process.execPath,['server.js','--synthetic'],{
    cwd:path.resolve(__dirname,'..'),
    env:{...process.env,PORT:String(port),DASHBOARD_PASSWORD:'this-is-a-long-passphrase'}, stdio:'ignore'
  });
  try {
    await ready(base);
    assert.equal((await fetch(base)).status,200);
    assert.equal((await fetch(base+'/api/trading/status')).status,401);
    assert.equal((await fetch(base+'/api/trading/manual',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
    const bad=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({password:'wrong'})});
    assert.equal(bad.status,401);
    const good=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({password:'this-is-a-long-passphrase'})});
    assert.equal(good.status,200);
    const cookie=good.headers.get('set-cookie').split(';')[0];
    const ok=await fetch(base+'/api/trading/status',{headers:{Cookie:cookie}});
    assert.equal(ok.status,200);
    const body=await ok.json();
    assert.equal(body.configured,false);
    assert.equal(body.auto,false);
    const noTrading=await fetch(base+'/api/trading/manual',{method:'POST',headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json'},body:'{}'});
    assert.equal(noTrading.status,403);
  } finally { server.kill(); }
});
