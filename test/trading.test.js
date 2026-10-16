'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DemoTrader, demoAccount, flattenAccounts } = require('../src/trading');
const { demoCandidate, evaluate } = require('../src/decision');
const { createAccess } = require('../src/access');

class MockSocket {
  constructor(url) {
    assert.match(url, /\/ws\/demo\?otp=/);
    this.listeners = {};
    this.readyState = 0;
    this.url = url;
    queueMicrotask(() => { this.readyState = 1; this.emit('open', {}); });
  }
  addEventListener(event, fn) { (this.listeners[event] ||= []).push(fn); }
  emit(name, event) { for (const fn of this.listeners[name] || []) fn(event); }
  send(source) {
    const msg = JSON.parse(source);
    let response;
    if (msg.balance) response = { msg_type:'balance', req_id:msg.req_id, balance:{balance:10000} };
    if (msg.proposal) response = { msg_type:'proposal', req_id:msg.req_id, proposal:{id:'mock-proposal-123',ask_price:msg.amount} };
    if (msg.buy) response = { msg_type:'buy', req_id:msg.req_id, buy:{contract_id:123456, buy_price:1} };
    if (msg.proposal_open_contract) response = { msg_type:'proposal_open_contract', req_id:msg.req_id, proposal_open_contract:{contract_id:123456, status:'won', is_sold:1, profit:0.8} };
    if (response) queueMicrotask(() => this.emit('message', { data: JSON.stringify(response) }));
  }
  close() { this.readyState = 3; this.emit('close', {}); }
}
function mockFetch(url, options) {
  assert.equal(options.headers['Deriv-App-ID'], 'TEST_ID');
  assert.equal(options.headers.Authorization, 'Bearer FAKE');
  if (url.endsWith('/accounts')) return Promise.resolve({ok:true,json:async()=>({data:[{account_id:'DOT90001',account_type:'demo',currency:'USD'},{account_id:'CR12345',account_type:'real'}]})});
  if (url.endsWith('/accounts/DOT90001/otp')) return Promise.resolve({ok:true,json:async()=>({data:{url:'wss://api.derivws.com/trading/v1/options/ws/demo?otp=fake-test-only'}})});
  throw Error('unexpected REST endpoint');
}
test('real accounts rejected and demo account selected', () => {
  assert.equal(demoAccount({account_id:'CR1234',account_type:'real'}), false);
  assert.equal(demoAccount({account_id:'DOT1234',account_type:'demo'}), true);
  assert.equal(demoAccount({account_id:'CR1234',account_type:'virtual'}), true);
  assert.equal(demoAccount({account_id:'DOT1234',account_type:'real'}), false);
  assert.equal(flattenAccounts({accounts:[{id:'DOT1'}]}).length, 1);
});
test('candidate waits for sample and flags historical, not predictive, concentration', () => {
  assert.equal(demoCandidate(Array(50).fill(9)), null);
  const s = evaluate(Array(200).fill(9));
  assert.equal(s[0].observedPct, 100);
  assert.ok(demoCandidate(Array(200).fill(9)));
  assert.equal(demoCandidate(Array(200).fill(3).map((x,i)=>i%10)), null);
});
test('mock Deriv REST OTP, demo WebSocket quote->buy->settle lifecycle', async () => {
  const engine = new DemoTrader({token:'FAKE',appId:'TEST_ID',fetchImpl:mockFetch,WebSocketImpl:MockSocket});
  await engine.connect();
  assert.equal(engine.status, 'connected');
  assert.equal(engine.accountId,'DOT90001');
  assert.equal(engine.balance, 10000);
  const order = await engine.place({type:'DIGITOVER',symbol:'R_100',stake:1});
  assert.equal(order.id,'123456');
  assert.equal(engine.history.length,1);
  assert.equal(engine.history[0].status,'won');
  assert.equal(engine.pnlToday,0.8);
  assert.equal(engine.open.size,0);
  await assert.rejects(engine.place({type:'DIGITOVER',symbol:'R_100',stake:1}), /cooldown/);
  engine.ws.close();
});
test('limits reject orders with stake above max, non-demo symbols and insufficient remaining risk', async () => {
  const engine = new DemoTrader({token:'FAKE',appId:'TEST_ID',fetchImpl:mockFetch,WebSocketImpl:MockSocket});
  await engine.connect();
  assert.throws(()=>engine.configure({stake:10,maxStake:10,lossLimit:10,maxOpen:1,cooldown:15,maxTrades:20}),/Stake/);
  assert.throws(()=>engine._validate('DIGITOVER','R_100',50),/Stake/);
  assert.throws(()=>engine._validate('DIGITOVER','R_UNKNOWN',1),/symbol/);
  engine.pnlToday = -9.5;
  assert.throws(()=>engine._validate('DIGITOVER','R_100',1),/loss cap/);
  engine.ws.close();
});
test('passphrase prevents unauthorized access and does not reveal session in UI', () => {
  const access = createAccess('this_is_a_test_passphrase');
  const req = {headers:{},socket:{remoteAddress:'127.0.0.1'}};
  const res = {headers:{},setHeader(key,val){this.headers[key]=val;}};
  assert.equal(access.login(req,res,'wrong'),false);
  assert.equal(access.login(req,res,'this_is_a_test_passphrase'),true);
  const cookie = res.headers['Set-Cookie'];
  assert.match(cookie,/HttpOnly/);
  assert.match(cookie,/SameSite=Strict/);
  req.headers.cookie = cookie.split(';')[0];
  assert.equal(access.valid(req),true);
  access.logout(req,res);
  assert.equal(access.valid(req),false);
});
