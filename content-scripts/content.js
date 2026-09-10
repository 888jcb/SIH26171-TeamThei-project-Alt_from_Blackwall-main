/**
 * content-scripts/content.js
 * In-Page Orchestration Coordinator for PRIVISION
 * 
 * Drives the 6-stage pipeline: Capture -> Perceive -> Detect -> Redact -> Reason -> Act
 */

(async function initPrivision() {
  // Prevent duplicate injection
  if (window.__PRIVISION_INITIALIZED__) return;
  window.__PRIVISION_INITIALIZED__ = true;

  console.log('[PRIVISION HANDSHAKE] Content script loaded');
  console.log('[PRIVISION] Initializing On-Device Privacy Layer...');

  // State flags
  let isEnabled = true;
  let isEligible = false;
  let isScanning = false;
  let inputDebounceTimer = null;
  let pipelineReady = false;

  // Pipeline instances
  let capturer = null;
  let perceiver = null;
  let detector = null;
  let redactor = null;
  let reasoner = null;
  let redactAnimation = null;
  let displayAgentHud = null;
  let validateAndExecuteAction = null;

  // Retrieve status from background service worker
  async function refreshEligibility() {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'GET_STATUS' });
      if (response && response.success) {
        isEnabled = response.config?.isEnabled !== false;
        isEligible = response.currentTab?.eligible || false;
        if (response.config) {
          if (response.config.confidenceThreshold !== undefined && detector) {
            detector.setThreshold(response.config.confidenceThreshold);
          }
          if (perceiver) {
            perceiver.updateConfig(response.config);
          }
        }
        return isEnabled && isEligible;
      }
    } catch {
      return false;
    }
    return false;
  }

  // Set up webpage postMessage handshake bridge early so no detection requests are missed
  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data || typeof event.data !== 'object') return;

    if (event.data.type === 'PRIVISION_DETECTION_REQUEST') {
      console.log('[PRIVISION HANDSHAKE] Detection request received');
      const canRun = await refreshEligibility();
      window.postMessage({
        type: 'PRIVISION_DETECTION_RESPONSE',
        installed: true,
        active: canRun,
        version: chrome.runtime?.getManifest?.()?.version || '1.0.0'
      }, '*');
      console.log('[PRIVISION HANDSHAKE] Detection response sent');
    } else if (event.data.type === 'PRIVISION_TRIGGER_SCAN') {
      executePipeline('manual-demo-trigger');
    } else if (event.data.type === 'PRIVISION_RESET') {
      if (typeof cancelJudgementAnimation === 'function') {
        cancelJudgementAnimation();
      }
      if (redactor) {
        redactor.clearAll();
      }
    }
  });

  // Dynamically load pipeline ES modules
  let PageCapture, VisionPerceiver, SensitivityDetector, ContextRedactor, ReasoningClient;
  let playJudgementAnimation = null;
  let cancelJudgementAnimation = null;
  try {
    const captureMod = await import(chrome.runtime.getURL('lib/pipeline/capture.js'));
    const perceiveMod = await import(chrome.runtime.getURL('lib/pipeline/perceive.js'));
    const detectMod = await import(chrome.runtime.getURL('lib/pipeline/detect.js'));
    const redactMod = await import(chrome.runtime.getURL('lib/pipeline/redact.js'));
    const reasonMod = await import(chrome.runtime.getURL('lib/pipeline/reason.js'));
    const actMod = await import(chrome.runtime.getURL('lib/pipeline/act.js'));
    const needleMod = await import(chrome.runtime.getURL('content-scripts/needle-animation.js'));

    PageCapture = captureMod.PageCapture;
    VisionPerceiver = perceiveMod.VisionPerceiver;
    SensitivityDetector = detectMod.SensitivityDetector;
    ContextRedactor = redactMod.ContextRedactor;
    redactAnimation = redactMod.redactAnimation;
    playJudgementAnimation = needleMod.playJudgementAnimation;
    cancelJudgementAnimation = needleMod.cancelJudgementAnimation;
    ReasoningClient = reasonMod.ReasoningClient;
    displayAgentHud = actMod.displayAgentHud;
    validateAndExecuteAction = actMod.validateAndExecuteAction;

    // Expose redactAnimation and playJudgementAnimation globally in isolated world
    window.redactAnimation = redactAnimation;
    window.playJudgementAnimation = playJudgementAnimation;
    window.cancelJudgementAnimation = cancelJudgementAnimation;
    window.__PRIVISION__ = {
      redactAnimation,
      playJudgementAnimation,
      cancelJudgementAnimation,
      runFullScan: () => executePipeline('manual-developer-call')
    };

    // Instantiate pipeline components
    capturer = new PageCapture();
    perceiver = new VisionPerceiver();
    detector = new SensitivityDetector();
    redactor = new ContextRedactor();
    reasoner = new ReasoningClient();
    pipelineReady = true;

    // Immediately announce presence to demo page
    const canRunInit = await refreshEligibility();
    window.postMessage({
      type: 'PRIVISION_DETECTION_RESPONSE',
      installed: true,
      active: canRunInit,
      version: chrome.runtime?.getManifest?.()?.version || '1.0.0'
    }, '*');
    console.log('[PRIVISION HANDSHAKE] Detection response sent');
  } catch (loadErr) {
    console.error('[PRIVISION] Failed to load pipeline modules:', loadErr);
    return;
  }

  /**
   * Primary pipeline executor:
   * LOCAL CAPTURE -> LOCAL DETECTION -> LOCAL SANITIZATION -> PRIVACY BOUNDARY -> REASONING -> ACTION VALIDATION -> BROWSER ACTION
   */
  async function executePipeline(triggerSource = 'auto') {
    if (isScanning || !pipelineReady || !capturer) return;
    const canRun = await refreshEligibility();
    if (!canRun) {
      console.log(`[PRIVISION] Pipeline skipped (${triggerSource}): disabled or domain not allowlisted.`);
      return;
    }

    isScanning = true;
    console.log(`[PRIVISION] 🛡️ Executing On-Device Pipeline (Trigger: ${triggerSource})`);

    try {
      // 1. LOCAL CAPTURE (Raw DOM, coordinates, and tab screenshot strictly on-device)
      const localCapture = await capturer.capture();

      // 2. LOCAL PERCEPTION (Evaluates visual bounding geometry & DOM taxonomy)
      const perceivedSignals = await perceiver.perceive(localCapture);

      // 3. LOCAL DETECTION (Multi-modal fail-closed sensitivity detection)
      const detections = detector.detect(perceivedSignals);

      console.log(`[PRIVISION] Detected ${detections.length} sensitive targets:`, detections.map(d => `${d.category} (${d.reason})`));

      // 4. LOCAL SANITIZATION & REDACTION (On-screen visual animation + in-memory canvas screenshot redaction)
      const { sanitizedContext, localElementMap } = await redactor.redact(detections, localCapture);

      // Notify background to update statistics
      if (detections.length > 0) {
        chrome.runtime.sendMessage({
          action: 'UPDATE_STATS',
          redactionsCount: detections.length
        }).catch(() => {});
      }

      // 5. PRIVACY GATE & REASONING (Asserts zero raw PII, dispatches only sanitized payload)
      const reasoningResponse = await reasoner.submitSanitizedContext(sanitizedContext);

      // 6. ACTION VALIDATION & EXECUTION (Enforces action allowlist and resolves targets locally)
      const actionResult = validateAndExecuteAction(reasoningResponse, localElementMap);
      console.log('[PRIVISION] Action Execution Result:', actionResult);

    } catch (err) {
      console.error('[PRIVISION] Pipeline error during execution:', err);
    } finally {
      isScanning = false;
    }
  }

  // Listen for manual scan trigger or configuration updates from popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'MANUAL_SCAN') {
      executePipeline('manual-popup-trigger')
        .then(() => sendResponse({ success: true, message: 'Scan complete' }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (message.action === 'CONFIG_CHANGED') {
      isEnabled = message.isEnabled;
      if (!isEnabled) {
        redactor.clearAll();
      } else {
        executePipeline('config-enabled');
      }
      sendResponse({ success: true });
    }
  });

  // Dynamic input monitoring: detects sensitive typing (e.g. user entering password, card, email)
  document.addEventListener('input', (event) => {
    const target = event.target;
    if (!target || !target.tagName) return;

    const isInputField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
    if (!isInputField) return;

    if (inputDebounceTimer) clearTimeout(inputDebounceTimer);
    inputDebounceTimer = setTimeout(() => {
      // Re-evaluate newly typed content
      executePipeline('input-event');
    }, 600);
  }, true);

  // Initial execution after DOM stabilizes
  setTimeout(() => {
    executePipeline('page-load');
  }, 400);

  // Observe substantial DOM modifications (e.g. modal popups or SPAs loading new forms)
  const mutationObserver = new MutationObserver((mutations) => {
    let hasAddedNodes = false;
    for (const m of mutations) {
      if (m.addedNodes.length > 0) {
        // Ignore PRIVISION's own overlays
        const hasExternalNode = Array.from(m.addedNodes).some(n =>
          n.nodeType === 1 &&
          !n.classList?.contains('privision-redact-overlay') &&
          !n.classList?.contains('privision-agent-hud') &&
          !n.classList?.contains('privision-judgement-animation')
        );
        if (hasExternalNode) {
          hasAddedNodes = true;
          break;
        }
      }
    }

    if (hasAddedNodes) {
      if (inputDebounceTimer) clearTimeout(inputDebounceTimer);
      inputDebounceTimer = setTimeout(() => {
        executePipeline('dom-mutation');
      }, 700);
    }
  });

  mutationObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  });
})();
