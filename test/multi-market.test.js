'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {MarketScanner,parseActiveSymbols} = require('../src/market-scanner');
const {DemoTrader} = require('../src/trading');
class Feed extends EventEmitter {
  constructor(){ super(); this.status='connected'; this.subs=new Set(); this.calls=[]; }
  request(payload) { this.calls.push(payload); return Promise.resolve({active_symbols:[
    {symbol:'R_100',display_name:'Volatility 100',market:'synthetic_index'},
    {symbol:'R_75',display_name:'Volatility 75',market:'synthetic_index'},
    {symbol:'R_25',display_name:'Volatility 25',market:'synthetic_index'},
    {symbol:'R_SUSP',display_name:'Suspended',is_trading_suspended:1}
  ]}); }
  subscribeTicks(id){this.subs.add(id);}
  unsubscribeTicks(id){this.subs.delete(id);}
}
test('active-symbol discovery accepts available Deriv symbols and rejects suspended', async () => {
  assert.deepEqual(parseActiveSymbols({active_symbols:[
    {symbol:'R_100',display_name:'V100'}, {symbol:'BAD*SYMBOL'}, {symbol:'HALT',is_trading_suspended:1}
  ]}).map(x=>x.id),['R_100']);
  const feed = new Feed(), scanner = new MarketScanner({feed,maxLive:2,rotateMs:100000});
  await scanner.start();
  assert.equal(scanner.symbols.length,3);
  assert.equal(scanner.current.size,2);
  assert.equal(scanner.state().discovered,3);
  scanner._rotate();
  assert.equal(scanner.state().round,2);
  assert.equal(feed.subs.size,2);
  scanner.stop();
});
test('multi-market rankings use recent live digits, not selected chart', () => {
  const feed=new Feed(); const scanner=new MarketScanner({feed});
  const mk = (symbol,digit) => ({symbol,digit});
  for(let i=0;i<60;i++) {
    scanner.onTick(mk('R_100',i%10));
    scanner.onTick(mk('R_75',i%2===0 ? 3 : 9));
  }
  const result=scanner.rankings(10);
  assert.ok(result.some(x => x.symbol === 'R_75'));
  assert.equal(result[0].symbol,'R_75');
  scanner.blockContract('R_75','DIGITOVER','Contract unsupported');
  assert.equal(scanner.rankings(20).some(x => x.symbol==='R_75' && x.type==='DIGITOVER'),false);
});
test('auto chooses market from scanner candidates, enforces requested order target and stops', async () => {
  const demo=new DemoTrader({token:'fake',appId:'test'});
  demo.status='connected';demo.connectedOnce=true;
  demo.settings.cooldown=0;
  demo.settings.maxTrades=10;
  demo.marketValidator=()=>true;
  const scanner={active:true, hasSymbol:()=>true, allowsContract:()=>true,
    rankings:()=>[
      {symbol:'R_100',name:'V100',type:'DIGITOVER',label:'Over 1',barrier:'1',sample:60,observedPct:81,baselinePct:80,adjustedPct:80.4},
      {symbol:'R_75',name:'V75',type:'DIGITUNDER',label:'Under 8',barrier:'8',sample:70,observedPct:84,baselinePct:80,adjustedPct:82.8}
    ]};
  demo.previewQuote=async c=>({symbol:c.symbol,type:c.type,stake:1,at:Date.now(),ask:1,payout:1.2,
    estimatedNet:c.symbol==='R_75'?0.10:-0.04,fairNet:-0.04,proposal:{id:'test'}});
  const ai={rankings:()=>scanner.rankings(),state:()=>({readyMarkets:2})};
  const trades=[];
  demo.place=async ({symbol,type})=>{trades.push({symbol,type});demo.tradesToday++;return{id:String(trades.length)}};
  demo.startAuto({count:2,confirm:'DEMO ONLY',scanner,mode:'research'});
  assert.equal(demo.auto,true);
  await demo.scanAndTrade(scanner,ai);
  assert.equal(demo.autoPlaced,1);
  assert.equal(trades[0].symbol,'R_75');
  demo.lastAutoCheck=0;
  await demo.scanAndTrade(scanner,ai);
  assert.equal(demo.autoPlaced,2);
  assert.equal(demo.auto,false);
  assert.equal(trades.length,2);
});
test('auto refuses quantities greater than remaining session trades and no verified scan', () => {
  const demo=new DemoTrader({token:'fake',appId:'test'});
  demo.status='connected';demo.connectedOnce=true;
  demo.tradesToday=19;
  assert.throws(()=>demo.startAuto({count:2,confirm:'DEMO ONLY',scanner:{active:true}}),/session trade limit/);
  assert.throws(()=>demo.startAuto({count:1,confirm:'DEMO ONLY',scanner:{active:false}}),/Scan all markets/);
  assert.throws(()=>demo.startAuto({count:30,confirm:'DEMO ONLY',scanner:{active:true}}),/1–20/);
});


test('ChatGPT-assisted DEMO auto uses only verified quoted choice and cannot invent a contract', async () => {
  const demo=new DemoTrader({token:'fake',appId:'test'});
  demo.status='connected'; demo.connectedOnce=true;demo.marketValidator=()=>true;demo.settings.cooldown=0;
  const t=Date.now();
  const scanner={active:true,hasSymbol:()=>true,allowsContract:()=>true,
    state:()=>({active:true,message:'Running',discovered:2,watching:2,warmed:2,minimumTicks:30}),
    rankings:()=>[],history:new Map(),latest:new Map(),byId:new Map()};
  const choices=[
    {symbol:'R_100',name:'V100',type:'DIGITOVER',label:'Over 1',sample:250,adjustedPct:80.3,baselinePct:80,predictedPct:82,forecasts:125,ageSeconds:0,modelSkill:0.02},
    {symbol:'R_75',name:'V75',type:'DIGITUNDER',label:'Under 8',sample:300,adjustedPct:82,baselinePct:80,predictedPct:85,forecasts:135,ageSeconds:0,modelSkill:0.03}
  ];
  const ai={rankings:()=>choices,state:()=>({kind:'online',totalTicks:1000,readyMarkets:2,totalSettlements:0})};
  demo.previewQuote=async c=>({symbol:c.symbol,type:c.type,stake:1,at:t,ask:1,payout:1.24,
    estimatedNet:c.symbol==='R_75'?0.08:-0.02,fairNet:-0.01,breakEven:1/1.24,proposal:{id:'quote'}});
  let pickCalled=0;
  const advisor={configured:()=>true,canSelect:()=>true,selectionCount:0,
    selectDemo:async(quotes,ctx)=>{pickCalled++;assert.equal(quotes.length,2);assert.equal(ctx.demo.connected,true);
      return {index:0,reason:'Demo experiment only'};}};
  const trades=[];
  demo.place=async ({symbol,type,source,quote})=>{trades.push({symbol,type,source,quote});return{id:'contract1'};};
  demo.startAuto({count:1,confirm:'DEMO ONLY',scanner,mode:'assistant'});
  await demo.scanAndTrade(scanner,ai,advisor);
  assert.equal(pickCalled,1);
  assert.equal(trades.length,1);
  assert.equal(trades[0].symbol,'R_100');
  assert.equal(trades[0].source,'chatgpt-assisted-demo');
  assert.equal(trades[0].quote.proposal.id,'quote');
  assert.equal(demo.auto,false);
});

test('ChatGPT-assisted DEMO mode respects WAIT and never creates an order', async () => {
  const demo=new DemoTrader({token:'fake',appId:'test'});
  demo.status='connected';demo.connectedOnce=true;demo.settings.cooldown=0;
  const scanner={active:true,hasSymbol:()=>true,allowsContract:()=>true,
    state:()=>({active:true,message:'Active',discovered:1,watching:1,warmed:1,minimumTicks:30}),
    rankings:()=>[],history:new Map(),latest:new Map(),byId:new Map()};
  const ai={rankings:()=>[{symbol:'R_100',type:'DIGITOVER',name:'V100',label:'Over 1',sample:250,
    adjustedPct:81,baselinePct:80,predictedPct:81,forecasts:125,ageSeconds:0,modelSkill:0.01}],
    state:()=>({kind:'online',totalTicks:500,readyMarkets:1,totalSettlements:0})};
  demo.previewQuote=async c=>({symbol:c.symbol,type:c.type,stake:1,at:Date.now(),ask:1,payout:1.1,
    estimatedNet:-0.1,fairNet:-0.12,breakEven:1/1.1,proposal:{id:'quote'}});
  const advisor={configured:()=>true,canSelect:()=>true,selectionCount:0,
    selectDemo:async()=>({index:null,reason:'Payout offers no advantage'})};
  demo.place=async()=>{throw new Error('Should never be called');};
  demo.startAuto({count:1,confirm:'DEMO ONLY',scanner,mode:'assistant'});
  await demo.scanAndTrade(scanner,ai,advisor);
  assert.equal(demo.autoPlaced,0);
  assert.equal(demo.auto,true);
  assert.match(demo.autoReason,/WAIT/);
});
