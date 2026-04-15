/**
 * AiDoc Recorder — Background Service Worker
 *
 * Coordinates DOM capture between the AiDoc app tab and the target tab
 * being recorded. When AiDoc sends START_DOM_CAPTURE, this worker injects
 * the capture script into the active tab.
 */

// Track which tab is being captured
let captureTabId = null;

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'AIDOC_START_DOM_CAPTURE') {
    // AiDoc wants to start capturing — inject into the NEXT active tab
    // (the user will switch to their app after clicking Record)
    captureTabId = null;

    // Listen for tab activation to detect when user switches to their app
    chrome.tabs.onActivated.addListener(function onActivated(activeInfo) {
      // Skip if it's the AiDoc tab itself
      if (activeInfo.tabId === sender.tab?.id) return;

      captureTabId = activeInfo.tabId;
      chrome.tabs.onActivated.removeListener(onActivated);

      // Inject the DOM capture content script
      chrome.scripting.executeScript({
        target: { tabId: captureTabId },
        files: ['dom-capture.js'],
      }).catch((err) => {
        console.error('[AiDoc] Failed to inject DOM capture script:', err);
      });
    });

    sendResponse({ ok: true });
  }

  if (message.type === 'AIDOC_STOP_DOM_CAPTURE') {
    if (captureTabId) {
      // Tell the capture script to stop and send back events
      chrome.tabs.sendMessage(captureTabId, { type: 'STOP_CAPTURE' }, (response) => {
        sendResponse({ events: response?.events ?? [] });
        captureTabId = null;
      });
      return true; // Keep channel open for async response
    }
    sendResponse({ events: [] });
  }

  if (message.type === 'DOM_EVENTS_COLLECTED') {
    // Forward events from the target tab back to the AiDoc tab
    // (This is handled directly in the bridge script)
  }
});
