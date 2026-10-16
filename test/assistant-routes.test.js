'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');
async function ready(base) {
  for(let i=0;i<70;i++) {
    try {if((await fetch(base+'/api/health')).ok)return;}catch{}
    await new Promise(r=>setTimeout(r,80));
  }
  throw new Error('server not ready');
}
test('live assistant routes remain locked and only expose sanitized data to authenticated dashboard',async()=>{
  const port=33891,base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['server.js','--synthetic'],{
    cwd:path.resolve(__dirname,'..'),stdio:'ignore',env:{...process.env,PORT:String(port),
      DASHBOARD_PASSWORD:'this-is-a-test-passphrase',OPENAI_API_KEY:'FAKE_PRIVATE_TEST_KEY'}
  });
  try {
    await ready(base);
    assert.equal((await fetch(base+'/api/assistant/status')).status,401);
    assert.equal((await fetch(base+'/api/assistant/context')).status,401);
    const page=await (await fetch(base+'/')).text();
    assert.match(page,/Talk to Market Shaker AI/);
    assert.match(page,/assistant.js/);
    assert.doesNotMatch(page,/FAKE_PRIVATE_TEST_KEY/);
    const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},
      body:JSON.stringify({password:'this-is-a-test-passphrase'})});
    assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const options={headers:{Cookie:cookie}};
    const status=await (await fetch(base+'/api/assistant/status',options)).json();
    assert.equal(status.configured,true);
    assert.equal(status.model,'gpt-4.1-mini');
    assert.ok(!JSON.stringify(status).includes('FAKE_PRIVATE_TEST_KEY'));
    const context=await (await fetch(base+'/api/assistant/context',options)).json();
    assert.equal(context.scanner.active,false);
    assert.ok(context.capturedAt);
    assert.ok(!JSON.stringify(context).includes('FAKE_PRIVATE_TEST_KEY'));
    const invalid=await fetch(base+'/api/assistant/chat',{method:'POST',headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json'},
      body:JSON.stringify({message:'x'})});
    assert.equal(invalid.status,422);
    assert.match((await invalid.json()).error,/between 2/);
    const csrf=await fetch(base+'/api/assistant/chat',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},
      body:JSON.stringify({message:'Scan markets'})});
    assert.equal(csrf.status,403);
  } finally {child.kill();}
});
