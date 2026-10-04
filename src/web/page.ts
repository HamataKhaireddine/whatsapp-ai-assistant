/** Minimal, dependency-free web chat used for local testing (and as a "website widget" demo). */
export const CHAT_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AI Customer Assistant - demo</title>
<style>
  :root { --bg:#efeae2; --me:#d9fdd3; --bot:#fff; --accent:#008069; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:#d1d7db; display:flex; justify-content:center; }
  .app { width:100%; max-width:480px; height:100vh; display:flex; flex-direction:column; background:var(--bg); }
  header { background:var(--accent); color:#fff; padding:14px 16px; display:flex; justify-content:space-between; align-items:center; }
  header small { opacity:.8; display:block; font-size:12px; }
  header button { background:transparent; color:#fff; border:1px solid #ffffff80; border-radius:6px; padding:4px 10px; cursor:pointer; }
  #log { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:8px; }
  .msg { max-width:85%; padding:8px 10px; border-radius:8px; white-space:pre-wrap; line-height:1.35; box-shadow:0 1px .5px #0002; }
  .me { align-self:flex-end; background:var(--me); }
  .bot { align-self:flex-start; background:var(--bot); }
  .tool { align-self:flex-start; font: 12px ui-monospace, monospace; color:#555; background:#ffffffa0; padding:3px 8px; border-radius:6px; }
  form { display:flex; gap:8px; padding:10px; background:#f0f2f5; }
  input { flex:1; padding:10px 14px; border-radius:20px; border:none; font-size:15px; }
  form button { background:var(--accent); color:#fff; border:none; border-radius:20px; padding:0 18px; cursor:pointer; }
</style>
</head>
<body>
<div class="app">
  <header><div>🐾 Customer Assistant<small id="mode">demo</small></div><button id="reset" type="button">Reset</button></header>
  <div id="log"></div>
  <form id="f"><input id="q" autocomplete="off" placeholder="Ask about products or book an appointment..." /><button>Send</button></form>
</div>
<script>
  const log = document.getElementById('log');
  let sessionId = sessionStorage.getItem('sid') || '';
  const add = (cls, text) => { const d = document.createElement('div'); d.className = 'msg ' + cls; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; };
  const tool = (t) => { const d = document.createElement('div'); d.className = 'tool'; d.textContent = '⚙ ' + t.name + '(' + JSON.stringify(t.args) + ')' + (t.ok ? '' : ' ✗'); log.appendChild(d); };
  fetch('/health').then(r => r.json()).then(h => { document.getElementById('mode').textContent = 'LLM: ' + h.llm + ' · WhatsApp: ' + h.whatsapp; });
  add('bot', 'Hi! Try "dog food under $30", "tell me about P010" or "book a grooming tomorrow".');
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = document.getElementById('q'); const message = q.value.trim(); if (!message) return;
    q.value = ''; add('me', message); const pending = add('bot', '…');
    try {
      const r = await fetch('/api/chat', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ sessionId, message }) });
      const data = await r.json(); pending.remove();
      if (!r.ok) return add('bot', 'Error: ' + data.error);
      sessionId = data.sessionId; sessionStorage.setItem('sid', sessionId);
      (data.toolCalls || []).forEach(tool); add('bot', data.reply);
    } catch (err) { pending.textContent = 'Network error'; }
  });
  document.getElementById('reset').addEventListener('click', async () => {
    await fetch('/api/reset', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ sessionId }) });
    log.innerHTML = ''; add('bot', 'Conversation cleared. How can I help?');
  });
</script>
</body>
</html>`;
