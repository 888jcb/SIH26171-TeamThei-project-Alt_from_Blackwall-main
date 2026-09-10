/**
 * lib/pipeline/capture.js
 * Stage 1: Capture
 * 
 * Captures the visible DOM snapshot, bounding boxes, element semantic attributes,
 * and viewport coordinates on the client device.
 */

export class PageCapture {
  constructor(options = {}) {
    this.includeImages = options.includeImages !== false;
    this.maxTextLength = options.maxTextLength || 1000;
  }

  /**
   * Captures the active viewport state and candidate DOM nodes.
   * @returns {Promise<PageCaptureSnapshot>}
   */
  async capture() {
    const startTime = performance.now();
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX || window.pageXOffset || 0,
      scrollY: window.scrollY || window.pageYOffset || 0,
      devicePixelRatio: window.devicePixelRatio || 1
    };

    const candidateElements = this._findCandidateNodes(viewport);

    // Capture viewport screenshot via background service worker if permitted
    let screenshotDataUrl = null;
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        const resp = await chrome.runtime.sendMessage({ action: 'CAPTURE_TAB' });
        if (resp && resp.success && resp.dataUrl) {
          screenshotDataUrl = resp.dataUrl;
        }
      }
    } catch {
      // Non-fatal if tab capture is restricted (e.g. extension pages or protected origins)
    }

    const durationMs = Math.round(performance.now() - startTime);
    const safePage = this._sanitizePageUrl(window.location.href);

    // =========================================================================
    // LOCAL CAPTURE OBJECT (STRICTLY ON-DEVICE — NEVER SENT TO NETWORK)
    // =========================================================================
    return {
      _isLocalCaptureOnly: true,
      timestamp: Date.now(),
      viewport,
      captureDurationMs: durationMs,
      elements: candidateElements, // LOCAL ONLY: raw DOM nodes, local attributes
      rawScreenshot: screenshotDataUrl, // LOCAL ONLY: raw pixels, fed only to local canvas redactor
      safePage // SAFE METADATA: sanitized origin and path, query params stripped
    };
  }

  /**
   * Sanitizes the page URL by stripping query parameters, fragments, tokens, and credentials.
   * Requirement 4: Never send window.location.href blindly.
   * Aggressively detects authentication / OAuth endpoints (e.g. accounts.google.com).
   * @param {string} rawUrl 
   * @returns {{ origin: string, domain: string, path: string, pageType: string }}
   * @private
   */
  _sanitizePageUrl(rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      const domain = (parsed.hostname || '').toLowerCase();
      const origin = parsed.origin || 'null';
      let path = parsed.pathname || '/';

      // Aggressively classify authentication / OAuth flows (e.g. accounts.google.com, /signin, /oauth)
      const isAuthDomain = domain === 'accounts.google.com' ||
                           domain.includes('login') ||
                           domain.includes('auth') ||
                           domain.includes('sso');

      const isAuthPath = /\/(signin|signup|login|logout|oauth|auth|authorize|token|v2\/auth|v3\/signin)/i.test(path);
      const isAuth = isAuthDomain || isAuthPath;
      const pageType = isAuth ? 'authentication' : 'general';

      // Check if path contains sensitive keywords or credentials/tokens (hex/base64 strings > 16 chars)
      const sensitivePathRegex = /(token|session|auth|key|secret|password|email|cvv|account|\b[A-Za-z0-9_-]{24,}\b)/i;
      if (isAuth || sensitivePathRegex.test(path)) {
        // Safe truncated path: keep at most the top-level auth segment without specific identifiers or queries
        const firstSegment = path.split('/').filter(Boolean)[0];
        path = firstSegment ? `/${firstSegment}` : '/';
      }

      // Explicitly return only safe domain, origin, path, and pageType.
      // Search params (e.g. code_challenge, state, client_id) and hash fragments are COMPLETELY EXCLUDED.
      return {
        domain,
        origin,
        path,
        pageType
      };
    } catch {
      return {
        domain: 'unknown-origin',
        origin: 'null',
        path: '/',
        pageType: 'unknown'
      };
    }
  }

  /**
   * Traverses visible DOM elements and filters for content nodes & interactive inputs.
   * @private
   */
  _findCandidateNodes(viewport) {
    const candidates = [];
    const elements = document.querySelectorAll(
      'input, textarea, [contenteditable="true"], select, ' +
      'p, span, td, th, li, a, h1, h2, h3, h4, h5, h6, label, div, img'
    );

    for (const el of elements) {
      // Avoid inspecting PRIVISION's own UI elements
      if (el.closest('.privision-redact-overlay') || el.closest('.privision-agent-hud')) {
        continue;
      }

      const rect = el.getBoundingClientRect();

      // Check if element has non-zero geometry and is reasonably within or near viewport
      if (rect.width <= 2 || rect.height <= 2) continue;
      if (rect.bottom < -200 || rect.top > viewport.height + 200) continue;

      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        continue;
      }

      // Check element role/tag
      const isInput = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
      const isImage = el.tagName === 'IMG';

      let textContent = '';
      let rawValue = '';

      if (isInput) {
        rawValue = el.value || el.innerText || '';
        textContent = rawValue;
      } else if (!isImage) {
        // Only include non-input text elements if they are direct text containers
        if (el.children.length === 0 || (el.children.length === 1 && el.firstElementChild.tagName === 'B')) {
          textContent = (el.innerText || el.textContent || '').trim();
          if (!textContent) continue;
          if (textContent.length > this.maxTextLength) {
            textContent = textContent.slice(0, this.maxTextLength);
          }
        } else {
          continue;
        }
      }

      // Associated label or accessible description
      const labelText = this._resolveElementLabel(el);

      candidates.push({
        node: el,
        tagName: el.tagName.toLowerCase(),
        isInput,
        isImage,
        type: (el.getAttribute('type') || '').toLowerCase(),
        name: el.getAttribute('name') || '',
        id: el.id || '',
        autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
        ariaLabel: el.getAttribute('aria-label') || '',
        ariaRole: el.getAttribute('role') || '',
        placeholder: el.getAttribute('placeholder') || '',
        labelText,
        rawValue,
        textContent,
        src: isImage ? el.currentSrc || el.src || '' : null,
        rect: {
          x: Math.round(rect.x + viewport.scrollX),
          y: Math.round(rect.y + viewport.scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          clientX: Math.round(rect.x),
          clientY: Math.round(rect.y)
        }
      });
    }

    return candidates;
  }

  /**
   * Resolves the textual label associated with an element (via <label for="..."> or parent label).
   * @private
   */
  _resolveElementLabel(el) {
    if (el.id) {
      const labelEl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (labelEl) return labelEl.innerText.trim();
    }
    const parentLabel = el.closest('label');
    if (parentLabel) {
      return parentLabel.innerText.trim();
    }
    return '';
  }
}
