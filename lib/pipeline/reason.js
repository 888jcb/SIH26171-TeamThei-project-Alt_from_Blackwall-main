/**
 * lib/pipeline/reason.js
 * Stage 5: Reason & Hard Privacy Boundary
 * 
 * Enforces the strict on-device privacy boundary assertion (Requirement 6, 7, 8).
 * Transmits ONLY sanitized context tokens and sanitized screenshots to the reasoning API.
 * Raw PII, unredacted pixels, and forbidden attributes are blocked by recursive assertions.
 */

export class PrivacyBoundaryBreachException extends Error {
  constructor(message) {
    super(`[PRIVISION PRIVACY BREACH] ${message}`);
    this.name = 'PrivacyBoundaryBreachException';
  }
}

export class ReasoningNetworkException extends Error {
  constructor(status, message, details = '') {
    super(message);
    this.name = 'ReasoningNetworkException';
    this.status = status;
    this.details = details;
  }
}

/**
 * Recursively inspects an object to ensure NO forbidden fields or unmasked PII exist.
 * Requirement 7: Second Privacy Gate before any network transmission.
 * @param {any} target
 * @param {string} currentPath
 */
export function assertSafeForNetwork(target, currentPath = 'root') {
  if (target === null || target === undefined) return;

  // Forbidden key names (case-insensitive)
  const FORBIDDEN_KEYS = [
    'rawvalue',
    'originalvalue',
    'originaltext',
    'rawtext',
    'html',
    'outerhtml',
    'innerhtml',
    'password',
    'secret',
    'authorization',
    'cookie',
    'session',
    'credential',
    'originalscreenshot',
    'rawscreenshot'
  ];

  if (typeof target === 'object') {
    if (Array.isArray(target)) {
      for (let i = 0; i < target.length; i++) {
        assertSafeForNetwork(target[i], `${currentPath}[${i}]`);
      }
    } else {
      for (const [key, value] of Object.entries(target)) {
        const lowerKey = key.toLowerCase();

        // Check for forbidden key names
        for (const forbidden of FORBIDDEN_KEYS) {
          if (lowerKey === forbidden || lowerKey.includes(forbidden)) {
            console.error('[PRIVISION SECURITY ALERT] Leak prevented:', {
              blocked: true,
              type: 'FORBIDDEN_FIELD',
              fieldPath: `${currentPath}.${key}`
            });
            throw new PrivacyBoundaryBreachException(`Forbidden field '${key}' detected at '${currentPath}.${key}'.`);
          }
        }

        // Check for image source leaks
        if (lowerKey === 'src' || lowerKey === 'currentsrc') {
          console.error('[PRIVISION SECURITY ALERT] Leak prevented:', {
            blocked: true,
            type: 'IMAGE_SOURCE',
            fieldPath: `${currentPath}.${key}`
          });
          throw new PrivacyBoundaryBreachException(`Raw image source '${key}' detected at '${currentPath}.${key}'.`);
        }

        assertSafeForNetwork(value, `${currentPath}.${key}`);
      }
    }
  } else if (typeof target === 'string') {
    // Dedicated Independent Image-Safety Gate:
    if (currentPath === 'root.screenshot') {
      if (!target.startsWith('data:image/')) {
        throw new PrivacyBoundaryBreachException(`Invalid screenshot format at '${currentPath}'. Must be a sanitized data URL.`);
      }
      if (target.length < 50) {
        throw new PrivacyBoundaryBreachException(`Truncated or invalid screenshot data at '${currentPath}'.`);
      }
      const lower = target.substring(0, 150).toLowerCase();
      if (lower.includes('rawscreenshot') || lower.includes('originalscreenshot')) {
        throw new PrivacyBoundaryBreachException(`Raw screenshot leakage detected at '${currentPath}'.`);
      }
      return;
    }

    // Check if text string contains unmasked high-risk PII patterns
    // Allow tokens like {{REDACTED_...}} or [REDACTED_...]
    const isRedactedToken = target.startsWith('{{REDACTED_') || target.startsWith('[REDACTED_');

    if (!isRedactedToken && target.length > 5) {
      // 1. Credit card pattern (13-19 digits, contiguous, spaced, hyphenated, or dot-separated)
      //    Use exec to capture the matched substring, then count only digit characters in that match.
      const ccRegexGlobal = /\b(?:\d[\s\-\.]*?){13,19}\b/g;
      let ccMatch;
      let hasUnmaskedCard = false;
      while ((ccMatch = ccRegexGlobal.exec(target)) !== null) {
        const matchedDigits = ccMatch[0].replace(/\D/g, '').length;
        if (matchedDigits >= 13 && matchedDigits <= 19) {
          hasUnmaskedCard = true;
          break;
        }
      }
      if (hasUnmaskedCard) {
        console.error('[PRIVISION SECURITY ALERT] Leak prevented: Credit card pattern detected in payload!', {
          blocked: true,
          type: 'CREDIT_CARD',
          fieldPath: currentPath
        });
        throw new PrivacyBoundaryBreachException(`Leak prevented: Credit card pattern detected in payload at '${currentPath}'!`);
      }

      // 2. SSN pattern (XXX-XX-XXXX)
      if (/\b\d{3}-\d{2}-\d{4}\b/.test(target)) {
        console.error('[PRIVISION SECURITY ALERT] Leak prevented: SSN pattern detected in payload!', {
          blocked: true,
          type: 'GOV_ID_SSN',
          fieldPath: currentPath
        });
        throw new PrivacyBoundaryBreachException(`Leak prevented: SSN pattern detected in payload at '${currentPath}'!`);
      }

      // 3. Aadhaar pattern (XXXX XXXX XXXX)
      if (/\b\d{4}\s\d{4}\s\d{4}\b/.test(target)) {
        console.error('[PRIVISION SECURITY ALERT] Leak prevented: Aadhaar pattern detected in payload!', {
          blocked: true,
          type: 'GOV_ID_AADHAAR',
          fieldPath: currentPath
        });
        throw new PrivacyBoundaryBreachException(`Leak prevented: Aadhaar pattern detected in payload at '${currentPath}'!`);
      }

      // 4. PAN pattern (5 letters + 4 digits + 1 letter)
      if (/\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/i.test(target)) {
        console.error('[PRIVISION SECURITY ALERT] Leak prevented: PAN pattern detected in payload!', {
          blocked: true,
          type: 'GOV_ID_PAN',
          fieldPath: currentPath
        });
        throw new PrivacyBoundaryBreachException(`Leak prevented: PAN pattern detected in payload at '${currentPath}'!`);
      }

      // 5. Email pattern (must not leak raw email addresses)
      if (/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(target)) {
        console.error('[PRIVISION SECURITY ALERT] Leak prevented: Email pattern detected in payload!', {
          blocked: true,
          type: 'EMAIL',
          fieldPath: currentPath
        });
        throw new PrivacyBoundaryBreachException(`Leak prevented: Email address detected in payload at '${currentPath}'!`);
      }
    }
  }
}

export class ReasoningClient {
  constructor(endpointUrl = 'http://localhost:3721/api/reason') {
    this.endpointUrl = endpointUrl;
  }

  /**
   * Dispatches the sanitized context to the cloud/agent reasoning service.
   * 
   * CRITICAL PRIVACY BOUNDARY ASSERTION:
   * Programmatically verifies that NO raw PII values, passwords, credit card numbers,
   * unredacted screenshots, or government IDs exist in the transmission payload.
   * 
   * FAIL CLOSED (Requirement 8): If any assertion or sanitization fails, the network
   * request is permanently aborted and { status: "blocked" } is returned.
   * 
   * @param {SanitizedContext} sanitizedContext 
   * @returns {Promise<AgentReasoningResponse>}
   */
  async submitSanitizedContext(sanitizedContext) {
    try {
      // =========================================================================
      // REQUIREMENT 6: CONSTRUCT COMPLETELY NEW ALLOWLISTED NETWORK PAYLOAD
      // =========================================================================
      if (!sanitizedContext || !sanitizedContext.privacy?.sanitized) {
        throw new PrivacyBoundaryBreachException('Payload missing certified sanitization signature.');
      }

      const networkPayload = {
        protocolVersion: 'privision-v2.0',
        timestamp: Date.now(),
        page: {
          domain: sanitizedContext.page?.domain || 'unknown',
          origin: sanitizedContext.page?.origin || 'null',
          path: sanitizedContext.page?.path || '/',
          pageType: sanitizedContext.page?.pageType || 'general'
        },
        viewport: {
          width: sanitizedContext.viewport?.width || 1280,
          height: sanitizedContext.viewport?.height || 800
        },
        elements: sanitizedContext.elements || [],
        screenshot: sanitizedContext.screenshot || null, // Sanitized on-device screenshot or null
        privacy: {
          sanitized: true,
          rawDataExcluded: true,
          redactedCount: sanitizedContext.redactedCount || 0,
          localPrivacyBoundaryActive: true
        }
      };

      // =========================================================================
      // DEVELOPMENT VERIFICATION & INDEPENDENT IMAGE SAFETY AUDIT
      // =========================================================================
      // 1. Verify raw screenshot is NOT included anywhere
      const rawScreenshotIncluded = 'rawScreenshot' in networkPayload ||
                                    'originalScreenshot' in networkPayload ||
                                    (sanitizedContext.rawScreenshot !== undefined && networkPayload.screenshot === sanitizedContext.rawScreenshot);

      if (rawScreenshotIncluded) {
        throw new PrivacyBoundaryBreachException('Security violation: raw screenshot detected in transmission payload!');
      }

      // 2. If screenshot exists, verify provenance (Option A with Option B safe fallback)
      if (networkPayload.screenshot) {
        const isValidDataUrl = typeof networkPayload.screenshot === 'string' &&
                               networkPayload.screenshot.startsWith('data:image/');

        if (!isValidDataUrl) {
          console.warn('[PRIVISION Security] Screenshot format invalid. Engaging Option B safe fallback: screenshot = null.');
          networkPayload.screenshot = null;
        }
      }

      // 3. Second Privacy Gate: Recursive inspection of all fields
      assertSafeForNetwork(networkPayload);

      // 4. Verification post-conditions
      const sanitizedScreenshotIncluded = !!networkPayload.screenshot;

      console.table({
        rawPIIDetected: false,
        rawScreenshotIncluded: false,
        sanitizedScreenshotIncluded,
        sanitizedDomIncluded: true,
        privacyBoundaryPassed: true
      });

      console.log(
        `%c[PRIVISION LOCAL PRIVACY BOUNDARY: ACTIVE]%c Transmitting ${networkPayload.elements.length} safe elements (${networkPayload.privacy.redactedCount} redacted).`,
        'background: #10B981; color: #000; font-weight: bold; padding: 2px 6px; border-radius: 3px;',
        'color: #10B981; font-weight: normal;'
      );

      // =========================================================================
      // NETWORK TRANSMISSION TO REASONING BACKEND
      // Avoids Mixed Content on HTTPS pages by routing via background service worker
      // =========================================================================
      let result;
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        let bgResponse = null;
        try {
          bgResponse = await chrome.runtime.sendMessage({
            action: 'DISPATCH_REASONING',
            endpointUrl: this.endpointUrl,
            payload: networkPayload
          });
        } catch (msgErr) {
          console.warn('[PRIVISION Reason] Background service worker unavailable, trying direct fetch fallback:', msgErr.message);
        }

        if (bgResponse && bgResponse.success) {
          result = bgResponse.data;
        } else if (bgResponse?.isOffline) {
          throw new ReasoningNetworkException(0, bgResponse.error || 'Endpoint unreachable', 'OFFLINE');
        } else if (bgResponse?.isTimeout) {
          throw new ReasoningNetworkException(504, bgResponse.error || 'Reasoning request timed out', 'TIMEOUT');
        } else if (bgResponse) {
          throw new ReasoningNetworkException(
            bgResponse.status || 500,
            bgResponse.error || 'Reasoning dispatch failed',
            bgResponse.errorBody || ''
          );
        } else {
          // Service worker was not reached or returned undefined; attempt direct fetch with loopback candidate fallback
          result = await this.directFetchWithFallback(networkPayload);
        }
      } else {
        // Headless / Node.js test environment
        result = await this.directFetchWithFallback(networkPayload);
      }

      return result;

    } catch (error) {
      // If it's a security breach, FAIL CLOSED permanently (Requirement 8)
      if (error instanceof PrivacyBoundaryBreachException) {
        console.error('%c[NETWORK SHARING: BLOCKED]%c ' + error.message, 'background: #EF4444; color: #fff; font-weight: bold; padding: 2px 6px;', 'color: #EF4444;');
        return {
          status: 'blocked',
          reason: 'PRIVACY_BOUNDARY_UNCERTAIN',
          errorTitle: 'NETWORK SHARING: BLOCKED',
          errorMessage: error.message,
          timestamp: Date.now()
        };
      }

      // Distinguish HTTP error states (Requirement 8)
      if (error instanceof ReasoningNetworkException) {
        if (error.status === 400) {
          console.warn(`[PRIVISION Reason] Reasoning backend invalid request (HTTP 400): ${error.message}`);
          return {
            status: 'blocked',
            reason: 'REASONING_BACKEND_INVALID_REQUEST',
            errorTitle: 'REASONING BACKEND: INVALID REQUEST',
            errorMessage: 'REASONING BACKEND: INVALID REQUEST — HTTP 400 Bad Request. The server rejected the payload schema or audit check.',
            timestamp: Date.now()
          };
        }

        if (error.status === 401 || error.status === 403) {
          console.warn(`[PRIVISION Reason] Reasoning backend authentication error (HTTP ${error.status}): ${error.message}`);
          return {
            status: 'blocked',
            reason: 'REASONING_BACKEND_AUTHENTICATION_ERROR',
            errorTitle: 'REASONING BACKEND: AUTHENTICATION ERROR',
            errorMessage: `REASONING BACKEND: AUTHENTICATION ERROR — HTTP ${error.status}. Invalid credentials or API key.`,
            timestamp: Date.now()
          };
        }

        if (error.status === 504) {
          console.warn(`[PRIVISION Reason] Reasoning backend timeout (HTTP 504): ${error.message}`);
          return {
            status: 'blocked',
            reason: 'REASONING_BACKEND_TIMEOUT',
            errorTitle: 'REASONING BACKEND: TIMEOUT',
            errorMessage: 'REASONING BACKEND: TIMEOUT — Reasoning request timed out waiting for AI response.',
            timestamp: Date.now()
          };
        }

        if (error.status >= 500) {
          console.warn(`[PRIVISION Reason] Reasoning backend server error (HTTP ${error.status}): ${error.message}`);
          return {
            status: 'blocked',
            reason: 'REASONING_BACKEND_SERVER_ERROR',
            errorTitle: 'REASONING BACKEND: SERVER ERROR',
            errorMessage: `REASONING BACKEND: SERVER ERROR — HTTP ${error.status}. Reasoning server encountered an internal error.`,
            timestamp: Date.now()
          };
        }
      }

      // Check if backend is actually online before declaring offline
      let isActuallyOnline = false;
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        try {
          const checkResp = await chrome.runtime.sendMessage({ action: 'CHECK_BACKEND' });
          if (checkResp?.isOnline) {
            isActuallyOnline = true;
          }
        } catch {}
      }

      if (isActuallyOnline) {
        console.warn(`[PRIVISION Reason] Reasoning dispatch failed, but backend is ONLINE: ${error.message}`);
        return {
          status: 'blocked',
          reason: 'REASONING_BACKEND_SERVER_ERROR',
          errorTitle: 'REASONING BACKEND: SERVER ERROR',
          errorMessage: `REASONING BACKEND: ONLINE (http://localhost:3721) — AI reasoning request did not complete: ${error.message}`,
          timestamp: Date.now()
        };
      }

      // Truly offline
      console.warn(`[PRIVISION Reason] Reasoning backend offline: ${error.message}`);
      return {
        status: 'blocked',
        reason: 'REASONING_BACKEND_OFFLINE',
        errorTitle: 'REASONING BACKEND: OFFLINE',
        errorMessage: 'REASONING BACKEND: OFFLINE — Server at http://localhost:3721 is unreachable. AI reasoning was not executed.',
        timestamp: Date.now()
      };
    }
  }

  /**
   * Direct fetch fallback with loopback candidate resolution (localhost <-> 127.0.0.1)
   * @param {Object} networkPayload
   * @returns {Promise<Object>}
   */
  async directFetchWithFallback(networkPayload) {
    const candidateUrls = [this.endpointUrl];
    if (this.endpointUrl.includes('://localhost:')) {
      candidateUrls.push(this.endpointUrl.replace('://localhost:', '://127.0.0.1:'));
    } else if (this.endpointUrl.includes('://127.0.0.1:')) {
      candidateUrls.push(this.endpointUrl.replace('://127.0.0.1:', '://localhost:'));
    }

    let lastError = null;
    for (const url of candidateUrls) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Privision-Sanitized': 'true'
          },
          body: JSON.stringify(networkPayload)
        });

        if (response.ok) {
          return await response.json();
        } else {
          let errBody = '';
          try { errBody = await response.text(); } catch {}
          throw new ReasoningNetworkException(
            response.status,
            `Reasoning endpoint returned status ${response.status}`,
            errBody
          );
        }
      } catch (fetchErr) {
        if (fetchErr instanceof ReasoningNetworkException) {
          throw fetchErr;
        }
        lastError = fetchErr;
      }
    }

    throw new ReasoningNetworkException(0, lastError?.message || 'Endpoint unreachable', 'OFFLINE');
  }
}
