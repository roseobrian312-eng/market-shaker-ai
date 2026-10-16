'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {DerivClient}=require('../src/deriv');
class Socket {
 constructor(url){this.url=url;this.readyState=0;this.events={};this.sent=[];queueMicrotask(()=>{this.readyState=1;this.emit('open',{});});}
 addEventListener(name,cb){(this.events[name] ||= []).push(cb);}
 emit(name,data){for(const f of this.events[name]||[])f(data);}
 send(payload){const msg=JSON.parse(payload);this.sent.push(msg);if(msg.active_symbols)queueMicrotask(()=>this.emit('message',{data:JSON.stringify({msg_type:'active_symbols',req_id:msg.req_id,active_symbols:[{symbol:'R_75',display_name:'V75'}]})}));}
 close(){this.readyState=3;this.emit('close',{code:1000,reason:'test'});}
}
test('public Deriv discovery plus subscription/forget works and keeps API tokens out of WS URL',async()=>{
 let ws;
 class CapturedSocket extends Socket {constructor(url){super(url);ws=this;}}
 const client=new DerivClient({WebSocketImpl:CapturedSocket});
 client.connect();
 await new Promise(r=>setTimeout(r,1));
 const result=await client.request({active_symbols:'brief'});
 assert.equal(result.active_symbols[0].symbol,'R_75');
 client.subscribeTicks('R_75');
 await new Promise(r=>setTimeout(r,200));
 assert.ok(ws.sent.some(m=>m.ticks==='R_75' && m.subscribe===1));
 let received;
 client.on('tick',t=>received=t);
 ws.emit('message',{data:JSON.stringify({msg_type:'tick',tick:{symbol:'R_75',quote:123.45,epoch:1,pip_size:2},subscription:{id:'subscription-42'}})});
 assert.equal(received.symbol,'R_75');
 client.unsubscribeTicks('R_75');
 assert.ok(ws.sent.some(m=>m.forget==='subscription-42'));
 assert.equal(client.subs.size,0);
 ws.close();
});
