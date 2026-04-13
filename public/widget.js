(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  var API_KEY = script.getAttribute('data-key');
  if (!API_KEY) { console.error('[AiDoc] Missing data-key attribute'); return; }

  var USER_NAME = script.getAttribute('data-user-name') || '';
  var USER_EMAIL = script.getAttribute('data-user-email') || '';
  var USER_PLAN = script.getAttribute('data-user-plan') || '';
  var USER_CONTEXT = script.getAttribute('data-user-context') || '';

  // Defaults — overridden by data-cfg, localStorage cache, or config endpoint
  var C = {
    accent: script.getAttribute('data-color') || '#635BFF',
    bg: '#0C0C0E',
    text: '#E5E5E5',
    font: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    position: script.getAttribute('data-position') || 'right',
    greeting: script.getAttribute('data-greeting') || '',
  };

  // Inline design from data-cfg — instant theme, zero fetch needed
  try {
    var inlineCfg = script.getAttribute('data-cfg');
    if (inlineCfg) {
      var d = JSON.parse(inlineCfg);
      if (d.accentColor) C.accent = d.accentColor;
      if (d.bgColor) C.bg = d.bgColor;
      if (d.textColor) C.text = d.textColor;
      if (d.font) C.font = d.font;
      if (d.widgetPosition) C.position = d.widgetPosition;
      if (d.widgetGreeting) C.greeting = d.widgetGreeting;
    }
  } catch (e) {}

  function getCurrentPage() { return window.location.href; }

  var API_BASE = script.src.replace(/\/widget\.js.*$/, '/api/widget');
  var projectName = '';
  var messages = [];
  var isOpen = false;
  var isSending = false;
  var dynamicSuggestions = [];

  // --- Build CSS from current config ---
  function buildCSS() {
    var isDark = isColorDark(C.bg);
    var border = isDark ? '#2a2a2e' : '#e0e0e4';
    var subtle = isDark ? '#141416' : '#f3f4f6';
    var mutedText = isDark ? '#888' : '#888';
    var inputBg = isDark ? '#1C1C1F' : '#ffffff';
    var headerBg = isDark ? '#111113' : '#f9fafb';
    var tint = hexToRgba(C.accent, 0.1);
    var pos = C.position !== 'left' ? 'right' : 'left';

    return [
      '#aidoc-widget-btn{position:fixed;bottom:24px;' + pos + ':24px;z-index:99999;width:56px;height:56px;border-radius:50%;background:' + C.accent + ';border:none;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;transition:transform .15s,box-shadow .15s,background .3s}',
      '#aidoc-widget-btn:hover{transform:scale(1.08);box-shadow:0 6px 20px rgba(0,0,0,.35)}',
      '#aidoc-widget-btn svg{width:26px;height:26px;fill:white}',
      '#aidoc-widget-panel{position:fixed;bottom:96px;' + pos + ':24px;z-index:99999;width:400px;max-width:calc(100vw - 48px);height:560px;max-height:calc(100vh - 120px);border-radius:16px;background:' + C.bg + ';border:1px solid ' + border + ';display:none;flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,' + (isDark ? '.5' : '.15') + ');font-family:' + C.font + ';color:' + C.text + '}',
      '#aidoc-widget-panel.open{display:flex;animation:aidoc-in .2s cubic-bezier(.16,1,.3,1)}',
      '@keyframes aidoc-in{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}',
      '#aidoc-widget-header{padding:16px 20px;border-bottom:1px solid ' + border + ';background:' + headerBg + ';display:flex;justify-content:space-between;align-items:center}',
      '#aidoc-widget-header span{font-size:14px;font-weight:600;color:' + C.text + '}',
      '#aidoc-widget-close{background:none;border:none;color:' + mutedText + ';cursor:pointer;font-size:18px;padding:4px;line-height:1;border-radius:6px;transition:color .15s,background .15s}',
      '#aidoc-widget-close:hover{color:' + C.text + ';background:' + (isDark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.04)') + '}',
      '#aidoc-widget-messages{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:12px}',
      '.aidoc-msg{max-width:88%;font-size:13px;line-height:1.6;padding:10px 14px;border-radius:14px;word-wrap:break-word}',
      '.aidoc-msg img{max-width:100%;border-radius:8px;margin:8px 0}',
      '.aidoc-msg a{color:' + C.accent + '}',
      '.aidoc-msg-user{align-self:flex-end;background:' + C.accent + ';color:white;border-radius:14px 14px 4px 14px}',
      '.aidoc-msg-bot{align-self:flex-start;background:' + subtle + ';color:' + C.text + ';border:1px solid ' + border + ';border-radius:14px 14px 14px 4px}',
      '.aidoc-sources{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;padding-top:8px;border-top:1px solid ' + border + '}',
      '.aidoc-source{font-size:10px;color:' + C.accent + ';background:' + tint + ';padding:2px 8px;border-radius:4px}',
      '.aidoc-welcome{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;text-align:center;padding:24px}',
      '.aidoc-welcome h3{font-size:16px;font-weight:600;color:' + C.text + ';margin:0}',
      '.aidoc-welcome p{font-size:12px;color:' + mutedText + ';margin:0;max-width:280px;line-height:1.5}',
      '.aidoc-suggestions{display:flex;flex-direction:column;gap:8px;width:100%;max-width:300px}',
      '.aidoc-suggestion{text-align:left;background:' + subtle + ';border:1px solid ' + border + ';border-radius:10px;padding:10px 14px;color:' + mutedText + ';font-size:12px;cursor:pointer;font-family:inherit;transition:border-color .15s,color .15s}',
      '.aidoc-suggestion:hover{border-color:' + C.accent + ';color:' + C.text + '}',
      '#aidoc-widget-input{display:flex;gap:8px;padding:12px 16px;border-top:1px solid ' + border + ';background:' + headerBg + '}',
      '#aidoc-widget-input input{flex:1;background:' + inputBg + ';border:1px solid ' + border + ';border-radius:10px;padding:10px 14px;color:' + C.text + ';font-size:13px;font-family:inherit;outline:none;transition:border-color .15s}',
      '#aidoc-widget-input input::placeholder{color:' + mutedText + '}',
      '#aidoc-widget-input input:focus{border-color:' + C.accent + '}',
      '#aidoc-widget-input button{background:' + C.accent + ';border:none;color:white;border-radius:10px;padding:10px 16px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;transition:opacity .15s}',
      '#aidoc-widget-input button:hover{opacity:.85}',
      '#aidoc-widget-input button:disabled{opacity:.4;cursor:not-allowed}',
      '.aidoc-typing{font-size:12px;color:' + mutedText + ';padding:4px 0;align-self:flex-start}',
      '#aidoc-widget-powered{text-align:center;padding:6px;font-size:10px;color:' + mutedText + ';border-top:1px solid ' + (isDark ? '#1a1a1e' : '#eee') + '}',
      '#aidoc-widget-powered a{color:' + mutedText + ';text-decoration:none}',
      '#aidoc-widget-powered a:hover{color:' + C.accent + '}',
      '@media(max-width:480px){#aidoc-widget-panel{bottom:0;' + pos + ':0;width:100vw;height:100vh;max-height:100vh;border-radius:0}#aidoc-widget-btn{bottom:16px;' + pos + ':16px}}',
    ].join('\n');
  }

  // --- Apply config to C and rebuild CSS ---
  function applyConfig(cfg) {
    projectName = cfg.projectName || 'this product';
    if (cfg.suggestions && cfg.suggestions.length > 0) dynamicSuggestions = cfg.suggestions;

    var changed = false;
    if (cfg.design) {
      if (cfg.design.accentColor && !script.getAttribute('data-color')) { C.accent = cfg.design.accentColor; changed = true; }
      if (cfg.design.bgColor) { C.bg = cfg.design.bgColor; changed = true; }
      if (cfg.design.textColor) { C.text = cfg.design.textColor; changed = true; }
      if (cfg.design.font) { C.font = cfg.design.font; changed = true; }
    }
    if (cfg.widgetPosition && !script.getAttribute('data-position')) { C.position = cfg.widgetPosition; changed = true; }
    if (cfg.widgetGreeting && !script.getAttribute('data-greeting')) { C.greeting = cfg.widgetGreeting; }
    return changed;
  }

  // --- Load cached config instantly (no flash) ---
  var CACHE_KEY = 'aidoc_cfg_' + API_KEY;
  try {
    var cached = localStorage.getItem(CACHE_KEY);
    if (cached) applyConfig(JSON.parse(cached));
  } catch (e) {}

  // --- Inject styles (with cached or default config) ---
  var styleEl = document.createElement('style');
  styleEl.id = 'aidoc-widget-style';
  styleEl.textContent = buildCSS();
  document.head.appendChild(styleEl);

  // --- Fetch fresh config in background → update cache ---
  fetch(API_BASE + '/' + API_KEY + '/config')
    .then(function (r) { return r.json(); })
    .then(function (cfg) {
      // Cache for next load
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(cfg)); } catch (e) {}

      if (applyConfig(cfg)) {
        styleEl.textContent = buildCSS();
      }
      if (isOpen && messages.length === 0) renderMessages();
    })
    .catch(function () {});

  // --- Button ---
  var btn = document.createElement('button');
  btn.id = 'aidoc-widget-btn';
  btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
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
    '<div id="aidoc-widget-powered">Powered by <a href="https://aidoc.dev" target="_blank">AiDoc</a></div>',
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
    if (isOpen) { renderMessages(); inputEl.focus(); }
  }

  function renderMessages() {
    if (messages.length === 0) {
      var greetingText = C.greeting || (USER_NAME ? 'Hi ' + USER_NAME + '!' : 'Hi! Ask me anything.');
      msgContainer.innerHTML = [
        '<div class="aidoc-welcome">',
        '<div><h3>' + greetingText + '</h3>',
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

    var lastMsg = messages[messages.length - 1];
    if (!isSending && lastMsg && lastMsg.role === 'assistant' && lastMsg.followUps && lastMsg.followUps.length > 0) {
      var fuDiv = document.createElement('div');
      fuDiv.className = 'aidoc-suggestions';
      fuDiv.style.alignSelf = 'flex-start';
      lastMsg.followUps.forEach(function (q) {
        var fuBtn = document.createElement('button');
        fuBtn.className = 'aidoc-suggestion';
        fuBtn.textContent = q;
        fuBtn.onclick = function () { sendMessage(q); };
        fuDiv.appendChild(fuBtn);
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
      body: JSON.stringify({ message: text, history: history.slice(0, -1), userContext: { name: USER_NAME, email: USER_EMAIL, plan: USER_PLAN, extra: USER_CONTEXT, currentUrl: getCurrentPage() } }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) { messages.push({ role: 'assistant', content: data.answer, sources: data.sources, followUps: data.followUps || [] }); })
      .catch(function () { messages.push({ role: 'assistant', content: 'Sorry, something went wrong. Please try again.' }); })
      .finally(function () { isSending = false; sendBtn.disabled = false; renderMessages(); inputEl.focus(); });
  }

  function simpleMarkdown(md) {
    return md
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code style="background:rgba(128,128,128,.15);padding:1px 4px;border-radius:3px;font-size:12px">$1</code>')
      .replace(/\n/g, '<br>');
  }

  function hexToRgba(hex, a) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function isColorDark(hex) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 < 128;
  }
})();
