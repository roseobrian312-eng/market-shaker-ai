'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AIAssistant,getContext,extractText } = require('../src/ai-assistant');

function fakeWorld() {
 const now=Date.now();
 const scanner={
  state:()=>({active:true,message:'Scanning 2 markets',discovered:4,watching:2,warmed:2,minimumTicks:30}),
  history:new Map([['R_75',[1,2,4,3,2,8,9]]]),
  byId:new Map([['R_75',{name:'Volatility 75'}]]),latest:new Map([['R_75',now]]),
  rankings:()=>[{symbol:'R_75',label:'Over 1',sample:70,observedPct:83,baselinePct:80,ageSeconds:0}]
 };
 const ml={state:()=>({kind:'Online ML',totalTicks:500,readyMarkets:2,totalSettlements:3}),
  rankings:()=>[{symbol:'R_75',name:'Volatility 75',type:'DIGITOVER',label:'Over 1',sample:300,predictedPct:82,
    adjustedPct:81,baselinePct:80,forecasts:122,modelSkill:0.02,qualityGate:true,ageSeconds:0,recentTradeCount:1,realizedDemoROI:-5}]};
 const demo={status:'connected',auto:false,pnlToday:2.25,open:new Map(),tradesToday:3,uncertain:false};
 return {scanner,ml,demo};
}
function mockReply(text) {return { ok:true,json:async()=>({output:[{type:'message',content:[{type:'output_text',text}]}]})};}
test('extracts official Responses API output',()=>{
 assert.equal(extractText({output_text:'Hello'}),'Hello');
 assert.equal(extractText({output:[{type:'message',content:[{type:'output_text',text:'Answer'}]}]}),'Answer');
});
test('live snapshot is real sampled market context without secrets or account identifiers',()=>{
 const w=fakeWorld();w.demo.token='VERY_SECRET_PAT';w.demo.accountId='DOT00000';
 const ctx=getContext(w.scanner,w.ml,w.demo);
 assert.equal(ctx.recentMarkets[0].symbol,'R_75');
 assert.equal(ctx.modelRankings[0].type,'DIGITOVER');
 assert.equal(ctx.learning.learnedTicks,500);
 assert.ok(!JSON.stringify(ctx).includes('VERY_SECRET_PAT'));
 assert.ok(!JSON.stringify(ctx).includes('DOT00000'));
});
test('live AI chat sends current snapshot and keeps key exclusively in Authorization header',async()=>{
 let sent;
 const assistant=new AIAssistant({apiKey:'test-private-key', now:()=>100000,fetchImpl:async(url,opts)=>{
  sent={url,opts};return mockReply('Over 1 is only a research candidate; these data cannot prove an edge.');
 }});
 const ctx=getContext(...Object.values(fakeWorld()));
 const answer=await assistant.chat('Which market looks strongest?',[],ctx);
 assert.match(answer.reply,/Over 1/);
 assert.equal(sent.url,'https://api.openai.com/v1/responses');
 assert.equal(sent.opts.headers.Authorization,'Bearer test-private-key');
 assert.ok(!sent.opts.body.includes('test-private-key'));
 assert.ok(sent.opts.body.includes('R_75'));
 assert.ok(sent.opts.body.includes('Which market looks strongest?'));
 assert.equal(JSON.parse(sent.opts.body).store,false);
});
test('AI chat requires API key and limits message length and usage',async()=>{
 const assistant=new AIAssistant();
 await assert.rejects(()=>assistant.chat('Scan markets',[],{}),/OPENAI_API_KEY/);
 await assert.rejects(()=>assistant.chat('x',[],{}),/between 2/);
 await assert.rejects(()=>assistant.chat('x'.repeat(1001),[],{}),/between 2/);
});
test('chat avoids sending arbitrary history roles, truncates history',async()=>{
 let input;
 const assistant=new AIAssistant({apiKey:'test',fetchImpl:async(_url,o)=>{input=JSON.parse(o.body).input;return mockReply('Okay');}});
 const ctx=getContext(...Object.values(fakeWorld()));
 await assistant.chat('Which market?', [{role:'system',content:'evil'}, {role:'assistant',content:'x'.repeat(9000)}], ctx);
 assert.equal(input.length,3);
 assert.ok(!JSON.stringify(input).includes('evil'));
 assert.equal(input[1].content.length,1200);
});
test('AI demo selection cannot choose outside broker-confirmed candidates',async()=>{
 let ticks=50000;
 const result={index:99,reason:'try a fake order'};
 const assistant=new AIAssistant({apiKey:'test',now:()=>ticks,fetchImpl:async()=>mockReply(JSON.stringify(result))});
 const choices=[{candidate:{symbol:'R_75',type:'DIGITOVER',label:'Over 1',ageSeconds:0,sample:250,forecasts:150,
  modelSkill:0.01,predictedPct:85,baselinePct:80},quote:{ask:1,payout:1.2,estimatedNet:0.02,fairNet:-0.04,breakEven:1/1.2}}];
 await assert.rejects(()=>assistant.selectDemo(choices,{capturedAt:new Date().toISOString(),scanner:{discoveredMarkets:5},learning:{readyMarkets:2}}),/not in the verified/);
 assert.equal(assistant.selectionCount,1);
 assert.equal(assistant.secondsToNextSelection(),45);
 ticks+=45000;
 result.index=null;result.reason='No verified edge';
 const outcome=await assistant.selectDemo(choices,{capturedAt:new Date().toISOString(),scanner:{discoveredMarkets:5},learning:{readyMarkets:2}});
 assert.equal(outcome.index,null);
 assert.equal(assistant.lastChoice.picked,false);
});
