/**
 * AiDoc Recorder — DOM Capture Content Script
 *
 * Injected into the TARGET tab (the app being documented) when recording starts.
 * Captures user interactions with timestamps and CSS selectors for enriching
 * the AI-generated documentation.
 *
 * Events captured:
 * - click: element selector, text, tag name
 * - input: field name (NOT the value — privacy)
 * - navigation: URL changes (pushState, popstate)
 * - scroll: debounced scroll position
 * - load: page title on initial load
 */

(function () {
  if (window.__AIDOC_CAPTURING__) return; // Prevent double injection
  window.__AIDOC_CAPTURING__ = true;

  const events = [];
  const startTime = Date.now();

  function ts() {
    return (Date.now() - startTime) / 1000; // seconds since recording started
  }

  /** Build a readable CSS selector for an element */
  function getSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return 'body';

    // Prefer id
    if (el.id) return `#${el.id}`;

    // Try data-testid or aria-label
    const testId = el.getAttribute('data-testid');
    if (testId) return `[data-testid="${testId}"]`;
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return `[aria-label="${ariaLabel}"]`;

    // Build a tag.class path
    let selector = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (classes) selector += `.${classes}`;
    }

    // Add nth-child if there are siblings with same tag
    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(el) + 1;
        selector += `:nth-child(${index})`;
      }
    }

    return selector;
  }

  /** Get visible text from an element (truncated) */
  function getText(el) {
    const text = (el.innerText || el.textContent || '').trim();
    return text.length > 100 ? text.slice(0, 100) + '...' : text;
  }

  // --- Click events ---
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!target || !(target instanceof HTMLElement)) return;
    events.push({
      type: 'click',
      timestamp: ts(),
      url: location.href,
      selector: getSelector(target),
      text: getText(target),
      tagName: target.tagName.toLowerCase(),
    });
  }, true);

  // --- Input events (debounced per field) ---
  const inputTimers = new Map();
  document.addEventListener('input', (e) => {
    const target = e.target;
    if (!target || !(target instanceof HTMLElement)) return;
    const key = getSelector(target);
    if (inputTimers.has(key)) clearTimeout(inputTimers.get(key));
    inputTimers.set(key, setTimeout(() => {
      events.push({
        type: 'input',
        timestamp: ts(),
        url: location.href,
        selector: key,
        inputName: target.getAttribute('name') || target.getAttribute('placeholder') || undefined,
        tagName: target.tagName.toLowerCase(),
      });
      inputTimers.delete(key);
    }, 500));
  }, true);

  // --- Navigation events ---
  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  function onNavigation() {
    events.push({
      type: 'navigation',
      timestamp: ts(),
      url: location.href,
      pageTitle: document.title,
    });
  }

  history.pushState = function (...args) {
    originalPushState(...args);
    onNavigation();
  };
  history.replaceState = function (...args) {
    originalReplaceState(...args);
    onNavigation();
  };
  window.addEventListener('popstate', onNavigation);

  // --- Scroll events (heavily debounced) ---
  let scrollTimer = null;
  window.addEventListener('scroll', () => {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      events.push({
        type: 'scroll',
        timestamp: ts(),
        url: location.href,
      });
    }, 1000);
  }, { passive: true });

  // --- Initial load event ---
  events.push({
    type: 'load',
    timestamp: 0,
    url: location.href,
    pageTitle: document.title,
  });

  // --- Listen for stop signal from extension ---
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'STOP_CAPTURE') {
      window.__AIDOC_CAPTURING__ = false;
      sendResponse({ events });
    }
  });
})();
