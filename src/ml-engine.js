'use strict';
// Genuine online 10-class softmax regression. Each observed next tick is labelled only
// AFTER a forecast is scored (prequential / walk-forward), then used for SGD training.
// No LLM, no guarantee of nonrandom digits or positive trading EV.
const { TYPES } = require('./decision');
const { EventEmitter } = require('node:events');
const FEATURES = 61;
const CONTEXT = 30;
const WARMUP = 120;
const MAX_MODELS = 128; // Deriv may expose 89+ markets; retain training across scan rotations.
const MAX_HISTORY = 100;
const EVAL_WINDOW = 250;
const LOG_UNIFORM = Math.log(10);
const MAX_AGE_MS = 90000;
const bound = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const validDigit = n => Number.isInteger(n) && n >= 0 && n <= 9;

function features(history) {
  if (history.length < CONTEXT) return null;
  const v = new Float64Array(FEATURES);
  v[0] = 1;
  // Three previous digits, and normalized frequencies in three backward windows.
  for (let lag = 0; lag < 3; lag++) v[1 + lag*10 + history[history.length-1-lag]] = 1;
  for (let w = 0; w < 3; w++) {
    const count = [5,15,30][w];
    for (let j = history.length-count; j < history.length; j++) v[31 + 10*w + history[j]] += 1/count;
  }
  return v;
}
function logits(weights, x) {
  const scores = Array(10).fill(0);
  for (let k=0; k<10; k++) for(let j=0; j<FEATURES; j++) scores[k] += weights[k][j]*x[j];
  const top = Math.max(...scores);
  const exp = scores.map(z => Math.exp(z-top));
  const sum = exp.reduce((a,b)=>a+b,0);
  return exp.map(z => z/sum);
}
function newRecord(symbol) {
  return { symbol, digits:[], weights:Array.from({length:10},()=>Array(FEATURES).fill(0)),
    samples:0, forecasts:[], lastTick:0, startedAt:Date.now() };
}
function metrics(forecasts) {
  const n = forecasts.length;
  if (!n) return { n:0, logLoss:null, uniformLogLoss:+LOG_UNIFORM.toFixed(4), skill:null, verdict:'Collecting forward outcomes' };
  const mean = forecasts.reduce((sum, f)=>sum+f.loss,0)/n;
  const skill = LOG_UNIFORM-mean;
  return { n, logLoss:+mean.toFixed(4), uniformLogLoss:+LOG_UNIFORM.toFixed(4),
    skill:+skill.toFixed(4), verdict:n<80 ? 'Insufficient forward tests' :
      skill>0.015 ? 'Better than uniform recently (not proven)' : 'No measured edge over uniform' };
}
class AdaptiveEngine extends EventEmitter {
  constructor() {
    super();
    this.models = new Map();
    this.feedback = new Map();
    this.totalTicks = 0;
    this.totalSettlements = 0;
    this.lastUpdate = null;
    this.importedAt = null;
  }
  _get(symbol) {
    if (!/^[A-Za-z0-9_]{2,48}$/.test(symbol)) return null;
    let model = this.models.get(symbol);
    if (!model) {
      if (this.models.size >= MAX_MODELS) {
        // Keep a bounded working set on the small Render instance.
        const first = this.models.keys().next().value;
        this.models.delete(first);
      }
      model = newRecord(symbol); this.models.set(symbol,model);
    }
    return model;
  }
  onTick({ symbol, digit }) {
    if (!validDigit(digit) || typeof symbol !== 'string') return;
    const model = this._get(symbol);
    if (!model) return;
    const x = features(model.digits);
    if (x) {
      const p = logits(model.weights, x); // predictive evaluation BEFORE update, no look-ahead
      model.forecasts.push({loss:-Math.log(Math.max(1e-12,p[digit]))});
      if (model.forecasts.length > EVAL_WINDOW) model.forecasts.shift();
      const eta = 0.06/Math.sqrt(1 + model.samples/180);
      for (let k=0; k<10; k++) {
        const delta = (k===digit?1:0)-p[k];
        for (let j=0; j<FEATURES; j++) {
          const weight = model.weights[k][j];
          model.weights[k][j] = bound(weight + eta*(delta*x[j] - 0.001*weight), -3, 3);
        }
      }
      model.samples++;
    }
    model.digits.push(digit);
    if (model.digits.length > MAX_HISTORY) model.digits.shift();
    model.lastTick=Date.now();
    this.lastUpdate=model.lastTick;
    this.totalTicks++;
    if (this.totalTicks % 50 === 0) this.emit('change');
  }
  probability(symbol) {
    const model=this.models.get(symbol);
    if (!model) return null;
    const x=features(model.digits);
    if (!x) return null;
    return logits(model.weights,x);
  }
  recordSettlement({symbol,type,profit,stake,id}) {
    if (typeof symbol !== 'string' || !TYPES[type] || !Number.isFinite(Number(profit)) || !Number.isFinite(Number(stake)) || !(Number(stake)>0)) return;
    const key=`${symbol}|${type}`;
    const r=this.feedback.get(key) || {n:0,wins:0,net:0,stake:0,ids:[]};
    if (id && r.ids.includes(String(id))) return; // no double-counted settlement
    r.n++; r.wins+=Number(profit)>0?1:0; r.net+=Number(profit); r.stake+=Number(stake);
    if (id) {r.ids.push(String(id));if(r.ids.length>100)r.ids.shift();}
    this.feedback.set(key,r);
    this.totalSettlements++;
    this.emit('change');
  }
  rankings(scanner, limit=20, {qualityOnly=false}={}) {
    const found=[];
    for (const [symbol,m] of this.models) {
      if (m.samples < WARMUP || Date.now()-m.lastTick > MAX_AGE_MS || !scanner.hasSymbol(symbol)) continue;
      const p=this.probability(symbol);
      if (!p || p.some(x => !Number.isFinite(x))) continue;
      const report=metrics(m.forecasts);
      for (const [type,rule] of Object.entries(TYPES)) {
        if (!scanner.allowsContract(symbol,type)) continue;
        const forecast = p.reduce((total, prob, digit) => total+(rule.accept(digit)?prob:0),0);
        // Regularize estimates toward fair digit odds. No claim of calibrated accuracy.
        const adjusted=rule.theoretical+0.4*(forecast-rule.theoretical);
        const feedback=this.feedback.get(`${symbol}|${type}`);
        const roi=feedback?.n ? feedback.net/feedback.stake : null;
        // Feedback is biased to chosen trades; use only as a cautious downside penalty.
        const penalty=feedback && feedback.n>=10 && roi<0 ? Math.min(0.08, -roi*0.1) : 0;
        const score=adjusted-rule.theoretical-penalty;
        found.push({symbol,name:scanner.byId?.get(symbol)?.name || symbol,type,label:rule.label,
          barrier:rule.barrier,sample:m.samples, baselinePct:+(rule.theoretical*100).toFixed(2),
          predictedPct:+(forecast*100).toFixed(2), adjustedPct:+(adjusted*100).toFixed(2),
          modelSkill:report.skill, modelLoss:report.logLoss, forecasts:report.n,
          modelVerdict:report.verdict, recentTradeCount:feedback?.n||0,
          realizedDemoROI:roi===null?null:+(100*roi).toFixed(1),
          score:+score.toFixed(5),ageSeconds:Math.round((Date.now()-m.lastTick)/1000),
          qualityGate:report.n>=120 && report.skill>0.015 });
      }
    }
    found.sort((a,b)=>b.score-a.score || b.forecasts-a.forecasts);
    return (qualityOnly ? found.filter(x=>x.qualityGate) : found).slice(0,Math.min(30,Math.max(1,limit)));
  }
  state(scanner) {
    const now = Date.now();
    const ready=[...this.models.values()].filter(x=>x.samples>=WARMUP && now-x.lastTick<MAX_AGE_MS);
    const fresh=[...this.models.values()].filter(x=>now-x.lastTick<MAX_AGE_MS);
    const closest=fresh.slice().sort((a,b)=>b.samples-a.samples)[0];
    const ranked=scanner?this.rankings(scanner,10):[];
    return {kind:'Online multinomial logistic regression (10 digit classes)',version:1,
      samplesNeeded:CONTEXT+WARMUP, totalTicks:this.totalTicks, trainedMarkets:this.models.size,
      freshMarkets:fresh.length, closestMarket:closest?.symbol || null,
      closestSamples:closest ? Math.min(CONTEXT+closest.samples,CONTEXT+WARMUP) : 0,
      readyMarkets:ready.length, totalSettlements:this.totalSettlements, lastUpdate:this.lastUpdate,
      importedAt:this.importedAt,
      leaders:ranked.map(r=>({symbol:r.symbol,name:r.name,strategy:r.label,predictedPct:r.predictedPct,
        baselinePct:r.baselinePct,adjustedPct:r.adjustedPct,modelSkill:r.modelSkill,
        forecasts:r.forecasts,modelVerdict:r.modelVerdict,tradeCount:r.recentTradeCount,
        realizedDemoROI:r.realizedDemoROI,qualityGate:r.qualityGate})),
      note:'Real online ML trained from completed tick outcomes, then checked on later unseen ticks. Recent skill is NOT evidence of a stable edge; trade outcomes are feedback, not a shortcut to prediction. All model data lives in server memory until backed up.' };
  }
  snapshot() {
    return {format:'market-shaker-online-ai',version:1,created:new Date().toISOString(),
      totalTicks:this.totalTicks,totalSettlements:this.totalSettlements,
      models:[...this.models.values()].map(m=>({symbol:m.symbol,digits:m.digits,weights:m.weights,
        samples:m.samples,forecasts:m.forecasts,lastTick:m.lastTick,startedAt:m.startedAt})),
      feedback:[...this.feedback].map(([key,r])=>({key,...r}))};
  }
  restore(data) {
    if (!data || data.format!=='market-shaker-online-ai' || data.version!==1 ||
      !Array.isArray(data.models) || data.models.length>MAX_MODELS ||
      !Array.isArray(data.feedback) || data.feedback.length>MAX_MODELS*4) throw new Error('Unsupported AI backup format');
    const models=new Map(),feedback=new Map();
    for (const row of data.models) {
      if (!row || typeof row.symbol!=='string' || !/^[A-Za-z0-9_]{2,48}$/.test(row.symbol) || models.has(row.symbol) ||
        !Array.isArray(row.digits) || row.digits.length>MAX_HISTORY || !row.digits.every(validDigit) ||
        !Number.isInteger(row.samples) || row.samples<0 || row.samples>100000000 ||
        !Array.isArray(row.forecasts) || row.forecasts.length>EVAL_WINDOW ||
        !row.forecasts.every(f=>f && Number.isFinite(f.loss) && f.loss>=0 && f.loss<100) ||
        !Array.isArray(row.weights) || row.weights.length!==10 ||
        !row.weights.every(w=>Array.isArray(w) && w.length===FEATURES && w.every(x=>Number.isFinite(x)&&Math.abs(x)<=3.01))) throw new Error('Invalid AI model weights or history');
      models.set(row.symbol,{symbol:row.symbol,digits:row.digits.slice(),samples:row.samples,
        forecasts:row.forecasts.map(f=>({loss:f.loss})),weights:row.weights.map(w=>w.slice()),
        lastTick:0,startedAt:Number(row.startedAt)||Date.now()});
    }
    for (const row of data.feedback) {
      if (!row || typeof row.key!=='string' || !/^[A-Za-z0-9_]{2,48}\|DIGIT(OVER|UNDER|DIFF|MATCH)$/.test(row.key) ||
        feedback.has(row.key) || !Number.isInteger(row.n) || row.n<0 || row.n>10000000 ||
        !Number.isInteger(row.wins) || row.wins<0 || row.wins>row.n ||
        !Number.isFinite(row.net) || !Number.isFinite(row.stake) || row.stake<0 ||
        !Array.isArray(row.ids) || row.ids.length>100 || !row.ids.every(x=>typeof x==='string' && x.length<64)) throw new Error('Invalid AI trade history');
      feedback.set(row.key,{n:row.n,wins:row.wins,net:row.net,stake:row.stake,ids:row.ids.slice()});
    }
    this.models=models;
    this.feedback=feedback;
    this.totalTicks=Number.isSafeInteger(data.totalTicks) && data.totalTicks>=0 ? data.totalTicks : 0;
    this.totalSettlements=Number.isSafeInteger(data.totalSettlements) && data.totalSettlements>=0 ? data.totalSettlements : 0;
    this.lastUpdate=null;
    this.importedAt=Date.now();
    this.emit('change');
    return this.state();
  }
}
module.exports={AdaptiveEngine,features,metrics,LOG_UNIFORM,WARMUP};
