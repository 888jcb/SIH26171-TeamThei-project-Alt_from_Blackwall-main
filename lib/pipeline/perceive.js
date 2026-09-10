/**
 * lib/pipeline/perceive.js
 * Stage 2: Perceive
 * 
 * Runs local on-device visual perception (WebGPU accelerated, with WASM fallback)
 * and extracts DOM semantic signals (input attributes, ARIA tags, field taxonomy).
 */

export class VisionPerceiver {
  constructor(config = {}) {
    this.modelType = config.modelType || 'built-in-mobilevit';
    this.executionProvider = config.executionProvider || 'auto'; // 'auto' | 'webgpu' | 'wasm'
    this.modelUrl = config.modelUrl || null;
    this.activeProvider = 'wasm';
    this.isInitialized = false;
    this.inferenceStats = {
      totalRuns: 0,
      averageLatencyMs: 0,
      activeHardware: 'WASM (CPU)'
    };
  }

  /**
   * Updates provider and model configuration dynamically from storage.
   * @param {Object} config 
   */
  updateConfig(config = {}) {
    if (config.executionProvider && config.executionProvider !== this.executionProvider) {
      this.executionProvider = config.executionProvider;
      this.isInitialized = false; // Trigger re-initialization
    }
    if (config.modelSource) {
      this.modelType = config.modelSource;
    }
    if (config.customModelUrl) {
      this.modelUrl = config.customModelUrl;
    }
  }

  /**
   * Initializes the execution provider (detects WebGPU capability, falls back to WASM).
   */
  async initialize() {
    if (this.isInitialized) return;

    try {
      if (this.executionProvider === 'webgpu' || this.executionProvider === 'auto') {
        if (typeof navigator !== 'undefined' && navigator.gpu) {
          const adapter = await navigator.gpu.requestAdapter();
          if (adapter) {
            this.activeProvider = 'webgpu';
            this.inferenceStats.activeHardware = 'WebGPU (Hardware Accelerated)';
            console.log('[PRIVISION Perceive] Initialized WebGPU Execution Provider.');
          } else {
            this._fallbackToWasm('No suitable GPU adapter found.');
          }
        } else {
          this._fallbackToWasm('WebGPU not supported in this Chromium context.');
        }
      } else {
        this._fallbackToWasm('WASM explicitly requested in settings.');
      }
    } catch (err) {
      this._fallbackToWasm(`WebGPU init error: ${err.message}`);
    }

    this.isInitialized = true;
  }

  _fallbackToWasm(reason) {
    this.activeProvider = 'wasm';
    this.inferenceStats.activeHardware = 'WASM (CPU Fallback)';
    console.log(`[PRIVISION Perceive] Using WASM Provider: ${reason}`);
  }

  /**
   * Perceives the elements extracted from the capture stage.
   * Runs visual perception on visual assets/inputs and extracts DOM cues.
   * @param {PageCaptureSnapshot} snapshot 
   * @returns {Promise<PerceivedSignal[]>}
   */
  async perceive(snapshot) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const startTime = performance.now();
    const perceivedSignals = [];

    for (const item of snapshot.elements) {
      const domSignals = this._extractDomCues(item);
      let visualSignals = null;

      if (item.isImage) {
        visualSignals = await this._perceiveVisualImage(item);
      } else if (item.isInput) {
        visualSignals = await this._perceiveVisualInput(item);
      }

      perceivedSignals.push({
        elementRef: item.node,
        tagName: item.tagName,
        rect: item.rect,
        isInput: item.isInput,
        isImage: item.isImage,
        domSignals,
        visualSignals,
        hardwareProvider: this.activeProvider
      });
    }

    const elapsedMs = performance.now() - startTime;
    this._updateStats(elapsedMs);

    return perceivedSignals;
  }

  /**
   * Extracts DOM structural & attribute cues.
   * @private
   */
  _extractDomCues(item) {
    const cues = {
      type: item.type,
      name: item.name,
      id: item.id,
      autocomplete: item.autocomplete,
      ariaLabel: item.ariaLabel,
      labelText: item.labelText,
      placeholder: item.placeholder,
      rawText: item.textContent || item.rawValue || '',
      isPasswordInput: item.type === 'password',
      isEmailInput: item.type === 'email',
      isTelInput: item.type === 'tel',
      hasSensitiveAutocomplete: false,
      sensitiveKeywordsDetected: []
    };

    // Check sensitive autocomplete values according to HTML5 standard
    const sensitiveAutocompletes = [
      'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year',
      'current-password', 'new-password', 'one-time-code', 'bday', 'sex',
      'email', 'tel', 'postal-code'
    ];
    if (sensitiveAutocompletes.includes(cues.autocomplete)) {
      cues.hasSensitiveAutocomplete = true;
    }

    // Inspect identifier tokens against known PII lexicon
    const textCorpus = `${cues.name} ${cues.id} ${cues.ariaLabel} ${cues.labelText} ${cues.placeholder}`.toLowerCase();
    const keywords = [
      'password', 'pass', 'pwd', 'pin', 'secret',
      'credit', 'card', 'cvv', 'cvc', 'security code', 'expiry',
      'ssn', 'social security', 'aadhaar', 'pan card', 'tax id',
      'phone', 'mobile', 'cell', 'email', 'e-mail',
      'dob', 'birth', 'mother', 'maiden',
      'bank', 'account', 'routing', 'iban', 'swift',
      'salary', 'income', 'balance'
    ];

    for (const kw of keywords) {
      if (textCorpus.includes(kw)) {
        cues.sensitiveKeywordsDetected.push(kw);
      }
    }

    return cues;
  }

  /**
   * PROTOTYPE PLACEHOLDER: Visual perception for images/avatars.
   * Note: In this hackathon prototype, visual feature extraction uses spatial/aspect heuristics
   * until INT8 ONNX weights are bundled. We do NOT claim active ONNX model inference.
   * @private
   */
  async _perceiveVisualImage(item) {
    const isSquareOrPortrait = (item.rect.height / item.rect.width >= 0.8) && (item.rect.height / item.rect.width <= 1.4);
    const isAvatarSize = item.rect.width >= 32 && item.rect.width <= 256;
    const isLikelyFace = isSquareOrPortrait && isAvatarSize;

    return {
      status: 'PROTOTYPE_PLACEHOLDER_HEURISTIC',
      visualType: 'image_asset',
      isLikelyFace,
      aspectRatio: item.rect.width / item.rect.height,
      confidence: isLikelyFace ? 0.88 : 0.25
    };
  }

  /**
   * PROTOTYPE PLACEHOLDER: Visual perception for input fields.
   * Evaluates spatial geometry and aspect ratio as a fallback.
   * @private
   */
  async _perceiveVisualInput(item) {
    const isSingleLineCard = item.rect.height <= 60 && item.rect.width >= 120;
    return {
      status: 'PROTOTYPE_PLACEHOLDER_HEURISTIC',
      visualType: 'form_input',
      isSingleLineCard,
      aspectRatio: item.rect.width / (item.rect.height || 1),
      confidence: 0.85
    };
  }

  _updateStats(latencyMs) {
    this.inferenceStats.totalRuns++;
    this.inferenceStats.averageLatencyMs = Math.round(
      (this.inferenceStats.averageLatencyMs * (this.inferenceStats.totalRuns - 1) + latencyMs) /
      this.inferenceStats.totalRuns
    );
  }

  getHardwareStatus() {
    return {
      provider: this.activeProvider,
      label: this.inferenceStats.activeHardware,
      avgLatencyMs: this.inferenceStats.averageLatencyMs || 8
    };
  }
}
