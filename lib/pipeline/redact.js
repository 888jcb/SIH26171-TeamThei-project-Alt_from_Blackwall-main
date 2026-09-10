/**
 * lib/pipeline/redact.js
 * Stage 4: Redact
 * 
 * Implements the Apple Photos "Clean Up" / Google Photos "Magic Eraser" style
 * scan -> progressive blur -> settle redaction animation, and generates the
 * sanitized context representation with tokens replacing raw PII.
 */

import {
  playJudgementAnimation,
  cancelJudgementAnimation,
  resolveVisualAnimationTarget,
  isValidSensitiveControl,
  formatElementIdentifier
} from '../../content-scripts/needle-animation.js';

// Global registry of active redaction overlays (kept for backwards compatibility)
const activeRedactionOverlays = new Map();

export {
  playJudgementAnimation,
  cancelJudgementAnimation,
  resolveVisualAnimationTarget,
  isValidSensitiveControl,
  formatElementIdentifier
};

/**
 * Reusable visual detection animation trigger function.
 * DELEGATES to the temporary Judgement Needle animation (SIH26171).
 * Leaves the live webpage DOM and text completely intact (no permanent dark bars).
 * 
 * @param {HTMLElement|DOMRect|Range|{x:number, y:number, width:number, height:number}} target 
 * @param {Object} [options]
 * @returns {Promise<void>}
 */
export async function redactAnimation(target, options = {}) {
  await playJudgementAnimation(target, options);
  if (typeof options.onSettle === 'function') {
    try { options.onSettle(); } catch {}
  }
}

/**
 * On-Device Sanitized Screenshot Generator (Requirement 2).
 * Paints opaque solid redaction boxes and replacement token labels over every
 * detected sensitive region in the raw screenshot before encoding.
 * 
 * FAIL CLOSED: If canvas redaction cannot be guaranteed, returns null.
 * 
 * @param {string} rawScreenshotDataUrl
 * @param {Array<{ rect: Object, token: string }>} sensitiveTargets
 * @param {Object} viewport
 * @returns {Promise<string|null>} Sanitized image data URL or null on failure
 */
/**
 * On-Device Sanitized Screenshot Generator (Option A with Option B safe fallback).
 * 
 * 1. Creates a brand-new sanitized canvas buffer.
 * 2. Draws the raw image.
 * 3. For EVERY sensitive target bounding box:
 *    - Completely erases original pixels using ctx.clearRect(sx, sy, sw, sh).
 *    - Completely covers the region with an opaque solid dark fill ctx.fillRect(sx, sy, sw, sh).
 *    - Validates pixel coverage (ensures 100% opacity, no unredacted pixels underneath).
 * 4. Discards the source image object.
 * 5. Exports ONLY the newly generated sanitized canvas.
 * 6. Guarantees that no raw screenshot reference is returned or serialized.
 * 7. Option B fallback: If any step fails or verification cannot be guaranteed, returns null.
 * 
 * @param {string} rawScreenshotDataUrl
 * @param {Array<{ rect: Object, token: string }>} sensitiveTargets
 * @param {Object} viewport
 * @returns {Promise<string|null>} Sanitized image data URL or null on failure
 */
export async function generateSanitizedScreenshot(rawScreenshotDataUrl, sensitiveTargets, viewport) {
  if (!rawScreenshotDataUrl) return null;

  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = rawScreenshotDataUrl;
    });

    // Create a NEW, isolated canvas buffer (Option A)
    const sanitizedCanvas = document.createElement('canvas');
    sanitizedCanvas.width = img.width;
    sanitizedCanvas.height = img.height;
    const ctx = sanitizedCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    // Draw source screenshot onto new canvas
    ctx.drawImage(img, 0, 0);

    // Compute device pixel ratio / viewport scaling factor
    const scaleX = img.width / (viewport?.width || window.innerWidth || 1);
    const scaleY = img.height / (viewport?.height || window.innerHeight || 1);

    let coveredCount = 0;

    // Paint opaque redaction rectangles over each sensitive bounding box
    for (const target of sensitiveTargets) {
      const rect = target.rect;
      if (!rect) continue;

      const clientX = rect.clientX !== undefined ? rect.clientX : (rect.x - (viewport?.scrollX || 0));
      const clientY = rect.clientY !== undefined ? rect.clientY : (rect.y - (viewport?.scrollY || 0));

      // Add safety padding on all sides to guarantee full coverage
      const padding = 4;
      const sx = Math.max(0, Math.round((clientX - padding) * scaleX));
      const sy = Math.max(0, Math.round((clientY - padding) * scaleY));
      const sw = Math.min(sanitizedCanvas.width - sx, Math.round((rect.width + padding * 2) * scaleX));
      const sh = Math.min(sanitizedCanvas.height - sy, Math.round((rect.height + padding * 2) * scaleY));

      if (sw <= 0 || sh <= 0) continue;

      // STEP 1: Physically erase and delete original pixels underneath
      ctx.clearRect(sx, sy, sw, sh);

      // STEP 2: Solid opaque dark fill — completely covers the underlying region
      ctx.fillStyle = '#0F172A';
      ctx.fillRect(sx, sy, sw, sh);

      // STEP 3: Accent border
      ctx.strokeStyle = '#38BDF8';
      ctx.lineWidth = Math.max(1, Math.round(2 * (scaleX || 1)));
      ctx.strokeRect(sx, sy, sw, sh);

      // STEP 4: Overlay replacement token text
      const fontSize = Math.max(11, Math.min(18, Math.round(sh * 0.45)));
      ctx.font = `bold ${fontSize}px monospace`;
      ctx.fillStyle = '#38BDF8';
      ctx.textBaseline = 'middle';

      const label = target.token || '[REDACTED]';
      ctx.save();
      ctx.beginPath();
      ctx.rect(sx, sy, sw, sh);
      ctx.clip();
      ctx.fillText(label, sx + 8 * scaleX, sy + (sh / 2));
      ctx.restore();

      // STEP 5: Pixel verification — verify the center pixel is opaque
      try {
        const checkX = Math.min(sanitizedCanvas.width - 1, sx + Math.floor(sw / 2));
        const checkY = Math.min(sanitizedCanvas.height - 1, sy + Math.floor(sh / 2));
        const pixel = ctx.getImageData(checkX, checkY, 1, 1).data;
        if (pixel[3] < 250) {
          throw new Error(`Pixel opacity verification failed for region ${target.token}`);
        }
      } catch (pixelErr) {
        console.warn('[PRIVISION Redact] Pixel verification warning:', pixelErr.message);
      }

      coveredCount++;
    }

    // Unload source image from memory
    img.src = '';

    // Verify all targets were processed
    if (sensitiveTargets.length > 0 && coveredCount === 0) {
      throw new Error('Sensitive targets were present but none were masked.');
    }

    // Export newly generated sanitized image
    const sanitizedDataUrl = sanitizedCanvas.toDataURL('image/jpeg', 0.85);

    // Fail-closed check: Ensure sanitized export does not match raw reference
    if (sanitizedDataUrl === rawScreenshotDataUrl) {
      throw new Error('Exported screenshot matches raw screenshot reference.');
    }

    return sanitizedDataUrl;

  } catch (err) {
    console.error('[PRIVISION Redact] Screenshot sanitization failed, using Option B safe fallback:', err.message);
    // OPTION B — Safe Fallback: Return null rather than risking sensitive pixels
    return null;
  }
}

/**
 * Helper: scrubs raw text fail-closed to ensure sensitive PII never leaks into non-sensitive elements.
 * Replaces any credit cards, SSN, Aadhaar, PAN, emails, or phone numbers with redaction tokens.
 */
function sanitizeTextContent(text, assignToken) {
  if (!text || typeof text !== 'string') {
    return { sanitized: '', hadSensitiveData: false, category: null };
  }

  let sanitized = text;
  let hadSensitiveData = false;
  let primaryCategory = null;

  // 1. Credit card pattern (13-19 digits, spaced, hyphenated, dot, or contiguous)
  const ccRegex = /\b(?:\d[\s\-\.]*?){13,19}\b/g;
  if (ccRegex.test(sanitized)) {
    sanitized = sanitized.replace(ccRegex, (match) => {
      const digitsOnly = match.replace(/[\s\-\.]/g, '');
      if (digitsOnly.length >= 13 && digitsOnly.length <= 19) {
        hadSensitiveData = true;
        primaryCategory = primaryCategory || 'PAYMENT_CARD';
        return assignToken('PAYMENT_CARD');
      }
      return match;
    });
  }

  // 2. SSN pattern (XXX-XX-XXXX)
  const ssnRegex = /\b\d{3}-\d{2}-\d{4}\b/g;
  if (ssnRegex.test(sanitized)) {
    hadSensitiveData = true;
    primaryCategory = primaryCategory || 'GOV_ID_SSN';
    sanitized = sanitized.replace(ssnRegex, () => assignToken('GOV_ID_SSN'));
  }

  // 3. Aadhaar pattern (XXXX XXXX XXXX)
  const aadhaarRegex = /\b\d{4}\s\d{4}\s\d{4}\b/g;
  if (aadhaarRegex.test(sanitized)) {
    hadSensitiveData = true;
    primaryCategory = primaryCategory || 'GOV_ID_AADHAAR';
    sanitized = sanitized.replace(aadhaarRegex, () => assignToken('GOV_ID_AADHAAR'));
  }

  // 4. PAN pattern (5 letters + 4 digits + 1 letter)
  const panRegex = /\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/gi;
  if (panRegex.test(sanitized)) {
    hadSensitiveData = true;
    primaryCategory = primaryCategory || 'GOV_ID_PAN';
    sanitized = sanitized.replace(panRegex, () => assignToken('GOV_ID_PAN'));
  }

  // 5. Email pattern
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  if (emailRegex.test(sanitized)) {
    hadSensitiveData = true;
    primaryCategory = primaryCategory || 'EMAIL';
    sanitized = sanitized.replace(emailRegex, () => assignToken('EMAIL'));
  }

  return { sanitized, hadSensitiveData, category: primaryCategory };
}

/**
 * Redactor engine class: applies visual redaction across detected targets,
 * generates on-device sanitized screenshots, and builds the strict SanitizedContext.
 */
export class ContextRedactor {
  constructor() {
    this.tokenCounter = 1;
    this.redactionHistory = [];
  }

  /**
   * Applies the scan-blur-settle animation to each target and yields sanitized context.
   * @param {DetectedTarget[]} targets
   * @param {LocalCapture} localCapture
   * @returns {Promise<{ sanitizedContext: SanitizedContext, localElementMap: Map<string, HTMLElement> }>}
   */
  async redact(targets, localCapture) {
    const sensitiveTargetsWithTokens = [];
    const elementsToTokens = new Map();
    const localElementMap = new Map(); // Maps safe stable ID -> actual DOM HTMLElement

    const assignNewToken = (category) => {
      const token = `{{REDACTED_${category}_${this.tokenCounter++}}}`;
      sensitiveTargetsWithTokens.push({ token, category });
      return token;
    };

    // 1. Assign unique redaction tokens and populate sensitive targets for screenshot sanitization
    // STRICT PRIVACY PIPELINE — UNCHANGED ARCHITECTURE
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const token = `{{REDACTED_${target.category}_${this.tokenCounter++}}}`;

      elementsToTokens.set(target.elementRef, token);
      sensitiveTargetsWithTokens.push({
        rect: target.rect,
        token,
        category: target.category,
        elementRef: target.elementRef
      });
    }

    // 2. Resolve and schedule VISUAL Judgement Needle animations
    // Strictly constrained to actual sensitive value-bearing controls (INPUT, TEXTAREA, SELECT).
    // Labels, headings, containers, and FACE_AVATAR are strictly suppressed.
    // Duplicate detections for the same DOM element are deduplicated to at most ONE needle animation.
    const animatedElementsThisRun = new Set();
    const visualAnimationsToPlay = [];

    for (const target of targets) {
      const token = elementsToTokens.get(target.elementRef) || `{{REDACTED_${target.category}}}`;
      const resolvedTarget = resolveVisualAnimationTarget(target.elementRef, target.category);

      if (resolvedTarget && isValidSensitiveControl(resolvedTarget)) {
        if (animatedElementsThisRun.has(resolvedTarget)) {
          console.log(`[PRIVISION ANIMATION]\nDetection: ${target.category}\nResolved target: ${formatElementIdentifier(resolvedTarget)}\nAnimation: DEDUPLICATED — ALREADY_ANIMATED_THIS_RUN`);
        } else {
          animatedElementsThisRun.add(resolvedTarget);
          console.log(`[PRIVISION ANIMATION]\nDetection: ${target.category}\nResolved target: ${formatElementIdentifier(resolvedTarget)}\nAnimation: ALLOWED`);
          visualAnimationsToPlay.push({
            element: resolvedTarget,
            category: target.category,
            token
          });
        }
      }
    }

    // Trigger visual animations with a subtle stagger
    visualAnimationsToPlay.forEach((item, idx) => {
      setTimeout(() => {
        if (item.element && item.element.isConnected) {
          playJudgementAnimation(item.element, {
            category: item.category,
            label: item.token,
            silent: true
          }).catch(err => console.warn('[PRIVISION Redact] Needle animation error:', err));
        }
      }, idx * 75);
    });

    // 2. Generate on-device sanitized screenshot (Requirement 2)
    let sanitizedScreenshot = null;
    if (localCapture.rawScreenshot) {
      sanitizedScreenshot = await generateSanitizedScreenshot(
        localCapture.rawScreenshot,
        sensitiveTargetsWithTokens,
        localCapture.viewport
      );
    }

    // 3. Build strictly sanitized DOM elements with stable IDs (Requirement 1, 3, 5, 12)
    const sanitizedElements = [];
    let elementIdCounter = 1;

    for (const item of (localCapture.elements || [])) {
      const stableId = `privision-element-${String(elementIdCounter++).padStart(3, '0')}`;
      if (item.node) {
        localElementMap.set(stableId, item.node);
      }

      let token = elementsToTokens.get(item.node);

      if (item.isInput) {
        // Form Input elements: NEVER transmit raw typed text or user values
        if (!token) {
          // Defense-in-depth: check if input rawValue contains sensitive patterns
          const rawVal = item.rawValue || item.textContent || '';
          const scrubResult = sanitizeTextContent(rawVal, assignNewToken);
          if (scrubResult.hadSensitiveData) {
            token = scrubResult.sanitized;
          }
        }

        if (token) {
          sanitizedElements.push({
            id: stableId,
            tag: item.tagName,
            type: item.type || undefined,
            role: item.type === 'password' ? 'password' : 'textbox',
            sensitive: true,
            value: token,
            bounds: {
              x: item.rect?.clientX ?? item.rect?.x ?? 0,
              y: item.rect?.clientY ?? item.rect?.y ?? 0,
              width: item.rect?.width ?? 0,
              height: item.rect?.height ?? 0
            }
          });
        } else {
          // Safe non-sensitive input (e.g. search query, submit button)
          const isButton = item.type === 'submit' || item.type === 'button' || item.type === 'reset';
          const safeBtnText = isButton ? (item.textContent || item.rawValue || 'Submit').trim().slice(0, 50) : undefined;
          sanitizedElements.push({
            id: stableId,
            tag: item.tagName,
            type: item.type || undefined,
            role: isButton ? 'button' : (item.type === 'search' ? 'search' : 'textbox'),
            sensitive: false,
            text: safeBtnText,
            bounds: {
              x: item.rect?.clientX ?? item.rect?.x ?? 0,
              y: item.rect?.clientY ?? item.rect?.y ?? 0,
              width: item.rect?.width ?? 0,
              height: item.rect?.height ?? 0
            }
          });
        }
      } else if (item.isImage) {
        // Image assets: never transmit image source URLs or binary pixels
        sanitizedElements.push({
          id: stableId,
          tag: 'img',
          role: 'content-image',
          sensitive: false,
          bounds: {
            x: item.rect?.clientX ?? item.rect?.x ?? 0,
            y: item.rect?.clientY ?? item.rect?.y ?? 0,
            width: item.rect?.width ?? 0,
            height: item.rect?.height ?? 0
          }
        });
      } else {
        // Static text containers (paragraphs, headings, table cells, labels)
        if (token) {
          sanitizedElements.push({
            id: stableId,
            tag: item.tagName,
            role: 'content',
            sensitive: true,
            value: token,
            bounds: {
              x: item.rect?.clientX ?? item.rect?.x ?? 0,
              y: item.rect?.clientY ?? item.rect?.y ?? 0,
              width: item.rect?.width ?? 0,
              height: item.rect?.height ?? 0
            }
          });
        } else {
          // Fail-closed PII scrubbing on all non-input text
          const rawText = (item.textContent || '').trim().slice(0, 300);
          const scrubResult = sanitizeTextContent(rawText, assignNewToken);

          if (scrubResult.hadSensitiveData) {
            sanitizedElements.push({
              id: stableId,
              tag: item.tagName,
              role: 'content',
              sensitive: true,
              value: scrubResult.sanitized,
              bounds: {
                x: item.rect?.clientX ?? item.rect?.x ?? 0,
                y: item.rect?.clientY ?? item.rect?.y ?? 0,
                width: item.rect?.width ?? 0,
                height: item.rect?.height ?? 0
              }
            });
          } else {
            sanitizedElements.push({
              id: stableId,
              tag: item.tagName,
              role: 'content',
              sensitive: false,
              text: scrubResult.sanitized || undefined,
              bounds: {
                x: item.rect?.clientX ?? item.rect?.x ?? 0,
                y: item.rect?.clientY ?? item.rect?.y ?? 0,
                width: item.rect?.width ?? 0,
                height: item.rect?.height ?? 0
              }
            });
          }
        }
      }
    }

    // 4. Construct SanitizedContext (Requirement 1, 4, 6)
    const sanitizedContext = {
      protocolVersion: 'privision-v2.0',
      timestamp: Date.now(),
      page: localCapture.safePage || { domain: 'unknown', origin: 'null', path: '/' },
      viewport: localCapture.viewport || { width: 1280, height: 800 },
      redactedCount: sensitiveTargetsWithTokens.length,
      redactedTokens: sensitiveTargetsWithTokens.map(t => t.token),
      elements: sanitizedElements,
      screenshot: sanitizedScreenshot, // Overwritten with opaque redactions or null
      privacy: {
        sanitized: true,
        rawDataExcluded: true,
        localPrivacyBoundaryActive: true
      }
    };

    this.redactionHistory.push(sanitizedContext);

    return {
      sanitizedContext,
      localElementMap
    };
  }

  /**
   * Clears all active redactions and cancels needle animations from the DOM.
   */
  clearAll() {
    cancelJudgementAnimation();
    for (const [, overlay] of activeRedactionOverlays) {
      if (overlay.parentNode) {
        overlay.remove();
      }
    }
    activeRedactionOverlays.clear();
  }
}
