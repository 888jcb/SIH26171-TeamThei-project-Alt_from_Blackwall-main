/**
 * lib/pipeline/act.js
 * Stage 6: Act — Local Action Validation & Execution
 * 
 * Enforces strict local validation of AI-recommended actions (Requirement 11, 12).
 * Resolves targets via stable local element IDs (privision-element-xxx).
 * NEVER evaluates arbitrary JavaScript or dynamic code from the model.
 */

export const ALLOWED_ACTIONS = Object.freeze([
  'CLICK',
  'FOCUS',
  'SCROLL',
  'NAVIGATE_SAFE',
  'WAIT',
  'NO_ACTION'
]);

let activeHudElement = null;
let hudTimeoutId = null;

/**
 * Validates and executes an agent action strictly against the local allowlist.
 * Requirement 11 & 12.
 * 
 * @param {AgentReasoningResponse} reasoningResponse 
 * @param {Map<string, HTMLElement>} localElementMap 
 * @returns {Object} Execution audit result
 */
export function validateAndExecuteAction(reasoningResponse, localElementMap) {
  // Check if reasoning was blocked (privacy breach or backend error/offline)
  if (reasoningResponse?.status === 'blocked') {
    let title = reasoningResponse.errorTitle || 'NETWORK SHARING: BLOCKED';
    let badgeText = 'Fail-Closed Active';
    let badgeColor = '#EF4444';

    if (reasoningResponse.reason === 'REASONING_BACKEND_OFFLINE') {
      title = 'REASONING BACKEND: OFFLINE';
      badgeText = 'Backend Offline';
      badgeColor = '#F59E0B';
    } else if (reasoningResponse.reason === 'REASONING_BACKEND_INVALID_REQUEST') {
      title = 'REASONING BACKEND: INVALID REQUEST';
      badgeText = 'Invalid Request (400)';
      badgeColor = '#EF4444';
    } else if (reasoningResponse.reason === 'REASONING_BACKEND_AUTHENTICATION_ERROR') {
      title = 'REASONING BACKEND: AUTHENTICATION ERROR';
      badgeText = 'Auth Error';
      badgeColor = '#EF4444';
    } else if (reasoningResponse.reason === 'REASONING_BACKEND_TIMEOUT') {
      title = 'REASONING BACKEND: TIMEOUT';
      badgeText = 'Request Timeout (504)';
      badgeColor = '#EF4444';
    } else if (reasoningResponse.reason === 'REASONING_BACKEND_SERVER_ERROR') {
      title = 'REASONING BACKEND: SERVER ERROR';
      badgeText = 'Server Error (500)';
      badgeColor = '#EF4444';
    }

    displayAgentHud({
      isBlocked: true,
      title,
      summary: reasoningResponse.errorMessage || (reasoningResponse.reason === 'REASONING_BACKEND_OFFLINE'
        ? 'Server at http://localhost:3721 is unreachable. AI reasoning was NOT executed. Start the backend with: node server/mock_reasoning_server.js'
        : 'Privacy boundary could not be guaranteed on this page. All network transmission was aborted.'),
      badgeText,
      badgeColor
    });
    return {
      executed: false,
      status: reasoningResponse.reason || 'BLOCKED_BY_PRIVACY_GATE',
      reason: reasoningResponse.reason
    };
  }

  const action = (reasoningResponse?.action || 'NO_ACTION').toUpperCase();
  const targetId = reasoningResponse?.targetId || null;
  const reason = reasoningResponse?.reason || 'Agent reasoning completed.';
  const confidence = reasoningResponse?.confidence || 0.0;

  // 1. Validate action against explicit allowlist
  if (!ALLOWED_ACTIONS.includes(action)) {
    console.error(`[PRIVISION Act] Security rejection: Disallowed action '${action}' received from reasoning model.`);
    displayAgentHud({
      isBlocked: true,
      title: 'ACTION VALIDATION: REJECTED',
      summary: `Model returned unauthorized action '${action}'. Permitted actions: ${ALLOWED_ACTIONS.join(', ')}.`,
      badgeText: 'Security Guard Active',
      badgeColor: '#EF4444'
    });
    return { executed: false, error: 'DISALLOWED_ACTION' };
  }

  // 2. Validate targetId if action requires a DOM target
  let targetElement = null;
  if (['CLICK', 'FOCUS'].includes(action)) {
    if (!targetId || !localElementMap.has(targetId)) {
      console.warn(`[PRIVISION Act] Target ID '${targetId}' not found in local stable element map.`);
      displayAgentHud({
        title: 'LOCAL PRIVACY BOUNDARY: ACTIVE',
        actionName: action,
        summary: `Action '${action}' could not find target '${targetId}'. No DOM mutation executed.`,
        badgeText: 'Target Unresolved',
        badgeColor: '#F59E0B'
      });
      return { executed: false, error: 'TARGET_NOT_FOUND' };
    }
    targetElement = localElementMap.get(targetId);
  }

  // 3. Safely execute strictly validated browser action (NO eval, NO new Function)
  let executionSuccess = false;
  try {
    switch (action) {
      case 'CLICK':
        if (targetElement && typeof targetElement.click === 'function') {
          targetElement.click();
          executionSuccess = true;
          console.log(`[PRIVISION Act] Executed safe CLICK on local target: ${targetId}`);
        }
        break;

      case 'FOCUS':
        if (targetElement && typeof targetElement.focus === 'function') {
          targetElement.focus();
          executionSuccess = true;
          console.log(`[PRIVISION Act] Executed safe FOCUS on local target: ${targetId}`);
        }
        break;

      case 'SCROLL':
        window.scrollBy({ top: 300, behavior: 'smooth' });
        executionSuccess = true;
        console.log('[PRIVISION Act] Executed safe SCROLL.');
        break;

      case 'NAVIGATE_SAFE':
        const targetUrl = reasoningResponse?.navigationUrl;
        if (targetUrl) {
          try {
            const parsed = new URL(targetUrl);
            if (['http:', 'https:'].includes(parsed.protocol)) {
              window.location.href = parsed.href;
              executionSuccess = true;
            } else {
              console.warn('[PRIVISION Act] Rejected unsafe navigation protocol:', parsed.protocol);
            }
          } catch {
            console.warn('[PRIVISION Act] Invalid navigation URL received.');
          }
        }
        break;

      case 'WAIT':
      case 'NO_ACTION':
        executionSuccess = true;
        console.log(`[PRIVISION Act] No DOM action required (${action}).`);
        break;
    }
  } catch (domErr) {
    console.error('[PRIVISION Act] DOM action execution error:', domErr);
  }

  // 4. Update on-page HUD
  displayAgentHud({
    isBlocked: false,
    title: 'LOCAL PRIVACY BOUNDARY: ACTIVE',
    actionName: action,
    targetId: targetId,
    summary: reason,
    confidence: Math.round(confidence * 100),
    badgeText: executionSuccess ? `${action} Validated` : 'Boundary Held',
    badgeColor: executionSuccess ? '#10B981' : '#38BDF8'
  });

  return {
    executed: executionSuccess,
    action,
    targetId,
    confidence
  };
}

/**
 * Displays the Agent Action HUD on the active web page.
 * @param {Object} options 
 */
export function displayAgentHud(options = {}) {
  if (activeHudElement && activeHudElement.parentNode) {
    activeHudElement.remove();
  }
  if (hudTimeoutId) {
    clearTimeout(hudTimeoutId);
  }

  const hud = document.createElement('div');
  hud.className = 'privision-agent-hud';
  if (options.isBlocked) {
    hud.classList.add('privision-hud-blocked');
  }

  const badgeColor = options.badgeColor || '#10B981';
  const badgeText = options.badgeText || 'Boundary Verified';
  const title = options.title || 'LOCAL PRIVACY BOUNDARY: ACTIVE';
  const actionBadge = options.actionName ? `<span class="privision-hud-action-tag">${options.actionName}${options.targetId ? ` &rarr; ${options.targetId}` : ''}</span>` : '';

  hud.innerHTML = `
    <div class="privision-hud-header">
      <div class="privision-hud-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${badgeColor}" stroke-width="2.2">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
        <span>${title}</span>
      </div>
      <span class="privision-hud-badge" style="border-color: ${badgeColor}; color: ${badgeColor};">${badgeText}</span>
    </div>
    <div class="privision-hud-body">
      ${options.summary || 'Page sanitized on-device. Zero raw PII transmitted.'}
    </div>
    ${actionBadge ? `<div class="privision-hud-action-row">${actionBadge}</div>` : ''}
  `;

  document.body.appendChild(hud);
  activeHudElement = hud;

  hudTimeoutId = setTimeout(() => {
    if (activeHudElement && activeHudElement.parentNode) {
      activeHudElement.style.opacity = '0';
      activeHudElement.style.transform = 'translateY(15px)';
      setTimeout(() => activeHudElement.remove(), 300);
    }
  }, 7000);

  return hud;
}
