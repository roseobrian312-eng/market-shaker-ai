'use strict';
// UI-only. Private OpenAI and Deriv credentials never appear in the browser.
(() => {
  const $ = id => document.getElementById(id);
  const history = [];
  let sending = false;
  let configured = false;
  const chat = $('assistant-chat');
  function add(role, content, details = '') {
    const row = document.createElement('div');
    row.className = `chat-line ${role === 'user' ? 'user' : 'bot'}`;
    const bubble = document.createElement('div');bubble.className='bubble';
    const heading = document.createElement('strong');heading.textContent=role==='user'?'You':'Market Shaker AI';
    const p=document.createElement('p');p.textContent=content;
    bubble.append(heading,p);
    if (details) {const small=document.createElement('small');small.textContent=details;bubble.append(small);}
    row.append(bubble);chat.append(row);
    while (chat.children.length>32) chat.firstElementChild.remove();
    chat.scrollTop=chat.scrollHeight;
    return row;
  }
  async function get(route,data) {
    const res=await fetch('/api/'+route,{method:data===undefined?'GET':'POST',
      headers:data===undefined?{}:{'Content-Type':'application/json'},credentials:'same-origin',
      ...(data===undefined?{}:{body:JSON.stringify(data)})});
    const json=await res.json();
    if(!res.ok)throw new Error(json.error||`HTTP ${res.status}`);
    return json;
  }
  async function poll() {
    if ($('trade-panel').hidden) return;
    try {
      const [status,context] = await Promise.all([get('assistant/status'),get('assistant/context')]);
      configured=status.configured;
      $('assistant-status').textContent=configured?'AI API ready':'AI API not configured';
      $('assistant-status').className='badge '+(configured?'on':'warn');
      $('assistant-feed').textContent=`Snapshot ${new Date(context.capturedAt).toLocaleTimeString()} · ${context.scanner.activeFeeds} monitored feeds · ${context.learning.learnedTicks.toLocaleString()} learned ticks`;
      $('assistant-budget').textContent=`Chat ${status.chatCalls}/${status.maxChatCalls} · AI demo picks ${status.aiSelections}/${status.maxAiSelections}`;
      $('assistant-send').disabled=sending||!configured;
    } catch(e) {
      if (!/401|unlock/i.test(e.message)) $('assistant-feed').textContent='Context unavailable: '+e.message;
    }
  }
  async function ask(question) {
    question=String(question||'').trim();
    if (!question||sending) return;
    if (!configured) {add('assistant','To activate ChatGPT, add OPENAI_API_KEY to Render → Environment, save and deploy.');return;}
    if ($('trade-panel').hidden) return;
    sending=true;$('assistant-send').disabled=true;
    $('assistant-question').value='';
    add('user',question);
    const thinking=add('assistant','Reviewing a fresh Deriv market snapshot…');
    try {
      const response=await get('assistant/chat',{message:question,history:history.slice(-6)});
      thinking.remove();add('assistant',response.reply,`Snapshot: ${new Date(response.snapshotTime).toLocaleString()} · ${response.model}`);
      history.push({role:'user',content:question},{role:'assistant',content:response.reply.slice(0,1200)});
      if(history.length>10)history.splice(0,history.length-10);
    }catch(e){thinking.remove();add('assistant','Unable to respond: '+e.message);}
    finally {sending=false;$('assistant-send').disabled=!configured;poll();}
  }
  $('assistant-form').addEventListener('submit',e=>{e.preventDefault();ask($('assistant-question').value);});
  for(const btn of document.querySelectorAll('[data-ai-prompt]')) btn.addEventListener('click',()=>ask(btn.dataset.aiPrompt));
  $('assistant-send').disabled=true;
  setInterval(poll,14000);poll();
})();
