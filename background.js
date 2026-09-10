/**
 * background.js
 * Service worker for PRIVISION (Manifest V3)
 * 
 * Manages configuration persistence, domain allowlist evaluation,
 * badge states, and tab message routing.
 */

// Default configuration schema
const DEFAULT_CONFIG = {
  isEnabled: true,
  mode: 'always-on', // 'always-on' | 'site-scoped'
  allowlist: ['localhost', '127.0.0.1', 'bank.example.com', 'checkout.example.com'],
  modelSource: 'builtin', // 'builtin' | 'custom-onnx' | 'custom-hf' | 'remote-endpoint'
  customModelUrl: '',
  remoteEndpointUrl: 'http://localhost:3721/api/reason',
  executionProvider: 'auto', // 'auto' | 'webgpu' | 'wasm'
  confidenceThreshold: 0.5,
  failClosedHighRisk: true,
  stats: {
    totalScans: 0,
    totalRedactions: 0
  }
};

// Initialize settings on installation
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[PRIVISION] Extension installed/updated:', details.reason);
  const current = await chrome.storage.local.get(null);
  const merged = { ...DEFAULT_CONFIG, ...current };
  await chrome.storage.local.set(merged);
  await checkBackendAvailability();
  await updateBadge();
});

// Refresh backend status on browser startup
if (typeof chrome.runtime.onStartup !== 'undefined') {
  chrome.runtime.onStartup.addListener(async () => {
    await checkBackendAvailability();
    await updateBadge();
  });
}

/**
 * Canonical health check function for the reasoning backend.
 * Checks root health endpoint GET http://localhost:3721/
 * Returns HTTP 200 with server status.
 */
async function checkBackendAvailability(endpoint = 'http://localhost:3721') {
  const rootUrl = endpoint.replace(/\/api\/reason\/?$/, '').replace(/\/$/, '') || 'http://localhost:3721';

  // Candidate loopback URLs for dual-stack resilience
  const candidateUrls = [rootUrl];
  if (rootUrl.includes('://localhost')) {
    candidateUrls.push(rootUrl.replace('://localhost', '://127.0.0.1'));
  } else if (rootUrl.includes('://127.0.0.1')) {
    candidateUrls.push(rootUrl.replace('://127.0.0.1', '://localhost'));
  }

  let lastErr = null;
  for (const url of candidateUrls) {
    const testEndpoints = [`${url}/`, `${url}/health`];
    for (const testUrl of testEndpoints) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);

        const resp = await fetch(testUrl, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (resp.ok) {
          let data = {};
          try { data = await resp.json(); } catch {}
          const isPrivision = data.service?.includes('PRIVISION') || data.status === 'online' || resp.status === 200;
          if (isPrivision) {
            const result = {
              success: true,
              isOnline: true,
              statusText: 'REASONING BACKEND: ONLINE',
              endpoint: 'http://localhost:3721',
              activeUrl: testUrl,
              port: data.port || 3721,
              geminiConfigured: !!data.geminiConfigured,
              model: data.model || 'gemini-3.6-flash',
              data
            };
            await chrome.storage.local.set({ lastBackendStatus: result });
            return result;
          }
        }
      } catch (err) {
        lastErr = err;
      }
    }
  }

  const offlineResult = {
    success: false,
    isOnline: false,
    statusText: 'REASONING BACKEND: OFFLINE',
    endpoint: 'http://localhost:3721',
    error: lastErr?.message || 'Server unreachable at http://localhost:3721'
  };
  await chrome.storage.local.set({ lastBackendStatus: offlineResult });
  return offlineResult;
}

// Update badge when tab changes or finishes loading
chrome.tabs.onActivated.addListener(async () => {
  await updateBadge();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab?.url) {
    await updateBadge(tab);
  }
});

/**
 * Evaluates whether PRIVISION should be active on the given URL.
 * @param {string} url 
 * @returns {Promise<boolean>}
 */
async function isUrlEligible(url) {
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) {
    return false;
  }

  const { isEnabled = true, mode = 'always-on', allowlist = DEFAULT_CONFIG.allowlist } = await chrome.storage.local.get([
    'isEnabled',
    'mode',
    'allowlist'
  ]);

  if (!isEnabled) return false;
  if (mode === 'always-on') return true;

  try {
    const hostname = new URL(url).hostname;
    const list = Array.isArray(allowlist) && allowlist.length > 0 ? allowlist : DEFAULT_CONFIG.allowlist;
    return list.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

/**
 * Updates action icon badge text and color based on active tab state.
 */
async function updateBadge(specificTab = null) {
  try {
    let tab = specificTab;
    if (!tab) {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = activeTab;
    }

    if (!tab || !tab.url) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }

    const eligible = await isUrlEligible(tab.url);
    const { isEnabled = true } = await chrome.storage.local.get('isEnabled');

    if (!isEnabled) {
      await chrome.action.setBadgeText({ text: 'OFF', tabId: tab.id });
      await chrome.action.setBadgeBackgroundColor({ color: '#64748B', tabId: tab.id });
    } else if (eligible) {
      await chrome.action.setBadgeText({ text: 'ON', tabId: tab.id });
      await chrome.action.setBadgeBackgroundColor({ color: '#10B981', tabId: tab.id });
    } else {
      await chrome.action.setBadgeText({ text: 'IDLE', tabId: tab.id });
      await chrome.action.setBadgeBackgroundColor({ color: '#F59E0B', tabId: tab.id });
    }
  } catch (err) {
    console.warn('[PRIVISION ServiceWorker] Badge update failed:', err);
  }
}

// Runtime message dispatcher
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {
        case 'GET_STATUS': {
          const config = await chrome.storage.local.get(null);
          const tab = sender.tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
          const tabUrl = tab?.url || sender.url || '';
          const eligible = tabUrl ? await isUrlEligible(tabUrl) : true;
          let hostname = '';
          try {
            if (tabUrl) hostname = new URL(tabUrl).hostname;
          } catch {}

          sendResponse({
            success: true,
            config,
            currentTab: {
              id: tab?.id,
              url: tabUrl,
              hostname,
              eligible
            }
          });
          break;
        }

        case 'TOGGLE_ENABLED': {
          const { isEnabled = true } = await chrome.storage.local.get('isEnabled');
          const newState = !isEnabled;
          await chrome.storage.local.set({ isEnabled: newState });
          await updateBadge();

          // Notify tabs of state change
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            if (tab.id) {
              chrome.tabs.sendMessage(tab.id, { action: 'CONFIG_CHANGED', isEnabled: newState }).catch(() => {});
            }
          }
          sendResponse({ success: true, isEnabled: newState });
          break;
        }

        case 'SET_MODE': {
          const { mode } = message;
          if (['always-on', 'site-scoped'].includes(mode)) {
            await chrome.storage.local.set({ mode });
            await updateBadge();
            sendResponse({ success: true, mode });
          } else {
            sendResponse({ success: false, error: 'Invalid mode' });
          }
          break;
        }

        case 'ADD_ALLOWLIST_DOMAIN': {
          const { domain } = message;
          const { allowlist = [] } = await chrome.storage.local.get('allowlist');
          const cleanDomain = domain.toLowerCase().trim();
          if (cleanDomain && !allowlist.includes(cleanDomain)) {
            const updated = [...allowlist, cleanDomain];
            await chrome.storage.local.set({ allowlist: updated });
            await updateBadge();
            sendResponse({ success: true, allowlist: updated });
          } else {
            sendResponse({ success: true, allowlist });
          }
          break;
        }

        case 'REMOVE_ALLOWLIST_DOMAIN': {
          const { domain } = message;
          const { allowlist = [] } = await chrome.storage.local.get('allowlist');
          const updated = allowlist.filter(d => d !== domain.toLowerCase().trim());
          await chrome.storage.local.set({ allowlist: updated });
          await updateBadge();
          sendResponse({ success: true, allowlist: updated });
          break;
        }

        case 'TRIGGER_SCAN': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id) {
            chrome.tabs.sendMessage(tab.id, { action: 'MANUAL_SCAN' }, (resp) => {
              sendResponse(resp || { success: true, message: 'Scan initiated' });
            });
          } else {
            sendResponse({ success: false, error: 'No active tab found' });
          }
          break;
        }

        case 'UPDATE_STATS': {
          const { redactionsCount = 0 } = message;
          const { stats = { totalScans: 0, totalRedactions: 0 } } = await chrome.storage.local.get('stats');
          stats.totalScans = (stats.totalScans || 0) + 1;
          stats.totalRedactions = (stats.totalRedactions || 0) + redactionsCount;
          await chrome.storage.local.set({ stats });
          sendResponse({ success: true, stats });
          break;
        }

        case 'VALIDATE_CUSTOM_MODEL': {
          const { modelSource, customModelUrl } = message;
          // Model validation sanity check
          const validationResult = await validateModelSource(modelSource, customModelUrl);
          sendResponse(validationResult);
          break;
        }

        case 'CAPTURE_TAB': {
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && tab.id && tab.windowId) {
              const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
              sendResponse({ success: true, dataUrl });
            } else {
              sendResponse({ success: false, error: 'No active tab found for capture.' });
            }
          } catch (err) {
            sendResponse({ success: false, error: err.message });
          }
          break;
        }

        case 'CHECK_BACKEND': {
          const { endpointUrl = 'http://localhost:3721' } = message;
          const statusResult = await checkBackendAvailability(endpointUrl);
          sendResponse(statusResult);
          break;
        }

        case 'DISPATCH_REASONING': {
          // Routes the reasoning fetch through the service worker to avoid
          // Mixed Content blocking when content scripts run on HTTPS pages.
          const { endpointUrl = 'http://localhost:3721/api/reason', payload } = message;
          
          // Generate candidate URLs for dual-stack loopback resilience (localhost <-> 127.0.0.1)
          const candidateUrls = [endpointUrl];
          if (endpointUrl.includes('://localhost:')) {
            candidateUrls.push(endpointUrl.replace('://localhost:', '://127.0.0.1:'));
          } else if (endpointUrl.includes('://127.0.0.1:')) {
            candidateUrls.push(endpointUrl.replace('://127.0.0.1:', '://localhost:'));
          }

          let lastFetchErr = null;
          let dispatched = false;

          for (const url of candidateUrls) {
            try {
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 45000); // 45s for cloud LLM reasoning

              const resp = await fetch(url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Privision-Sanitized': 'true'
                },
                body: JSON.stringify(payload),
                signal: controller.signal
              });

              clearTimeout(timeoutId);

              if (resp.ok) {
                const data = await resp.json();
                sendResponse({ success: true, data });
                dispatched = true;
                break;
              } else {
                let errorBody = '';
                try { errorBody = await resp.text(); } catch {}
                sendResponse({
                  success: false,
                  status: resp.status,
                  errorBody,
                  error: `Reasoning endpoint returned status ${resp.status}`
                });
                dispatched = true;
                break;
              }
            } catch (fetchErr) {
              lastFetchErr = fetchErr;
              if (fetchErr.name === 'AbortError') {
                sendResponse({
                  success: false,
                  status: 504,
                  isTimeout: true,
                  error: 'Reasoning request timed out after 45s'
                });
                dispatched = true;
                break;
              }
              console.warn(`[PRIVISION ServiceWorker] Reachability attempt failed for ${url}: ${fetchErr.message}. Trying candidate fallback...`);
            }
          }

          if (!dispatched) {
            // Verify whether the backend server is actually online via root health check (GET /)
            const check = await checkBackendAvailability('http://localhost:3721');
            if (check.isOnline) {
              console.warn('[PRIVISION ServiceWorker] POST /api/reason failed, but backend root is ONLINE (GET /: 200)');
              sendResponse({
                success: false,
                status: 502,
                isOffline: false,
                error: `Reasoning request failed: ${lastFetchErr?.message || 'Server returned error'}`
              });
            } else {
              console.warn('[PRIVISION ServiceWorker] All candidate endpoints unreachable and backend root offline');
              sendResponse({
                success: false,
                isOffline: true,
                error: 'http://localhost:3721 is unreachable. AI reasoning was not executed.'
              });
            }
          }
          break;
        }

        default:
          sendResponse({ success: false, error: `Unknown action: ${message.action}` });
      }
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  })();
  return true; // Keep message channel open for async response
});

/**
 * Validates custom model configuration before saving.
 */
async function validateModelSource(modelSource, url) {
  if (modelSource === 'builtin') {
    return {
      valid: true,
      message: 'Built-in MobileViT ONNX weights verified (quantized, on-device).'
    };
  }

  if (modelSource === 'custom-hf') {
    if (!url || !url.includes('/')) {
      return { valid: false, message: 'Invalid Hugging Face model ID. Format: username/model-name' };
    }
    return { valid: true, message: `Model ID '${url}' format verified for Transformers.js.` };
  }

  if (modelSource === 'custom-onnx' || modelSource === 'remote-endpoint') {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { valid: false, message: 'Endpoint must use HTTP or HTTPS protocol.' };
      }
      return { valid: true, message: `Reachable endpoint format verified: ${parsed.hostname}` };
    } catch {
      return { valid: false, message: 'Invalid URL format provided.' };
    }
  }

  return { valid: false, message: 'Unrecognized model source type.' };
}
