/**
 * AiDoc Recorder — Bridge Content Script
 *
 * Runs on ALL pages. Its job:
 * 1. On AiDoc pages: announce the extension's presence and relay messages
 *    between the web page and the background service worker.
 * 2. On all pages: set the __AIDOC_EXTENSION__ flag so the app can detect it.
 */

// Signal to the page that the extension is installed
window.__AIDOC_EXTENSION__ = true;
window.postMessage({ type: 'AIDOC_EXTENSION_READY' }, '*');

// Listen for messages from the AiDoc web app
window.addEventListener('message', (event) => {
  if (event.source !== window) return;

  if (event.data?.type === 'AIDOC_START_DOM_CAPTURE') {
    chrome.runtime.sendMessage({ type: 'AIDOC_START_DOM_CAPTURE' });
  }

  if (event.data?.type === 'AIDOC_STOP_DOM_CAPTURE') {
    chrome.runtime.sendMessage({ type: 'AIDOC_STOP_DOM_CAPTURE' }, (response) => {
      window.postMessage({
        type: 'AIDOC_DOM_EVENTS',
        events: response?.events ?? [],
      }, '*');
    });
  }
});
