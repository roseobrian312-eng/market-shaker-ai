'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {AdaptiveEngine,features,LOG_UNIFORM} = require('../src/ml-engine');
function scanning() {return {hasSymbol:s=>s.startsWith('R_'), allowsContract:()=>true,byId:new Map([['R_75',{name:'Volatility 75'}],['R_100',{name:'Volatility 100'}]])};}
test('model produces valid 10-digit probabilities and learns after labelled ticks, not before',()=>{
 const ai=new AdaptiveEngine();
 for(let i=0;i<30;i++)ai.onTick({symbol:'R_75',digit:i%10});
 assert.equal(ai.models.get('R_75').samples,0);
 assert.equal(ai.models.get('R_75').forecasts.length,0);
 ai.onTick({symbol:'R_75',digit:0});
 assert.equal(ai.models.get('R_75').samples,1);
 assert.equal(ai.models.get('R_75').forecasts.length,1);
 const p=ai.probability('R_75');
 assert.equal(p.length,10);
 assert.ok(Math.abs(p.reduce((a,b)=>a+b,0)-1)<1e-10);
 assert.ok(p.every(n=>n>0 && n<1));
 const before=ai.totalTicks;
 ai.onTick({symbol:'R_75',digit:10});
 assert.equal(ai.totalTicks,before);
});
test('walk-forward learning can beat uniform on deterministic sequence without same-tick leakage',()=>{
 const ai=new AdaptiveEngine();
 // Deterministic progression (digit 0→1→2→3→...); predictable from previous digit.
 for(let i=0;i<2400;i++)ai.onTick({symbol:'R_75',digit:i%10});
 const rec=ai.models.get('R_75');
 const loss=rec.forecasts.reduce((sum,r)=>sum+r.loss,0)/rec.forecasts.length;
 assert.ok(loss<LOG_UNIFORM*0.5,`expected trainable pattern to beat uniform, loss=${loss}`);
 const leader=ai.rankings(scanning());
 assert.ok(leader.length>0);
 assert.ok(leader.every(x=>x.forecasts===250));
 assert.equal(ai.state(scanning()).readyMarkets,1);
});
test('market rankings work across two markets using model predictions',()=>{
 const ai=new AdaptiveEngine();
 for(let i=0;i<240;i++){
   ai.onTick({symbol:'R_100',digit:(i*7)%10});
   ai.onTick({symbol:'R_75',digit:(i*3)%10});
 }
 const rows=ai.rankings(scanning(),30);
 assert.ok(rows.some(r=>r.symbol==='R_100'));
 assert.ok(rows.some(r=>r.symbol==='R_75'));
 assert.ok(rows.every(r=>r.predictedPct>=0 && r.predictedPct<=100));
 assert.ok(rows.some(r=>r.type==='DIGITMATCH'));
});
test('settled demo trades supply separate feedback, not training labels; deduplicated',()=>{
 const ai=new AdaptiveEngine();
 const original=ai.totalTicks;
 ai.recordSettlement({id:'a',symbol:'R_75',type:'DIGITUNDER',stake:1,profit:-1});
 ai.recordSettlement({id:'a',symbol:'R_75',type:'DIGITUNDER',stake:1,profit:-1});
 ai.recordSettlement({id:'b',symbol:'R_75',type:'DIGITUNDER',stake:1,profit:0.18});
 assert.equal(ai.totalSettlements,2);
 assert.equal(ai.totalTicks,original);
 assert.ok(Math.abs(ai.feedback.get('R_75|DIGITUNDER').net + 0.82) < 1e-9);
});
test('save and restore learner without credentials, rejects corrupt backup',()=>{
 const ai=new AdaptiveEngine();
 for(let i=0;i<180;i++)ai.onTick({symbol:'R_75',digit:i%10});
 ai.recordSettlement({id:'aaa',symbol:'R_75',type:'DIGITOVER',stake:1,profit:0.18});
 const snapshot=JSON.parse(JSON.stringify(ai.snapshot()));
 assert.ok(!JSON.stringify(snapshot).includes('DERIV_PAT'));
 const restored=new AdaptiveEngine();
 restored.restore(snapshot);
 assert.equal(restored.totalTicks,ai.totalTicks);
 assert.equal(restored.totalSettlements,1);
 assert.equal(restored.models.get('R_75').samples,ai.models.get('R_75').samples);
 assert.equal(restored.models.get('R_75').lastTick,0);
 restored.onTick({symbol:'R_75',digit:2});
 assert.equal(restored.state(scanning()).readyMarkets,1);
 snapshot.models[0].weights[1][3]='malicious';
 assert.throws(()=>restored.restore(snapshot),/Invalid AI model/);
 assert.equal(restored.models.get('R_75').samples,ai.models.get('R_75').samples+1);
});
test('quality gating declines trades without forward-test advantage',async()=>{
 const {DemoTrader}=require('../src/trading');
 const trader=new DemoTrader({token:'fake',appId:'test'});
 trader.status='connected';trader.connectedOnce=true;
 trader.settings.cooldown=0;
 const scanner={active:true,hasSymbol:()=>true,allowsContract:()=>true};
 const ai={rankings:()=>[{symbol:'R_75',name:'V75',type:'DIGITOVER',label:'Over 1',adjustedPct:86,baselinePct:80,modelSkill:-0.1,forecasts:200,qualityGate:false}],state:()=>({readyMarkets:1})};
 let calls=0;
 trader.previewQuote=async c=>{calls++;return {symbol:c.symbol,type:c.type,at:Date.now(),stake:1,ask:1,payout:1.2,estimatedNet:.1,fairNet:-.04,proposal:{id:'x'}};};
 trader.place=async()=>{throw Error('Should not place trade');};
 trader.startAuto({count:1,confirm:'DEMO ONLY',scanner,mode:'quality'});
 await trader.scanAndTrade(scanner,ai);
 assert.equal(trader.autoPlaced,0);
 assert.equal(trader.auto,true);
 assert.match(trader.autoReason,/No (AI candidate passed|forward-evaluated AI candidate)/);
 trader.stopAuto();
});
