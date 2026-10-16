'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {MarketScanner} = require('../src/market-scanner');
const {AdaptiveEngine} = require('../src/ml-engine');
class StubFeed {
  constructor(symbols) { this.symbols = symbols; this.subs=new Set(); this.subscribed=[]; }
  async request() { return {active_symbols:this.symbols.map(id=>({symbol:id,display_name:id,market:'synthetic_index'}))}; }
  subscribeTicks(id) { this.subs.add(id);this.subscribed.push(id); }
  unsubscribeTicks(id) { this.subs.delete(id); }
}

test('stable synthetic feeds remain subscribed across batch rotations and new markets are visited',async()=>{
  const markets=['R_10','R_25','R_50','R_75','R_100','1HZ10V','1HZ100V',...Array.from({length:24},(_,i)=>'X_'+(i+100))];
  const feed=new StubFeed(markets);
  const scanner=new MarketScanner({feed,maxLive:12,rotateMs:99999999});
  await scanner.start();
  assert.equal(scanner.current.size,12);
  for(let i=0;i<5;i++)scanner._rotate();
  for(const id of ['R_10','R_75','1HZ100V'])assert.ok(feed.subs.has(id),'core feed must stay monitored: '+id);
  const unique=new Set(feed.subscribed);
  assert.ok(unique.size>12,'should visit markets beyond initial batch');
  assert.equal(scanner.state().continuousFeeds,7);
  scanner.stop();
});

test('a continuously monitored synthetic market becomes ML-ready after 150 live ticks',async()=>{
  const feed=new StubFeed(['R_75',...Array.from({length:30},(_,i)=>'X_'+(i+100))]);
  const scanner=new MarketScanner({feed,maxLive:8,rotateMs:99999999});
  const ai=new AdaptiveEngine();
  await scanner.start();
  for(let i=0;i<151;i++){
    const tick={symbol:'R_75',digit:i%10};
    scanner.onTick(tick);ai.onTick(tick);
    if (i===70)scanner._rotate();
  }
  assert.equal(ai.state(scanner).readyMarkets,1);
  assert.ok(ai.rankings(scanner).some(r=>r.symbol==='R_75'));
  scanner.stop();
});

test('the online learner retains 89 separate market models rather than evicting after 72',()=>{
  const ai=new AdaptiveEngine();
  for(let j=0;j<89;j++) ai.onTick({symbol:'X_'+j,digit:j%10});
  assert.equal(ai.models.size,89);
  assert.equal(ai.models.has('X_0'),true);
});
