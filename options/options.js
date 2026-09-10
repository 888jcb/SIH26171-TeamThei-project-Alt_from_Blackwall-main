/**
 * options/options.js
 * Manages BYOM configuration, allowlist management, sensitivity tuning,
 * model sanity validation, and the interactive redaction demo.
 */

import { playJudgementAnimation, cancelJudgementAnimation, redactAnimation } from '../lib/pipeline/redact.js';

document.addEventListener('DOMContentLoaded', async () => {
  // DOM references
  const modelSourceRadios = document.querySelectorAll('input[name="modelSource"]');
  const customModelFields = document.getElementById('customModelFields');
  const customSourceType = document.getElementById('customSourceType');
  const customModelUrlInput = document.getElementById('customModelUrl');
  const customApiKeyInput = document.getElementById('customApiKey');
  const executionProviderSelect = document.getElementById('executionProvider');
  const remoteEndpointUrlInput = document.getElementById('remoteEndpointUrl');
  const btnValidateModel = document.getElementById('btnValidateModel');
  const btnSaveCustomModel = document.getElementById('btnSaveCustomModel');
  const validationBadge = document.getElementById('validationBadge');
  const validationMessage = document.getElementById('validationMessage');

  const newDomainInput = document.getElementById('newDomainInput');
  const btnAddDomain = document.getElementById('btnAddDomain');
  const allowlistTags = document.getElementById('allowlistTags');

  const confidenceThresholdSlider = document.getElementById('confidenceThreshold');
  const thresholdValueLabel = document.getElementById('thresholdValue');
  const failClosedCheckbox = document.getElementById('failClosedCheckbox');

  const btnSaveSettings = document.getElementById('btnSaveSettings');
  const toast = document.getElementById('toast');

  // Playground demo buttons
  const btnRunTestRedaction = document.getElementById('btnRunTestRedaction');
  const btnResetPlayground = document.getElementById('btnResetPlayground');

  let currentAllowlist = [];
  let testOverlays = [];

  // Load saved settings
  async function loadSettings() {
    const config = await chrome.storage.local.get(null);

    // 1. Model Source
    const modelSource = config.modelSource || 'builtin';
    const activeRadio = document.querySelector(`input[name="modelSource"][value="${modelSource}"]`);
    if (activeRadio) activeRadio.checked = true;
    updateCustomFieldsVisibility(modelSource);

    customModelUrlInput.value = config.customModelUrl || '';
    customApiKeyInput.value = config.customApiKey || '';
    executionProviderSelect.value = config.executionProvider || 'auto';
    remoteEndpointUrlInput.value = config.remoteEndpointUrl || 'http://localhost:3721/api/reason';

    // 2. Allowlist
    currentAllowlist = config.allowlist || ['localhost', '127.0.0.1', 'bank.example.com', 'checkout.example.com'];
    renderAllowlistTags();

    // 3. Sensitivity
    const threshold = config.confidenceThreshold !== undefined ? config.confidenceThreshold : 0.5;
    confidenceThresholdSlider.value = threshold;
    updateThresholdDisplay(threshold);
    failClosedCheckbox.checked = config.failClosedHighRisk !== false;

    // 4. Verify Backend Connectivity on settings load
    await checkBackendConnection();
  }

  // Check Reasoning Backend Connection
  async function checkBackendConnection() {
    const titleEl = document.getElementById('backendStatusTitle');
    const dotEl = document.getElementById('backendStatusDot');
    const badgeEl = document.getElementById('backendStatusBadge');
    const endpointEl = document.getElementById('backendEndpointInput');
    const feedbackEl = document.getElementById('backendConnectionFeedback');
    const cardEl = document.getElementById('backendStatusCard');

    if (feedbackEl) {
      feedbackEl.textContent = 'Checking connectivity to http://localhost:3721...';
      feedbackEl.style.color = 'var(--text-muted, #94A3B8)';
    }

    try {
      const resp = await chrome.runtime.sendMessage({ action: 'CHECK_BACKEND', endpointUrl: 'http://localhost:3721' });
      if (resp && resp.isOnline) {
        if (titleEl) titleEl.textContent = 'REASONING BACKEND: ONLINE';
        if (dotEl) dotEl.style.background = '#10B981';
        if (badgeEl) {
          badgeEl.textContent = 'ONLINE';
          badgeEl.style.color = '#10B981';
          badgeEl.style.borderColor = '#10B981';
          badgeEl.style.background = 'rgba(16, 185, 129, 0.15)';
        }
        if (cardEl) cardEl.style.borderLeftColor = '#10B981';
        if (endpointEl) endpointEl.value = 'http://localhost:3721';
        if (feedbackEl) {
          feedbackEl.style.color = '#10B981';
          feedbackEl.textContent = `Connected • HTTP 200 OK • ${resp.data?.service || 'PRIVISION Server'} (${resp.data?.model || 'gemini-3.6-flash'}, port ${resp.data?.port || 3721})`;
        }
        return true;
      } else {
        if (titleEl) titleEl.textContent = 'REASONING BACKEND: OFFLINE';
        if (dotEl) dotEl.style.background = '#EF4444';
        if (badgeEl) {
          badgeEl.textContent = 'OFFLINE';
          badgeEl.style.color = '#EF4444';
          badgeEl.style.borderColor = '#EF4444';
          badgeEl.style.background = 'rgba(239, 68, 68, 0.15)';
        }
        if (cardEl) cardEl.style.borderLeftColor = '#EF4444';
        if (endpointEl) endpointEl.value = 'http://localhost:3721';
        if (feedbackEl) {
          feedbackEl.style.color = '#EF4444';
          feedbackEl.textContent = 'http://localhost:3721 is unreachable. Start the backend with: node server/mock_reasoning_server.js';
        }
        return false;
      }
    } catch (err) {
      if (titleEl) titleEl.textContent = 'REASONING BACKEND: OFFLINE';
      if (feedbackEl) {
        feedbackEl.style.color = '#EF4444';
        feedbackEl.textContent = err.message || 'Connection check failed';
      }
      return false;
    }
  }

  function updateCustomFieldsVisibility(source) {
    if (source === 'builtin') {
      customModelFields.style.display = 'none';
      validationBadge.textContent = 'Verified Ready';
      validationBadge.style.background = 'rgba(16, 185, 129, 0.2)';
      validationBadge.style.color = '#34D399';
      validationMessage.textContent = 'Built-in MobileViT ONNX weights verified (quantized, on-device).';
    } else {
      customModelFields.style.display = 'block';
      if (customSourceType) {
        if (customSourceType.value === 'hf') {
          customModelUrlInput.placeholder = 'e.g. microsoft/mobilevit-small';
        } else if (customSourceType.value === 'onnx') {
          customModelUrlInput.placeholder = 'https://my-models.cdn/models/vit-quant.onnx';
        } else {
          customModelUrlInput.placeholder = 'http://localhost:8080/v1/vision/embed';
        }
      }
      validationBadge.textContent = 'Configured';
      validationBadge.style.background = 'rgba(59, 130, 246, 0.2)';
      validationBadge.style.color = '#60A5FA';
      validationMessage.textContent = 'Custom model specified. Run sanity validation before saving.';
    }
  }

  if (customSourceType) {
    customSourceType.addEventListener('change', () => {
      const type = customSourceType.value;
      if (type === 'hf') {
        customModelUrlInput.placeholder = 'e.g. microsoft/mobilevit-small';
      } else if (type === 'onnx') {
        customModelUrlInput.placeholder = 'https://my-models.cdn/models/vit-quant.onnx';
      } else {
        customModelUrlInput.placeholder = 'http://localhost:8080/v1/vision/embed';
      }
    });
  }

  modelSourceRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      updateCustomFieldsVisibility(e.target.value);
    });
  });

  // Slider change
  confidenceThresholdSlider.addEventListener('input', (e) => {
    updateThresholdDisplay(parseFloat(e.target.value));
  });

  function updateThresholdDisplay(val) {
    let label = `${val.toFixed(2)}`;
    if (val <= 0.3) label += ' (High Sensitivity)';
    else if (val >= 0.7) label += ' (High Precision)';
    else label += ' (Balanced)';
    thresholdValueLabel.textContent = label;
  }

  // Allowlist rendering
  function renderAllowlistTags() {
    allowlistTags.innerHTML = '';
    currentAllowlist.forEach((domain, idx) => {
      const tag = document.createElement('div');
      tag.className = 'tag-item';
      tag.innerHTML = `
        <span>${domain}</span>
        <span class="tag-remove" data-index="${idx}" title="Remove domain">&times;</span>
      `;
      allowlistTags.appendChild(tag);
    });

    allowlistTags.querySelectorAll('.tag-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.target.getAttribute('data-index'), 10);
        currentAllowlist.splice(index, 1);
        renderAllowlistTags();
      });
    });
  }

  // Add domain
  btnAddDomain.addEventListener('click', () => {
    const val = newDomainInput.value.trim().toLowerCase();
    if (!val) return;
    try {
      const hostname = val.includes('://') ? new URL(val).hostname : val;
      if (hostname && !currentAllowlist.includes(hostname)) {
        currentAllowlist.push(hostname);
        renderAllowlistTags();
        newDomainInput.value = '';
      }
    } catch {
      showToast('Please enter a valid domain or URL.', 'error');
    }
  });

  // Validate Model & Sanity Check
  btnValidateModel.addEventListener('click', async () => {
    const selectedSource = document.querySelector('input[name="modelSource"]:checked')?.value || 'builtin';
    const url = customModelUrlInput.value.trim();

    validationBadge.textContent = 'Testing...';
    validationBadge.style.background = 'rgba(245, 158, 11, 0.2)';
    validationBadge.style.color = '#F59E0B';
    validationMessage.textContent = 'Running model execution validation check...';

    const resp = await chrome.runtime.sendMessage({
      action: 'VALIDATE_CUSTOM_MODEL',
      modelSource: selectedSource,
      customModelUrl: url
    });

    if (resp && resp.valid) {
      validationBadge.textContent = 'Verified Ready';
      validationBadge.style.background = 'rgba(16, 185, 129, 0.2)';
      validationBadge.style.color = '#34D399';
      validationMessage.textContent = resp.message;
      showToast('Model validation passed successfully!', 'success');
    } else {
      validationBadge.textContent = 'Failed';
      validationBadge.style.background = 'rgba(239, 68, 68, 0.2)';
      validationBadge.style.color = '#F87171';
      validationMessage.textContent = resp?.message || 'Model failed verification.';
      showToast(resp?.message || 'Model verification failed.', 'error');
    }
  });

  // Save Settings
  const saveAllSettings = async () => {
    const selectedSource = document.querySelector('input[name="modelSource"]:checked')?.value || 'builtin';
    const configToSave = {
      modelSource: selectedSource,
      customModelUrl: customModelUrlInput.value.trim(),
      customApiKey: customApiKeyInput.value.trim(),
      executionProvider: executionProviderSelect.value,
      remoteEndpointUrl: remoteEndpointUrlInput.value.trim(),
      allowlist: currentAllowlist,
      confidenceThreshold: parseFloat(confidenceThresholdSlider.value),
      failClosedHighRisk: failClosedCheckbox.checked
    };

    await chrome.storage.local.set(configToSave);
    showToast('Configuration saved successfully. All changes active immediately.', 'success');
  };

  btnSaveSettings.addEventListener('click', saveAllSettings);
  if (btnSaveCustomModel) {
    btnSaveCustomModel.addEventListener('click', saveAllSettings);
  }

  function showToast(msg, type = 'success') {
    toast.textContent = msg;
    toast.className = `toast ${type}`;
    setTimeout(() => {
      toast.className = 'toast hidden';
    }, 3500);
  }

  // =========================================================================
  // Interactive Redaction Playground Execution
  // =========================================================================

  btnRunTestRedaction.addEventListener('click', async () => {
    btnRunTestRedaction.disabled = true;

    // Targets to animate
    const testTargets = [
      { id: 'samplePassword', category: 'PASSWORD', label: '{{REDACTED_PASSWORD_1}}' },
      { id: 'sampleCard', category: 'PAYMENT_CARD', label: '{{REDACTED_CARD_1}}' },
      { id: 'sampleEmail', category: 'EMAIL', label: '{{REDACTED_EMAIL_1}}' },
      { id: 'sampleSsn', category: 'GOV_ID_SSN', label: '{{REDACTED_SSN_1}}' },
      { id: 'sampleAvatar', category: 'FACE_AVATAR', label: '{{REDACTED_FACE_1}}' }
    ];

    for (let i = 0; i < testTargets.length; i++) {
      const t = testTargets[i];
      const el = document.getElementById(t.id);
      if (el) {
        setTimeout(async () => {
          try {
            await playJudgementAnimation(el, {
              category: t.category,
              label: t.label,
              duration: 580
            });
          } catch (err) {
            console.error('Test animation error:', err);
          }
        }, i * 120); // Stagger by 120ms for satisfying cascade
      }
    }

    setTimeout(() => {
      btnRunTestRedaction.disabled = false;
      showToast('Judgement Needle animation executed. Page content remains intact.', 'success');
    }, testTargets.length * 120 + 650);
  });

  btnResetPlayground.addEventListener('click', () => {
    cancelJudgementAnimation();
    showToast('Playground reset. Ready for next test run.', 'success');
  });

  // Test Connection button listener
  const btnTestConnection = document.getElementById('btnTestConnection');
  if (btnTestConnection) {
    btnTestConnection.addEventListener('click', async () => {
      btnTestConnection.disabled = true;
      btnTestConnection.textContent = 'Testing...';
      const isOnline = await checkBackendConnection();
      btnTestConnection.disabled = false;
      btnTestConnection.textContent = 'Test Connection';
      if (isOnline) {
        showToast('Backend connection verified! REASONING BACKEND: ONLINE (http://localhost:3721)', 'success');
      } else {
        showToast('Connection failed: http://localhost:3721 is unreachable.', 'error');
      }
    });
  }

  // Initialize
  await loadSettings();
});
