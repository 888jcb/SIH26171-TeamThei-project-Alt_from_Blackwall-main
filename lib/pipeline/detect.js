/**
 * lib/pipeline/detect.js
 * Stage 3: Detect
 * 
 * Merges DOM cues and visual perception signals to identify sensitive PII targets.
 * Implements a strict fail-closed policy on high-risk fields (passwords, cards, emails, identifiers).
 */

export class SensitivityDetector {
  constructor(options = {}) {
    this.confidenceThreshold = options.confidenceThreshold !== undefined ? options.confidenceThreshold : 0.5;
    this.failClosedHighRisk = options.failClosedHighRisk !== false; // Default true
  }

  /**
   * Sets sensitivity threshold dynamically.
   * @param {number} threshold 0.0 - 1.0
   */
  setThreshold(threshold) {
    this.confidenceThreshold = Math.max(0.1, Math.min(1.0, threshold));
  }

  /**
   * Evaluates perceived signals and outputs detected sensitive targets.
   * @param {PerceivedSignal[]} perceivedSignals 
   * @returns {DetectedTarget[]}
   */
  detect(perceivedSignals) {
    const detections = [];
    let counter = 1;

    for (const signal of perceivedSignals) {
      const evaluation = this._evaluateSignal(signal);

      if (evaluation.isSensitive) {
        // Enforce threshold unless fail-closed is triggered
        const meetsThreshold = evaluation.confidence >= this.confidenceThreshold;
        const shouldRedact = meetsThreshold || (this.failClosedHighRisk && evaluation.isHighRisk);

        if (shouldRedact) {
          detections.push({
            id: `privision-target-${counter++}`,
            elementRef: signal.elementRef,
            category: evaluation.category,
            confidence: evaluation.confidence,
            reason: evaluation.reason,
            rect: signal.rect,
            isHighRisk: evaluation.isHighRisk,
            isInput: signal.isInput,
            isImage: signal.isImage,
            rawValue: signal.domSignals?.rawText || ''
          });
        }
      }
    }

    return detections;
  }

  /**
   * Evaluates individual signal multi-modally.
   * @private
   */
  _evaluateSignal(signal) {
    const dom = signal.domSignals || {};
    const text = (dom.rawText || '').trim();

    // 1. Passwords (Absolute Fail-Closed)
    if (dom.isPasswordInput || dom.autocomplete?.includes('password')) {
      return {
        isSensitive: true,
        isHighRisk: true,
        category: 'PASSWORD',
        confidence: 1.0,
        reason: 'DOM input type is password or autocomplete specified password'
      };
    }

    if (dom.sensitiveKeywordsDetected?.some(k => ['password', 'pwd', 'pin', 'secret'].includes(k))) {
      return {
        isSensitive: true,
        isHighRisk: true,
        category: 'PASSWORD',
        confidence: 0.95,
        reason: 'Input label/attributes match password/pin lexicon'
      };
    }

    // 2. Payment Cards & CVV (High Risk)
    if (dom.autocomplete?.startsWith('cc-') || dom.sensitiveKeywordsDetected?.some(k => ['card', 'cvv', 'cvc', 'credit'].includes(k))) {
      return {
        isSensitive: true,
        isHighRisk: true,
        category: 'PAYMENT_CARD',
        confidence: 0.95,
        reason: 'Payment card autocomplete or credit card identifier detected'
      };
    }

    // Check credit card regex in raw text (13-19 digits, contiguous, spaced, hyphenated, or dot-separated)
    const ccRe = /\b(?:\d[\s\-\.]*?){13,19}\b/g;
    let ccM;
    let hasCC = false;
    while ((ccM = ccRe.exec(text)) !== null) {
      if (ccM[0].replace(/\D/g, '').length >= 13 && ccM[0].replace(/\D/g, '').length <= 19) {
        hasCC = true;
        break;
      }
    }
    if (hasCC) {
      return {
        isSensitive: true,
        isHighRisk: true,
        category: 'PAYMENT_CARD',
        confidence: 0.95,
        reason: '13-19 digit card sequence pattern matched (contiguous, spaced, or hyphenated)'
      };
    }

    // 3. National Identity Numbers (SSN, Aadhaar, PAN)
    // SSN format: XXX-XX-XXXX
    if (/\b\d{3}-\d{2}-\d{4}\b/.test(text) || dom.sensitiveKeywordsDetected?.includes('ssn')) {
      return {
        isSensitive: true,
        isHighRisk: true,
        category: 'GOV_ID_SSN',
        confidence: 0.96,
        reason: 'SSN / National ID number pattern or label matched'
      };
    }

    // Aadhaar format: XXXX XXXX XXXX
    if (/\b\d{4}\s\d{4}\s\d{4}\b/.test(text) || dom.sensitiveKeywordsDetected?.includes('aadhaar')) {
      return {
        isSensitive: true,
        isHighRisk: true,
        category: 'GOV_ID_AADHAAR',
        confidence: 0.94,
        reason: 'Aadhaar format (12-digit grouped) or label matched'
      };
    }

    // PAN Card format: 5 letters + 4 digits + 1 letter
    if (/\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/i.test(text) || dom.sensitiveKeywordsDetected?.includes('pan card')) {
      return {
        isSensitive: true,
        isHighRisk: true,
        category: 'GOV_ID_PAN',
        confidence: 0.92,
        reason: 'PAN card format or PAN label matched'
      };
    }

    // 4. Email Addresses
    if (dom.isEmailInput || dom.autocomplete === 'email') {
      return {
        isSensitive: true,
        isHighRisk: true,
        category: 'EMAIL',
        confidence: 0.98,
        reason: 'Email field attribute specified'
      };
    }
    const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
    if (emailRegex.test(text)) {
      return {
        isSensitive: true,
        isHighRisk: true,
        category: 'EMAIL',
        confidence: 0.95,
        reason: 'Valid RFC-compliant email string pattern found'
      };
    }

    // 5. Phone numbers
    if (dom.isTelInput || dom.autocomplete === 'tel') {
      return {
        isSensitive: true,
        isHighRisk: false,
        category: 'PHONE_NUMBER',
        confidence: 0.90,
        reason: 'Telephone field attribute specified'
      };
    }
    const phoneRegex = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/;
    if (phoneRegex.test(text) && text.replace(/\D/g, '').length >= 10) {
      return {
        isSensitive: true,
        isHighRisk: false,
        category: 'PHONE_NUMBER',
        confidence: 0.85,
        reason: 'Phone number format matched'
      };
    }

    // 6. Visual Face / Photo
    if (signal.isImage && signal.visualSignals?.isLikelyFace) {
      return {
        isSensitive: true,
        isHighRisk: false,
        category: 'FACE_AVATAR',
        confidence: signal.visualSignals.confidence,
        reason: 'Vision model classified image as biometric face/avatar'
      };
    }

    // 7. General Financial / Banking
    if (dom.sensitiveKeywordsDetected?.some(k => ['bank', 'account', 'routing', 'iban', 'salary', 'income'].includes(k))) {
      return {
        isSensitive: true,
        isHighRisk: true,
        category: 'FINANCIAL_INFO',
        confidence: 0.88,
        reason: 'Financial/banking keyword association'
      };
    }

    // 8. Personal Name in Form Field
    if (dom.autocomplete?.includes('name') || dom.id.toLowerCase().includes('fullname') || dom.name.toLowerCase().includes('name')) {
      if (text.length > 2) {
        return {
          isSensitive: true,
          isHighRisk: false,
          category: 'FULL_NAME',
          confidence: 0.78,
          reason: 'Personal name identifier detected'
        };
      }
    }

    // Not sensitive
    return {
      isSensitive: false,
      isHighRisk: false,
      category: null,
      confidence: 0.0,
      reason: 'No sensitive markers detected'
    };
  }
}
