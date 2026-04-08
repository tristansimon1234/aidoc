(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  var API_KEY = script.getAttribute('data-key');
  if (!API_KEY) { console.error('[AiDoc] Missing data-key attribute'); return; }

  // User context — the client app can pass info about the logged-in user
  var USER_NAME = script.getAttribute('data-user-name') || '';
  var USER_EMAIL = script.getAttribute('data-user-email') || '';
  var USER_PLAN = script.getAttribute('data-user-plan') || '';
  var USER_CONTEXT = script.getAttribute('data-user-context') || '';

  // Track current page URL — updates on navigation (SPA support)
  function getCurrentPage() { return window.location.href; }

  var API_BASE = script.src.replace(/\/widget\.js.*$/, '/api/widget');
  var projectName = '';
  var messages = [];
  var isOpen = false;
  var isSending = false;

  var dynamicSuggestions = [];

  // --- Fetch config + suggestions ---
  fetch(API_BASE + '/' + API_KEY + '/config')
    .then(function (r) { return r.json(); })
    .then(function (cfg) {
      projectName = cfg.projectName || 'this product';
      if (cfg.suggestions && cfg.suggestions.length > 0) dynamicSuggestions = cfg.suggestions;
    })
    .catch(function () {});

  // --- Styles ---
  var style = document.createElement('style');
  style.textContent = [
    '#aidoc-widget-btn{position:fixed;bottom:24px;right:24px;z-index:99999;width:56px;height:56px;border-radius:50%;background:#2563eb;border:none;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;transition:transform .15s}',
    '#aidoc-widget-btn:hover{transform:scale(1.08)}',
    '#aidoc-widget-btn svg{width:28px;height:28px;fill:white}',
    '#aidoc-widget-panel{position:fixed;bottom:96px;right:24px;z-index:99999;width:400px;max-width:calc(100vw - 48px);height:560px;max-height:calc(100vh - 120px);border-radius:16px;background:#0C0C0E;border:1px solid #2a2a2e;display:none;flex-direction:column;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.5);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    '#aidoc-widget-panel.open{display:flex}',
    '#aidoc-widget-header{padding:16px 20px;border-bottom:1px solid #2a2a2e;background:#141416;display:flex;justify-content:space-between;align-items:center}',
    '#aidoc-widget-header span{font-size:14px;font-weight:600;color:#e5e5e5}',
    '#aidoc-widget-close{background:none;border:none;color:#888;cursor:pointer;font-size:20px;padding:0;line-height:1}',
    '#aidoc-widget-messages{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:12px}',
    '.aidoc-msg{max-width:88%;font-size:13px;line-height:1.6;padding:10px 14px;border-radius:12px;word-wrap:break-word}',
    '.aidoc-msg img{max-width:100%;border-radius:8px;margin:8px 0}',
    '.aidoc-msg-user{align-self:flex-end;background:#2563eb;color:white;border-radius:12px 12px 4px 12px}',
    '.aidoc-msg-bot{align-self:flex-start;background:#141416;color:#e5e5e5;border:1px solid #2a2a2e;border-radius:12px 12px 12px 4px}',
    '.aidoc-sources{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;padding-top:8px;border-top:1px solid #2a2a2e}',
    '.aidoc-source{font-size:10px;color:#60a5fa;background:rgba(37,99,235,.1);padding:2px 8px;border-radius:4px}',
    '.aidoc-welcome{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;text-align:center;padding:24px}',
    '.aidoc-welcome h3{font-size:15px;font-weight:600;color:#e5e5e5;margin:0}',
    '.aidoc-welcome p{font-size:12px;color:#888;margin:0;max-width:280px;line-height:1.5}',
    '.aidoc-suggestions{display:flex;flex-direction:column;gap:8px;width:100%;max-width:300px}',
    '.aidoc-suggestion{text-align:left;background:#141416;border:1px solid #2a2a2e;border-radius:8px;padding:8px 12px;color:#aaa;font-size:12px;cursor:pointer;transition:border-color .15s}',
    '.aidoc-suggestion:hover{border-color:#2563eb;color:#e5e5e5}',
    '#aidoc-widget-input{display:flex;gap:8px;padding:12px 16px;border-top:1px solid #2a2a2e;background:#141416}',
    '#aidoc-widget-input input{flex:1;background:#1C1C1F;border:1px solid #2a2a2e;border-radius:8px;padding:8px 12px;color:#e5e5e5;font-size:13px;outline:none}',
    '#aidoc-widget-input input:focus{border-color:#2563eb}',
    '#aidoc-widget-input button{background:#2563eb;border:none;color:white;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:500;cursor:pointer}',
    '#aidoc-widget-input button:disabled{opacity:.4;cursor:not-allowed}',
    '.aidoc-typing{font-size:12px;color:#888;padding:4px 0;align-self:flex-start}',
    '@media(max-width:480px){#aidoc-widget-panel{bottom:0;right:0;width:100vw;height:100vh;max-height:100vh;border-radius:0}#aidoc-widget-btn{bottom:16px;right:16px}}',
  ].join('\n');
  document.head.appendChild(style);

  // --- Button ---
  var btn = document.createElement('button');
  btn.id = 'aidoc-widget-btn';
  btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.2L4 17.2V4h16v12z"/></svg>';
  btn.title = 'Chat with docs';
  btn.onclick = function () { togglePanel(); };
  document.body.appendChild(btn);

  // --- Panel ---
  var panel = document.createElement('div');
  panel.id = 'aidoc-widget-panel';
  panel.innerHTML = [
    '<div id="aidoc-widget-header"><span>Ask about the docs</span><button id="aidoc-widget-close">&times;</button></div>',
    '<div id="aidoc-widget-messages"></div>',
    '<div id="aidoc-widget-input"><input placeholder="Ask a question..." /><button>Send</button></div>',
  ].join('');
  document.body.appendChild(panel);

  var msgContainer = panel.querySelector('#aidoc-widget-messages');
  var inputEl = panel.querySelector('#aidoc-widget-input input');
  var sendBtn = panel.querySelector('#aidoc-widget-input button');

  panel.querySelector('#aidoc-widget-close').onclick = function () { togglePanel(); };
  sendBtn.onclick = function () { sendMessage(inputEl.value); };
  inputEl.onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(inputEl.value); } };

  function togglePanel() {
    isOpen = !isOpen;
    panel.classList.toggle('open', isOpen);
    if (isOpen) {
      renderMessages();
      inputEl.focus();
    }
  }

  function renderMessages() {
    if (messages.length === 0) {
      msgContainer.innerHTML = [
        '<div class="aidoc-welcome">',
        '<div><h3>' + (USER_NAME ? 'Hi ' + USER_NAME + '!' : 'Hi! Ask me anything.') + '</h3>',
        '<p>I can help you find answers about ' + (projectName || 'this product') + '.</p></div>',
        '<div class="aidoc-suggestions">',
        (dynamicSuggestions.length > 0
          ? dynamicSuggestions
          : ['How does ' + projectName + ' work?', 'What are the main features?']
        ).map(function (s) { return '<button class="aidoc-suggestion">' + s + '</button>'; }).join(''),
        '</div></div>',
      ].join('');
      msgContainer.querySelectorAll('.aidoc-suggestion').forEach(function (el) {
        el.onclick = function () { sendMessage(el.textContent); };
      });
      return;
    }

    msgContainer.innerHTML = '';
    messages.forEach(function (m) {
      var div = document.createElement('div');
      div.className = 'aidoc-msg ' + (m.role === 'user' ? 'aidoc-msg-user' : 'aidoc-msg-bot');
      if (m.role === 'assistant') {
        div.innerHTML = simpleMarkdown(m.content);
        if (m.sources && m.sources.length > 0) {
          var srcDiv = document.createElement('div');
          srcDiv.className = 'aidoc-sources';
          m.sources.forEach(function (s) {
            var tag = document.createElement('span');
            tag.className = 'aidoc-source';
            tag.textContent = s.pageTitle;
            srcDiv.appendChild(tag);
          });
          div.appendChild(srcDiv);
        }
      } else {
        div.textContent = m.content;
      }
      msgContainer.appendChild(div);
    });

    // Render follow-up buttons for the last assistant message
    var lastMsg = messages[messages.length - 1];
    if (!isSending && lastMsg && lastMsg.role === 'assistant' && lastMsg.followUps && lastMsg.followUps.length > 0) {
      var fuDiv = document.createElement('div');
      fuDiv.className = 'aidoc-suggestions';
      fuDiv.style.alignSelf = 'flex-start';
      lastMsg.followUps.forEach(function (q) {
        var btn = document.createElement('button');
        btn.className = 'aidoc-suggestion';
        btn.textContent = q;
        btn.onclick = function () { sendMessage(q); };
        fuDiv.appendChild(btn);
      });
      msgContainer.appendChild(fuDiv);
    }

    if (isSending) {
      var typing = document.createElement('div');
      typing.className = 'aidoc-typing';
      typing.textContent = 'Searching docs...';
      msgContainer.appendChild(typing);
    }

    msgContainer.scrollTop = msgContainer.scrollHeight;
  }

  function sendMessage(text) {
    text = (text || '').trim();
    if (!text || isSending) return;

    inputEl.value = '';
    messages.push({ role: 'user', content: text });
    isSending = true;
    sendBtn.disabled = true;
    renderMessages();

    var history = messages.map(function (m) { return { role: m.role, content: m.content }; });

    fetch(API_BASE + '/' + API_KEY + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        history: history.slice(0, -1),
        userContext: { name: USER_NAME, email: USER_EMAIL, plan: USER_PLAN, extra: USER_CONTEXT, currentUrl: getCurrentPage() } }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        messages.push({ role: 'assistant', content: data.answer, sources: data.sources, followUps: data.followUps || [] });
      })
      .catch(function () {
        messages.push({ role: 'assistant', content: 'Sorry, something went wrong. Please try again.' });
      })
      .finally(function () {
        isSending = false;
        sendBtn.disabled = false;
        renderMessages();
        inputEl.focus();
      });
  }

  // Minimal markdown → HTML (bold, links, images, code, lists)
  function simpleMarkdown(md) {
    return md
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:#60a5fa">$1</a>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code style="background:#1C1C1F;padding:1px 4px;border-radius:3px;font-size:12px">$1</code>')
      .replace(/\n/g, '<br>');
  }
})();
