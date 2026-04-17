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
    lang: (script.getAttribute('data-lang') || 'en').slice(0, 2).toLowerCase(),
  };

  // --- Localized UI strings ---
  var STRINGS = {
    en: {
      header: 'Ask about the docs',
      placeholder: 'Ask a question...',
      send: 'Send',
      greeting: 'Hi! Ask me anything.',
      greetingNamed: function (n) { return 'Hi ' + n + '!'; },
      helpAbout: function (p) { return 'I can help you find answers about ' + p + '.'; },
      defaultSuggestions: function (p) { return ['How does ' + p + ' work?', 'What are the main features?']; },
      searching: 'Searching docs...',
      errorGeneric: 'Sorry, something went wrong. Please try again.',
      guideMe: 'Guide me',
      analyzing: 'Analyzing your page...',
      analyzingShort: 'Analyzing...',
      permissionIntro: function (n) { return 'To guide you step-by-step, I\'ll read <strong>' + n + ' elements</strong> on this page (buttons, links, form fields).<br>No passwords or typed text are captured.'; },
      permissionAllow: 'Allow',
      permissionDeny: 'No thanks',
      skip: 'Skip',
      done: 'Done',
      exit: 'Exit',
      step: 'Step',
      poweredBy: 'Powered by',
    },
    fr: {
      header: 'Questions sur la doc',
      placeholder: 'Posez votre question...',
      send: 'Envoyer',
      greeting: 'Bonjour ! Je peux répondre à vos questions.',
      greetingNamed: function (n) { return 'Bonjour ' + n + ' !'; },
      helpAbout: function (p) { return 'Je peux vous aider à trouver des réponses sur ' + p + '.'; },
      defaultSuggestions: function (p) { return ['Comment fonctionne ' + p + ' ?', 'Quelles sont les fonctionnalités principales ?']; },
      searching: 'Recherche dans la doc...',
      errorGeneric: "Désolé, une erreur s'est produite. Veuillez réessayer.",
      guideMe: 'Guidez-moi',
      analyzing: 'Analyse de votre page...',
      analyzingShort: 'Analyse...',
      permissionIntro: function (n) { return 'Pour vous guider pas à pas, je vais lire <strong>' + n + ' éléments</strong> sur cette page (boutons, liens, champs de formulaire).<br>Aucun mot de passe ni texte saisi n\'est capturé.'; },
      permissionAllow: 'Autoriser',
      permissionDeny: 'Non merci',
      skip: 'Passer',
      done: 'Terminé',
      exit: 'Quitter',
      step: 'Étape',
      poweredBy: 'Propulsé par',
    },
  };
  function t() { return STRINGS[C.lang] || STRINGS.en; }

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

  // --- Walkthrough state (progressive — one step at a time) ---
  var wtActive = false;
  var wtMessage = '';
  var wtCompletedSteps = [];
  var wtCurrentStep = null;
  var wtStepNumber = 0;

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
      // Walkthrough styles
      '.aidoc-guide-btn{display:inline-flex;align-items:center;gap:6px;margin-top:8px;padding:8px 14px;background:' + tint + ';border:1px solid ' + C.accent + ';border-radius:10px;color:' + C.accent + ';font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;transition:background .15s,color .15s}',
      '.aidoc-guide-btn:hover{background:' + C.accent + ';color:white}',
      '.aidoc-guide-btn svg{width:14px;height:14px;fill:currentColor}',
      '.aidoc-permission{padding:16px;text-align:center}',
      '.aidoc-permission p{font-size:12px;color:' + mutedText + ';margin:0 0 12px;line-height:1.5}',
      '.aidoc-permission-actions{display:flex;gap:8px;justify-content:center}',
      '.aidoc-permission-actions button{padding:8px 16px;border-radius:8px;font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;border:1px solid ' + border + ';transition:all .15s}',
      '.aidoc-perm-allow{background:' + C.accent + ';color:white;border-color:' + C.accent + '}',
      '.aidoc-perm-deny{background:transparent;color:' + mutedText + '}',
      // Mini bar — replaces the full panel during walkthrough
      '#aidoc-wt-bar{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:100001;display:flex;align-items:center;gap:10px;padding:10px 16px;border-radius:12px;background:' + C.bg + ';border:1px solid ' + border + ';box-shadow:0 8px 24px rgba(0,0,0,.3);font-family:' + C.font + ';color:' + C.text + ';font-size:12px;white-space:nowrap}',
      '#aidoc-wt-bar .aidoc-wt-bar-step{color:' + mutedText + ';font-size:11px}',
      '#aidoc-wt-bar .aidoc-wt-bar-text{font-weight:500;max-width:280px;overflow:hidden;text-overflow:ellipsis}',
      '#aidoc-wt-bar button{padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-family:inherit;border:1px solid ' + border + ';background:transparent;color:' + C.text + ';transition:all .15s}',
      '#aidoc-wt-bar button:hover{border-color:' + C.accent + ';color:' + C.accent + '}',
      '#aidoc-wt-bar .aidoc-wt-bar-exit{color:' + mutedText + ';border-color:transparent}',
      '#aidoc-wt-bar .aidoc-wt-bar-exit:hover{color:#f87171}',
      '#aidoc-wt-overlay{position:fixed;inset:0;z-index:99998;pointer-events:none}',
      '#aidoc-wt-ring{position:fixed;z-index:100000;pointer-events:none;border:2px solid ' + C.accent + ';border-radius:4px;transition:all .3s ease;box-shadow:0 0 0 0 ' + hexToRgba(C.accent, 0.4) + ';animation:aidoc-pulse 2s infinite}',
      '#aidoc-wt-tooltip{position:fixed;z-index:100001;max-width:280px;padding:12px 16px;border-radius:10px;background:' + C.bg + ';border:1px solid ' + border + ';box-shadow:0 8px 24px rgba(0,0,0,.3);font-family:' + C.font + ';color:' + C.text + ';font-size:12px;line-height:1.5}',
      '#aidoc-wt-tooltip .aidoc-wt-tip-step{font-size:10px;color:' + mutedText + ';margin-bottom:4px}',
      '#aidoc-wt-tooltip .aidoc-wt-tip-text{font-weight:500;margin-bottom:8px}',
      '#aidoc-wt-tooltip .aidoc-wt-tip-actions{display:flex;gap:6px}',
      '#aidoc-wt-tooltip .aidoc-wt-tip-actions button{padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-family:inherit;border:1px solid ' + border + ';background:transparent;color:' + C.text + ';transition:all .15s}',
      '#aidoc-wt-tooltip .aidoc-wt-tip-actions button:hover{border-color:' + C.accent + ';color:' + C.accent + '}',
      '#aidoc-wt-tooltip.aidoc-wt-notfound{border-color:#f59e0b}',
      '#aidoc-wt-tooltip.aidoc-wt-notfound .aidoc-wt-tip-text{color:#f59e0b}',
      '@keyframes aidoc-pulse{0%{box-shadow:0 0 0 0 ' + hexToRgba(C.accent, 0.4) + '}70%{box-shadow:0 0 0 8px ' + hexToRgba(C.accent, 0) + '}100%{box-shadow:0 0 0 0 ' + hexToRgba(C.accent, 0) + '}}',
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
    if (cfg.language && !script.getAttribute('data-lang')) {
      var lang = String(cfg.language).slice(0, 2).toLowerCase();
      if (STRINGS[lang]) C.lang = lang;
    }
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

      var prevLang = C.lang;
      if (applyConfig(cfg)) {
        styleEl.textContent = buildCSS();
      }
      // Language may have changed between cached + live config — refresh panel chrome
      if (C.lang !== prevLang) {
        renderPanelChrome();
        wirePanel();
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
  function renderPanelChrome() {
    panel.innerHTML = [
      '<div id="aidoc-widget-header"><span>' + escapeHtml(t().header) + '</span><button id="aidoc-widget-close">&times;</button></div>',
      '<div id="aidoc-widget-messages"></div>',
      '<div id="aidoc-widget-input"><input placeholder="' + escapeHtml(t().placeholder) + '" /><button>' + escapeHtml(t().send) + '</button></div>',
      '<div id="aidoc-widget-powered">' + escapeHtml(t().poweredBy) + ' <a href="https://aidoc.dev" target="_blank">AiDoc</a></div>',
    ].join('');
  }
  renderPanelChrome();
  document.body.appendChild(panel);

  var msgContainer, inputEl, sendBtn;
  function wirePanel() {
    msgContainer = panel.querySelector('#aidoc-widget-messages');
    inputEl = panel.querySelector('#aidoc-widget-input input');
    sendBtn = panel.querySelector('#aidoc-widget-input button');

    panel.querySelector('#aidoc-widget-close').onclick = function () { togglePanel(); };
    sendBtn.onclick = function () { sendMessage(inputEl.value); };
    inputEl.onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(inputEl.value); } };
  }
  wirePanel();

  function togglePanel() {
    isOpen = !isOpen;
    panel.classList.toggle('open', isOpen);
    if (isOpen) { renderMessages(); inputEl.focus(); }
  }

  function renderMessages() {
    if (messages.length === 0) {
      var greetingText = C.greeting || (USER_NAME ? t().greetingNamed(USER_NAME) : t().greeting);
      var productName = projectName || 'this product';
      msgContainer.innerHTML = [
        '<div class="aidoc-welcome">',
        '<div><h3>' + escapeHtml(greetingText) + '</h3>',
        '<p>' + escapeHtml(t().helpAbout(productName)) + '</p></div>',
        '<div class="aidoc-suggestions">',
        (dynamicSuggestions.length > 0
          ? dynamicSuggestions
          : t().defaultSuggestions(productName)
        ).map(function (s) { return '<button class="aidoc-suggestion">' + escapeHtml(s) + '</button>'; }).join(''),
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
        if (m.walkthroughAvailable) {
          var guideBtn = document.createElement('button');
          guideBtn.className = 'aidoc-guide-btn';
          guideBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/></svg> ' + escapeHtml(t().guideMe);
          guideBtn.onclick = function () { requestWalkthrough(m._originalQuestion || messages[messages.indexOf(m) - 1]?.content || ''); };
          div.appendChild(guideBtn);
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
      typing.textContent = t().searching;
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
      .then(function (data) { messages.push({ role: 'assistant', content: data.answer, sources: data.sources, followUps: data.followUps || [], walkthroughAvailable: data.walkthroughAvailable || false, _originalQuestion: text }); })
      .catch(function () { messages.push({ role: 'assistant', content: t().errorGeneric }); })
      .finally(function () { isSending = false; sendBtn.disabled = false; renderMessages(); inputEl.focus(); });
  }

  // --- DOM Snapshot Capture ---

  // Redact PII patterns from text before sending to backend
  function redactPii(str) {
    if (!str) return str;
    return str
      .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '[email]')
      .replace(/\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g, '[card]')
      .replace(/\b[0-9a-f]{32,}\b/gi, '[token]')
      .replace(/\b(sk|pk|api|key|token|secret|password)[_\-]?[a-zA-Z0-9]{16,}\b/gi, '[key]');
  }

  function captureDomSnapshot() {
    var INTERACTIVE = 'button,a,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[onclick],[data-testid]';
    var els = document.querySelectorAll(INTERACTIVE);
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var cx = vw / 2;
    var cy = vh / 2;
    var elements = [];

    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      // Skip hidden elements
      if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      var rect = el.getBoundingClientRect();
      // Skip offscreen elements
      if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
      // Skip password fields
      if (el.type === 'password') continue;
      // Skip our own widget elements
      if (el.closest('#aidoc-widget-btn,#aidoc-widget-panel,#aidoc-wt-overlay,#aidoc-wt-ring,#aidoc-wt-tooltip')) continue;

      var ref = el.getAttribute('data-testid') || el.id || ('el-' + el.tagName.toLowerCase() + '-' + i);
      var text = redactPii((el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100));
      var tag = el.tagName.toLowerCase();
      var role = el.getAttribute('role') || inferRole(tag);
      var ariaLabel = redactPii((el.getAttribute('aria-label') || '').slice(0, 100));
      var placeholder = redactPii((el.getAttribute('placeholder') || '').slice(0, 100));

      // Build a short selector
      var selector = tag;
      if (el.id) selector = '#' + el.id;
      else if (el.className && typeof el.className === 'string') {
        var cls = el.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) selector = tag + '.' + cls;
      }

      elements.push({
        ref: ref.slice(0, 100),
        tag: tag,
        text: text,
        role: role,
        ariaLabel: ariaLabel.slice(0, 100),
        rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
        selector: selector.slice(0, 200),
        placeholder: placeholder.slice(0, 100),
      });
    }

    // Sort by proximity to viewport center, cap at 200
    elements.sort(function (a, b) {
      var da = Math.abs(a.rect.x + a.rect.w / 2 - cx) + Math.abs(a.rect.y + a.rect.h / 2 - cy);
      var db = Math.abs(b.rect.x + b.rect.w / 2 - cx) + Math.abs(b.rect.y + b.rect.h / 2 - cy);
      return da - db;
    });
    elements = elements.slice(0, 80);

    return {
      url: window.location.origin + window.location.pathname, // Strip query params and hash
      title: document.title,
      viewport: { width: vw, height: vh },
      elements: elements,
    };
  }

  function inferRole(tag) {
    var roles = { button: 'button', a: 'link', input: 'textbox', select: 'combobox', textarea: 'textbox' };
    return roles[tag] || '';
  }

  // --- Permission Flow ---

  var DOM_PERM_TTL = 30 * 60 * 1000; // 30 minutes

  function checkDomPermission() {
    try {
      if (sessionStorage.getItem('aidoc_dom_permission') !== 'granted') return false;
      var expiry = parseInt(sessionStorage.getItem('aidoc_dom_perm_expiry') || '0', 10);
      if (Date.now() > expiry) {
        sessionStorage.removeItem('aidoc_dom_permission');
        sessionStorage.removeItem('aidoc_dom_perm_expiry');
        return false;
      }
      return true;
    } catch (e) { return false; }
  }

  function grantDomPermission() {
    try {
      sessionStorage.setItem('aidoc_dom_permission', 'granted');
      sessionStorage.setItem('aidoc_dom_perm_expiry', String(Date.now() + DOM_PERM_TTL));
    } catch (e) {}
  }

  function showPermissionDialog(elementCount, onAllow, onDeny) {
    msgContainer.innerHTML = [
      '<div class="aidoc-permission">',
      '<p>' + t().permissionIntro(elementCount) + '</p>',
      '<div class="aidoc-permission-actions">',
      '<button class="aidoc-perm-allow">' + escapeHtml(t().permissionAllow) + '</button>',
      '<button class="aidoc-perm-deny">' + escapeHtml(t().permissionDeny) + '</button>',
      '</div></div>',
    ].join('');
    msgContainer.querySelector('.aidoc-perm-allow').onclick = function () { grantDomPermission(); onAllow(); };
    msgContainer.querySelector('.aidoc-perm-deny').onclick = function () { onDeny(); };
  }

  // --- Progressive Walkthrough API ---

  function requestWalkthrough(text) {
    wtMessage = text;
    wtCompletedSteps = [];

    // Pre-scan to show element count in permission dialog
    var preSnapshot = captureDomSnapshot();

    function startWalkthrough() {
      fetchNextStep();
    }

    if (checkDomPermission()) {
      startWalkthrough();
    } else {
      showPermissionDialog(preSnapshot.elements.length, startWalkthrough, function () { renderMessages(); });
    }
  }

  function fetchNextStep() {
    // Show loading in mini bar or messages
    if (wtActive) {
      showLoadingBar();
    } else {
      msgContainer.innerHTML = '<div class="aidoc-typing">' + escapeHtml(t().analyzing) + '</div>';
    }

    var snapshot = captureDomSnapshot();
    var history = messages.map(function (m) { return { role: m.role, content: m.content }; });

    fetch(API_BASE + '/' + API_KEY + '/walkthrough', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: wtMessage,
        history: history,
        domSnapshot: snapshot,
        completedSteps: wtCompletedSteps,
        userContext: { name: USER_NAME, email: USER_EMAIL, plan: USER_PLAN, extra: USER_CONTEXT, currentUrl: getCurrentPage() },
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.done || !data.step) {
          exitWalkthrough();
          return;
        }
        wtCurrentStep = data.step;
        wtStepNumber = data.stepNumber;

        if (!wtActive) {
          // First step — collapse panel, enter walkthrough mode
          panel.classList.remove('open');
          isOpen = false;
          wtActive = true;
          startDomObserver();
        }

        removeHighlight();
        renderWalkthroughBar();
        highlightStep(wtCurrentStep);
      })
      .catch(function () {
        exitWalkthrough();
      });
  }

  // Called when user clicks the highlighted element — advance to next step
  function onStepCompleted() {
    if (!wtActive || !wtCurrentStep) return;
    wtCompletedSteps.push({
      instruction: wtCurrentStep.instruction,
      action: wtCurrentStep.action,
      pageUrl: window.location.href,
    });
    removeHighlight();
    showLoadingBar();
    // Wait for DOM to settle (animations, navigation, modals)
    setTimeout(function () { if (wtActive) fetchNextStep(); }, 600);
  }

  // --- Walkthrough Mode ---

  function exitWalkthrough() {
    wtActive = false;
    wtCurrentStep = null;
    wtCompletedSteps = [];
    wtStepNumber = 0;
    stopDomObserver();
    removeHighlight();
    removeWalkthroughBar();
  }

  function removeWalkthroughBar() {
    var bar = document.getElementById('aidoc-wt-bar');
    if (bar) bar.remove();
  }

  function showLoadingBar() {
    removeWalkthroughBar();
    var bar = document.createElement('div');
    bar.id = 'aidoc-wt-bar';
    bar.innerHTML = '<span class="aidoc-wt-bar-step">' + (wtCompletedSteps.length + 1) + '</span><span class="aidoc-wt-bar-text">' + escapeHtml(t().analyzingShort) + '</span><button class="aidoc-wt-bar-exit" data-wt="exit">&times;</button>';
    document.body.appendChild(bar);
    bar.querySelector('[data-wt="exit"]').onclick = function () { exitWalkthrough(); };
  }

  function renderWalkthroughBar() {
    if (!wtCurrentStep) { exitWalkthrough(); return; }

    removeWalkthroughBar();

    var bar = document.createElement('div');
    bar.id = 'aidoc-wt-bar';
    bar.innerHTML = [
      '<span class="aidoc-wt-bar-step">' + wtStepNumber + '</span>',
      '<span class="aidoc-wt-bar-text">' + escapeHtml(wtCurrentStep.instruction) + '</span>',
      '<button data-wt="skip">' + escapeHtml(t().skip) + '</button>',
      '<button class="aidoc-wt-bar-exit" data-wt="exit">&times;</button>',
    ].join('');
    document.body.appendChild(bar);

    bar.querySelector('[data-wt="skip"]').onclick = function (e) {
      e.stopPropagation();
      onStepCompleted(); // Skip = mark as done and move on
    };
    bar.querySelector('[data-wt="exit"]').onclick = function (e) {
      e.stopPropagation();
      exitWalkthrough();
    };
  }

  function renderWalkthroughBarManual(step) {
    removeWalkthroughBar();

    var bar = document.createElement('div');
    bar.id = 'aidoc-wt-bar';
    bar.style.borderColor = '#f59e0b';
    bar.innerHTML = [
      '<span class="aidoc-wt-bar-step">' + wtStepNumber + '</span>',
      '<span class="aidoc-wt-bar-text">' + escapeHtml(step.instruction) + '</span>',
      '<button data-wt="done">' + escapeHtml(t().done) + '</button>',
      '<button data-wt="skip">' + escapeHtml(t().skip) + '</button>',
      '<button class="aidoc-wt-bar-exit" data-wt="exit">&times;</button>',
    ].join('');
    document.body.appendChild(bar);

    bar.querySelectorAll('button[data-wt]').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var action = b.getAttribute('data-wt');
        if (action === 'done' || action === 'skip') { onStepCompleted(); }
        else if (action === 'exit') { exitWalkthrough(); }
      };
    });
  }

  // --- Highlight Engine ---

  function matchElement(step) {
    if (!step) return null;

    // 1. Try by ref (data-testid or id)
    if (step.elementRef) {
      var byTestId = document.querySelector('[data-testid="' + CSS.escape(step.elementRef) + '"]');
      if (byTestId) return byTestId;
      var byId = document.getElementById(step.elementRef);
      if (byId) return byId;
    }

    // 2. Try fallback selector (validate to prevent ReDoS / selector injection)
    if (step.fallbackSelector && step.fallbackSelector.length <= 150 && /^[a-zA-Z0-9#.\-_\[\]=":,>\s\(\)]+$/.test(step.fallbackSelector)) {
      try {
        var bySel = document.querySelector(step.fallbackSelector);
        if (bySel) return bySel;
      } catch (e) {}
    }

    // 3. Text match on interactive elements
    var INTERACTIVE = 'button,a,input,select,textarea,[role="button"],[role="link"],[role="tab"]';
    var candidates = document.querySelectorAll(INTERACTIVE);
    var instructionLower = step.instruction.toLowerCase();
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      var text = (el.textContent || '').trim().toLowerCase();
      var ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
      if (text && instructionLower.indexOf(text) !== -1) return el;
      if (ariaLabel && instructionLower.indexOf(ariaLabel) !== -1) return el;
    }

    return null;
  }

  // Track the currently highlighted DOM element for click detection
  var wtHighlightedEl = null;
  var wtClickHandler = null;

  function highlightStep(step) {
    removeHighlight();
    if (!step) return;

    var el = matchElement(step);
    if (!el) {
      // Element not found — show instruction in the bar with manual mode
      renderWalkthroughBarManual(step);
      return;
    }

    wtHighlightedEl = el;

    // Listen for user clicking the highlighted element — triggers progressive next step
    wtClickHandler = function () {
      if (!wtActive) return;
      el.removeEventListener('click', wtClickHandler);
      wtClickHandler = null;
      wtHighlightedEl = null;
      onStepCompleted();
    };
    el.addEventListener('click', wtClickHandler);

    // Scroll into view
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    setTimeout(function () {
      var rect = el.getBoundingClientRect();

      // Overlay with cutout
      var overlay = document.createElement('div');
      overlay.id = 'aidoc-wt-overlay';
      var pad = 6;
      var cx = rect.left - pad;
      var cy = rect.top - pad;
      var cw = rect.width + pad * 2;
      var ch = rect.height + pad * 2;
      overlay.style.background = 'rgba(0,0,0,0.4)';
      overlay.style.clipPath = 'polygon(0% 0%,0% 100%,100% 100%,100% 0%,' +
        cx + 'px 0,' + cx + 'px ' + (cy + ch) + 'px,' + (cx + cw) + 'px ' + (cy + ch) + 'px,' +
        (cx + cw) + 'px ' + cy + 'px,' + cx + 'px ' + cy + 'px,' + cx + 'px 0)';
      document.body.appendChild(overlay);

      // Highlight ring
      var ring = document.createElement('div');
      ring.id = 'aidoc-wt-ring';
      ring.style.left = cx + 'px';
      ring.style.top = cy + 'px';
      ring.style.width = cw + 'px';
      ring.style.height = ch + 'px';
      document.body.appendChild(ring);

      // Tooltip
      showFloatingTooltip(step, rect);
    }, 350);
  }

  function showFloatingTooltip(step, rect) {
    var existing = document.getElementById('aidoc-wt-tooltip');
    if (existing) existing.remove();

    var tip = document.createElement('div');
    tip.id = 'aidoc-wt-tooltip';
    if (!rect) tip.className = 'aidoc-wt-notfound';

    tip.innerHTML = [
      '<div class="aidoc-wt-tip-step">' + escapeHtml(t().step) + ' ' + wtStepNumber + '</div>',
      '<div class="aidoc-wt-tip-text">' + simpleMarkdown(step.instruction) + '</div>',
      '<div class="aidoc-wt-tip-actions">',
      '<button data-wt="skip">' + escapeHtml(t().skip) + '</button>',
      '<button data-wt="exit">' + escapeHtml(t().exit) + '</button>',
      '</div>',
    ].join('');

    document.body.appendChild(tip);

    // Position tooltip
    if (rect) {
      var tipRect = tip.getBoundingClientRect();
      var left = Math.max(8, Math.min(rect.left, window.innerWidth - tipRect.width - 8));
      var top = rect.bottom + 12;
      // Flip above if too close to bottom
      if (top + tipRect.height > window.innerHeight - 8) {
        top = rect.top - tipRect.height - 12;
      }
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    } else {
      // No element — center at top
      tip.style.left = '50%';
      tip.style.top = '80px';
      tip.style.transform = 'translateX(-50%)';
    }

    // Tooltip nav handlers
    tip.querySelectorAll('button[data-wt]').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var action = b.getAttribute('data-wt');
        if (action === 'skip') { onStepCompleted(); }
        else if (action === 'exit') { exitWalkthrough(); }
      };
    });
  }

  function removeHighlight() {
    // Clean up click listener on previous element
    if (wtHighlightedEl && wtClickHandler) {
      wtHighlightedEl.removeEventListener('click', wtClickHandler);
    }
    wtHighlightedEl = null;
    wtClickHandler = null;

    var overlay = document.getElementById('aidoc-wt-overlay');
    var ring = document.getElementById('aidoc-wt-ring');
    var tooltip = document.getElementById('aidoc-wt-tooltip');
    if (overlay) overlay.remove();
    if (ring) ring.remove();
    if (tooltip) tooltip.remove();
  }

  // Re-scan after page navigation — fetch next step for the new page
  function onPageChange() {
    if (!wtActive) return;
    removeHighlight();
    // Wait for new page to render, then re-analyze with fresh DOM
    setTimeout(function () {
      if (wtActive) fetchNextStep();
    }, 500);
  }

  window.addEventListener('popstate', onPageChange);
  window.addEventListener('hashchange', onPageChange);

  // Observe DOM mutations — re-position highlight when DOM changes significantly
  // Only active during walkthrough mode to avoid unnecessary overhead
  var wtMutationTimer;
  var wtObserver = null;

  function startDomObserver() {
    if (wtObserver) return;
    wtObserver = new MutationObserver(function () {
      if (!wtActive) return;
      clearTimeout(wtMutationTimer);
      wtMutationTimer = setTimeout(function () {
        if (!wtActive || !wtCurrentStep) return;
        var el = wtHighlightedEl || matchElement(wtCurrentStep);
        if (!el) return;
        var ring = document.getElementById('aidoc-wt-ring');
        var overlay = document.getElementById('aidoc-wt-overlay');
        if (!ring || !overlay) return;
        var rect = el.getBoundingClientRect();
        var pad = 6;
        var cx = rect.left - pad;
        var cy = rect.top - pad;
        var cw = rect.width + pad * 2;
        var ch = rect.height + pad * 2;
        ring.style.left = cx + 'px';
        ring.style.top = cy + 'px';
        ring.style.width = cw + 'px';
        ring.style.height = ch + 'px';
        overlay.style.clipPath = 'polygon(0% 0%,0% 100%,100% 100%,100% 0%,' +
          cx + 'px 0,' + cx + 'px ' + (cy + ch) + 'px,' + (cx + cw) + 'px ' + (cy + ch) + 'px,' +
          (cx + cw) + 'px ' + cy + 'px,' + cx + 'px ' + cy + 'px,' + cx + 'px 0)';
      }, 300);
    });
    wtObserver.observe(document.body, { childList: true, subtree: true, attributes: false });
  }

  function stopDomObserver() {
    if (wtObserver) { wtObserver.disconnect(); wtObserver = null; }
    clearTimeout(wtMutationTimer);
  }

  // Reposition on resize (debounced)
  var resizeTimer;
  window.addEventListener('resize', function () {
    if (!wtActive) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      removeHighlight();
      if (wtCurrentStep) highlightStep(wtCurrentStep);
    }, 200);
  });

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function simpleMarkdown(md) {
    // Escape HTML first to prevent XSS, then apply markdown formatting
    var safe = escapeHtml(md);
    return safe
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (_, alt, url) {
        // Only allow http/https image URLs
        if (/^https?:\/\//i.test(url)) return '<img src="' + url + '" alt="' + alt + '" />';
        return alt;
      })
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, text, url) {
        if (/^https?:\/\//i.test(url)) return '<a href="' + url + '" target="_blank" rel="noopener">' + text + '</a>';
        return text;
      })
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
